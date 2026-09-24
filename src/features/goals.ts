/**
 * Goal recommendation — Mifflin-St Jeor BMR × activity → TDEE, adjusted for
 * the user's direction (lose/maintain/gain), then split into macro grams.
 *
 * These are recommendations only; the user can override any number in
 * settings. Deliberately simple and transparent (no body-fat models, no
 * adaptive TDEE) — accuracy beyond ±10% isn't meaningful for goal-setting.
 */

import type { ActivityLevel, GoalDirection, Goals, Profile } from "../types";

const ACTIVITY_MULTIPLIER: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

/** Human-readable descriptions for each activity level, shown in the picker
 *  so the user can self-select without guessing what "moderate" means. */
export const ACTIVITY_LABELS: Record<ActivityLevel, string> = {
  sedentary: "Sedentary (little/no exercise)",
  light: "Light (1–3 days/week)",
  moderate: "Moderate (3–5 days/week)",
  active: "Active (6–7 days/week)",
  very_active: "Very active (hard daily training)",
};

/**
 * Direction is DERIVED, not asked: a goal weight below the current weight means
 * lose, above means gain, and none (or within ~1 kg — nobody targets a sub-kilo
 * change) means maintain. Kills the redundant lose/maintain/gain selector.
 */
export function deriveDirection(
  weightKg: number | undefined,
  goalWeightKg: number | undefined,
): GoalDirection {
  if (weightKg == null || goalWeightKg == null || goalWeightKg <= 0) return "maintain";
  if (Math.abs(goalWeightKg - weightKg) < 1) return "maintain";
  return goalWeightKg < weightKg ? "lose" : "gain";
}

/**
 * Activity level DERIVED from planned workout days per week — the wizard no
 * longer asks both ("how active are you" duplicated "how often will you
 * train"). Coarse on purpose; the calorie model is only ±10% honest anyway.
 */
export function activityForDaysPerWeek(days: number): ActivityLevel {
  if (days <= 2) return "light";
  if (days <= 4) return "moderate";
  if (days === 5) return "active";
  return "very_active";
}

/**
 * Inverse of `activityForDaysPerWeek`: a representative days/week that maps back
 * to the given activity level. Used to seed the plan editor's days chip from a
 * stored profile so editing the plan doesn't silently re-derive a DIFFERENT
 * activity (and thus a different calorie target) than the plan was built with.
 */
export function daysPerWeekForActivity(activity: ActivityLevel): number {
  switch (activity) {
    case "very_active":
      return 6;
    case "active":
      return 5;
    case "moderate":
      return 3;
    default:
      return 2; // light / sedentary
  }
}

/** Calorie delta per day for each direction (~0.5 kg/week ≈ 500 kcal). */
const DIRECTION_DELTA: Record<GoalDirection, number> = {
  lose: -500,
  maintain: 0,
  gain: 300,
};

/**
 * Basal metabolic rate via Mifflin-St Jeor — calories burned at complete
 * rest. The starting point for every calorie target; multiply by an activity
 * factor (see {@link tdee}) before applying a deficit or surplus.
 */
export function bmrMifflin(p: Profile): number {
  const base = 10 * p.weightKg + 6.25 * p.heightCm - 5 * p.age;
  // Undisclosed sex uses the male constant (the higher, safer estimate),
  // matching the kcal floor default.
  return p.sex === "female" ? base - 161 : base + 5;
}

/**
 * Total daily energy expenditure: BMR scaled by the profile's activity
 * level. This is maintenance — the calories that hold weight steady.
 */
export function tdee(p: Profile): number {
  return bmrMifflin(p) * ACTIVITY_MULTIPLIER[p.activityLevel];
}

/**
 * Split a calorie target into macro grams: protein 1.6 g/kg bodyweight, fat 25%
 * of calories, carbs fill the remainder — a sane, widely-used default split.
 * Shared by `recommendGoals` (profile-derived) and the plan service (deriving
 * targets from the plan's AI calorie target), so the split lives in one place.
 */
export function macrosForCalories(calories: number, weightKg: number): Omit<Goals, "calories"> {
  const protein = Math.round(1.6 * weightKg);
  const fat = Math.round((calories * 0.25) / 9);
  const carbs = Math.max(0, Math.round((calories - protein * 4 - fat * 9) / 4));
  return { protein, carbs, fat };
}

/**
 * Recommend goals from a profile. Calories = TDEE + direction delta, floored
 * at a safe minimum; macros via `macrosForCalories`.
 */
export function recommendGoals(p: Profile): Goals {
  const minCalories = p.sex === "female" ? 1200 : 1500;
  const calories = Math.max(minCalories, Math.round(tdee(p) + DIRECTION_DELTA[p.direction]));
  return { calories, ...macrosForCalories(calories, p.weightKg) };
}

/** BMI from the profile's current weight + height. */
export function bmi(p: Profile): number {
  const m = p.heightCm / 100;
  if (m <= 0) return 0;
  return Math.round((p.weightKg / (m * m)) * 10) / 10;
}
