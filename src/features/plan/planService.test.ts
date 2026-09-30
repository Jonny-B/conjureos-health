import { describe, it, expect, beforeEach } from "vitest";
import type { Plan, Profile } from "../../types";
import { getRepository, __resetRepository } from "../../data/repository";
import { commitNewPlan, decidePlanEdit, mergeBodyIntoProfile, modifyPlanInPlace } from "./planService";
import {
  hasAiJournalConsent,
  recordAiJournalConsent,
  withdrawAiJournalConsent,
} from "../aiConsent";
import { seedActivityLevel, wizardInputsValid } from "./wizardRules";
import { vfs } from "../../bridge/vfs";

// With no `window`, vfs is an in-memory store that outlives each test's repository.
beforeEach(async () => {
  await vfs.rm("store.json");
});

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
  mode: "eat_better",
  durationWeeks: 2,
  startDate: "2026-07-22",
  endDate: "2026-08-04",
  goals: [],
  targets: { dailyCalories: 2100, protein: 150, carbs: 200, fat: 70 },
  safety: { ageBand: "40_59", pregnant: false, cardiacFlag: false, activityLevel: "very_active" },
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
    // e.g. a logging-only plan collects no sex/height/weight.
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
  const base: Plan = { ...plan, goalText: "lose weight and eat more protein" };

  it("forks a new plan when the goal text changes", () => {
    expect(decidePlanEdit(base, { mode: base.mode, goalText: "cut back on sugar", startDate: base.startDate })).toBe("new");
  });
  it("forks a new plan when the mode changes", () => {
    expect(decidePlanEdit(base, { mode: "logging_only", goalText: base.goalText!, startDate: base.startDate })).toBe("new");
  });
  it("forks a new plan when the start date moves", () => {
    expect(decidePlanEdit(base, { mode: base.mode, goalText: base.goalText!, startDate: "2026-09-01" })).toBe("new");
  });
  it("modifies in place for anything else (same goal/mode/start)", () => {
    // Goal text differing only by whitespace/case is NOT a change.
    expect(decidePlanEdit(base, { mode: base.mode, goalText: "  Lose weight and eat MORE protein ", startDate: base.startDate })).toBe("modify");
  });
  it("forks a new plan when a goal is typed on a plan that has none stored", () => {
    const noGoal: Plan = { ...plan }; // created with the box blank (or pre-goalText)
    expect(decidePlanEdit(noGoal, { mode: noGoal.mode, goalText: "lose 10 lb for the wedding", startDate: noGoal.startDate })).toBe("new");
  });
  it("still modifies in place when the goal stays blank on a plan with none stored", () => {
    const noGoal: Plan = { ...plan };
    expect(decidePlanEdit(noGoal, { mode: noGoal.mode, goalText: "  ", startDate: noGoal.startDate })).toBe("modify");
  });
});

// ── Clearing the goal weight ───────────────────────────────────────────
describe("mergeBodyIntoProfile goal weight", () => {
  const base: Profile = { ...cogProfile, goalWeightKg: 70 };
  it("clears the stored goal weight when the body carries the key as undefined", () => {
    expect(mergeBodyIntoProfile(base, { weightKg: 80, goalWeightKg: undefined, direction: "maintain" }).goalWeightKg).toBeUndefined();
  });
  it("keeps the stored goal weight when the body did not collect it", () => {
    expect(mergeBodyIntoProfile(base, { weightKg: 80 }).goalWeightKg).toBe(70);
  });
  it("replaces it when the body carries a value", () => {
    expect(mergeBodyIntoProfile(base, { goalWeightKg: 65 }).goalWeightKg).toBe(65);
  });
});

// ── Wizard form rules ──────────────────────────────────────────────────
describe("wizardInputsValid", () => {
  it("requires an age in every mode", () => {
    expect(wizardInputsValid(true, { age: undefined, heightCm: 180, weightKg: 80 })).toBe(false);
    expect(wizardInputsValid(false, { age: undefined })).toBe(false);
  });
  it("requires height and weight only when the plan tracks food", () => {
    expect(wizardInputsValid(true, { age: 45, heightCm: 180 })).toBe(false);
    expect(wizardInputsValid(true, { age: 45, heightCm: 180, weightKg: 80 })).toBe(true);
    expect(wizardInputsValid(false, { age: 45 })).toBe(true);
  });
});

describe("seedActivityLevel", () => {
  it("shows a legacy very_active profile as the top chip", () => {
    expect(seedActivityLevel("very_active")).toBe("active");
  });
  it("passes the offered levels through and defaults to moderate", () => {
    expect(seedActivityLevel("light")).toBe("light");
    expect(seedActivityLevel(undefined)).toBe("moderate");
  });
});

// ── Editing a plan: modify in place ────────────────────────────────────
describe("modifyPlanInPlace", () => {
  beforeEach(() => __resetRepository());

  const cur: Profile = { sex: "male", age: 45, heightCm: 180, weightKg: 85, activityLevel: "very_active", direction: "lose", goalWeightKg: 78, units: "imperial" };

  it("recomputes the calorie target from an updated goal weight and moves stored Goals", async () => {
    const res = await modifyPlanInPlace(
      plan,
      // Lowering the goal weight keeps direction=lose but the recompute still
      // runs; assert it produced a fresh, non-null target that persisted.
      { ...cur, direction: "lose", goalWeightKg: 70 },
      { endDate: plan.endDate },
      { currentProfile: cur, currentGoals: { calories: 0, protein: 0, carbs: 0, fat: 0 } },
    );
    expect(res.plan.targets?.dailyCalories).not.toBeNull();
    expect(res.plan.targets?.dailyCalories).toBe(res.goals.calories);
    const repo = await getRepository();
    expect((await repo.getGoals()).calories).toBe(res.goals.calories);
  });

  it("keeps the plan id and its goals", async () => {
    const withGoals: Plan = { ...plan, goals: [{ id: "g1", label: "Protein at every meal", kind: "nutrition" }] };
    const res = await modifyPlanInPlace(
      withGoals,
      cur,
      { endDate: "2026-08-11", durationWeeks: 3 },
      { currentProfile: cur, currentGoals: { calories: 0, protein: 0, carbs: 0, fat: 0 } },
    );
    expect(res.plan.id).toBe(withGoals.id);
    expect(res.plan.endDate).toBe("2026-08-11");
    expect(res.plan.goals).toEqual(withGoals.goals);
    const repo = await getRepository();
    expect((await repo.getPlan())?.goals).toEqual(withGoals.goals);
  });

  it("leaves the calorie target null for a logging-only plan", async () => {
    const loggingOnly: Plan = { ...plan, mode: "logging_only", targets: { dailyCalories: null } };
    const res = await modifyPlanInPlace(
      loggingOnly,
      { ...cur, direction: "maintain" },
      {},
      { currentProfile: cur, currentGoals: { calories: 0, protein: 0, carbs: 0, fat: 0 } },
    );
    expect(res.plan.targets?.dailyCalories ?? null).toBeNull();
  });
});

// ── Writes build on the STORED profile, never App's cached copy ────────
describe("plan writes keep AI consent changes made behind App's back", () => {
  beforeEach(() => __resetRepository());
  const goals = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  const seed = async () => {
    const repo = await getRepository();
    await repo.saveProfile({ ...cogProfile });
    await recordAiJournalConsent(true);
    // What App holds in state after load.
    return (await repo.getProfile())!;
  };

  it("modifyPlanInPlace does not reinstate a withdrawn consent", async () => {
    const cached = await seed();
    await withdrawAiJournalConsent();
    await modifyPlanInPlace(plan, { units: "metric" }, {}, { currentProfile: cached, currentGoals: goals });
    expect(await hasAiJournalConsent()).toBe(false);
  });

  it("commitNewPlan does not reinstate a withdrawn consent", async () => {
    const cached = await seed();
    await withdrawAiJournalConsent();
    await commitNewPlan(plan, { body: { age: 45, heightCm: 180 }, currentProfile: cached, currentGoals: goals });
    expect(await hasAiJournalConsent()).toBe(false);
  });

  it("commitNewPlan without a body does not reinstate a withdrawn consent", async () => {
    const cached = await seed();
    await withdrawAiJournalConsent();
    await commitNewPlan(plan, { currentProfile: cached, currentGoals: goals });
    expect(await hasAiJournalConsent()).toBe(false);
  });

  it("modifyPlanInPlace and commitNewPlan keep a consent granted after App loaded", async () => {
    const repo = await getRepository();
    await repo.saveProfile({ ...cogProfile });
    const cached = (await repo.getProfile())!; // no consent yet
    await recordAiJournalConsent(false);
    const res = await modifyPlanInPlace(plan, { units: "metric" }, {}, { currentProfile: cached, currentGoals: goals });
    expect(await hasAiJournalConsent()).toBe(true);
    // The returned profile (App's next state) carries it too.
    expect(res.profile?.aiJournalConsent).toBeDefined();
    const res2 = await commitNewPlan(plan, { body: { age: 45, heightCm: 180 }, currentProfile: cached, currentGoals: goals });
    expect(await hasAiJournalConsent()).toBe(true);
    expect(res2.profile?.aiJournalConsent).toBeDefined();
  });

  it("falls back to App's profile when nothing is stored", async () => {
    const res = await modifyPlanInPlace(plan, { weightKg: 80 }, {}, { currentProfile: cogProfile, currentGoals: goals });
    expect(res.profile).toMatchObject({ sex: "male", heightCm: 180, weightKg: 80 });
  });
});

// ── Units chosen before any profile exists ─────────────────────────────
describe("commitNewPlan keeps the wizard's units when no stats are merged", () => {
  beforeEach(() => __resetRepository());
  it("stores imperial from a units-only body with no current profile", async () => {
    const res = await commitNewPlan(plan, {
      body: { units: "imperial" },
      currentProfile: null,
      currentGoals: { calories: 0, protein: 0, carbs: 0, fat: 0 },
    });
    expect(res.profile?.units).toBe("imperial");
    const repo = await getRepository();
    expect((await repo.getProfile())?.units).toBe("imperial");
  });
});
