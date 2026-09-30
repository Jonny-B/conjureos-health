/**
 * Intermediate shapes for plan generation (P2). The wizard collects a
 * `PlanInput`; the AI (or a fallback template) produces a `GeneratedPlan`; the
 * validator checks it; then it's assembled into the persisted domain `Plan`
 * (src/types.ts). Kept separate from the domain model so generate/validate/
 * fallback can share these without importing each other.
 */

import type { Plan, PlanGoal, PlanMode, SafetyIntake, Sex } from "../../types";

/** Everything the wizard gathers before generating a plan. */
export interface PlanInput {
  mode: PlanMode;
  /** Free-text goal, e.g. "lose a few pounds and feel less winded". */
  goalText: string;
  /** Plan length in weeks (derived from the start/end dates). */
  durationWeeks: number;
  /** Inclusive plan dates (YYYY-MM-DD); start defaults to today. */
  startDate?: string;
  endDate?: string;
  /** Required when calorie tracking (eat_better). */
  heightCm?: number;
  weightKg?: number;
  /** Target weight in kg (lose/gain goals); referenced in the plan. */
  goalWeightKg?: number;
  /** Age in years (for the calorie estimate). */
  age?: number;
  /** Used for the sex-specific kcal floor + calorie estimate. */
  sex?: Sex;
  /** Daily calorie target computed locally from the profile (Mifflin). When
   *  set, it fills/overrides the AI's number so a missing AI target can't force
   *  the fallback template — see createPlan. */
  calorieTarget?: number | null;
  /** The user's display-unit preference. Storage stays metric; this only tells
   *  the generator to write user-facing TEXT (summary, goal labels) in the
   *  units the user actually reads. */
  units?: "metric" | "imperial";
  safety: SafetyIntake;
}

/** One goal as emitted by generation, before it becomes a PlanGoal (+ id). The
 *  model may still call a goal a "workout"; validatePlan rejects a plan that
 *  has one, and buildPlan never turns one into a PlanGoal. */
export interface GeneratedGoal {
  label: string;
  kind: PlanGoal["kind"] | "workout";
  /** Machine hint, e.g. the kcal number for a nutrition goal. */
  detail?: string;
}

/** The raw plan a generator (AI or template) produces, pre-validation. */
export interface GeneratedPlan {
  /** One-line framing shown on the review step. */
  summary: string;
  /** Daily calorie target when the mode tracks food; null otherwise. */
  dailyCalorieTarget: number | null;
  goals: GeneratedGoal[];
}

/** Sex-specific daily calorie floor (kcal). Below this a plan is rejected. */
export function kcalFloor(sex: Sex | undefined): number {
  if (sex === "female") return 1200;
  return 1500; // male + unspecified default
}

/** Whether this mode tracks food (and therefore needs a calorie target). */
export function modeTracksFood(mode: PlanMode): boolean {
  return mode === "eat_better";
}

/**
 * Whether the user logs food against a calorie target at all.
 *
 * False only for a `logging_only` plan: the mode the safety gate forces for
 * someone under 18, pregnant or postpartum, or with a heart condition. Those
 * users log food with no budget, so nothing — the diary, the coach, or another
 * app reading through an action — may show them a target, a "remaining", or an
 * "over". Callers outside the app get this boolean and never the reason:
 * handing out the mode would tell them which of those applies.
 *
 * Everyone else tracks against a target, including someone with no plan yet
 * (the default goals).
 */
export function planTracksCalories(plan: Pick<Plan, "mode"> | null | undefined): boolean {
  return plan?.mode !== "logging_only";
}
