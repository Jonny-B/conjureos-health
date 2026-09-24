/**
 * Recent-saved food history — re-suggest the *literal* thing you logged before,
 * not just the generic catalog item.
 *
 * The diary stores every entry as `{ food snapshot, quantity }`, so "half an
 * RXBar" is `{ food: <RXBar>, quantity: 0.5 }`. This walks recent days, keeps
 * the entries for one meal, and dedups by a *literal* signature that includes
 * the quantity — so "RXBar ×0.5" and "RXBar ×1" are distinct suggestions, and
 * re-logging one re-adds exactly what you ate (no re-adjusting). The snapshot is
 * self-contained, so a suggestion stays valid even if the source catalog/recipe
 * later changes or disappears.
 *
 * There is no cross-date query in the Repository (listDiary is single-date), so
 * this fans out over a day window the same way the coach context does.
 */

import type { DiaryEntry, FoodItem, MealType } from "../types";
import { getRepository } from "../data/repository";
import { shiftDate, todayISO } from "./diary";

/** A food the user logged recently, with the quantity they last used — so
 *  re-logging it is one tap with their portion already filled in. */
export interface RecentFood {
  food: FoodItem;
  quantity: number;
  lastLoggedAt: string;
}

interface Options {
  /** How many days back to scan. */
  days?: number;
  /** Max suggestions returned. */
  limit?: number;
}

/**
 * A literal signature: two entries collapse only when they'd re-log to the same
 * thing — same food identity (name + brand + serving) AND the same per-serving
 * macros AND the same quantity. Quantity is part of the key on purpose.
 */
function signature(entry: DiaryEntry): string {
  const f = entry.food;
  const p = f.perServing;
  return [
    f.name.trim().toLowerCase(),
    (f.brand ?? "").trim().toLowerCase(),
    f.servingSize.trim().toLowerCase(),
    Math.round(p.calories),
    Math.round(p.protein),
    Math.round(p.carbs),
    Math.round(p.fat),
    entry.quantity,
  ].join("|");
}

/**
 * Recently-logged foods for one meal, most-recent first, deduped to the literal
 * saved entry (food snapshot + quantity). Best-effort: a failed day read is
 * skipped, never thrown.
 */
export async function recentFoodsForMeal(
  meal: MealType,
  { days = 30, limit = 12 }: Options = {},
): Promise<RecentFood[]> {
  const repo = await getRepository();
  const today = todayISO();
  const dates = Array.from({ length: days }, (_, i) => shiftDate(today, -i));

  const perDay = await Promise.all(
    dates.map((d) => repo.listDiary(d).catch(() => [] as DiaryEntry[])),
  );

  // listDiary sorts a day ascending by loggedAt; our date list is today→back,
  // so flattening then sorting by loggedAt desc yields newest-first overall.
  const entries = perDay
    .flat()
    // Entries the user chose to keep out of history never surface here. They
    // are still in the diary; this only governs the re-log shortcuts.
    .filter((e) => e.meal === meal && !e.excludeFromQuickAdd)
    .sort((a, b) => (a.loggedAt < b.loggedAt ? 1 : a.loggedAt > b.loggedAt ? -1 : 0));

  const seen = new Set<string>();
  const out: RecentFood[] = [];
  for (const e of entries) {
    const sig = signature(e);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({ food: e.food, quantity: e.quantity, lastLoggedAt: e.loggedAt });
    if (out.length >= limit) break;
  }
  return out;
}
