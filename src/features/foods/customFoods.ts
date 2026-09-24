/**
 * Foods the user typed in themselves, for when no provider knows the item.
 *
 * Stored in the app's VFS (`custom-foods.json`), which is the same on every
 * backend (mock and Supabase alike), and matched ahead of the provider results
 * in `searchFoods` so a saved food is findable the next time it is searched.
 */

import type { FoodItem } from "../../types";
import { readJson, writeJsonOrThrow } from "../../bridge/vfs";
import { newId } from "../../data/id";
import { persist } from "../../data/saveFailure";

export const CUSTOM_FOODS_PATH = "custom-foods.json";

interface CustomFoodsFile {
  v: 1;
  foods: FoodItem[];
}

export interface CustomFoodInput {
  name: string;
  brand?: string;
  servingAmount: number;
  servingUnit: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

/** Units the form offers; grams and millilitres also give a gram weight. */
export const CUSTOM_SERVING_UNITS = ["g", "ml", "oz", "cup", "tbsp", "tsp", "piece", "slice", "serving"] as const;

async function load(): Promise<CustomFoodsFile> {
  const f = await readJson<CustomFoodsFile>(CUSTOM_FOODS_PATH, { v: 1, foods: [] });
  return f && Array.isArray(f.foods) ? f : { v: 1, foods: [] };
}

const nonNeg = (n: number) => (Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : 0);

/** Why the input cannot be saved, or null when it can. */
export function customFoodProblem(input: CustomFoodInput): string | null {
  if (!input.name.trim()) return "Give the food a name.";
  if (!(input.servingAmount > 0)) return "Enter a serving amount above zero.";
  if (!input.servingUnit.trim()) return "Pick a serving unit.";
  if (!(input.calories >= 0)) return "Enter the calories per serving.";
  return null;
}

export function toFoodItem(input: CustomFoodInput, id = newId()): FoodItem {
  const amount = nonNeg(input.servingAmount);
  const unit = input.servingUnit.trim();
  const grams =
    unit === "g" || unit === "ml" ? amount : unit === "oz" ? Math.round(amount * 28.35 * 10) / 10 : undefined;
  const brand = input.brand?.trim();
  return {
    id,
    source: "custom",
    name: input.name.trim(),
    ...(brand ? { brand } : {}),
    perServing: {
      calories: Math.round(nonNeg(input.calories)),
      protein: nonNeg(input.protein),
      carbs: nonNeg(input.carbs),
      fat: nonNeg(input.fat),
    },
    servingSize: `${amount} ${unit}`,
    ...(grams ? { servingGrams: grams } : {}),
    provenance: { sourceTag: "user_manual" },
  };
}

/** Save a food the user entered. Resolves to the saved food, or null when the write failed (already reported). */
export async function saveCustomFood(input: CustomFoodInput): Promise<FoodItem | null> {
  const food = toFoodItem(input);
  const file = await load();
  const next: CustomFoodsFile = { v: 1, foods: [food, ...file.foods] };
  const ok = await persist("your food", writeJsonOrThrow(CUSTOM_FOODS_PATH, next));
  return ok ? food : null;
}

export async function listCustomFoods(): Promise<FoodItem[]> {
  return (await load()).foods;
}

/** Saved foods whose name or brand contains every word of the query. */
export async function searchCustomFoods(query: string, limit = 10): Promise<FoodItem[]> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const foods = await listCustomFoods();
  return foods
    .filter((f) => {
      const hay = `${f.name} ${f.brand ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .slice(0, limit);
}
