/**
 * Safety layer 4 (last resort) — hardcoded, known-safe plan templates. Used
 * when AI generation fails validation twice (or the estimator is unreachable).
 * Every template is above the kcal floor and prescribes no exercise, so it can
 * never trip the validator. The logging-only mode doesn't need a template —
 * it's just the diary — but we return a minimal food-logging plan for it so
 * the shape is always valid.
 */

import type { PlanMode } from "../../types";
import type { GeneratedPlan } from "./model";
import { modeTracksFood } from "./model";

/** A generous, always-safe daily calorie target (well above every floor). */
const SAFE_KCAL = 1800;

const EAT_BETTER: GeneratedPlan = {
  summary: "A gentle 'eat better' plan: steady calories, more protein and produce, no crash dieting.",
  dailyCalorieTarget: SAFE_KCAL,
  goals: [
    { label: `Stay around ${SAFE_KCAL} kcal`, kind: "nutrition", detail: String(SAFE_KCAL) },
    { label: "Protein at every meal", kind: "nutrition" },
    { label: "Two servings of vegetables", kind: "habit" },
    { label: "A glass of water before each meal", kind: "habit" },
  ],
};

const LOGGING_ONLY: GeneratedPlan = {
  summary: "Just tracking for now: log your food and weight, no plan pressure.",
  dailyCalorieTarget: SAFE_KCAL,
  goals: [
    { label: "Log everything you eat", kind: "nutrition" },
    { label: "A weekly weigh-in", kind: "habit" },
  ],
};

/**
 * The safe template for a mode. Only `eat_better` and `logging_only` plans are
 * created now; a legacy mode gets the `eat_better` template. The calorie
 * target is null for modes that don't track food. Deliberately generic — the
 * template's whole job is to be unconditionally safe.
 */
export function fallbackPlan(mode: PlanMode): GeneratedPlan {
  const t = mode === "logging_only" ? LOGGING_ONLY : EAT_BETTER;
  return {
    summary: t.summary,
    dailyCalorieTarget: modeTracksFood(mode) ? t.dailyCalorieTarget : null,
    goals: t.goals.map((g) => ({ ...g })),
  };
}
