import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiabilityAck, Plan, Profile, SafetyIntake } from "../../types";
import type { PlanInput } from "./model";

// Control the AI bridge, as generate.test.ts does: the generator always thinks
// AI is present, and each test decides what `complete` returns.
const { complete } = vi.hoisted(() => ({
  complete: vi.fn<(req: { system: string; messages: { content: string }[] }) => Promise<string>>(),
}));
vi.mock("../../bridge/ai", async (orig) => ({
  ...(await orig<typeof import("../../bridge/ai")>()),
  complete,
  isAiAvailable: () => true,
}));

import { createPlan } from "./generate";
import { archivePlan, commitNewPlan, loadPlan, modifyPlanInPlace } from "./planService";
import { intakeInjuries } from "../safety/intakeGate";
import { COACH_AND_WORKOUTS_ENABLED } from "../flags";
import { getRepository, __resetRepository } from "../../data/repository";
import { readJson } from "../../bridge/vfs";

// The VFS falls back to an in-memory store when no host is mounted, but it
// reads `window.__vfs` to find out, so node needs a window to exist.
(globalThis as unknown as { window: object }).window ??= {};

const liability: LiabilityAck = { acknowledged: true, acceptedAt: "2026-10-08T00:00:00Z" };

/** The intake the wizard builds for someone whose chip state somehow still
 *  holds a knee injury (say, a future edit-mode reload). */
const pausedIntake = (): SafetyIntake => ({
  ageBand: "40_59",
  pregnant: false,
  cardiacFlag: false,
  injuries: intakeInjuries(new Set(["knee"])),
  activityLevel: "light",
});

/** A food-only plan input, as the paused wizard sends it. */
const foodOnlyInput = (): PlanInput => ({
  mode: "eat_better",
  goalText: "lose a couple of pounds",
  durationWeeks: 2,
  heightCm: 180,
  weightKg: 85,
  age: 45,
  sex: "male",
  calorieTarget: 2100,
  units: "metric",
  safety: pausedIntake(),
});

const FOOD_CORE = JSON.stringify({
  summary: "A steady plan to lose a couple of pounds.",
  dailyCalorieTarget: 2100,
  goals: [
    { label: "Stay around 2100 kcal", kind: "nutrition" },
    { label: "Protein at every meal", kind: "nutrition" },
    { label: "Lights out by 11", kind: "habit" },
  ],
});

const promptsSent = (): string[] =>
  complete.mock.calls.map(([req]) => req.messages.map((m) => m.content).join("\n"));

// A braced body on purpose: vitest runs a function returned from beforeEach
// as the test's teardown, and mockReset() returns the mock itself.
beforeEach(() => {
  complete.mockReset();
});

describe("plan generation with the injuries question hidden", () => {
  it("is running with workouts paused", () => {
    expect(COACH_AND_WORKOUTS_ENABLED).toBe(false);
  });

  it("records no injuries for a new plan while paused, whatever the chips held", () => {
    expect(intakeInjuries(new Set(["knee", "shoulder"]))).toEqual([]);
    expect(intakeInjuries([])).toEqual([]);
    // With workouts on, the answer passes straight through, as it always did.
    expect(intakeInjuries(new Set(["knee", "shoulder"]), true)).toEqual(["knee", "shoulder"]);
  });

  it("still builds a food-only plan, with no injuries stored and no avoid-list sent", async () => {
    complete.mockResolvedValueOnce(FOOD_CORE);
    const res = await createPlan(foodOnlyInput(), liability);

    expect(res.usedFallback).toBe(false);
    expect(res.plan.goals.map((g) => g.label)).toContain("Lights out by 11");
    expect(res.plan.targets?.dailyCalories).toBe(2100);
    expect(res.plan.program).toBeUndefined();
    expect(res.plan.safety.injuries).toEqual([]);

    const prompts = promptsSent();
    expect(prompts).toHaveLength(1); // food-only: the core call and no program call
    expect(prompts[0]).toContain("Mode: eat_better.");
    expect(prompts[0]).not.toMatch(/HARD SAFETY RULE|NEVER include|squat/i);
  });

  it("still builds the starter plan with no injuries when the AI fails", async () => {
    complete.mockRejectedValue(new Error("the AI was unreachable"));
    const res = await createPlan(foodOnlyInput(), liability);

    expect(res.usedFallback).toBe(true);
    expect(res.plan.goals.length).toBeGreaterThan(0);
    expect(res.plan.goals.some((g) => g.kind === "workout")).toBe(false);
    expect(res.plan.safety.injuries).toEqual([]);
    for (const prompt of promptsSent()) expect(prompt).not.toMatch(/HARD SAFETY RULE/);
  });
});

describe("injuries saved before the pause", () => {
  // An existing user whose workout plan recorded injuries before the question
  // was hidden. They guard that plan's program if workouts return.
  const saved: Plan = {
    id: "saved-plan",
    mode: "both",
    durationWeeks: 2,
    startDate: "2026-07-22",
    endDate: "2026-08-04",
    goalText: "get stronger",
    goals: [{ id: "g1", label: "Protein at every meal", kind: "nutrition" }],
    targets: { dailyCalories: 2100, protein: 150, carbs: 200, fat: 70 },
    safety: { ageBand: "40_59", pregnant: false, cardiacFlag: false, injuries: ["knee", "lower_back"], activityLevel: "moderate" },
    liability: { acknowledged: true, acceptedAt: "2026-07-22T00:00:00Z" },
    createdAt: "2026-07-22T00:00:00Z",
  };
  const profile: Profile = {
    sex: "male",
    age: 45,
    heightCm: 180,
    weightKg: 85,
    activityLevel: "moderate",
    direction: "lose",
    goalWeightKg: 80,
    units: "metric",
  };
  const goals = { calories: 2100, protein: 150, carbs: 200, fat: 70 };

  beforeEach(async () => {
    __resetRepository();
    const repo = await getRepository();
    await repo.savePlan(structuredClone(saved));
  });

  it("survive loading, an in-place edit, and the archive when a new plan replaces them", async () => {
    // Loading the stored plan hands its injuries back untouched.
    expect((await loadPlan())?.safety.injuries).toEqual(["knee", "lower_back"]);

    // An edit that keeps the plan (a new end date) keeps them too, on disk.
    const modified = await modifyPlanInPlace(saved, profile, { endDate: "2026-08-11" }, {
      currentProfile: profile,
      currentGoals: goals,
    });
    expect(modified.plan.safety.injuries).toEqual(["knee", "lower_back"]);
    expect((await loadPlan())?.safety.injuries).toEqual(["knee", "lower_back"]);

    // An edit that forks a new plan, in App's order: archive the outgoing plan
    // whole, then commit the new one the paused wizard built.
    complete.mockResolvedValueOnce(FOOD_CORE);
    const { plan: next } = await createPlan(foodOnlyInput(), liability);
    const outgoing = (await loadPlan())!;
    await archivePlan(outgoing);
    await commitNewPlan(next, { currentProfile: profile, currentGoals: goals });

    const archive = await readJson<Plan[]>("plan-archive.json", []);
    expect(archive[0]?.id).toBe("saved-plan");
    expect(archive[0]?.safety.injuries).toEqual(["knee", "lower_back"]);
    expect(archive[0]?.safety).toEqual(saved.safety);
    // Only the new plan starts with none.
    expect((await loadPlan())?.safety.injuries).toEqual([]);
  });
});
