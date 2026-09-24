import { describe, it, expect } from "vitest";
import { planModeLabel, visiblePlanGoals } from "./display";
import { COACH_AND_WORKOUTS_ENABLED } from "../flags";
import type { Plan, PlanGoal } from "../../types";

const goal = (kind: PlanGoal["kind"], label: string): PlanGoal => ({ id: label, label, kind });

// A plan from before the pause: mode "both", with workout goals on it.
const legacy = {
  id: "p1",
  mode: "both",
  durationWeeks: 4,
  startDate: "2026-07-27",
  endDate: "2026-08-24",
  goals: [
    goal("nutrition", "Hit a 300-500 cal daily deficit"),
    goal("workout", "Run 1.5-3 miles 2x per week"),
    goal("workout", "Murph-specific strength session (Day 1)"),
    goal("habit", "Weigh in every morning"),
  ],
  safety: {} as Plan["safety"],
  liability: {} as Plan["liability"],
  createdAt: "2026-07-27T00:00:00Z",
} as Plan;

describe("plan display while workouts are paused", () => {
  it("is only meaningful with the flag off (guards the rest of this suite)", () => {
    expect(COACH_AND_WORKOUTS_ENABLED).toBe(false);
  });

  it("reads a legacy 'both' plan as the half we can still deliver", () => {
    expect(planModeLabel(legacy)).toBe("Eat better");
  });

  it("leaves a food-only plan's label alone", () => {
    expect(planModeLabel({ ...legacy, mode: "eat_better" })).toBe("Eat better");
  });

  it("hides workout goals without touching the plan", () => {
    const shown = visiblePlanGoals(legacy);
    expect(shown.map((g) => g.label)).toEqual([
      "Hit a 300-500 cal daily deficit",
      "Weigh in every morning",
    ]);
    // The plan itself is untouched — flipping the flag back restores them.
    expect(legacy.goals).toHaveLength(4);
  });

  it("keeps nutrition and habit goals", () => {
    expect(visiblePlanGoals(legacy).every((g) => g.kind !== "workout")).toBe(true);
  });
});
