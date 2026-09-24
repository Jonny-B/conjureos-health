/**
 * Safety layer 1 — the intake gate.
 *
 * A short questionnaire at wizard step 2 can force the plan into `logging_only`
 * mode, which hides (not disables) the workout surface. Three conditions trip
 * the gate: under-18, pregnant/postpartum, or a cardiac flag. This module is
 * pure so the wizard (P2) and the home screen (P3) share one source of truth
 * for "may this user see workouts?".
 */

import type { PlanMode, SafetyIntake } from "../../types";

/**
 * True when the intake forces logging-only. Under-18, pregnancy, and cardiac
 * advisories are all hard gates — we do not prescribe exercise in any of them.
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

/**
 * Whether the workout tab/surface should be hidden for this plan's safety
 * profile. Mirrors `requiresLoggingOnly` but reads intention-first at call
 * sites (home screen, settings). Hidden, per the design — never a disabled,
 * teasing control.
 */
export function workoutSurfaceHidden(intake: SafetyIntake): boolean {
  return requiresLoggingOnly(intake);
}
