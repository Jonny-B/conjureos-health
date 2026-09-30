/**
 * Post-generation plan validator (P2 / safety layer 4). Runs on the AI's plan
 * before it can be saved. Enforces two rails:
 *   1. Kcal floor — a food-tracking plan's daily target can't dip below the
 *      sex-specific floor (1200 F / 1500 M / 1500 default).
 *   2. No exercise prescriptions — Conjure Health tracks food. Workouts belong
 *      to a separate fitness app, so a plan never carries a workout goal.
 *   3. No calorie talk on a logging-only plan — that user must never see a
 *      target or budget, so the summary and goals can't mention calories either.
 * A failing plan is retried once, then replaced by a fallback template.
 */

import type { PlanMode, Sex } from "../../types";
import type { GeneratedPlan } from "./model";
import { kcalFloor, modeTracksFood } from "./model";

/** What a generated plan must be checked against: the plan's mode plus the
 *  sex that sets the calorie floor. */
export interface ValidationContext {
  mode: PlanMode;
  sex?: Sex;
}

/** Outcome of a safety check. `reasons` is empty when `ok`, and otherwise
 *  lists every violation — it feeds the AI re-prompt, so it stays specific. */
export interface ValidationResult {
  ok: boolean;
  reasons: string[];
}

/** Calorie / deficit wording a logging-only plan must not contain. */
const CALORIE_TALK = /\b(k?cal(orie)?s?|deficit)\b/i;

/**
 * Safety-check an AI-generated plan before it can be shown or stored.
 *
 * This is the gate, not a warning: a plan that fails here is regenerated or
 * replaced by the fallback template, never surfaced. Checks the calorie floor
 * for food-tracking modes, that no goal prescribes a workout, and that a
 * logging-only plan's text doesn't mention calories.
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

  // 2. No workout goals, on any plan. The logging-only gate (under-18 /
  // pregnancy / cardiac) relied on this before workouts left the app; now it
  // holds for everyone.
  const workoutGoals = gen.goals.filter((g) => g.kind === "workout").length;
  if (workoutGoals > 0) {
    reasons.push(`the plan has ${workoutGoals} workout goal(s); use only "nutrition" or "habit" goals`);
  }

  // 3. No calorie wording on a plan that doesn't track food (logging_only).
  // buildPlan nulls the target, but the AI's summary and goal text would still
  // be shown verbatim.
  if (!modeTracksFood(ctx.mode)) {
    const texts = [gen.summary, ...gen.goals.flatMap((g) => [g.label, g.detail ?? ""])];
    if (texts.some((t) => CALORIE_TALK.test(t))) {
      reasons.push("a logging-only plan must not mention calories, kcal or deficits");
    }
  }

  return { ok: reasons.length === 0, reasons };
}
