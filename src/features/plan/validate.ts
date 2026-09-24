/**
 * Post-generation plan validator (P2 / safety layer 4). Runs on the AI's plan
 * before it can be saved. Enforces three rails from the design:
 *   1. Kcal floor — a food-tracking plan's daily target can't dip below the
 *      sex-specific floor (1200 F / 1500 M / 1500 default).
 *   2. Injury exclusion — no workout goal may name a movement excluded by a
 *      declared injury region (reuses the P1 exclusion map).
 *   3. Intensity cap — no absurd number of workout goals.
 * A failing plan is retried once, then replaced by a fallback template.
 */

import type { PlanMode, SafetyIntake, Sex, WorkoutProgram } from "../../types";
import type { GeneratedPlan } from "./model";
import { kcalFloor, modeHasWorkouts, modeTracksFood } from "./model";
import { isExerciseExcluded } from "../safety/injuryExclusions";

const MAX_WORKOUT_GOALS = 6;
const MAX_PROGRAM_WORKOUTS = 6;
const MAX_BENCHMARKS = 4;

/**
 * Program-only safety rails (W4/W5). Returns a list of reasons the program is
 * unsafe/invalid; empty means it passes. Shared by full plan validation and the
 * adaptation engine so an AI-adjusted program clears the exact same gate a
 * generated one does.
 */
export function validateProgram(
  program: WorkoutProgram,
  mode: PlanMode,
  injuries: string[],
): string[] {
  const reasons: string[] = [];
  if (!modeHasWorkouts(mode)) {
    reasons.push(`a ${mode} plan must not carry a workout program`);
  }
  // The workout cap applies PER GROUP: a program retains the current group plus
  // the evaluation/training templates it clones the next group from, so the
  // flat total can legitimately exceed one group's worth. (Local derivation of
  // a workout's group — groups.ts imports this module, so no import cycle.)
  const groupNums = new Map<number, number>();
  for (const pw of program.workouts) {
    const g = pw.group ?? (pw.isBenchmark ? 1 : 2);
    groupNums.set(g, (groupNums.get(g) ?? 0) + 1);
  }
  if (program.workouts.length < 1) {
    reasons.push("program has no workouts");
  }
  for (const [g, count] of groupNums) {
    if (count > MAX_PROGRAM_WORKOUTS) {
      reasons.push(`group ${g} has ${count} workouts (max ${MAX_PROGRAM_WORKOUTS})`);
    }
  }
  for (const pw of program.workouts) {
    for (const e of pw.workout.exercises) {
      if (isExerciseExcluded(`${e.name} ${e.notes ?? ""}`, injuries)) {
        reasons.push(`program exercise "${e.name}" conflicts with a declared injury`);
      }
    }
  }
  // 1–4 benchmarks: a single keystone effort, or a small multi-part assessment
  // (e.g. Murph = pull-ups + push-ups + run). More than 4 is noise, zero leaves
  // the adaptive loop with nothing to track.
  if (program.benchmarks.length < 1 || program.benchmarks.length > MAX_BENCHMARKS) {
    reasons.push(`program must have 1-${MAX_BENCHMARKS} benchmarks (found ${program.benchmarks.length})`);
  }
  for (const b of program.benchmarks) {
    if (!Number.isFinite(b.target) || b.target <= 0) {
      reasons.push(`benchmark "${b.name}" has no valid target`);
    }
    if (isExerciseExcluded(b.name, injuries)) {
      reasons.push(`benchmark "${b.name}" conflicts with a declared injury`);
    }
  }
  return reasons;
}

/** What a generated plan must be checked against: the plan's mode plus the
 *  user's safety intake (age band, flags, injuries). */
export interface ValidationContext {
  mode: PlanMode;
  sex?: Sex;
  safety: SafetyIntake;
}

/** Outcome of a safety check. `reasons` is empty when `ok`, and otherwise
 *  lists every violation — it feeds the AI re-prompt, so it stays specific. */
export interface ValidationResult {
  ok: boolean;
  reasons: string[];
}

/**
 * Safety-check an AI-generated plan before it can be shown or stored.
 *
 * This is the gate, not a warning: a plan that fails here is regenerated or
 * replaced by the fallback template, never surfaced. Checks the calorie floor
 * for food-tracking modes, injury-excluded movements, and per-session volume.
 */
export function validatePlan(gen: GeneratedPlan, ctx: ValidationContext): ValidationResult {
  const reasons: string[] = [];

  // 1. Kcal floor (only for modes that actually track food).
  if (modeTracksFood(ctx.mode)) {
    const floor = kcalFloor(ctx.sex);
    if (gen.dailyCalorieTarget == null) {
      reasons.push("food-tracking plan has no daily calorie target");
    } else if (gen.dailyCalorieTarget < floor) {
      reasons.push(`calorie target ${gen.dailyCalorieTarget} is below the ${floor} kcal floor`);
    }
  }

  // 2. Injury-region exclusion on every workout goal.
  const injuries = ctx.safety.injuries ?? [];
  for (const g of gen.goals) {
    if (g.kind !== "workout") continue;
    const text = `${g.label} ${g.detail ?? ""}`;
    if (isExerciseExcluded(text, injuries)) {
      reasons.push(`workout "${g.label}" conflicts with a declared injury`);
    }
  }

  // 3. Intensity cap.
  const workoutGoals = gen.goals.filter((g) => g.kind === "workout").length;
  if (workoutGoals > MAX_WORKOUT_GOALS) {
    reasons.push(`too many workout goals (${workoutGoals} > ${MAX_WORKOUT_GOALS})`);
  }

  // 4. Mode/gate consistency: a food-only or logging-only plan (e.g. the
  // under-18 / pregnancy / cardiac gate) must never prescribe exercise.
  if (!modeHasWorkouts(ctx.mode) && workoutGoals > 0) {
    reasons.push(`a ${ctx.mode} plan must not prescribe workouts`);
  }

  // 5. Structured workout program (W4), when present.
  if (gen.program) {
    reasons.push(...validateProgram(gen.program, ctx.mode, injuries));
  }

  return { ok: reasons.length === 0, reasons };
}
