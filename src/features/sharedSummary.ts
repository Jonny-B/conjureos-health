/**
 * The one file ConjureOS may read to answer a question about this app's data.
 *
 * package.json's `dataReadable` lists `nutrition-summary.json` and nothing
 * else. When no action fits a question ("how has my protein been this
 * week?"), ConjureOS's assistant — or another app, through `data.ask` — can
 * read this file and answer from it, after the user allows that reader.
 *
 * Deliberately a SUMMARY written for that purpose, not the store: `store.json`
 * holds everything (symptoms and their notes, weight, sleep, the profile, the
 * plan and its safety answers) and would pass the 20,000-character read cap
 * within weeks. This holds food, water and exercise for the last 14 days and
 * nothing else, and it follows the same rule as the actions: a user with no
 * calorie target gets no target and no "remaining" here either.
 *
 * Rewritten by App after startup and after every change, so it is only as
 * fresh as the last time the app ran — `updatedAt` says when that was.
 *
 * ConjureOS Chat sends what it reads here to an AI, and this app's code does
 * not run when it does, so the file is the one thing that can be withheld
 * (ConjureOS #1230). It exists only while the AI agreement is in force: it is
 * written under one, and removed on an AI withdrawal, on a withdrawal of the
 * consent to collect, and by Reset health data.
 */

import type { MealType, Profile } from "../types";
import { getRepository } from "../data/repository";
import { vfs, writeJson } from "../bridge/vfs";
import { recentSnapshots } from "./dataApi";
import { takeAiTicket, ticketHolds } from "./aiGate";

/** The manifest's `dataReadable` entry. Change both together. */
export const SUMMARY_PATH = "nutrition-summary.json";

/** How many days back the summary covers, today included. */
export const SUMMARY_DAYS = 14;

export interface NutritionSummary {
  about: string;
  updatedAt: string;
  units: Profile["units"];
  tracksCalories: boolean;
  /** Null when the user has no calorie target. */
  dailyTargets: { calories: number; protein: number; carbs: number; fat: number } | null;
  today: {
    date: string;
    eaten: { calories: number; protein: number; carbs: number; fat: number };
    exerciseCalories: number;
    /** Target − eaten + exercise; absent when there's no target. */
    remainingCalories?: number;
    waterMl: number;
    foods: { meal: MealType; name: string; quantity: number; calories: number; protein: number }[];
    moreFoods: number;
  };
  /** Oldest first, today last. */
  days: {
    date: string;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    exerciseCalories: number;
    waterMl: number;
  }[];
}

const ABOUT =
  "Conjure Health's shareable summary: food, water and exercise for the last 14 days. " +
  "Calories in kcal, macros in grams, water in ml. It holds no symptoms, sleep, weight, " +
  "profile or plan details. Rewritten whenever the diary changes, so check updatedAt.";

const NO_TARGET =
  " This user logs food without a calorie target: don't suggest one, and don't describe " +
  "what they ate as over or under anything.";

export async function buildNutritionSummary(now = new Date()): Promise<NutritionSummary> {
  const [snaps, units] = await Promise.all([
    recentSnapshots(SUMMARY_DAYS),
    getRepository()
      .then((r) => r.getProfile())
      .then((p) => (p?.units === "imperial" ? "imperial" : "metric") as Profile["units"])
      .catch(() => "metric" as const),
  ]);
  const today = snaps[snaps.length - 1]!;
  return {
    about: ABOUT + (today.tracksCalories ? "" : NO_TARGET),
    updatedAt: now.toISOString(),
    units,
    tracksCalories: today.tracksCalories,
    dailyTargets: today.targets,
    today: {
      date: today.date,
      eaten: today.consumed,
      exerciseCalories: today.exerciseCalories,
      ...(today.remaining ? { remainingCalories: today.remaining.calories } : {}),
      waterMl: today.waterMl,
      foods: today.foods.map((f) => ({
        meal: f.meal,
        name: f.name,
        quantity: f.quantity,
        calories: f.calories,
        protein: f.protein,
      })),
      moreFoods: today.moreFoods,
    },
    days: snaps.map((s) => ({
      date: s.date,
      calories: s.consumed.calories,
      protein: s.consumed.protein,
      carbs: s.consumed.carbs,
      fat: s.consumed.fat,
      exerciseCalories: s.exerciseCalories,
      waterMl: s.waterMl,
    })),
  };
}

/** Bumped by every removal, so a write begun before one knows not to land. */
let removals = 0;
/** The write last posted, so a removal runs after it rather than racing it. */
let writing: Promise<void> = Promise.resolve();

/**
 * Rewrite the summary, under the AI agreement only. With none in force, any
 * summary an earlier version left is removed instead, so it cannot outlive the
 * agreement it was written under. Best-effort: a failed write never reaches
 * the user.
 */
export async function writeNutritionSummary(): Promise<void> {
  const since = removals;
  try {
    const ticket = await takeAiTicket();
    if (!ticket) return void (await removeNutritionSummary());
    const summary = await buildNutritionSummary();
    // A withdrawal that landed while it was built must not leave a file behind.
    if (!(await ticketHolds(ticket))) return void (await removeNutritionSummary());
    // A withdrawal or a reset that landed while it was built took the summary away.
    if (since !== removals) return;
    writing = writeJson(SUMMARY_PATH, summary);
    await writing;
  } catch {
    /* the next change rewrites it */
  }
}

/**
 * Take the summary away. Removes the file; a host that cannot remove one gets
 * `null` written over it, which holds nothing. Never throws.
 */
export async function removeNutritionSummary(): Promise<void> {
  removals++;
  await writing.catch(() => {});
  try {
    await vfs.rm(SUMMARY_PATH);
    return;
  } catch {
    /* fall back to emptying it */
  }
  try {
    await vfs.write(SUMMARY_PATH, "null");
  } catch {
    /* nothing more to do */
  }
}
