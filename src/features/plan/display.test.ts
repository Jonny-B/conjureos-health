import { describe, it, expect } from "vitest";
import { planModeLabel } from "./display";
import type { Plan } from "../../types";

const plan = (mode: Plan["mode"]) => ({ id: "p1", mode }) as Plan;

describe("planModeLabel", () => {
  it("labels each mode", () => {
    expect(planModeLabel(plan("eat_better"))).toBe("Eat better");
    expect(planModeLabel(plan("logging_only"))).toBe("Logging");
  });
});
