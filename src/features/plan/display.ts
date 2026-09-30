/** Display text for a plan. */

import type { Plan, PlanMode } from "../../types";

const MODE_LABEL: Record<PlanMode, string> = {
  eat_better: "Eat better",
  logging_only: "Logging",
};

/** Mode label as the plan should read. */
export function planModeLabel(plan: Plan): string {
  return MODE_LABEL[plan.mode] ?? plan.mode;
}
