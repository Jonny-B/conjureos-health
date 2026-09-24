/**
 * The day's completed workouts + exercise-calorie total, COMBINING exercise
 * entries (added by hand, or logged by another app through `logWorkout`) with
 * wearable/Apple-Health workouts.
 *
 * Calories from both sources ADD together (a manual workout and an Apple Health
 * workout are distinct efforts). Because we can't delete from Apple Health, the
 * user "removes" a wearable workout by excluding it locally and "edits" it by
 * storing a kcal override — both per-day on `DailyCheckoff` (reversible).
 * Entries are edited/deleted for real.
 *
 * Single source of truth for exercise calories: the diary ring and the cross-app
 * `todayTotals` action both call `exerciseCaloriesForDate`.
 */

import type { WorkoutSession } from "../types";
import { getRepository } from "../data/repository";
import { persist } from "../data/saveFailure";
import { readWorkouts, type WorkoutBurn } from "../bridge/health";
import { shiftDate, todayISO } from "./diary";
import { newId } from "../data/id";

/** Where a completed workout came from: an entry stored by this app (added
 *  here or by another app), or synced from Apple Health / another wearable. */
export type CompletedSource = "app" | "wearable";

/**
 * One completed workout for a given day, normalized across both sources so
 * the UI can list in-app and wearable workouts together. `kcal` is already
 * the effective value — any user override has been applied.
 */
export interface CompletedWorkout {
  /** Stable key: the session id (app) or `${start}-${workoutType}` (wearable). */
  key: string;
  source: CompletedSource;
  /** Short provenance label, e.g. "Added by you" or the wearable's name. */
  sourceLabel: string;
  name: string;
  /** Effective calories (wearable override applied). */
  kcal: number;
  durationSec?: number;
  /** Wearable workout the user removed from this day's total (still listed so it
   *  can be restored). Always false for in-app sessions. */
  excluded: boolean;
}

/** Key a wearable workout stably (HealthKit gives no id). */
export function wearableKey(w: WorkoutBurn): string {
  return `${w.start}-${w.workoutType}`;
}

const WORKOUT_TYPE_LABELS: Record<string, string> = {
  running: "Run",
  walking: "Walk",
  cycling: "Ride",
  hiking: "Hike",
  swimming: "Swim",
  rowing: "Row",
  elliptical: "Elliptical",
  functionalStrengthTraining: "Strength",
  traditionalStrengthTraining: "Strength",
  highIntensityIntervalTraining: "HIIT",
  yoga: "Yoga",
  coreTraining: "Core",
};

function labelForWorkoutType(t: string): string {
  if (WORKOUT_TYPE_LABELS[t]) return WORKOUT_TYPE_LABELS[t];
  // Fallback: split camelCase / capitalize, or a bare "Workout" for opaque codes.
  const spaced = t.replace(/([a-z])([A-Z])/g, "$1 $2");
  const cleaned = spaced.charAt(0).toUpperCase() + spaced.slice(1);
  return /^[a-zA-Z ]+$/.test(cleaned) ? cleaned : "Workout";
}

/** Provenance for a stored entry. "app" stands for a missing `source`: a
 *  session from the workout player this app used to have. */
const SOURCE_LABELS: Record<string, string> = {
  manual: "Added by you",
  logWorkout: "From an app",
  healthkit: "Apple Health",
  health_connect: "Health Connect",
  app: "In-app",
};

function nameForSession(s: WorkoutSession): string {
  if (s.workoutName) return s.workoutName;
  if (s.cardio) return "Cardio";
  return "Workout";
}

async function readWorkoutsForDate(date: string): Promise<WorkoutBurn[]> {
  const start = new Date(`${date}T00:00:00`).getTime();
  const end = new Date(`${date}T23:59:59.999`).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return [];
  return readWorkouts(start, end).catch(() => []);
}

/**
 * Every completed workout for a date — in-app sessions plus wearable workouts —
 * newest first. Excluded wearable items are included (marked `excluded`) so the
 * UI can offer a restore.
 */
export async function listCompletedWorkouts(date: string): Promise<CompletedWorkout[]> {
  const repo = await getRepository();
  const [sessions, wearable, dayLog] = await Promise.all([
    repo.listWorkoutSessions().catch(() => [] as WorkoutSession[]),
    readWorkoutsForDate(date),
    repo.getDayLog(date).catch(() => null),
  ]);
  const excluded = new Set(dayLog?.excludedWearableKeys ?? []);
  const overrides = dayLog?.wearableKcalOverrides ?? {};

  const app = sessions
    .filter((s) => s.date === date)
    .map((s) => ({
      item: {
        key: s.id,
        source: "app" as const,
        sourceLabel: SOURCE_LABELS[s.source ?? "app"] ?? "In-app",
        name: nameForSession(s),
        kcal: s.caloriesBurned ?? 0,
        durationSec: s.durationSec ?? s.cardio?.durationSec ?? undefined,
        excluded: false,
      },
      ts: Date.parse(s.completedAt || "") || 0,
    }));

  const wear = wearable.map((w) => {
    const key = wearableKey(w);
    return {
      item: {
        key,
        source: "wearable" as const,
        sourceLabel: w.source || "Apple Health",
        name: labelForWorkoutType(w.workoutType),
        kcal: overrides[key] ?? w.caloriesBurned,
        durationSec: w.end > w.start ? Math.round((w.end - w.start) / 1000) : undefined,
        excluded: excluded.has(key),
      },
      ts: w.end || w.start || 0,
    };
  });

  return [...app, ...wear].sort((a, b) => b.ts - a.ts).map((x) => x.item);
}

/**
 * Total exercise calories for a date = sum of every NON-excluded completed
 * workout (in-app + wearable). Replaces the old broker-precedence logic.
 */
export async function exerciseCaloriesForDate(date: string): Promise<number> {
  const items = await listCompletedWorkouts(date);
  return items.filter((i) => !i.excluded).reduce((n, i) => n + (i.kcal || 0), 0);
}

// ── Mutations ──────────────────────────────────────────────────────────

async function patchDay(
  date: string,
  fn: (dl: import("../types").DailyCheckoff | null) => Partial<import("../types").DailyCheckoff>,
): Promise<void> {
  const repo = await getRepository();
  const dl = await repo.getDayLog(date).catch(() => null);
  await persist("your check-offs", repo.saveDayLog(date, fn(dl)));
}

/** What the user types to log an exercise by hand. */
export interface ManualExerciseInput {
  name: string;
  /** Minutes, optional. */
  durationMin?: number;
  /** Calories burned, required: this is what reaches the budget. */
  calories: number;
}

/**
 * Validate a hand-entered exercise. Returns the problem to show, or null when
 * it can be saved.
 */
export function manualExerciseProblem(input: Partial<ManualExerciseInput>): string | null {
  if (!input.name || !input.name.trim()) return "Give the exercise a name.";
  const c = input.calories;
  if (c === undefined || !Number.isFinite(c) || c <= 0) return "Enter the calories burned.";
  if (c > 5000) return "That is more than 5,000 calories. Check the number.";
  const d = input.durationMin;
  if (d !== undefined && (!Number.isFinite(d) || d < 0 || d > 1440)) return "Duration must be between 0 and 1,440 minutes.";
  return null;
}

/**
 * Log an exercise by hand for `date`. Unlike the other mutations this does NOT
 * swallow a failed write: a save button that silently does nothing is the bug
 * this exists to avoid, so the caller shows the error.
 */
export async function addManualExercise(date: string, input: ManualExerciseInput): Promise<WorkoutSession> {
  const problem = manualExerciseProblem(input);
  if (problem) throw new Error(problem);
  const session: WorkoutSession = {
    id: newId(),
    date,
    workoutName: input.name.trim().slice(0, 60),
    completedAt: new Date().toISOString(),
    caloriesBurned: Math.round(input.calories),
    ...(input.durationMin ? { durationSec: Math.round(input.durationMin * 60) } : {}),
    source: "manual",
  };
  const repo = await getRepository();
  await repo.saveWorkoutSession(session);
  return session;
}

/** Delete an exercise entry (anything but a wearable workout). */
export async function removeSession(id: string): Promise<void> {
  const repo = await getRepository();
  await persist("that change to your workouts", repo.removeWorkoutSession(id));
}

/** Edit an exercise entry's burned calories (anything but a wearable workout). */
export async function setSessionKcal(id: string, kcal: number): Promise<void> {
  const repo = await getRepository();
  const s = (await repo.listWorkoutSessions().catch(() => [])).find((x) => x.id === id);
  if (!s) return;
  await persist("this workout", repo.saveWorkoutSession({ ...s, caloriesBurned: Math.max(0, Math.round(kcal)) }));
}

/** Remove a wearable workout from this day's total (reversible). */
export async function excludeWearable(date: string, key: string): Promise<void> {
  await patchDay(date, (dl) => ({
    excludedWearableKeys: Array.from(new Set([...(dl?.excludedWearableKeys ?? []), key])),
  }));
}

/** Restore a previously-removed wearable workout. */
export async function restoreWearable(date: string, key: string): Promise<void> {
  await patchDay(date, (dl) => ({
    excludedWearableKeys: (dl?.excludedWearableKeys ?? []).filter((k) => k !== key),
  }));
}

/** Override a wearable workout's burned calories for this day. */
export async function setWearableKcal(date: string, key: string, kcal: number): Promise<void> {
  await patchDay(date, (dl) => ({
    wearableKcalOverrides: { ...(dl?.wearableKcalOverrides ?? {}), [key]: Math.max(0, Math.round(kcal)) },
  }));
}

// ── weekly movement goal ────────────────────────────────────────────────

/** Progress against a plan's weekly exercise-days target. */
export interface WeekExerciseProgress {
  /** Distinct days so far this week with any exercise. */
  days: number;
  /** The plan's target days per week. */
  target: number;
  /** Which of the week's dates had exercise, oldest first (YYYY-MM-DD). */
  activeDates: string[];
  /** The week's dates, Monday first, up to and including today. */
  weekDates: string[];
}

/** Monday-start week containing `date`, truncated at `date` itself — we only
 *  ever count days that have actually happened. */
export function weekToDate(date: string): string[] {
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return [date];
  // getDay(): 0=Sun. Shift so Monday is the first day of the week.
  const back = (d.getDay() + 6) % 7;
  const out: string[] = [];
  for (let i = back; i >= 0; i--) out.push(shiftDate(date, -i));
  return out;
}

/**
 * How many days this week the user has moved, against their plan's target.
 *
 * Counts a day when ANY exercise reached the calorie budget that day — wearable
 * or logged in-app — so it stays consistent with the ring rather than inventing
 * a second definition of "did I exercise".
 */
export async function weekExerciseProgress(
  target: number,
  date = todayISO(),
): Promise<WeekExerciseProgress> {
  const weekDates = weekToDate(date);
  const results = await Promise.all(
    weekDates.map(async (d) => ({ d, kcal: await exerciseCaloriesForDate(d).catch(() => 0) })),
  );
  const activeDates = results.filter((r) => r.kcal > 0).map((r) => r.d);
  return { days: activeDates.length, target, activeDates, weekDates };
}
