/**
 * Deterministic join key for an exercise name — the single identifier that
 * ties together a workout's prescribed sets, recorded `ExerciseActual`s,
 * benchmarks, and the layered explainer sources (user VFS / trainer DB / AI).
 * Lowercased, non-alphanumerics collapsed to single hyphens, trimmed.
 */
export function normalizeExerciseKey(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
