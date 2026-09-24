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

import { createPlan } from "./generate";

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
    expect("program" in res.plan).toBe(false);
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
    expect(res.plan.goals.some((g) => g.kind === "workout")).toBe(false);
    expect(messageOf(1)).toMatch(/REJECTED for: .*workout goal/i);
  });

  it("falls back to the food template when both attempts prescribe workouts", async () => {
    complete.mockResolvedValue(WITH_WORKOUT);
    const res = await createPlan(input, liability);
    expect(res.usedFallback).toBe(true);
    expect(res.failureReason).toMatch(/workout goal/i);
    expect(res.plan.goals.every((g) => g.kind !== "workout")).toBe(true);
  });

  it("falls back with a 'too long' reason when the JSON is truncated on both attempts", async () => {
    const TRUNCATED_CORE = '{"summary":"A plan","goals":[{"label":"Stay around 1800 kcal","kind":"nutri';
    complete.mockResolvedValue(TRUNCATED_CORE);
    const res = await createPlan(input, liability);
    expect(res.usedFallback).toBe(true);
    expect(res.failureReason).toMatch(/too long/i);
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
