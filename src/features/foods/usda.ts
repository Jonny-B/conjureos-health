/**
 * USDA FoodData Central provider: generic whole foods ("banana", "chicken
 * breast", "white rice") where Open Food Facts skews toward branded packages.
 * Branded entries carry per-serving label nutrients; Foundation/SR Legacy
 * entries are per-100g, which we expose as a "100 g" serving the user can
 * scale.
 *
 * Searches go through ConjureOS's `usda-proxy` edge function, never to USDA
 * directly (conjureos-fitness#70). The proxy holds the FoodData Central key as
 * a server secret (`USDA_API_KEY`), so no key ships in this bundle and the
 * quota is the platform's to manage, instead of USDA's shared demo key at 30
 * requests an hour per IP. It passes USDA's search JSON and status through
 * unchanged, so a USDA 429 arrives here as a 429.
 *
 * A search that gets no answer throws `ProviderUnavailableError`; `[]` means
 * USDA answered and had nothing.
 *
 * Docs: https://fdc.nal.usda.gov/api-guide.html
 */

import type { FoodItem, Macros } from "../../types";
import { ProviderUnavailableError, SEARCH_TIMEOUT_MS, withTimeout } from "./http";

declare global {
  interface ConjureosBridge {
    /** Per-deploy values the host hands every app. */
    env?: {
      /** This deploy's usda-proxy, e.g. `https://<ref>.supabase.co/functions/v1/usda-proxy`. */
      usdaProxyUrl?: string;
    };
  }
}

const PROXY_PATH = "/functions/v1/usda-proxy";

/**
 * Where a USDA search goes: the proxy the host names for the deploy the app is
 * running in, else the one on the project this build was made for, else
 * nowhere (an unconfigured build, which the search reports).
 */
export function usdaProxyUrl(): string {
  const fromHost =
    typeof window !== "undefined" ? window.__conjureos?.env?.usdaProxyUrl : undefined;
  if (typeof fromHost === "string" && fromHost.trim()) return fromHost.trim();
  const base = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim();
  return base ? `${base.replace(/\/+$/, "")}${PROXY_PATH}` : "";
}

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
 *  branded items (Open Food Facts covers those). Throws
 *  `ProviderUnavailableError` when USDA did not answer; resolves `[]` when it
 *  answered with nothing, or when the caller cancelled. */
export async function searchText(
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<FoodItem[]> {
  const q = query.trim();
  if (!q) return [];
  let url: URL;
  try {
    url = new URL(usdaProxyUrl());
  } catch {
    // No proxy named and no project in this build: nowhere to ask.
    throw new ProviderUnavailableError("usda");
  }
  url.searchParams.set("query", q);
  url.searchParams.set("pageSize", String(Math.min(limit, 25)));
  url.searchParams.set("dataType", "Foundation,SR Legacy,Branded");
  let json: { foods?: FdcFood[] };
  try {
    const resp = await fetch(url.toString(), { signal: withTimeout(signal, SEARCH_TIMEOUT_MS) });
    // 429 is the key's hourly quota; anything else not ok is a refusal too.
    if (!resp.ok) throw new ProviderUnavailableError("usda", resp.status);
    json = (await resp.json()) as { foods?: FdcFood[] };
  } catch (err) {
    // A newer keystroke cancelled this search: nobody is waiting for it.
    if (signal?.aborted) return [];
    // Offline, timed out, refused, or an answer that was not JSON.
    if (err instanceof ProviderUnavailableError) throw err;
    throw new ProviderUnavailableError("usda");
  }
  const out: FoodItem[] = [];
  for (const f of json.foods ?? []) {
    const item = toFoodItem(f);
    if (item) out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}
