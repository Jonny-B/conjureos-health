/**
 * Diary math — pure functions over diary entries. No I/O here; the repository
 * supplies the entries and these shape them into the day view the UI renders.
 */

import type { DayView, DiaryEntry, Macros, MealType } from "../types";
import { MEAL_TYPES, ZERO_MACROS } from "../types";

/** Local calendar date as YYYY-MM-DD (not UTC — the diary is day-of-life). */
export function todayISO(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Shift a YYYY-MM-DD date by whole days, returning a new YYYY-MM-DD. */
export function shiftDate(dateISO: string, deltaDays: number): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  const dt = new Date(y!, (m ?? 1) - 1, d ?? 1);
  dt.setDate(dt.getDate() + deltaDays);
  return todayISO(dt);
}

/** Sum two macro totals field by field. Pure; neither input is mutated. */
export function addMacros(a: Macros, b: Macros): Macros {
  return {
    calories: a.calories + b.calories,
    protein: a.protein + b.protein,
    carbs: a.carbs + b.carbs,
    fat: a.fat + b.fat,
  };
}

/**
 * True when an entry's numbers are an unreviewed AI estimate (logged by name
 * without explicit macros, via the assistant or the Describe tab). The diary
 * badges these so the user knows they're a guess and may be inaccurate.
 */
export function isAiEstimate(entry: DiaryEntry): boolean {
  return entry.food.provenance?.sourceTag === "ai_estimate";
}

/** Nutrition for an entry = its food's per-serving macros × quantity, rounded. */
export function entryMacros(entry: DiaryEntry): Macros {
  const q = entry.quantity;
  const p = entry.food.perServing;
  return {
    calories: Math.round(p.calories * q),
    protein: Math.round(p.protein * q),
    carbs: Math.round(p.carbs * q),
    fat: Math.round(p.fat * q),
  };
}

/**
 * Group one day's entries into the shape the diary renders: entries bucketed
 * by meal, per-meal macro subtotals, and the day's grand total. Meals with no
 * entries are present but empty, so the UI can render every slot unconditionally.
 */
export function buildDayView(date: string, entries: DiaryEntry[]): DayView {
  const meals = emptyMealMap<DiaryEntry[]>(() => []);
  const perMeal = emptyMealMap<Macros>(() => ({ ...ZERO_MACROS }));
  let total: Macros = { ...ZERO_MACROS };

  for (const e of entries) {
    meals[e.meal].push(e);
    const m = entryMacros(e);
    perMeal[e.meal] = addMacros(perMeal[e.meal], m);
    total = addMacros(total, m);
  }
  return { date, meals, perMeal, total };
}

function emptyMealMap<T>(make: () => T): Record<MealType, T> {
  return MEAL_TYPES.reduce(
    (acc, m) => {
      acc[m] = make();
      return acc;
    },
    {} as Record<MealType, T>,
  );
}

/** Percent of a goal consumed, clamped to [0, 999] for ring rendering. */
export function pctOf(consumed: number, goal: number): number {
  if (goal <= 0) return 0;
  return Math.max(0, Math.min(999, Math.round((consumed / goal) * 100)));
}
