/**
 * "Reset health data" (settings) — itemized, permanent history clears.
 *
 * Each item wipes ONE history: the food diary, weight history, exercise
 * (entries + daily check-offs), sleep, water, symptoms, the Ask Health
 * conversation, the current plan, or archived plans. "Clear all history" runs
 * the lot. Deliberately NOT touched: the profile and settings/units, which
 * aren't histories.
 *
 * Nothing here runs on its own: a user's stored data is only ever deleted by
 * the user, from these rows. That includes the files the removed trainer left:
 * `coach.json`, its memory, which the "Current plan" row removes, and
 * `coach-chat.json`, which the "Ask Health" row removes. Nothing reads
 * either, and "Clear all history" removes both.
 *
 * Every clear is best-effort per store (a failure in one store never blocks
 * the others) and idempotent — clearing an already-empty history is a no-op.
 */

import { getRepository } from "../data/repository";
import { vfs } from "../bridge/vfs";

/** One independently clearable slice of the user's history. */
export type HistoryKind =
  | "diary"
  | "weights"
  | "workouts"
  | "askHealth"
  | "sleep"
  | "water"
  | "symptoms"
  | "planHistory"
  | "plan";

/** The clearable history slices with their user-facing copy, in the order
 *  Settings lists them. Drives the reset UI so labels live beside the logic. */
export const HISTORY_ITEMS: { kind: HistoryKind; label: string; desc: string }[] = [
  { kind: "diary", label: "Food diary", desc: "Every logged meal and snack" },
  { kind: "weights", label: "Weight history", desc: "All weigh-ins and the trend graph" },
  { kind: "workouts", label: "Exercise", desc: "Exercise you've added or corrected" },
  { kind: "sleep", label: "Sleep", desc: "Every night you've recorded" },
  { kind: "water", label: "Water", desc: "Every drink you've logged" },
  { kind: "symptoms", label: "Symptoms", desc: "Everything under \u201cHow you felt\u201d" },
  { kind: "askHealth", label: "Ask Health", desc: "Your questions and the answers, including Find patterns" },
  {
    kind: "plan",
    label: "Current plan",
    desc: "Your goal, dates, daily targets and plan notes. Weigh-ins and diary are kept.",
  },
  { kind: "planHistory", label: "Past plans", desc: "Only the archive of previous plans" },
];

const rm = (path: string) => vfs.rm(path).catch(() => {});

/**
 * Permanently delete one slice of the user's history. DESTRUCTIVE and not
 * undoable — callers must confirm first.
 *
 * Never rejects: each underlying delete is best-effort, so one unavailable
 * store can't leave the rest of a "clear all" half-applied.
 */
export async function clearHistory(kind: HistoryKind): Promise<void> {
  const repo = await getRepository();
  switch (kind) {
    case "diary":
      await repo.clearDiary().catch(() => {});
      return;
    case "weights":
      await repo.clearWeights().catch(() => {});
      return;
    case "workouts":
      await repo.clearWorkoutHistory().catch(() => {});
      return;
    case "sleep":
      await repo.clearSleep().catch(() => {});
      return;
    case "water":
      await repo.clearWater().catch(() => {});
      return;
    case "symptoms":
      await repo.clearSymptoms().catch(() => {});
      return;
    case "askHealth":
      // The Ask Health conversation, from the home card and Find patterns,
      // and `coach-chat.json`, where older versions kept the questions asked
      // in-app. Ask Health never reads that file, since it can also hold the
      // removed trainer's replies (see features/ask/ask.ts), and this row is
      // how a user wipes it.
      await rm("ask-health.json");
      await rm("coach-chat.json");
      return;
    case "planHistory":
      await rm("plan-archive.json");
      return;
    case "plan":
      // The ACTIVE plan. Nothing here used to clear it — "Past plans" only ever
      // removed the archive — so a user who cleared everything still landed on
      // the Plan tab with their old plan intact.
      await repo.clearPlan().catch(() => {});
      // `coach.json` is the memory the removed trainer kept: a narrative
      // ABOUT the plan, so it goes with the plan. Nothing reads it and it has
      // no row of its own, so this is how a user wipes it. The Ask Health
      // conversation is deliberately NOT cleared here: those are the user's
      // own questions, they have their own row, and they outlive any one plan.
      await rm("coach.json");
      return;
  }
}

/** Clear every history above (plus the food-lookup cache, which is derived
 *  data and pointless to keep once the diary is gone). */
export async function clearAllHistories(): Promise<void> {
  for (const item of HISTORY_ITEMS) {
    await clearHistory(item.kind);
  }
  await rm("food-cache.json");
}

/**
 * The history rows Settings should actually offer: every one. Each row is a
 * slice a visible feature produces, and the files no feature reads have no
 * row of their own (they go with "Current plan" and "Ask Health", above), so
 * nothing is hidden. "Clear all history" walks the same list, so it keeps
 * meaning all.
 */
export function visibleHistoryItems(): typeof HISTORY_ITEMS {
  return HISTORY_ITEMS;
}
