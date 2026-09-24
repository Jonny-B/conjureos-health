/**
 * Layered exercise-explainer resolution (W2). For a given exercise key we try,
 * in order:
 *   1. the user's own note in VFS  (explainers/user/<key>.json)
 *   2. a trainer/DB entry          (stub — no table yet; where CoachProfile
 *      and WorkoutOrigin:"coach" will attach once trainers exist)
 *   3. an AI-generated explainer, cached to VFS (explainers/ai/<key>.json)
 * The AI path is only hit on a cache miss, so the second view of an exercise
 * is instant and free.
 */

import type { ExerciseExplainer } from "../../types";
import { readJson, writeJson, writeJsonOrThrow } from "../../bridge/vfs";
import { complete, extractJson } from "../../bridge/ai";

const userPath = (key: string) => `explainers/user/${key}.json`;
const aiPath = (key: string) => `explainers/ai/${key}.json`;

const SYSTEM = `You are a concise, encouraging fitness coach. Explain how to perform an exercise safely.
Return ONLY a JSON object:
  { "howTo": string, "worksMuscles": string[], "usefulData": string }
- howTo: 2-4 short sentences on form + setup.
- worksMuscles: the primary muscles worked (2-5 short names).
- usefulData: one line of tips, typical rep range, or a common mistake to avoid.
Output ONLY the JSON. No prose, no markdown fences.`;

function parseExplainer(raw: string, exerciseKey: string): ExerciseExplainer | null {
  let json: unknown;
  try {
    json = JSON.parse(extractJson(raw));
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  const howTo = typeof o.howTo === "string" ? o.howTo.trim().slice(0, 800) : "";
  if (!howTo) return null;
  const worksMuscles = Array.isArray(o.worksMuscles)
    ? o.worksMuscles.filter((m): m is string => typeof m === "string").map((m) => m.trim()).slice(0, 6)
    : undefined;
  const usefulData = typeof o.usefulData === "string" ? o.usefulData.trim().slice(0, 400) : undefined;
  return {
    exerciseKey,
    howTo,
    ...(worksMuscles && worksMuscles.length ? { worksMuscles } : {}),
    ...(usefulData ? { usefulData } : {}),
    source: "ai",
    cachedAt: new Date().toISOString(),
  };
}

/** Trainer/DB lookup — stub until the exercise_explainers table exists. */
async function fetchTrainerExplainer(_exerciseKey: string): Promise<ExerciseExplainer | null> {
  return null;
}

/**
 * Resolve the best explainer for an exercise, generating + caching an AI one on
 * a miss. `inline` is an optional override carried on the Exercise itself.
 */
export async function resolveExplainer(
  exerciseKey: string,
  displayName: string,
  inline?: ExerciseExplainer,
): Promise<ExerciseExplainer | null> {
  if (inline) return inline;

  const user = await readJson<ExerciseExplainer | null>(userPath(exerciseKey), null);
  if (user) return user;

  const trainer = await fetchTrainerExplainer(exerciseKey);
  if (trainer) return trainer;

  const cached = await readJson<ExerciseExplainer | null>(aiPath(exerciseKey), null);
  if (cached) return cached;

  try {
    const raw = await complete({
      system: SYSTEM,
      messages: [{ role: "user", content: `Exercise: ${displayName}` }],
      maxTokens: 400,
      tier: "cheap",
    });
    const gen = parseExplainer(raw, exerciseKey);
    if (gen) await writeJson(aiPath(exerciseKey), gen);
    return gen;
  } catch {
    return null;
  }
}

/** Persist a user-authored/edited explainer; it wins over trainer + AI. */
/** Throws when the write fails, so the caller can tell the user. */
export async function saveUserExplainer(explainer: ExerciseExplainer): Promise<void> {
  await writeJsonOrThrow(userPath(explainer.exerciseKey), {
    ...explainer,
    source: "user",
    cachedAt: undefined,
  });
}
