/**
 * USDA FoodData Central provider — generic whole foods ("banana", "chicken
 * breast", "white rice") where Open Food Facts skews toward branded packages.
 *
 * Free API; ships with DEMO_KEY (30 req/hr per IP). Set VITE_USDA_API_KEY for
 * the 1000/hr signup limit. Branded entries carry per-serving label nutrients;
 * Foundation/SR Legacy entries are per-100g, which we expose as a "100 g"
 * serving the user can scale.
 *
 * Docs: https://fdc.nal.usda.gov/api-guide.html
 */

import type { FoodItem, Macros } from "../../types";
import { SEARCH_TIMEOUT_MS, withTimeout } from "./http";

const BASE = "https://api.nal.usda.gov/fdc/v1";
const KEY = import.meta.env.VITE_USDA_API_KEY ?? "DEMO_KEY";
/** True when no VITE_USDA_API_KEY is configured and we're on USDA's shared
 *  DEMO_KEY, which is heavily rate-limited. The UI notes the degraded search. */
export const USING_DEMO_KEY = KEY === "DEMO_KEY";

interface FdcNutrient {
  nutrientName?: string;
  value?: number;
}
interface FdcLabelNutrients {
  calories?: { value?: number };
  protein?: { value?: number };
  carbohydrates?: { value?: number };
  fat?: { value?: number };
}
interface FdcFood {
  fdcId: number;
  description?: string;
  brandOwner?: string;
  dataType?: string;
  servingSize?: number;
  servingSizeUnit?: string;
  foodNutrients?: FdcNutrient[];
  labelNutrients?: FdcLabelNutrients;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function per100g(nutrients: FdcNutrient[] = []): Macros {
  let calories = 0,
    protein = 0,
    fat = 0,
    carbs = 0;
  for (const n of nutrients) {
    switch (n.nutrientName) {
      case "Energy":
        if (calories === 0) calories = num(n.value);
        break;
      case "Protein":
        protein = num(n.value);
        break;
      case "Total lipid (fat)":
        fat = num(n.value);
        break;
      case "Carbohydrate, by difference":
        carbs = num(n.value);
        break;
    }
  }
  return { calories, protein, carbs, fat };
}

function toFoodItem(f: FdcFood): FoodItem | null {
  const name = (f.description ?? "").trim();
  if (!name) return null;

  // Branded label nutrients are already per labelled serving.
  if (f.labelNutrients && f.servingSize) {
    const l = f.labelNutrients;
    return {
      id: String(f.fdcId),
      source: "usda",
      name: titleCase(name),
      brand: f.brandOwner?.trim() || undefined,
      perServing: {
        calories: Math.round(num(l.calories?.value)),
        protein: Math.round(num(l.protein?.value)),
        carbs: Math.round(num(l.carbohydrates?.value)),
        fat: Math.round(num(l.fat?.value)),
      },
      servingSize: `${f.servingSize} ${f.servingSizeUnit ?? "g"}`,
      servingGrams: (f.servingSizeUnit ?? "g").toLowerCase() === "g" ? f.servingSize : undefined,
    };
  }

  const macros = per100g(f.foodNutrients);
  if (macros.calories === 0 && macros.protein === 0 && macros.carbs === 0 && macros.fat === 0) {
    return null;
  }
  return {
    id: String(f.fdcId),
    source: "usda",
    name: titleCase(name),
    perServing: {
      calories: Math.round(macros.calories),
      protein: Math.round(macros.protein),
      carbs: Math.round(macros.carbs),
      fat: Math.round(macros.fat),
    },
    servingSize: "100 g",
    servingGrams: 100,
  };
}

function titleCase(s: string): string {
  // USDA descriptions are ALL CAPS or comma-segmented; show the leading,
  // human-readable segment in title case.
  const head = s.split(",")[0]!.toLowerCase();
  return head.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Search USDA FoodData Central. Strong on whole/generic foods, weak on
 *  branded items (Open Food Facts covers those). Returns [] on any failure. */
export async function searchText(
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<FoodItem[]> {
  const q = query.trim();
  if (!q) return [];
  const url = new URL(`${BASE}/foods/search`);
  url.searchParams.set("api_key", KEY);
  url.searchParams.set("query", q);
  url.searchParams.set("pageSize", String(Math.min(limit, 25)));
  url.searchParams.set("dataType", "Foundation,SR Legacy,Branded");
  let resp: Response;
  try {
    resp = await fetch(url.toString(), { signal: withTimeout(signal, SEARCH_TIMEOUT_MS) });
  } catch {
    return [];
  }
  if (!resp.ok) return [];
  const json = (await resp.json()) as { foods?: FdcFood[] };
  const out: FoodItem[] = [];
  for (const f of json.foods ?? []) {
    const item = toFoodItem(f);
    if (item) out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}
