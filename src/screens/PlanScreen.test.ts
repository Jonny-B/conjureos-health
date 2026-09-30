import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Plan } from "../types";
import { SAVE_FAILED_EVENT } from "../data/saveFailure";
import { planSummaryLine, saveWeighIn } from "./PlanScreen";

const plan = (over: Partial<Plan>): Plan => ({ mode: "both", targets: { dailyCalories: 2000 }, ...over }) as Plan;

describe("planSummaryLine", () => {
  it("shows the calorie target and end date for a food-tracking plan", () => {
    expect(planSummaryLine(plan({ endDate: "2026-10-27" }))).toBe("2,000 cal a day · until 2026-10-27");
    expect(planSummaryLine(plan({ targets: { dailyCalories: null } }))).toBe("Daily targets below");
  });

  it("never shows a calorie target or 'Daily targets below' for logging_only", () => {
    expect(planSummaryLine(plan({ mode: "logging_only" }))).toBe("");
    expect(planSummaryLine(plan({ mode: "logging_only", endDate: "2026-10-27" }))).toBe("until 2026-10-27");
    expect(planSummaryLine(plan({ mode: "logging_only", targets: { dailyCalories: null } }))).toBe("");
  });
});

describe("saveWeighIn", () => {
  let seen: string[];
  beforeEach(() => {
    seen = [];
    const events = new EventTarget();
    events.addEventListener(SAVE_FAILED_EVENT, (e) =>
      seen.push((e as CustomEvent<{ message: string }>).detail.message),
    );
    (globalThis as unknown as { window: unknown }).window = events;
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("resolves true and stays quiet when the write succeeds", async () => {
    expect(await saveWeighIn(async () => {})).toBe(true);
    expect(seen).toEqual([]);
  });

  it("reports a failed write instead of rejecting", async () => {
    const failed = await saveWeighIn(async () => {
      throw new Error("failed to persist");
    });
    expect(failed).toBe(false);
    expect(seen).toEqual(["We couldn't save your weight. Please try again."]);
  });

  it("also catches a synchronous throw", async () => {
    expect(
      await saveWeighIn(() => {
        throw new Error("boom");
      }),
    ).toBe(false);
    expect(seen).toHaveLength(1);
  });
});
