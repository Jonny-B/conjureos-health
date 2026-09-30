import { describe, expect, it, vi, beforeEach } from "vitest";
import type { LiabilityAck } from "../../types";
import type { PlanInput } from "./model";

// Control the AI bridge; the plan generator always thinks AI is present.
const { complete } = vi.hoisted(() => ({ complete: vi.fn<(req: { system: string }) => Promise<string>>() }));
// Stub only the host-dependent surface; pure helpers (extractJson) stay real.
vi.mock("../../bridge/ai", async (orig) => ({
  ...(await orig<typeof import("../../bridge/ai")>()),
  complete,
  isAiAvailable: () => true,
}));

import { buildPlan, createPlan } from "./generate";
import { fallbackPlan } from "./fallbackTemplates";

const input: PlanInput = {
  mode: "eat_better",
  goalText: "lose a few pounds and feel less winded",
  durationWeeks: 8,
  heightCm: 178,
  weightKg: 80,
  age: 30,
  sex: "male",
  calorieTarget: 1800,
  safety: { ageBand: "18_39", pregnant: false, cardiacFlag: false, activityLevel: "light" },
};
const liability: LiabilityAck = { acknowledged: true, acceptedAt: "2026-07-16T00:00:00Z" };

const GOOD_CORE = JSON.stringify({
  summary: "A steady plan to lose a few pounds.",
  dailyCalorieTarget: 1800,
  goals: [
    { label: "Stay around 1800 kcal", kind: "nutrition" },
    { label: "Protein at every meal", kind: "nutrition" },
    { label: "Water before each meal", kind: "habit" },
  ],
});
const WITH_WORKOUT = JSON.stringify({
  summary: "A plan to lose weight and get moving.",
  dailyCalorieTarget: 1800,
  goals: [
    { label: "Stay around 1800 kcal", kind: "nutrition" },
    { label: "Three short strength sessions", kind: "workout" },
  ],
});

const messageOf = (call: number): string =>
  (complete.mock.calls[call]![0] as unknown as { messages: { content: string }[] }).messages[0]!.content;

beforeEach(() => complete.mockReset());

describe("createPlan", () => {
  it("builds the plan from one AI call when it passes validation", async () => {
    complete.mockResolvedValueOnce(GOOD_CORE);
    const res = await createPlan(input, liability);
    expect(res.usedFallback).toBe(false);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(res.plan.goals.map((g) => g.label)).toContain("Protein at every meal");
    expect(res.plan.targets?.dailyCalories).toBe(1800);
  });

  it("never asks for workouts", async () => {
    complete.mockResolvedValueOnce(GOOD_CORE);
    await createPlan(input, liability);
    const req = complete.mock.calls[0]![0];
    expect(req.system).toMatch(/No exercise or workout goals/);
    expect(req.system).not.toMatch(/"workout"/);
    expect(messageOf(0)).not.toMatch(/Workout days|Equipment|Training experience/);
  });

  it("retries with the reason when the AI prescribes a workout, and uses the retry", async () => {
    complete.mockResolvedValueOnce(WITH_WORKOUT).mockResolvedValueOnce(GOOD_CORE);
    const res = await createPlan(input, liability);
    expect(res.usedFallback).toBe(false);
    expect(res.plan.goals.map((g) => g.kind)).not.toContain("workout");
    expect(messageOf(1)).toMatch(/REJECTED for: .*workout goal/i);
  });

  it("falls back to the food template when both attempts prescribe workouts", async () => {
    complete.mockResolvedValue(WITH_WORKOUT);
    const res = await createPlan(input, liability);
    expect(res.usedFallback).toBe(true);
    expect(res.failureReason).toMatch(/workout goal/i);
    expect(res.plan.goals.map((g) => g.kind)).not.toContain("workout");
  });

  // The safety gate (under-18 / pregnant / heart condition) forces
  // logging_only, for which the wizard supplies no calorie target. The AI's
  // own number used to fill that gap, so a gated user could end up with a
  // budget after all.
  it("never gives a logging-only plan a calorie target, even when the AI offers one", async () => {
    complete.mockResolvedValueOnce(
      JSON.stringify({
        summary: "Log what you eat, no targets.",
        dailyCalorieTarget: 1500,
        goals: [
          { label: "Log every meal", kind: "habit" },
          { label: "Water before each meal", kind: "habit" },
        ],
      }),
    );
    const res = await createPlan(
      {
        mode: "logging_only",
        goalText: "eat more regularly",
        durationWeeks: 4,
        calorieTarget: null,
        safety: { ...input.safety, pregnant: true },
      },
      liability,
    );
    expect(res.usedFallback).toBe(false);
    expect(res.plan.targets?.dailyCalories).toBeNull();
    expect(res.plan.targets?.protein).toBeUndefined();
  });

  it("gives a logging-only fallback plan no calorie target either", async () => {
    complete.mockResolvedValue("not json");
    const res = await createPlan(
      {
        mode: "logging_only",
        goalText: "",
        durationWeeks: 2,
        calorieTarget: null,
        safety: { ...input.safety, ageBand: "under_18" },
      },
      liability,
    );
    expect(res.usedFallback).toBe(true);
    expect(res.plan.targets?.dailyCalories).toBeNull();
  });

  it("falls back with a 'too long' reason when the JSON is truncated on both attempts", async () => {
    const TRUNCATED_CORE = '{"summary":"A plan","goals":[{"label":"Stay around 1800 kcal","kind":"nutri';
    complete.mockResolvedValue(TRUNCATED_CORE);
    const res = await createPlan(input, liability);
    expect(res.usedFallback).toBe(true);
    expect(res.failureReason).toMatch(/too long/i);
  });

  it("reports a truncation that follows complete inner objects as 'too long', not invalid JSON", async () => {
    // Complete goal objects (with their own "}") then a cut: the extracted
    // slice still ends in "}", so the old endsWith("}") check missed it.
    const CUT = '{"summary":"A plan","goals":[{"label":"Protein at every meal","kind":"nutrition"},{"label":"Water","kind":"habit"},{"label":"Veg","ki';
    complete.mockResolvedValue(CUT);
    const res = await createPlan(input, liability);
    expect(res.usedFallback).toBe(true);
    expect(res.failureReason).toMatch(/too long/i);
  });

  it("still reports malformed-but-closed JSON as invalid JSON", async () => {
    complete.mockResolvedValue('{"summary":"A plan","goals":[{"label":"x",}]}');
    const res = await createPlan(input, liability);
    expect(res.failureReason).toMatch(/valid JSON/i);
  });

  it("makes the fallback calorie goal match the plan's real target", async () => {
    complete.mockResolvedValue("not json");
    const res = await createPlan({ ...input, calorieTarget: 2350 }, liability);
    expect(res.usedFallback).toBe(true);
    expect(res.plan.targets?.dailyCalories).toBe(2350);
    const g = res.plan.goals[0]!;
    expect(g.label).toBe("Stay around 2350 kcal");
    expect(g.detail).toBe("2350");
  });

  it("keeps the 1800 default in the fallback goal when there is no computed target", () => {
    expect(fallbackPlan("eat_better", null).goals[0]!.label).toBe("Stay around 1800 kcal");
    expect(fallbackPlan("eat_better").goals[0]!.label).toBe("Stay around 1800 kcal");
  });

  it("tells the model the app's calorie target for food-tracking modes", async () => {
    complete.mockResolvedValueOnce(GOOD_CORE);
    await createPlan({ ...input, calorieTarget: 2350 }, liability);
    expect(messageOf(0)).toMatch(/calorie target to 2350 kcal/);
  });

  describe("logging-only plans never carry calorie wording", () => {
    const logging: PlanInput = {
      mode: "logging_only",
      goalText: "lose weight",
      durationWeeks: 4,
      calorieTarget: null,
      safety: { ...input.safety, ageBand: "under_18" },
    };
    const CALORIE_REPLY = JSON.stringify({
      summary: "Cut 500 kcal a day to reach your goal.",
      dailyCalorieTarget: null,
      goals: [
        { label: "Stay around 1,800 calories a day", kind: "nutrition" },
        { label: "Water", kind: "habit" },
      ],
    });

    it("tells the model not to mention calories", async () => {
      complete.mockResolvedValueOnce(JSON.stringify({ summary: "Log it.", goals: [{ label: "Log meals", kind: "habit" }] }));
      await createPlan(logging, liability);
      expect(messageOf(0)).toMatch(/NO calorie target: do not mention calories/);
    });

    it("rejects calorie text and falls back to the calorie-free template", async () => {
      complete.mockResolvedValue(CALORIE_REPLY);
      const res = await createPlan(logging, liability);
      expect(res.usedFallback).toBe(true);
      expect(res.failureReason).toMatch(/calorie/i);
      expect(messageOf(1)).toMatch(/REJECTED for: .*calorie/i);
      const text = [res.gen.summary, ...res.gen.goals.map((g) => `${g.label} ${g.detail ?? ""}`)].join(" ");
      expect(text).not.toMatch(/cal|deficit/i);
    });

    it("lets a calorie-free reply through unchanged", async () => {
      complete.mockResolvedValueOnce(
        JSON.stringify({ summary: "Log what you eat.", goals: [{ label: "Log every meal", kind: "habit" }] }),
      );
      const res = await createPlan(logging, liability);
      expect(res.usedFallback).toBe(false);
      expect(res.plan.goals[0]!.label).toBe("Log every meal");
    });

    it("does not apply to food-tracking plans", async () => {
      complete.mockResolvedValueOnce(GOOD_CORE);
      expect((await createPlan(input, liability)).usedFallback).toBe(false);
    });
  });

  it("falls back with a 'no goals' reason when the response has an empty goals array", async () => {
    complete.mockResolvedValue(JSON.stringify({ summary: "hi", goals: [] }));
    const res = await createPlan(input, liability);
    expect(res.usedFallback).toBe(true);
    expect(res.failureReason).toMatch(/didn't include any goals/i);
  });

  it("writes imperial numbers + a units directive into the prompt when the user reads imperial", async () => {
    complete.mockResolvedValueOnce(GOOD_CORE);
    await createPlan({ ...input, units: "imperial", goalWeightKg: 72 }, liability);
    const msg = messageOf(0);
    expect(msg).toContain(`5'10"`); // 178 cm
    expect(msg).toContain("176 lb"); // 80 kg
    expect(msg).toContain("159 lb"); // 72 kg goal
    expect(msg).toContain("UNITS: the user reads IMPERIAL");
  });

  it("keeps metric prompts unchanged when the user reads metric", async () => {
    complete.mockResolvedValueOnce(GOOD_CORE);
    await createPlan({ ...input, units: "metric" }, liability);
    const msg = messageOf(0);
    expect(msg).toContain("178 cm");
    expect(msg).toContain("80 kg");
    expect(msg).not.toContain("UNITS:");
  });

  // (Transport-error → fallback with the thrown message is the try/catch path
  // in createPlan; a mock that throws trips vitest's uncaught-error guard, so
  // it isn't re-asserted here.)
});

describe("buildPlan", () => {
  it("never turns a workout goal into a plan goal, even when the plan skipped validation", () => {
    const plan = buildPlan(
      {
        summary: "A plan.",
        dailyCalorieTarget: 1800,
        goals: [
          { label: "Protein at every meal", kind: "nutrition" },
          { label: "Three short strength sessions", kind: "workout" },
          { label: "Water before each meal", kind: "habit" },
        ],
      },
      input,
      liability,
    );
    expect(plan.goals.map((g) => [g.label, g.kind])).toEqual([
      ["Protein at every meal", "nutrition"],
      ["Water before each meal", "habit"],
    ]);
  });
});
