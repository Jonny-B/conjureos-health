/**
 * Plan service — the single API surface for the active plan.
 *
 * Everything that reads or writes a plan goes through here: the wizard (create
 * and edit) and the Plan tab (targets). Screens never call `getRepository()`
 * for plan ops or hand-spread `{ ...plan }` inline anymore — that glue lived in
 * three places and drifted. This module also owns the reconciliation between the three
 * previously-disjoint stores (Plan ↔ Profile ↔ Goals) so a plan actually
 * informs the diary and body stats aren't entered twice.
 *
 * A write that fails is reported through `persist` (logged, and the user is
 * told) and the returned in-memory plan stays authoritative for the session.
 */

import type { AgeBand, Goals, Plan, PlanGoal, PlanTargets, Profile } from "../../types";
import { DEFAULT_PROFILE } from "../../types";
import { getRepository } from "../../data/repository";
import { persist } from "../../data/saveFailure";
import { modeTracksFood } from "./model";
import { recommendGoals } from "../goals";

/** Body stats the wizard collects, reconciled into the Profile on commit. */
export interface WizardBody {
  sex?: Profile["sex"];
  heightCm?: number;
  weightKg?: number;
  goalWeightKg?: number;
  /** Exact age (preferred); ageBand is the coarse fallback. */
  age?: number;
  ageBand?: AgeBand;
  activityLevel?: Profile["activityLevel"];
  direction?: Profile["direction"];
  units?: Profile["units"];
}

/** Coarse age bands → a representative age for Mifflin-based recompute later. */
const AGE_FOR_BAND: Record<AgeBand, number> = {
  under_18: 16,
  "18_39": 28,
  "40_59": 50,
  "60_plus": 68,
};

/** Load the active plan, or null (Supabase throws → treated as no plan). */
export async function loadPlan(): Promise<Plan | null> {
  const repo = await getRepository();
  return repo.getPlan().catch(() => null);
}

/**
 * The effective daily targets the diary should show: the plan's targets when it
 * tracks food, else the separately-stored Goals. Missing macros fall back to
 * the stored ones so a plan that only pinned calories still shows sane macros.
 */
export function targetsToGoals(plan: Plan | null, stored: Goals): Goals {
  const t = plan?.targets;
  if (t && t.dailyCalories != null) {
    return {
      calories: t.dailyCalories,
      protein: t.protein ?? stored.protein,
      carbs: t.carbs ?? stored.carbs,
      fat: t.fat ?? stored.fat,
    };
  }
  return stored;
}

/** Build PlanTargets from an explicit Goals object (settings edits). */
export function goalsToTargets(goals: Goals): PlanTargets {
  return {
    dailyCalories: goals.calories,
    protein: goals.protein,
    carbs: goals.carbs,
    fat: goals.fat,
  };
}

/** What a plan commit produced. All three are already persisted; they're
 *  returned so the caller can update React state without re-reading. */
export interface CommitResult {
  plan: Plan;
  profile: Profile | null;
  goals: Goals;
}

/**
 * Merge the wizard's body stats onto a profile (each field falls back to the
 * base when the wizard didn't collect it). Shared by plan creation and in-place
 * plan edits so both reconcile the profile identically. Storage stays metric —
 * the wizard's `PlanFields` already convert display→kg before we get here.
 */
export function mergeBodyIntoProfile(base: Profile, b: WizardBody): Profile {
  return {
    ...base,
    sex: b.sex ?? base.sex,
    heightCm: b.heightCm ?? base.heightCm,
    weightKg: b.weightKg ?? base.weightKg,
    goalWeightKg: b.goalWeightKg ?? base.goalWeightKg,
    // Prefer the exact age; fall back to the age-band's representative age.
    age: b.age ?? (b.ageBand ? AGE_FOR_BAND[b.ageBand] : base.age),
    activityLevel: b.activityLevel ?? base.activityLevel,
    direction: b.direction ?? base.direction,
    units: b.units ?? base.units,
  };
}

/**
 * Persist a newly-created plan and reconcile the other two stores:
 *  - merge the wizard's body stats into the Profile (so Trends/BMI work and the
 *    user never re-enters height/weight in settings), and
 *  - project the plan's targets into stored Goals (so the diary rings match even
 *    on code paths that read Goals directly).
 */
export async function commitNewPlan(
  plan: Plan,
  ctx: { body?: WizardBody; currentProfile: Profile | null; currentGoals: Goals },
): Promise<CommitResult> {
  const repo = await getRepository();
  await persist("your plan", repo.savePlan(plan));

  let profile = ctx.currentProfile;
  const b = ctx.body;
  if (b && (b.heightCm != null || b.weightKg != null || b.sex != null || b.age != null)) {
    profile = mergeBodyIntoProfile(ctx.currentProfile ?? DEFAULT_PROFILE, b);
  }
  // ALWAYS persist a profile once a plan exists — never leave store.json.profile
  // null. A null profile makes the cog fall back to DEFAULT_PROFILE (and older
  // code could then cement those defaults), which reads as "my stats reverted to
  // default" after a reload. Fall back to the current profile, else DEFAULT.
  const finalProfile: Profile = profile ?? { ...DEFAULT_PROFILE };
  await persist("your profile", repo.saveProfile(finalProfile));
  profile = finalProfile;

  const goals = targetsToGoals(plan, ctx.currentGoals);
  if (plan.targets?.dailyCalories != null) {
    await persist("your daily targets", repo.saveGoals(goals));
  }
  return { plan, profile, goals };
}

/** The plan fields an edit may change. Deliberately excludes `id`, and a
 *  legacy plan's `program`, which patching carries forward untouched. */
export interface PlanPatch {
  mode?: Plan["mode"];
  /** Weekly exercise-days target; 0 clears it (see Plan.weeklyExerciseDays). */
  weeklyExerciseDays?: number;
  goals?: PlanGoal[];
  targets?: PlanTargets;
  startDate?: string;
  endDate?: string;
  durationWeeks?: number;
}

const PLAN_ARCHIVE_PATH = "plan-archive.json";

/**
 * Archive the outgoing plan so history/insight survives a "start a new plan"
 * reset. Keeps the 20 most recent, newest first.
 *
 * Diary, weight, and exercise history live in separate stores and are never
 * touched here. Best-effort: a failed write is swallowed rather than
 * blocking the new plan.
 */
export async function archivePlan(plan: Plan): Promise<void> {
  try {
    const { readJson, writeJson } = await import("../../bridge/vfs");
    const prev = await readJson<Plan[]>(PLAN_ARCHIVE_PATH, []);
    const next = [{ ...plan }, ...prev].slice(0, 20);
    await writeJson(PLAN_ARCHIVE_PATH, next);
  } catch {
    /* archiving is best-effort */
  }
}

/**
 * Patch the plan (mode / plan-goals / targets) from the settings editor, persist
 * it, and re-project targets into stored Goals when they changed.
 */
export async function updatePlan(
  plan: Plan,
  patch: PlanPatch,
  ctx: { currentGoals: Goals },
): Promise<{ plan: Plan; goals: Goals }> {
  const next: Plan = { ...plan, ...patch };
  const repo = await getRepository();
  await persist("your plan", repo.savePlan(next));
  const goals = targetsToGoals(next, ctx.currentGoals);
  if (patch.targets && next.targets?.dailyCalories != null) {
    await persist("your daily targets", repo.saveGoals(goals));
  }
  return { plan: next, goals };
}

// ── Editing an existing plan: new vs modify-in-place ───────────────────

/** The wizard answers that decide whether an edit forks a new plan. */
export interface PlanEditAnswers {
  mode: Plan["mode"];
  goalText: string;
  startDate: string;
}

/** What an edit does: fork a brand-new plan (archiving the old one) or patch
 *  the existing one in place, keeping its id and goals. */
export type PlanEditDecision = "new" | "modify";

const normGoal = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Decide whether editing a plan should regenerate a brand-new plan or modify
 * the existing one in place. Owner-locked trigger: a change to the GOAL TEXT,
 * the MODE, or the START DATE means the plan itself is different → new plan
 * (archive + regenerate). Everything else (end date, calories/macros, goal
 * weight, activity, weekly movement days) is a tune of the same plan → modify
 * in place, keeping the plan id and goals.
 *
 * Legacy plans created before `goalText` was persisted can't be diffed on text,
 * so for those only mode/start-date fork a new plan (a freshly typed goal won't
 * surprise-archive an old plan the user is just tweaking).
 */
export function decidePlanEdit(plan: Plan, next: PlanEditAnswers): PlanEditDecision {
  if (next.mode !== plan.mode) return "new";
  if (next.startDate !== plan.startDate) return "new";
  if (plan.goalText != null && normGoal(next.goalText) !== normGoal(plan.goalText)) return "new";
  return "modify";
}

/**
 * Modify the active plan in place from an edit that didn't change its identity.
 * Keeps the plan id and the plan goals (and a legacy plan's `program`) — but
 * re-merges body stats into the profile and RECOMPUTES the daily calorie
 * target from that updated profile.
 *
 * The recompute is the fix for the old cog behaviour, where editing goal weight
 * only moved `profile.direction` and never touched the calorie target, so the
 * diary ring never changed. Targets only recompute when the mode tracks food; a
 * plan that doesn't (logging-only, or a legacy get-fit one) keeps whatever
 * (null) target it had.
 */
export async function modifyPlanInPlace(
  plan: Plan,
  body: WizardBody,
  patch: { endDate?: string; durationWeeks?: number; weeklyExerciseDays?: number },
  ctx: { currentProfile: Profile | null; currentGoals: Goals },
): Promise<CommitResult> {
  const profile = mergeBodyIntoProfile(ctx.currentProfile ?? DEFAULT_PROFILE, body);
  const repo = await getRepository();
  await persist("your profile", repo.saveProfile(profile));

  const targets: PlanTargets = modeTracksFood(plan.mode)
    ? goalsToTargets(recommendGoals(profile))
    : plan.targets ?? { dailyCalories: null };

  // Patch intentionally omits goals / mode → updatePlan's spread preserves
  // them, along with a legacy plan's program.
  const { plan: next, goals } = await updatePlan(
    plan,
    { targets, ...patch },
    { currentGoals: ctx.currentGoals },
  );
  return { plan: next, profile, goals };
}

/** Drop the active plan. */
export async function clearPlan(): Promise<void> {
  const repo = await getRepository();
  await persist("that change to your plan", repo.clearPlan());
}
