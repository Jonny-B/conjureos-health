/**
 * Safety layer 2 — the injury-region exclusion list.
 *
 * A static map from an injury region the user declared in their SafetyIntake to
 * the movement patterns we must NOT prescribe for that region. Consumed by both
 * the plan-generation validator (P2) and the coach-reprompt validator (P4): any
 * generated or coach-suggested exercise whose name matches an excluded pattern
 * for one of the user's injuries is rejected.
 *
 * Matching is deliberately name-substring based (case-insensitive): the workout
 * library is name-keyed and has no movement taxonomy, so patterns are the
 * pragmatic mechanism. Patterns are lowercase; keep them broad enough to catch
 * naming variants ("squat" catches "Goblet Squat", "Split Squat").
 *
 * This ships in the bundle as a typed module (not JSON) so the values are
 * type-checked and there's no loader dependency.
 */

/** The regions a user can flag. Ids are the strings stored in SafetyIntake.injuries. */
export interface InjuryRegion {
  id: string;
  label: string;
}

/** The body regions a user can flag as injured during intake. Each maps to a
 *  set of movement patterns the plan generator and validators exclude. */
export const INJURY_REGIONS: readonly InjuryRegion[] = [
  { id: "knee", label: "Knee" },
  { id: "lower_back", label: "Lower back" },
  { id: "shoulder", label: "Shoulder" },
  { id: "neck", label: "Neck" },
  { id: "wrist", label: "Wrist / hand" },
  { id: "elbow", label: "Elbow" },
  { id: "hip", label: "Hip" },
  { id: "ankle", label: "Ankle / foot" },
] as const;

/**
 * region id → lowercase movement-name patterns to exclude. A pattern matches an
 * exercise when it appears anywhere in the (lowercased) exercise name.
 */
export const EXCLUDED_MOVEMENTS: Record<string, readonly string[]> = {
  knee: ["squat", "lunge", "jump", "plyo", "step-up", "step up", "wall sit", "pistol", "burpee", "sprint"],
  lower_back: ["deadlift", "good morning", "row", "sit-up", "sit up", "crunch", "toe touch", "superman", "hyperextension", "clean", "snatch"],
  shoulder: ["overhead press", "shoulder press", "military press", "push-up", "push up", "pull-up", "pull up", "dip", "handstand", "lateral raise", "upright row", "snatch", "clean"],
  neck: ["overhead press", "shoulder press", "bridge", "neck", "headstand", "handstand", "shrug"],
  wrist: ["push-up", "push up", "plank", "handstand", "burpee", "front rack", "curl", "wrist"],
  elbow: ["curl", "dip", "push-up", "push up", "pull-up", "pull up", "chin-up", "chin up", "skullcrusher", "tricep extension", "close-grip"],
  hip: ["lunge", "deadlift", "squat", "hip thrust", "step-up", "step up", "leg raise", "sprint", "jump"],
  ankle: ["jump", "plyo", "calf raise", "sprint", "lunge", "box jump", "burpee", "run", "hop", "skip"],
};

/** The union of excluded patterns for the given declared injuries. */
export function movementsExcludedFor(injuries: readonly string[]): string[] {
  const out = new Set<string>();
  for (const region of injuries) {
    for (const pattern of EXCLUDED_MOVEMENTS[region] ?? []) out.add(pattern);
  }
  return [...out];
}

/**
 * True when `exerciseName` matches any pattern excluded by the declared
 * injuries. Returns false when there are no injuries or no match.
 */
export function isExerciseExcluded(exerciseName: string, injuries: readonly string[]): boolean {
  if (injuries.length === 0) return false;
  const name = exerciseName.toLowerCase();
  return movementsExcludedFor(injuries).some((pattern) => name.includes(pattern));
}
