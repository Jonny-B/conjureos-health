/**
 * One place that answers "what does something outside the UI need to know
 * about this user's day".
 *
 * Three consumers with the same underlying need and very different trust
 * levels: the in-app coach (sees everything, it's the user's own assistant),
 * the bridge actions other ConjureOS apps call (nutrition only — see
 * bridge/actions), and anything later. Assembling this once means the coach
 * and an external caller can't drift into disagreeing about the same day.
 *
 * Read-only. Nothing here writes, and nothing here decides who may call it —
 * that's the caller's job.
 */

import type { MealType } from "../types";
import { MEAL_LABELS, MEAL_TYPES } from "../types";
import { getRepository } from "../data/repository";
import { buildDayView, shiftDate, todayISO } from "./diary";
import { exerciseCaloriesForDate } from "./exercise";
import { formatSleep, sleepMinutes } from "./sleep";
import { fmtWater, totalMl } from "./water";
import type { Profile } from "../types";

type Units = Profile["units"];

/** How many logged foods a snapshot names before it starts counting instead.
 *  A prompt that lists forty items crowds out the question being asked. */
const MAX_NAMED_FOODS = 25;

/** One food as an assistant needs to see it. */
export interface SnapshotFood {
  name: string;
  meal: MealType;
  quantity: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

/** Everything about one day, assembled from every store. */
export interface DaySnapshot {
  date: string;
  targets: { calories: number; protein: number; carbs: number; fat: number };
  consumed: { calories: number; protein: number; carbs: number; fat: number };
  /** Targets minus consumed, plus exercise back. Negative means over. */
  remaining: { calories: number; protein: number; carbs: number; fat: number };
  exerciseCalories: number;
  foods: SnapshotFood[];
  /** Foods beyond MAX_NAMED_FOODS, counted rather than listed. */
  moreFoods: number;
  waterMl: number;
  sleepMinutes: number;
  symptoms: { label: string; at: string; severity?: number }[];
  weightKg?: number;
}

/**
 * Assemble one day. Every store is read best-effort: a slice that fails reads
 * as absent rather than failing the snapshot, because a coach answer built on
 * four of five stores is far better than an error.
 */
export async function daySnapshot(date = todayISO()): Promise<DaySnapshot> {
  const repo = await getRepository();
  const [entries, goals, exercise, water, sleep, symptoms, weights] = await Promise.all([
    repo.listDiary(date).catch(() => []),
    repo.getGoals(),
    exerciseCaloriesForDate(date).catch(() => 0),
    repo.listWater(date).catch(() => []),
    repo.listSleep(date).catch(() => []),
    repo.listSymptoms(date).catch(() => []),
    repo.listWeights().catch(() => []),
  ]);

  const { total } = buildDayView(date, entries);
  const foods: SnapshotFood[] = entries.slice(0, MAX_NAMED_FOODS).map((e) => ({
    name: e.food.name,
    meal: e.meal,
    quantity: e.quantity,
    calories: Math.round(e.food.perServing.calories * e.quantity),
    protein: Math.round(e.food.perServing.protein * e.quantity),
    carbs: Math.round(e.food.perServing.carbs * e.quantity),
    fat: Math.round(e.food.perServing.fat * e.quantity),
  }));

  const snap: DaySnapshot = {
    date,
    targets: goals,
    consumed: total,
    remaining: {
      // Exercise adds back to the calorie allowance only — it doesn't create
      // more protein to eat, and pretending otherwise would skew advice.
      calories: goals.calories - total.calories + exercise,
      protein: goals.protein - total.protein,
      carbs: goals.carbs - total.carbs,
      fat: goals.fat - total.fat,
    },
    exerciseCalories: exercise,
    foods,
    moreFoods: Math.max(0, entries.length - foods.length),
    waterMl: totalMl(water),
    sleepMinutes: sleep.reduce((sum, n) => sum + sleepMinutes(n), 0),
    symptoms: symptoms.map((s) => ({
      label: s.label,
      at: s.loggedAt,
      ...(s.severity ? { severity: s.severity } : {}),
    })),
  };
  const w = weights.find((x) => x.date === date);
  if (w) snap.weightKg = w.weightKg;
  return snap;
}

/** Snapshots for the last `days` days, newest last. */
export async function recentSnapshots(days = 3, from = todayISO()): Promise<DaySnapshot[]> {
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) dates.push(shiftDate(from, -i));
  return Promise.all(dates.map((d) => daySnapshot(d)));
}

/**
 * Render a day for a prompt.
 *
 * Plain lines rather than JSON: models read this more reliably, and it keeps
 * the token cost of "what have I eaten today" proportional to the answer.
 * Deliberately states what is LEFT as well as what was eaten — the question is
 * nearly always "what should I have now", and making the model subtract is a
 * needless chance for it to get the arithmetic wrong.
 */
export function renderDayForPrompt(s: DaySnapshot, units: Units = "metric"): string {
  const lines: string[] = [`Date: ${s.date}`];
  lines.push(
    `Targets: ${s.targets.calories} cal, ${s.targets.protein}g protein, ` +
      `${s.targets.carbs}g carbs, ${s.targets.fat}g fat.`,
  );
  lines.push(
    `Eaten so far: ${s.consumed.calories} cal, ${s.consumed.protein}g protein, ` +
      `${s.consumed.carbs}g carbs, ${s.consumed.fat}g fat.`,
  );
  if (s.exerciseCalories > 0) lines.push(`Exercise: ${s.exerciseCalories} cal burned, added back.`);
  // Signed rather than worded ("121 left" / "121 over"): a bare negative is
  // unambiguous to read, and gluing a unit onto a phrase produced "121 leftg
  // protein" the first time round.
  lines.push(
    `Remaining, negative means over (${s.remaining.calories} cal, ` +
      `${s.remaining.protein}g protein, ${s.remaining.carbs}g carbs, ${s.remaining.fat}g fat).`,
  );

  if (s.foods.length === 0) {
    lines.push("Nothing logged yet today.");
  } else {
    const byMeal = MEAL_TYPES.map((m) => {
      const inMeal = s.foods.filter((f) => f.meal === m);
      if (inMeal.length === 0) return null;
      const names = inMeal
        .map((f) => `${f.quantity !== 1 ? `${f.quantity}× ` : ""}${f.name} (${f.calories} cal)`)
        .join(", ");
      return `  ${MEAL_LABELS[m]}: ${names}`;
    }).filter(Boolean);
    lines.push("Logged today:");
    lines.push(...(byMeal as string[]));
    if (s.moreFoods > 0) lines.push(`  …and ${s.moreFoods} more items.`);
  }

  if (s.waterMl > 0) lines.push(`Water: ${fmtWater(s.waterMl, units)}.`);
  if (s.sleepMinutes > 0) lines.push(`Slept: ${formatSleep(s.sleepMinutes)}.`);
  if (s.symptoms.length > 0) {
    lines.push(
      `Symptoms: ${s.symptoms
        .map((x) => `${x.label}${x.severity ? ` (${x.severity}/5)` : ""}`)
        .join(", ")}.`,
    );
  }
  if (s.weightKg) lines.push(`Weighed in at ${s.weightKg.toFixed(1)} kg.`);
  return lines.join("\n");
}

/** One line per earlier day — enough to spot a trend without spending the
 *  prompt on days the user didn't ask about. */
export function renderRecentForPrompt(days: DaySnapshot[]): string {
  return days
    .filter((d) => d.consumed.calories > 0 || d.foods.length > 0)
    .map(
      (d) =>
        `${d.date}: ${d.consumed.calories} cal, ${d.consumed.protein}g protein` +
        (d.exerciseCalories ? `, ${d.exerciseCalories} cal exercise` : "") +
        (d.sleepMinutes ? `, slept ${formatSleep(d.sleepMinutes)}` : ""),
    )
    .join("\n");
}
