/**
 * How a plan should be DESCRIBED now that workouts live in their own app.
 *
 * Plans from before that move keep their mode and workout goals on disk —
 * nothing was migrated. Rendered verbatim they leak into a nutrition-only app:
 * it once showed "Eat better + train" over a Murph strength session.
 *
 * These helpers are the display-side guard. They change nothing on disk.
 */

import type { Plan, PlanGoal, PlanMode } from "../../types";

const MODE_LABEL: Record<PlanMode, string> = {
  eat_better: "Eat better",
  logging_only: "Logging",
  // Legacy modes read as the food half of themselves: the only half this app
  // can act on.
  both: "Eat better",
  get_fit: "Eat better",
};

/** Mode label as the plan should read. */
export function planModeLabel(plan: Plan): string {
  return MODE_LABEL[plan.mode] ?? plan.mode;
}

/** The plan's goals minus workout goals, which only legacy plans carry. They
 *  stay ON the plan; they are just never shown. */
export function visiblePlanGoals(plan: Plan): PlanGoal[] {
  return plan.goals.filter((g) => g.kind !== "workout");
}
