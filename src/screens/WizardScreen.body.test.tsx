import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import type { Plan, WeightEntry } from "../types";
import { DEFAULT_PROFILE } from "../types";
import type { WizardBody } from "../features/plan/planService";
import { button, elements, runtime, textOf } from "../testing/hooks";

vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  const { runtime: rt } = await import("../testing/hooks");
  const api = { ...actual, ...rt.hooks };
  return { ...api, default: api };
});

/** The plan the review step shows: whatever generation returned. */
const built: Plan = {
  id: "p",
  mode: "logging_only",
  durationWeeks: 2,
  startDate: "2026-10-08",
  endDate: "2026-10-21",
  goals: [],
  targets: { dailyCalories: null },
  safety: { ageBand: "under_18", pregnant: false, cardiacFlag: false, injuries: [], activityLevel: "moderate" },
  liability: { acknowledged: false, acceptedAt: "" },
  createdAt: "2026-10-08T00:00:00Z",
};

vi.mock("../features/plan/generate", () => ({
  createPlan: async () => ({ plan: built, gen: { summary: "Log what you eat.", goals: [] }, usedFallback: false }),
  regenerateProgram: async () => ({}),
}));
vi.mock("../data/repository", () => ({
  getRepository: async () => ({ listWeights: async (): Promise<WeightEntry[]> => [] }),
}));

const press = (tree: ReactNode, name: string) => (button(tree, name).props.onClick as () => unknown)();

/** The element a screen renders for `type`, whose props a test can call. */
function child(tree: ReactNode, type: unknown) {
  for (const el of elements(tree)) if (el.type === type) return el;
  throw new Error("no such child");
}

beforeEach(() => {
  runtime.reset();
});

/**
 * The About you step asks sex on every plan, a logging-only one included, and
 * the coach states the stored answer as fact and keys its under-eating floor
 * on it. A first plan merges onto DEFAULT_PROFILE, so a sex left out of the
 * body is stored as that default's "female", whatever the user picked.
 */
describe("a plan the safety intake makes logging-only", () => {
  it("stores the sex the user picked, and the coach is told it", async () => {
    const { WizardScreen } = await import("./WizardScreen");
    const { DisclaimerCard } = await import("../components/DisclaimerCard");
    const { AgeField, SexField } = await import("../components/PlanFields");
    const { mergeBodyIntoProfile } = await import("../features/plan/planService");
    const { renderAskContext } = await import("../features/coach/askSummary");
    const { shiftDate } = await import("../features/diary");

    let committed: WizardBody | null = null;
    const props = { onComplete: (_plan: Plan, body: WizardBody) => void (committed = body), profile: null };
    const render = () => runtime.render(WizardScreen, props);

    let tree = await render();
    (child(tree, DisclaimerCard).props.onAccept as () => void)();
    tree = await render();
    press(tree, "Continue");
    tree = await render();
    (child(tree, AgeField).props.onChange as (n: number) => void)(15);
    (child(tree, SexField).props.onChange as (s: string) => void)("male");
    tree = await render();
    expect(textOf(tree)).toContain("Based on your answers we'll keep this to food & habit tracking.");
    press(tree, "Continue");
    tree = await render();
    press(tree, "Build my plan");
    tree = await render();
    press(tree, "Start plan");

    expect(committed).not.toBeNull();
    const body = committed! as WizardBody;
    expect(body.age).toBe(15);
    expect(body.sex).toBe("male");

    // The first plan, so it merges onto the default profile, as commitNewPlan does.
    const profile = mergeBodyIntoProfile(DEFAULT_PROFILE, body);
    const today = "2026-10-08";
    const days = Array.from({ length: 8 }, (_, i) => {
      const date = shiftDate(today, -(7 - i));
      return {
        date,
        targets: { calories: 0, protein: 0, carbs: 0, fat: 0 },
        consumed: { calories: 1300, protein: 60, carbs: 160, fat: 40 },
        remaining: { calories: 0, protein: 0, carbs: 0, fat: 0 },
        exerciseCalories: 0,
        foods: [{ name: "Toast", meal: "breakfast" as const, quantity: 1, calories: 1300, protein: 0, carbs: 0, fat: 0 }],
        moreFoods: 0,
        waterMl: 0,
        sleepMinutes: 0,
        symptoms: [],
      };
    });
    const ctx = renderAskContext({
      today,
      units: "metric",
      profile,
      weights: [],
      plan: { ...built, liability: { acknowledged: true, acceptedAt: "2026-10-08T00:00:00Z" } },
      days,
      sleep: [],
    });
    expect(ctx).toContain("Sex: male.");
    expect(ctx).toContain("Logged days under 1500 cal: 7.");
    // Never asked on a logging-only plan, so the default's number is not theirs.
    expect(ctx).not.toContain("Height:");
  });
});
