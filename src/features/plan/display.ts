/**
 * How a plan should be DESCRIBED while parts of the app are paused.
 *
 * Pausing the coach and workouts (see features/flags) deliberately kept every
 * existing plan intact so flipping the flag back restores them — nothing was
 * migrated. The cost is that a plan created before the pause still carries its
 * mode and its workout goals, and those leak into anything that renders a plan
 * verbatim: a nutrition-only build was showing "Eat better + train" over a
 * Murph strength session.
 *
 * These helpers are the display-side guard. They change nothing on disk.
 */

import type { Plan, PlanGoal } from "../../types";
import { COACH_AND_WORKOUTS_ENABLED } from "../flags";

const MODE_LABEL: Record<string, string> = {
  both: "Eat better + train",
  eat_better: "Eat better",
  get_fit: "Get fit",
  logging_only: "Logging",
};

/** Mode label as the plan should read right now. A legacy `both` plan reads as
 *  the food half of itself while training is paused, since that is the only
 *  half the app can still act on. */
export function planModeLabel(plan: Plan): string {
  if (!COACH_AND_WORKOUTS_ENABLED && (plan.mode === "both" || plan.mode === "get_fit")) {
    return MODE_LABEL.eat_better!;
  }
  return MODE_LABEL[plan.mode] ?? plan.mode;
}

/** The plan's goals minus anything the app can't currently deliver. Workout
 *  goals stay ON the plan — they are just not shown while workouts are off. */
export function visiblePlanGoals(plan: Plan): PlanGoal[] {
  if (COACH_AND_WORKOUTS_ENABLED) return plan.goals;
  return plan.goals.filter((g) => g.kind !== "workout");
}
