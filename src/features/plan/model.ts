/**
 * Intermediate shapes for plan generation (P2). The wizard collects a
 * `PlanInput`; the AI (or a fallback template) produces a `GeneratedPlan`; the
 * validator checks it; then it's assembled into the persisted domain `Plan`
 * (src/types.ts). Kept separate from the domain model so generate/validate/
 * fallback can share these without importing each other.
 */

import type { PlanGoal, PlanMode, SafetyIntake, Sex } from "../../types";

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

/** One goal as emitted by generation, before it becomes a PlanGoal (+ id). */
export interface GeneratedGoal {
  label: string;
  kind: PlanGoal["kind"];
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

/** Whether this mode tracks food (and therefore needs a calorie target). A
 *  stored legacy "both" plan still does; a legacy "get_fit" one never did. */
export function modeTracksFood(mode: PlanMode): boolean {
  return mode === "eat_better" || mode === "both";
}
