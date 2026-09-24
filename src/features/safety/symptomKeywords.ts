/**
 * Safety layer 3 — the pre-LLM symptom classifier.
 *
 * Before ANY coach model call, the user's "Tell coach" text is screened for
 * red-flag symptom language. A hit ends the workout session deterministically
 * (no model in the loop) and surfaces a stop-and-seek-help message. This is a
 * blunt keyword screen on purpose: it must fire even if the LLM would have
 * mishandled the input, and it must be auditable.
 *
 * The list errs toward caution — false positives (ending a session early) are
 * acceptable; false negatives are not. Phrases are lowercase; matching is
 * substring on the lowercased input so "I'm getting chest pain" trips
 * "chest pain".
 */

/** Red-flag phrases that end a coach session before any model call. */
export const STOP_SYMPTOMS: readonly string[] = [
  "chest pain",
  "chest tightness",
  "chest pressure",
  "short of breath",
  "shortness of breath",
  "can't breathe",
  "cant breathe",
  "trouble breathing",
  "dizzy",
  "dizziness",
  "lightheaded",
  "light-headed",
  "faint",
  "fainted",
  "passed out",
  "black out",
  "blacked out",
  "palpitation",
  "heart racing",
  "irregular heartbeat",
  "numb",
  "numbness",
  "tingling",
  "blurred vision",
  "blurry vision",
  "slurred speech",
  "severe pain",
  "sharp pain",
  "stabbing pain",
  "heard a pop",
  "felt a pop",
  "popping sound",
  "can't move",
  "cant move",
  "throwing up",
  "vomit",
  "nausea",
  "cold sweat",
  "clammy",
];

/**
 * Returns the first matched red-flag phrase in `text`, or null if none. The
 * matched phrase is returned (not just a boolean) so the caller can log which
 * trigger fired without re-scanning.
 */
export function detectStopSymptom(text: string): string | null {
  const t = text.toLowerCase();
  for (const phrase of STOP_SYMPTOMS) {
    if (t.includes(phrase)) return phrase;
  }
  return null;
}

/** Convenience boolean wrapper around {@link detectStopSymptom}. */
export function isStopSymptom(text: string): boolean {
  return detectStopSymptom(text) !== null;
}
