import { describe, it, expect, beforeEach } from "vitest";
import type { Plan, Profile, WorkoutProgram } from "../../types";
import { getRepository, __resetRepository } from "../../data/repository";
import { commitNewPlan, decidePlanEdit, modifyPlanInPlace } from "./planService";

// A user who filled in the cog (real body stats) BEFORE ever making a plan.
const cogProfile: Profile = {
  sex: "male",
  age: 45,
  heightCm: 180,
  weightKg: 85,
  activityLevel: "very_active",
  direction: "lose",
  goalWeightKg: 78,
  units: "imperial",
};

const plan: Plan = {
  id: "p1",
  mode: "both",
  durationWeeks: 2,
  startDate: "2026-07-22",
  endDate: "2026-08-04",
  goals: [],
  targets: { dailyCalories: 2100, protein: 150, carbs: 200, fat: 70 },
  safety: { ageBand: "40_59", pregnant: false, cardiacFlag: false, injuries: [], activityLevel: "very_active" },
  liability: { acknowledged: true, acceptedAt: "2026-07-22T00:00:00Z" },
  createdAt: "2026-07-22T00:00:00Z",
};

describe("commitNewPlan preserves pre-plan profile data", () => {
  beforeEach(() => {
    __resetRepository();
  });

  it("keeps existing cog body stats when the wizard body carries them (prefill)", async () => {
    // The wizard prefills from the profile, so its body mirrors the cog values.
    const res = await commitNewPlan(plan, {
      body: {
        sex: "male",
        age: 45,
        heightCm: 180,
        weightKg: 85,
        goalWeightKg: 78,
        activityLevel: "very_active",
        direction: "lose",
        units: "imperial",
      },
      currentProfile: cogProfile,
      currentGoals: { calories: 0, protein: 0, carbs: 0, fat: 0 },
    });
    expect(res.profile).toMatchObject({
      sex: "male",
      age: 45,
      heightCm: 180,
      weightKg: 85,
      goalWeightKg: 78,
      activityLevel: "very_active",
      direction: "lose",
      units: "imperial",
    });
    // …and it's actually persisted, not just returned.
    const repo = await getRepository();
    expect((await repo.getProfile())?.sex).toBe("male");
    expect((await repo.getProfile())?.age).toBe(45);
  });

  it("never overwrites a cog field the wizard body leaves undefined", async () => {
    // e.g. a "get fit" (workouts-only) plan collects no sex/height/weight.
    const res = await commitNewPlan(plan, {
      body: { age: 45, activityLevel: "very_active" },
      currentProfile: cogProfile,
      currentGoals: { calories: 0, protein: 0, carbs: 0, fat: 0 },
    });
    // Untouched fields survive from the existing profile.
    expect(res.profile).toMatchObject({
      sex: "male",
      heightCm: 180,
      weightKg: 85,
      goalWeightKg: 78,
      direction: "lose",
      units: "imperial",
    });
  });
});

// ── Editing a plan: the new-vs-modify decision ─────────────────────────
describe("decidePlanEdit", () => {
  const base: Plan = { ...plan, goalText: "lose weight and get better at the half murph" };

  it("forks a new plan when the goal text changes", () => {
    expect(decidePlanEdit(base, { mode: base.mode, goalText: "train for a 5k", startDate: base.startDate })).toBe("new");
  });
  it("forks a new plan when the mode changes", () => {
    expect(decidePlanEdit(base, { mode: "get_fit", goalText: base.goalText!, startDate: base.startDate })).toBe("new");
  });
  it("forks a new plan when the start date moves", () => {
    expect(decidePlanEdit(base, { mode: base.mode, goalText: base.goalText!, startDate: "2026-09-01" })).toBe("new");
  });
  it("modifies in place for anything else (same goal/mode/start)", () => {
    // Goal text differing only by whitespace/case is NOT a change.
    expect(decidePlanEdit(base, { mode: base.mode, goalText: "  Lose weight and get better at the HALF Murph ", startDate: base.startDate })).toBe("modify");
  });
  it("ignores goal text for legacy plans that never stored it", () => {
    const legacy: Plan = { ...plan }; // no goalText
    expect(decidePlanEdit(legacy, { mode: legacy.mode, goalText: "a freshly typed goal", startDate: legacy.startDate })).toBe("modify");
  });
});

// ── Editing a plan: modify in place ────────────────────────────────────
describe("modifyPlanInPlace", () => {
  beforeEach(() => __resetRepository());

  const workoutProgram: WorkoutProgram = {
    workouts: [
      {
        id: "pw1",
        isBenchmark: true,
        group: 1,
        completedAt: "2026-07-23T10:00:00Z",
        workout: { id: "w1", name: "Baseline", exercises: [] },
      },
    ],
    benchmarks: [
      { id: "b1", exerciseKey: "pushup", name: "Push-ups", metric: "reps", baseline: 20, target: 40, unit: "reps", history: [{ value: 20, at: "2026-07-23T10:00:00Z" }] },
    ],
    currentGroup: 1,
    groupsPerCycle: 4,
  };
  const both: Plan = { ...plan, program: workoutProgram };
  const cur: Profile = { sex: "male", age: 45, heightCm: 180, weightKg: 85, activityLevel: "very_active", direction: "lose", goalWeightKg: 78, units: "imperial" };

  it("recomputes the calorie target from an updated goal weight and moves stored Goals", async () => {
    const res = await modifyPlanInPlace(
      both,
      // Lowering the goal weight keeps direction=lose but the recompute still
      // runs; assert it produced a fresh, non-null target that persisted.
      { ...cur, direction: "lose", goalWeightKg: 70 },
      { endDate: both.endDate },
      { currentProfile: cur, currentGoals: { calories: 0, protein: 0, carbs: 0, fat: 0 } },
    );
    expect(res.plan.targets?.dailyCalories).not.toBeNull();
    expect(res.plan.targets?.dailyCalories).toBe(res.goals.calories);
    const repo = await getRepository();
    expect((await repo.getGoals()).calories).toBe(res.goals.calories);
  });

  it("keeps the plan id and the whole program (benchmarks + completedAt)", async () => {
    const res = await modifyPlanInPlace(
      both,
      cur,
      { endDate: "2026-08-11", durationWeeks: 3 },
      { currentProfile: cur, currentGoals: { calories: 0, protein: 0, carbs: 0, fat: 0 } },
    );
    expect(res.plan.id).toBe(both.id);
    expect(res.plan.endDate).toBe("2026-08-11");
    expect(res.plan.program?.workouts[0]?.completedAt).toBe("2026-07-23T10:00:00Z");
    expect(res.plan.program?.benchmarks[0]?.baseline).toBe(20);
    expect(res.plan.program?.currentGroup).toBe(1);
  });

  it("leaves the calorie target null for a workouts-only plan", async () => {
    const getFit: Plan = { ...both, mode: "get_fit", targets: { dailyCalories: null } };
    const res = await modifyPlanInPlace(
      getFit,
      { ...cur, direction: "maintain" },
      {},
      { currentProfile: cur, currentGoals: { calories: 0, protein: 0, carbs: 0, fat: 0 } },
    );
    expect(res.plan.targets?.dailyCalories ?? null).toBeNull();
  });
});
