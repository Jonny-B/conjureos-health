/**
 * "Reset health data" (settings) — itemized, permanent history clears.
 *
 * Each item wipes ONE history: the food diary, weight history, exercise
 * (entries + daily check-offs), food questions, the retired coach's memory, or
 * archived plans. "Everything" runs the lot. Deliberately NOT touched: the profile,
 * settings/units, and the ACTIVE plan — those aren't histories, and the cog
 * already has "Start a new plan" for replacing the plan itself.
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
  | "coach"
  | "coachChat"
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
  { kind: "coachChat", label: "Food questions", desc: "Everything you've asked about food, and the answers" },
  { kind: "coach", label: "Coach memory", desc: "What the coach remembers about you" },
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
    case "coachChat":
      // The Q&A thread behind the home screen's ask box.
      await rm("coach-chat.json");
      return;
    case "coach":
      // The retired trainer's long-term memory of the user, separate from the
      // thread. Nothing writes it now; this is what removes what's left.
      await rm("coach.json");
      return;
    case "planHistory":
      await rm("plan-archive.json");
      return;
    case "plan":
      // The ACTIVE plan. Nothing here used to clear it — "Past plans" only ever
      // removed the archive — so a user who cleared everything still landed on
      // the Plan tab with their old plan intact.
      await repo.clearPlan().catch(() => {});
      // The retired trainer's memory is a narrative ABOUT the plan, so it goes
      // with it — its own row is hidden, making this one of the ways to reach
      // the stale text. The chat thread is deliberately NOT cleared here: those
      // are the user's own food questions, they have their own row in
      // Settings, and they outlive any one plan.
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

/** Slices no visible feature produces any more: the AI trainer left with the
 *  workouts, which moved to their own app. */
const HIDDEN_KINDS: ReadonlySet<HistoryKind> = new Set<HistoryKind>(["coach"]);
// "coachChat" is deliberately NOT hidden: the home screen's ask box writes to
// it, so the user must be able to clear what they can see.

/**
 * The history rows Settings should actually offer. With no feature producing
 * a hidden slice, offering to clear it on its own just raises questions.
 * "Clear all history" still wipes everything, including the hidden slices, so
 * it keeps meaning all.
 */
export function visibleHistoryItems(): typeof HISTORY_ITEMS {
  return HISTORY_ITEMS.filter((i) => !HIDDEN_KINDS.has(i.kind));
}
