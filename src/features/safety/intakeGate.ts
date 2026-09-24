/**
 * Safety layer 1 — the intake gate.
 *
 * A short questionnaire at wizard step 2 can force the plan into `logging_only`
 * mode: food and weight logging with no calorie target. Three conditions trip
 * the gate: under-18, pregnant/postpartum, or a cardiac flag. This module is
 * pure so every caller shares one source of truth for "may this plan set a
 * calorie target?".
 */

import type { PlanMode, SafetyIntake } from "../../types";

/**
 * True when the intake forces logging-only. Under-18, pregnancy, and cardiac
 * advisories are all hard gates — we do not prescribe a diet in any of them.
 */
export function requiresLoggingOnly(intake: SafetyIntake): boolean {
  return intake.ageBand === "under_18" || intake.pregnant || intake.cardiacFlag;
}

/**
 * Collapse a requested mode down to what's actually safe for this intake. Any
 * gated intake becomes `logging_only`; otherwise the requested mode passes
 * through untouched. Call this at plan creation so a stored Plan.mode is always
 * already-safe and downstream code never re-checks.
 */
export function resolveSafeMode(requested: PlanMode, intake: SafetyIntake): PlanMode {
  return requiresLoggingOnly(intake) ? "logging_only" : requested;
}
