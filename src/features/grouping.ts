/**
 * Collapsing several foods into one.
 *
 * Two callers with the same underlying need. The AI review screen groups items
 * it just detected (a hotdog is sausage + bun + mustard); the meal screen
 * groups entries already in the diary (a smoothie you assembled by scanning
 * three barcodes). Both want one entry with the totals added up and a name
 * short enough to read in a list.
 */

import type { DiaryEntry, FoodItem } from "../types";
import { newId } from "../data/id";

/** Longest a grouped name may be. Past this it stops being a label and starts
 *  being a list, which is the thing grouping was meant to avoid. */
export const GROUP_NAME_MAX = 40;

/**
 * Build a group name from the items themselves.
 *
 * The fallback for when the model omits `groupName` or returns something
 * unusable. Leads with the biggest item by calories — that is what the meal
 * actually was — and adds the next one as "with X" when it fits. Beyond that
 * it counts the rest rather than listing them, because "Hotdog with mustard,
 * relish, onions and a bun" is exactly the sprawl grouping is for.
 */
export function suggestGroupName(items: FoodItem[]): string {
  if (items.length === 0) return "";
  const sorted = [...items].sort((a, b) => b.perServing.calories - a.perServing.calories);
  const head = sorted[0]!.name.trim();
  if (sorted.length === 1) return head.slice(0, GROUP_NAME_MAX);

  const second = sorted[1]!.name.trim().toLowerCase();
  const withTwo = `${head} with ${second}`;
  if (sorted.length === 2) {
    return withTwo.length <= GROUP_NAME_MAX ? withTwo : head.slice(0, GROUP_NAME_MAX);
  }

  const more = `${head} +${sorted.length - 1} more`;
  return more.length <= GROUP_NAME_MAX ? more : head.slice(0, GROUP_NAME_MAX);
}

/**
 * Collapse several estimated foods into one entry.
 *
 * Macros are summed; the serving label becomes the item count, since "1
 * serving" would be a lie about something assembled from five things. Returns
 * null for an empty list.
 */
export function groupItems(items: FoodItem[], name?: string): FoodItem | null {
  if (items.length === 0) return null;
  const total = items.reduce(
    (acc, f) => ({
      calories: acc.calories + f.perServing.calories,
      protein: acc.protein + f.perServing.protein,
      carbs: acc.carbs + f.perServing.carbs,
      fat: acc.fat + f.perServing.fat,
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
  const label = (name ?? "").trim().slice(0, GROUP_NAME_MAX) || suggestGroupName(items);
  return {
    id: newId(),
    source: "custom",
    name: label,
    perServing: {
      calories: Math.round(total.calories),
      protein: Math.round(total.protein),
      carbs: Math.round(total.carbs),
      fat: Math.round(total.fat),
    },
    servingSize: items.length === 1 ? items[0]!.servingSize : `${items.length} items`,
    provenance: { sourceTag: "ai_estimate" },
  };
}
/**
 * Collapse diary entries the user picked into one food.
 *
 * Unlike {@link groupItems} this must respect each entry's QUANTITY — the
 * diary stores "half a scoop of protein powder" as a food plus 0.5, and a
 * smoothie built from those parts is wrong by half if the multiplier is
 * dropped. The result is a single serving of the whole thing, so it re-logs at
 * quantity 1.
 *
 * The AI-estimate tag carries over only when EVERY part was an estimate.
 * Grouping a scanned yogurt with an estimated banana produces something part
 * measured and part guessed, and badging that as "AI estimate" would be the
 * more honest of the two readings.
 */
export function groupEntries(entries: DiaryEntry[], name?: string): FoodItem | null {
  if (entries.length === 0) return null;
  const total = entries.reduce(
    (acc, e) => {
      const q = Number.isFinite(e.quantity) ? e.quantity : 1;
      const p = e.food.perServing;
      return {
        calories: acc.calories + p.calories * q,
        protein: acc.protein + p.protein * q,
        carbs: acc.carbs + p.carbs * q,
        fat: acc.fat + p.fat * q,
      };
    },
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );

  const foods = entries.map((e) => e.food);
  const label = (name ?? "").trim().slice(0, GROUP_NAME_MAX) || suggestGroupName(foods);
  const allEstimated = entries.every((e) => e.food.provenance?.sourceTag === "ai_estimate");

  const food: FoodItem = {
    id: newId(),
    source: "custom",
    name: label,
    perServing: {
      calories: Math.round(total.calories),
      protein: Math.round(total.protein),
      carbs: Math.round(total.carbs),
      fat: Math.round(total.fat),
    },
    servingSize: `${entries.length} items`,
  };
  if (allEstimated) food.provenance = { sourceTag: "ai_estimate" };
  return food;
}
