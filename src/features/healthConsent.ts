/**
 * Consent to COLLECT consumer health data, asked before the app stores any.
 *
 * Washington's My Health My Data Act (RCW 19.373.030) requires consent before
 * a regulated entity collects consumer health data, not only before it shares
 * it, and the consent must be a clear affirmative act: so the gate is an
 * unticked checkbox plus a button, never a pre-ticked box or "by continuing".
 * Nevada SB 370 is close enough that one gate serves both.
 *
 * This is separate from `aiConsent.ts`. That one authorizes sending part of
 * the journal to an AI (Find patterns, the coach) and stays its own opt-in;
 * this one authorizes keeping the journal at all.
 *
 * Stored as its own file in the app's VFS rather than on the profile, because
 * a new user has no profile until they build a plan, and the gate has to come
 * before the first entry. VFS files sync through the ConjureOS account, so the
 * agreement follows the person between devices.
 *
 * Bump `HEALTH_CONSENT_VERSION` when the gate's wording changes materially:
 * agreement to old wording is not agreement to new wording.
 */

import { readJson, writeJsonOrThrow } from "../bridge/vfs";

export const HEALTH_CONSENT_VERSION = 1;
const PATH = "health-consent.json";

export interface HealthConsent {
  /** ISO timestamp of the agreement. */
  acceptedAt: string;
  /** Which wording was agreed to. */
  version: number;
}

let granted = false;

/** Synchronous view for code that cannot await (cross-app action guards). */
export function healthConsentGranted(): boolean {
  return granted;
}

/**
 * Whether a current agreement is on file. Fails CLOSED: an unreadable file is
 * an unknown agreement, and an unknown agreement is not an agreement.
 */
export async function loadHealthConsent(): Promise<boolean> {
  const stored = await readJson<HealthConsent | null>(PATH, null).catch(() => null);
  granted = !!stored && stored.version === HEALTH_CONSENT_VERSION && typeof stored.acceptedAt === "string";
  return granted;
}

/**
 * Record an agreement. Returns false when it could not be written; the caller
 * still lets the person in for this session (they did agree), and the gate
 * asks again next time rather than pretending a record exists.
 */
export async function recordHealthConsent(): Promise<boolean> {
  granted = true;
  try {
    await writeJsonOrThrow(PATH, { acceptedAt: new Date().toISOString(), version: HEALTH_CONSENT_VERSION });
    return true;
  } catch {
    return false;
  }
}

/** Withdraw. Collection stops at once; deleting what is stored is Reset health data. */
export async function withdrawHealthConsent(): Promise<void> {
  granted = false;
  await writeJsonOrThrow(PATH, null).catch(() => {});
}
