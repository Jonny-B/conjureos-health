/**
 * Pure helpers over recorded workout history — the machinery behind the
 * "last time you did X", progressive-overload suggestions, end-of-workout
 * stats, and PR callouts (W1). All read `WorkoutSession.byExercise`; sessions
 * are assumed newest-first (as `listWorkoutSessions` returns them).
 */

import type { ExerciseActual, SetActual, WorkoutSession } from "../types";

/** The most recent recorded set for an exercise, across prior sessions. */
export function lastSetFor(
  sessions: WorkoutSession[],
  exerciseKey: string,
): SetActual | undefined {
  for (const s of sessions) {
    const ex = s.byExercise?.find((e) => e.exerciseKey === exerciseKey);
    const set = ex?.sets[ex.sets.length - 1];
    if (set) return set;
  }
  return undefined;
}

/** Compact "8 × 20 kg" / "12 reps" / "45s" description of a set's metrics. */
export function formatSet(s: {
  reps?: number | null;
  weightKg?: number | null;
  durationSec?: number | null;
}): string {
  if (s.weightKg != null && s.reps != null) return `${s.reps} × ${s.weightKg} kg`;
  if (s.reps != null) return `${s.reps} reps`;
  if (s.durationSec != null) return `${s.durationSec}s`;
  return "—";
}

/**
 * A gentle progressive-overload nudge for the current set, from the last time
 * the user did this exercise. Weighted → +2.5 kg once reps are hit; bodyweight
 * reps → +1–2 reps. Returns undefined when there's no useful history.
 */
export function overloadSuggestion(
  last: SetActual | undefined,
  prescribed: { reps?: number | null; weightKg?: number | null; durationSec?: number | null },
): string | undefined {
  if (!last) return undefined;
  if (last.weightKg != null && last.reps != null) {
    const targetReps = prescribed.reps ?? last.reps;
    if (last.reps >= targetReps) return `Try ${last.weightKg + 2.5} kg`;
    return `Aim for ${targetReps} reps at ${last.weightKg} kg`;
  }
  if (last.reps != null) return `Beat ${last.reps} — try ${last.reps + 1}`;
  if (last.durationSec != null) return `Hold past ${last.durationSec}s`;
  return undefined;
}

/** Headline totals for one finished session, shown on the summary screen. */
export interface SessionStats {
  totalSets: number;
  totalReps: number;
  totalVolumeKg: number; // Σ reps·weight over weighted sets
  totalWorkSec: number; // Σ per-set elapsed
}

/** Roll a session's structured actuals into headline totals for the summary. */
export function summarize(byExercise: ExerciseActual[]): SessionStats {
  let totalSets = 0;
  let totalReps = 0;
  let totalVolumeKg = 0;
  let totalWorkSec = 0;
  for (const ex of byExercise) {
    for (const set of ex.sets) {
      totalSets += 1;
      if (set.reps != null) totalReps += set.reps;
      if (set.reps != null && set.weightKg != null) totalVolumeKg += set.reps * set.weightKg;
      const started = Date.parse(set.startedAt);
      const done = Date.parse(set.completedAt);
      if (Number.isFinite(started) && Number.isFinite(done) && done > started) {
        totalWorkSec += Math.round((done - started) / 1000);
      }
    }
  }
  return { totalSets, totalReps, totalVolumeKg, totalWorkSec };
}

/** A personal record beaten in the session just finished: the heaviest
 *  weight, most reps, or longest hold yet recorded for that movement. */
export interface PR {
  exerciseKey: string;
  name: string;
  kind: "weight" | "reps" | "hold";
  value: number;
}

const bestInHistory = (
  sessions: WorkoutSession[],
  exerciseKey: string,
  pick: (s: SetActual) => number | undefined,
): number => {
  let best = 0;
  for (const s of sessions) {
    for (const ex of s.byExercise ?? []) {
      if (ex.exerciseKey !== exerciseKey) continue;
      for (const set of ex.sets) {
        const v = pick(set);
        if (v != null && v > best) best = v;
      }
    }
  }
  return best;
};

/**
 * Personal records set in `session` versus everything in `priorSessions`.
 * Heaviest weight, most reps at bodyweight, or longest hold — whichever the
 * exercise is measured by — when this session beat the prior best.
 */
export function detectPRs(
  session: ExerciseActual[],
  priorSessions: WorkoutSession[],
): PR[] {
  const prs: PR[] = [];
  for (const ex of session) {
    const maxWeight = Math.max(0, ...ex.sets.map((s) => s.weightKg ?? 0));
    const maxReps = Math.max(0, ...ex.sets.filter((s) => s.weightKg == null).map((s) => s.reps ?? 0));
    const maxHold = Math.max(0, ...ex.sets.map((s) => s.durationSec ?? 0));
    if (maxWeight > 0 && maxWeight > bestInHistory(priorSessions, ex.exerciseKey, (s) => s.weightKg)) {
      prs.push({ exerciseKey: ex.exerciseKey, name: ex.name, kind: "weight", value: maxWeight });
    } else if (
      maxReps > 0 &&
      maxReps > bestInHistory(priorSessions, ex.exerciseKey, (s) => (s.weightKg == null ? s.reps : undefined))
    ) {
      prs.push({ exerciseKey: ex.exerciseKey, name: ex.name, kind: "reps", value: maxReps });
    } else if (maxHold > 0 && maxHold > bestInHistory(priorSessions, ex.exerciseKey, (s) => s.durationSec)) {
      prs.push({ exerciseKey: ex.exerciseKey, name: ex.name, kind: "hold", value: maxHold });
    }
  }
  return prs;
}
