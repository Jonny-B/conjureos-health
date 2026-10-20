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
 * the journal to an AI (Find patterns, Ask Health) and stays its own opt-in;
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

/**
 * Which wording of the gate (features/healthConsentCopy.ts) an agreement
 * covers. Bump on a material change, per the note above.
 *
 * Not bumped on 2026-10-10, when "the food coach" in CONSENT_BODY was renamed
 * "Ask Health". That sentence says Find patterns and Ask Health ask for a
 * separate agreement before they send anything. It names the same feature
 * by its new name, behind the same separate agreement (features/aiConsent.ts,
 * whose own version holds for the same reason), and nothing new is collected,
 * sent or named. A bump would send every agreed person back through this gate,
 * with collection stopped until they agree again, over a label.
 */
export const HEALTH_CONSENT_VERSION = 1;
const PATH = "health-consent.json";

export interface HealthConsent {
  /** ISO timestamp of the agreement. */
  acceptedAt: string;
  /** Which wording was agreed to. */
  version: number;
}

/**
 * What this session knows about the agreement.
 *
 * - "unknown": the gate has not read the file yet, as at startup. The
 *   cross-app guard reads the file for itself and settles nothing.
 * - "granted": the gate read a current agreement, or the person agreed here.
 * - "absent": the gate read the file and found no current agreement.
 * - "withdrawn": the person withdrew here. That stands until they agree again,
 *   whatever the file says. The write that clears the file can fail or still
 *   be in progress, and an agreement read back from it must never switch
 *   collection on again (ConjureOS #1156 review).
 */
type SessionConsent = "unknown" | "granted" | "absent" | "withdrawn";
let session: SessionConsent = "unknown";
/** Bumped by every record and withdrawal, so a read that started before one does not overrule it. */
let decisions = 0;

/** Synchronous view for code that cannot await. */
export function healthConsentGranted(): boolean {
  return session === "granted";
}

/**
 * Whether an agreement is on file, for the cross-app action guard. The
 * actions are registered at startup, before the gate has read the file
 * (ConjureOS #1156), so a call that lands first must not be refused for a
 * read that has not finished: until the gate has read it, this reads the file
 * itself. Once the gate has read it, or the person has agreed or withdrawn,
 * the session's answer is final and the file is not read again.
 */
export async function healthConsentOnFile(): Promise<boolean> {
  if (session !== "unknown") return session === "granted";
  const onFile = await readAgreement();
  // The gate may have read the file, or the person decided, meanwhile.
  return session === "unknown" ? onFile : session === "granted";
}

/**
 * The gate's read. Whether a current agreement is on file. Fails CLOSED: an
 * unreadable file is an unknown agreement, and an unknown agreement is not an
 * agreement. A withdrawal in this session stands over whatever the file says.
 */
export async function loadHealthConsent(): Promise<boolean> {
  if (session === "withdrawn") return false;
  const before = decisions;
  const onFile = await readAgreement();
  if (decisions !== before) return session === "granted";
  session = onFile ? "granted" : "absent";
  return onFile;
}

/** Reads the file and changes nothing. */
async function readAgreement(): Promise<boolean> {
  const stored = await readJson<HealthConsent | null>(PATH, null).catch(() => null);
  return !!stored && stored.version === HEALTH_CONSENT_VERSION && typeof stored.acceptedAt === "string";
}

/**
 * Record an agreement. Returns false when it could not be written; the caller
 * still lets the person in for this session (they did agree), and the gate
 * asks again next time rather than pretending a record exists.
 */
export async function recordHealthConsent(): Promise<boolean> {
  session = "granted";
  decisions++;
  try {
    await writeJsonOrThrow(PATH, { acceptedAt: new Date().toISOString(), version: HEALTH_CONSENT_VERSION });
    return true;
  } catch {
    return false;
  }
}

/**
 * Withdraw. Collection stops at once and stays stopped for the session, even
 * when clearing the file fails; deleting what is stored is Reset health data.
 *
 * Returns whether the withdrawal was saved. The next session reads the file,
 * so a withdrawal that could not clear it leaves the old agreement in force
 * after a reload: the caller says so and offers a retry (the agreement
 * screen), rather than letting it pass in silence (ConjureOS #1156 review).
 * Calling it again is the retry.
 */
export async function withdrawHealthConsent(): Promise<boolean> {
  session = "withdrawn";
  decisions++;
  try {
    await writeJsonOrThrow(PATH, null);
    return true;
  } catch {
    return false;
  }
}
