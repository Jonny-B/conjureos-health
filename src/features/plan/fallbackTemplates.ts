/**
 * Safety layer 4 (last resort) — three hardcoded, known-safe plan templates,
 * one per real mode. Used when AI generation fails validation twice (or the
 * estimator is unreachable). Every template is intensity-capped, above the
 * kcal floor, and equipment-free, so it can never trip the validator. The
 * logging-only mode doesn't need a template — it's just the diary — but we
 * return a minimal food-logging plan for it so the shape is always valid.
 */

import type { Exercise, ExerciseSet, ExperienceLevel, PlanMode, WorkoutProgram } from "../../types";
import type { GeneratedPlan, PlanInput } from "./model";
import { modeHasWorkouts, modeTracksFood } from "./model";
import { isExerciseExcluded } from "../safety/injuryExclusions";
import { newId } from "../../data/id";
import { normalizeExerciseKey } from "../explainers/normalizeKey";

/** A generous, always-safe daily calorie target (well above every floor). */
const SAFE_KCAL = 1800;

const TEMPLATES: Record<PlanMode, GeneratedPlan> = {
  eat_better: {
    summary: "A gentle 'eat better' plan: steady calories, more protein and produce, no crash dieting.",
    dailyCalorieTarget: SAFE_KCAL,
    goals: [
      { label: `Stay around ${SAFE_KCAL} kcal`, kind: "nutrition", detail: String(SAFE_KCAL) },
      { label: "Protein at every meal", kind: "nutrition" },
      { label: "Two servings of vegetables", kind: "habit" },
      { label: "A glass of water before each meal", kind: "habit" },
    ],
  },
  get_fit: {
    summary: "A beginner-friendly 'get fit' plan: short bodyweight sessions and daily movement, no equipment.",
    dailyCalorieTarget: null,
    goals: [
      { label: "15-minute bodyweight session", kind: "workout", detail: "marching, wall push-ups, sit-to-stand, gentle stretching" },
      { label: "A brisk 20-minute walk", kind: "workout", detail: "walking" },
      { label: "Stand and stretch every hour", kind: "habit" },
    ],
  },
  both: {
    summary: "A balanced 'both' plan: sensible calories plus short, equipment-free movement.",
    dailyCalorieTarget: SAFE_KCAL,
    goals: [
      { label: `Stay around ${SAFE_KCAL} kcal`, kind: "nutrition", detail: String(SAFE_KCAL) },
      { label: "Protein at every meal", kind: "nutrition" },
      { label: "15-minute bodyweight session", kind: "workout", detail: "marching, wall push-ups, sit-to-stand, gentle stretching" },
      { label: "A brisk 20-minute walk", kind: "workout", detail: "walking" },
    ],
  },
  logging_only: {
    summary: "Just tracking for now: log your food and weight, no plan pressure.",
    dailyCalorieTarget: SAFE_KCAL,
    goals: [
      { label: "Log everything you eat", kind: "nutrition" },
      { label: "A weekly weigh-in", kind: "habit" },
    ],
  },
};

type FallbackSeed = { name: string; sets: ExerciseSet[]; notes?: string };

/**
 * Equipment-free fallback programs, tiered by training experience. The whole
 * job of a fallback is to be unconditionally safe, but it must not INSULT an
 * advanced user with a beginner routine (the reported bug: a Murph-seeker got
 * "Sit-to-Stand"). So each tier has a real, harder session and benchmarks the
 * tier's keystone movement at a level-appropriate target. Still bodyweight (no
 * assumed equipment) so it can never fail the validator.
 */
interface FallbackSpec {
  workoutName: string;
  summary: string;
  seed: FallbackSeed[];
  /** Name of the seed movement to benchmark (max reps). Must be in `seed`. */
  benchName: string;
  benchTarget: number;
}

const FALLBACK_SPECS: Record<ExperienceLevel, FallbackSpec> = {
  beginner: {
    workoutName: "Bodyweight Starter",
    summary: "Equipment-free full-body",
    benchName: "Sit-to-Stand",
    benchTarget: 20,
    seed: [
      { name: "Sit-to-Stand", sets: [{ reps: 12, durationSec: null, restSec: 45 }], notes: "As many good reps as possible on your benchmark; stand from a chair, control the way down." },
      { name: "Wall Push-ups", sets: [{ reps: 10, durationSec: null, restSec: 45 }], notes: "Hands on a wall, chest to wall." },
      { name: "March in Place", sets: [{ reps: null, durationSec: 60, restSec: 30 }], notes: "Lift the knees, easy pace." },
      { name: "Plank", sets: [{ reps: null, durationSec: 30, restSec: 45 }], notes: "Neutral spine, squeeze the glutes." },
    ],
  },
  intermediate: {
    workoutName: "Bodyweight Strength",
    summary: "Equipment-free strength circuit",
    benchName: "Push-ups",
    benchTarget: 30,
    seed: [
      { name: "Push-ups", sets: [{ reps: 15, durationSec: null, restSec: 60 }, { reps: 15, durationSec: null, restSec: 60 }], notes: "Benchmark = as many strict reps as possible in one set. Chest to floor, straight body." },
      { name: "Bodyweight Squats", sets: [{ reps: 20, durationSec: null, restSec: 60 }, { reps: 20, durationSec: null, restSec: 60 }], notes: "Full depth, drive through the heels." },
      { name: "Reverse Lunges", sets: [{ reps: 12, durationSec: null, restSec: 60 }], notes: "Per leg, controlled." },
      { name: "Mountain Climbers", sets: [{ reps: null, durationSec: 40, restSec: 45 }], notes: "Fast but controlled, hips down." },
      { name: "Plank", sets: [{ reps: null, durationSec: 45, restSec: 45 }], notes: "Neutral spine." },
    ],
  },
  advanced: {
    workoutName: "Conditioning + Strength",
    summary: "Equipment-free high-output session",
    benchName: "Push-ups",
    benchTarget: 50,
    seed: [
      { name: "Push-ups", sets: [{ reps: 25, durationSec: null, restSec: 60 }, { reps: 25, durationSec: null, restSec: 60 }, { reps: 25, durationSec: null, restSec: 60 }], notes: "Benchmark = max strict reps in one unbroken set. Chest to floor." },
      { name: "Jump Squats", sets: [{ reps: 20, durationSec: null, restSec: 60 }, { reps: 20, durationSec: null, restSec: 60 }], notes: "Explode up, land soft." },
      { name: "Walking Lunges", sets: [{ reps: 20, durationSec: null, restSec: 60 }], notes: "Per leg, long strides." },
      { name: "Burpees", sets: [{ reps: 15, durationSec: null, restSec: 75 }, { reps: 15, durationSec: null, restSec: 75 }], notes: "Chest to floor, full stand + hop at the top." },
      { name: "Hollow Hold", sets: [{ reps: null, durationSec: 45, restSec: 45 }], notes: "Low back pinned to the floor." },
    ],
  },
};

/**
 * A known-safe fallback program for the workout modes, scaled to experience.
 * Any exercise a declared injury excludes is dropped; if the benchmark movement
 * itself is excluded (or no exercises survive) the program is omitted entirely —
 * a plan is still valid without one.
 */
export function fallbackProgram(
  mode: PlanMode,
  injuries: string[],
  experience: ExperienceLevel = "beginner",
): WorkoutProgram | undefined {
  if (!modeHasWorkouts(mode)) return undefined;

  const spec = FALLBACK_SPECS[experience] ?? FALLBACK_SPECS.beginner;
  const exercises: Exercise[] = spec.seed
    .filter((s) => !isExerciseExcluded(`${s.name} ${s.notes ?? ""}`, injuries))
    .map((s) => ({ id: newId(), name: s.name, sets: s.sets, ...(s.notes ? { notes: s.notes } : {}) }));
  if (exercises.length === 0) return undefined;

  // Benchmark the tier's keystone movement if it survived; else the first
  // surviving rep-based exercise. Require it to be safe.
  const benchEx =
    exercises.find((e) => e.name === spec.benchName) ??
    exercises.find((e) => e.sets.some((set) => set.reps != null));
  if (!benchEx || isExerciseExcluded(benchEx.name, injuries)) return undefined;
  const benchTarget = benchEx.name === spec.benchName ? spec.benchTarget : 20;

  const benchmarkId = newId();
  return {
    workouts: [
      {
        id: newId(),
        workout: { id: newId(), name: spec.workoutName, summary: spec.summary, exercises, origin: "built-in" },
        isBenchmark: true,
        benchmarkId,
        benchmarkIds: [benchmarkId],
        group: 1,
      },
    ],
    benchmarks: [
      {
        id: benchmarkId,
        exerciseKey: normalizeExerciseKey(benchEx.name),
        name: benchEx.name,
        metric: "reps",
        baseline: null,
        target: benchTarget,
        unit: "reps",
        history: [],
      },
    ],
    analysisCursor: 0,
    currentGroup: 1,
  };
}

/**
 * The safe template for a mode. Adjusts the calorie target down only for modes
 * that don't track food (null), never below the safe value otherwise. `input`
 * is accepted for future personalisation but the template is intentionally
 * generic — its whole job is to be unconditionally safe.
 */
export function fallbackPlan(mode: PlanMode, input?: PlanInput): GeneratedPlan {
  const t = TEMPLATES[mode] ?? TEMPLATES.logging_only;
  const injuries = input?.safety?.injuries ?? [];
  // The fallback isn't re-validated, so it must be safe by construction: drop
  // any workout goal a declared injury excludes.
  let goals = t.goals.filter(
    (g) => g.kind !== "workout" || !isExerciseExcluded(`${g.label} ${g.detail ?? ""}`, injuries),
  );
  if (goals.length === 0) {
    goals = [{ label: "Log everything you eat", kind: "nutrition" }];
  }
  const program = fallbackProgram(mode, injuries, input?.experienceLevel);
  return {
    summary: t.summary,
    dailyCalorieTarget: modeTracksFood(mode) ? t.dailyCalorieTarget : null,
    goals: goals.map((g) => ({ ...g })),
    ...(program ? { program } : {}),
  };
}
