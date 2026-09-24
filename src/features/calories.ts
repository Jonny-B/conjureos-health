/**
 * Post-workout calorie-burn estimate.
 *
 * Primary path is a local MET formula (kcal ≈ MET × bodyweight(kg) × hours) —
 * deterministic, offline, and instant. When the formula can't run (no stored
 * bodyweight) we fall back to an AI estimate, and to a coarse per-minute default
 * if neither is available. The result is always shown to the user as an
 * ESTIMATE they can edit before it's added to the day's calorie ring.
 */

import type { Profile, Workout, WorkoutSession } from "../types";
import { complete, isAiAvailable } from "../bridge/ai";

/**
 * How a burn figure was arrived at. Surfaced in the UI so an estimate is
 * never mistaken for a measurement: `formula` is the MET calculation,
 * `ai` a model guess when the formula lacked inputs, `default` a flat fallback.
 */
export type BurnMethod = "formula" | "ai" | "default";
/** An estimated calorie burn plus its provenance. The user can always
 *  override `kcal` before it reaches the diary. */
export interface BurnEstimateResult {
  kcal: number;
  method: BurnMethod;
}

/** Session length in minutes: wall-clock durationSec, else cardio duration. */
export function sessionMinutes(session: WorkoutSession): number {
  const sec = session.durationSec ?? session.cardio?.durationSec ?? 0;
  return sec > 0 ? sec / 60 : 0;
}

/** A coarse MET value for the workout kind (and pace, for a run). */
function metFor(workout: Workout, session: WorkoutSession): number {
  const kind = workout.kind;
  if (kind === "run") {
    const km = session.cardio?.distanceKm ?? 0;
    const sec = session.cardio?.durationSec ?? session.durationSec ?? 0;
    if (km > 0 && sec > 0) {
      const mph = (km * 0.621371) / (sec / 3600);
      if (mph < 5) return 8;
      if (mph < 6) return 9;
      if (mph < 7) return 10;
      if (mph < 8) return 11.5;
      return 13;
    }
    return 9.8; // jogging, unknown pace
  }
  if (kind === "bike") return 8;
  return 5; // strength / general resistance training
}

/**
 * Estimate calories burned for a finished session. Formula first (needs
 * bodyweight + a duration), AI fallback, coarse default last. Never throws.
 */
export async function estimateWorkoutBurn(
  session: WorkoutSession,
  workout: Workout,
  profile: Profile | null,
): Promise<BurnEstimateResult> {
  const min = sessionMinutes(session);
  const weight = profile?.weightKg;

  if (weight && weight > 0 && min > 0) {
    const met = metFor(workout, session);
    return { kcal: Math.max(0, Math.round(met * weight * (min / 60))), method: "formula" };
  }

  if (min > 0 && isAiAvailable()) {
    const ai = await estimateViaAi(session, workout, profile, min).catch(() => null);
    if (ai != null && Number.isFinite(ai) && ai > 0) return { kcal: Math.round(ai), method: "ai" };
  }

  // Last resort: ~6 kcal/min of moderate effort so the ring isn't left at 0.
  return { kcal: Math.max(0, Math.round(6 * min)), method: "default" };
}

async function estimateViaAi(
  session: WorkoutSession,
  workout: Workout,
  profile: Profile | null,
  minutes: number,
): Promise<number | null> {
  const parts = [
    `Workout: ${workout.name} (${workout.kind ?? "strength"}).`,
    `Duration: ${Math.round(minutes)} min.`,
    session.cardio?.distanceKm ? `Distance: ${session.cardio.distanceKm.toFixed(2)} km.` : "",
    profile ? `Athlete: ${profile.sex}, age ${profile.age}, ${Math.round(profile.weightKg)} kg.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const res = await complete({
    system:
      'Estimate active calories burned for one workout. Reply with ONLY strict JSON: {"kcal": <integer>}. No prose.',
    messages: [{ role: "user", content: parts }],
    maxTokens: 60,
    tier: "cheap",
  });
  const m = res.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const kcal = Number((JSON.parse(m[0]) as { kcal?: unknown }).kcal);
    return Number.isFinite(kcal) ? kcal : null;
  } catch {
    return null;
  }
}
