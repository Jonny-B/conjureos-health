/**
 * Consent for sending journal data off-device to the AI.
 *
 * Journal entries — symptoms, weight, sleep, what you ate — are consumer
 * health data. ConjureOS is not a HIPAA covered entity and this app does not
 * make it one, but the consumer-health-privacy statutes that DO apply
 * (Washington's My Health My Data Act most sharply, since it carries a
 * private right of action) treat COLLECTING that data and SHARING it with a
 * third party as two different acts needing two different permissions.
 * Logging a headache is collection; asking the AI to find patterns in it is a
 * disclosure to a processor.
 *
 * Two features gate on this, sharing one consent: "Find patterns" in the
 * journal (a chosen date range), and asking the coach a question (today plus
 * the two days before, always — see features/coach/ask.ts, which is the one
 * chokepoint both the "Ask about food" card and the journal's coach chat run
 * through). One agreement, one wording, because a user who consents to the
 * AI reading their journal is consenting to the same disclosure regardless of
 * which button triggered it.
 *
 * So this module exists to make that disclosure deliberate:
 *
 *   - It never happens without a stored, dated agreement to specific wording.
 *   - It only ever happens because the user pressed a button. Nothing here
 *     may be called from a timer, a background refresh, or app startup — the
 *     statutory carve-out for a processor leans on the sharing being needed
 *     to deliver something the consumer actually asked for.
 *   - Free-text symptom notes are a second, separate opt-in, because that is
 *     the field where someone eventually types the thing they would hate to
 *     send anywhere.
 *
 * Bump `DISCLOSURE_VERSION` whenever the wording below changes materially.
 * Consent to old wording is not consent to new wording, and a bump re-asks.
 */

import type { AiJournalConsent, Profile } from "../types";
import { getRepository } from "../data/repository";
import { readJson, vfs, writeJsonOrThrow } from "../bridge/vfs";

/**
 * Current disclosure wording. Bump on any material change to `DISCLOSURE_*`
 * below — v2 (2026-09) added the coach path (it was disclosing today's data
 * and the user's goal direction with no wording covering either).
 */
export const DISCLOSURE_VERSION = 2;

/**
 * Exactly what leaves the device, in the order the sheet shows it. Kept as
 * data so the consent sheet and the privacy policy cannot drift apart — both
 * render this list, so there is one description of the disclosure, not two.
 *
 * Two different scopes share this one list, called out explicitly rather than
 * averaged into something vaguer than either: "Find patterns" sends a range
 * you pick, the coach (both "Ask about food" and the journal's coach chat)
 * always sends today plus the 2 days before. See features/coach/ask.ts.
 */
export const DISCLOSURE_SENDS: string[] = [
  "Find patterns: the dates in the range you asked about",
  "Asking the coach: today in full, plus daily totals from the 2 days before",
  "Daily totals: calories, protein, water, sleep length, exercise calories",
  "Your weight on days you recorded one, and your goal (losing, gaining, or maintaining)",
  "Symptoms you logged, with the severity you picked (Find patterns also sends the time of day)",
  "The names of foods you ate (up to 12 a day for Find patterns; up to 25 for today, when asking the coach)",
];

/** What is held back regardless, so the sheet can be specific about limits. */
export const DISCLOSURE_WITHHOLDS: string[] = [
  "Your name, email, or account details",
  "The free-text note on a symptom, unless you turn that on below",
  "Find patterns: anything outside the range you asked about",
  "Asking the coach: anything from more than 2 days before today",
];

/**
 * A realistic sample of one line, so the user can see the shape of what they
 * are agreeing to rather than trusting a description of it. Matches what
 * `summarizeRange` actually produces for "Find patterns" — the coach path
 * renders its own day differently (see `renderDayForPrompt`), but sends the
 * same underlying fields, so one honest sample stands in for both rather than
 * the sheet showing two blocks nobody reads in full.
 */
export const DISCLOSURE_SAMPLE =
  "2026-09-03: 2140 cal from 9 items; 118g protein; 1900ml water; " +
  "slept 7h30m; 82.4kg; symptoms: Heartburn at 21:40 (3/5); ate: coffee, oats, pizza";

/** Whether a stored consent still covers the current disclosure wording. */
export function consentIsCurrent(consent: AiJournalConsent | undefined): boolean {
  return consent !== undefined && consent.version === DISCLOSURE_VERSION;
}

/**
 * Where consent lives when there is no profile to hold it. Profiles are only
 * created by the plan wizard, and the app is usable (Diary, Ask about food,
 * Journal) without one — so a plan-less user's accept has to land somewhere,
 * and fabricating a DEFAULT profile to carry it would be overwritten by
 * `commitNewPlan` (dropping the consent) and mistaken for real stats.
 * Exported so "Clear all history" can remove it.
 */
export const AI_CONSENT_VFS_PATH = "ai-journal-consent.json";

/** The consent held in the VFS key. A missing or unreadable file reads as no
 *  consent, which is the fail-closed answer. */
async function readVfsConsent(): Promise<AiJournalConsent | undefined> {
  const v = await readJson<AiJournalConsent | null>(AI_CONSENT_VFS_PATH, null);
  return v && typeof v === "object" ? v : undefined;
}

/**
 * Whether the AI pattern-finder may run without asking first.
 *
 * Fails CLOSED: a profile that cannot be read means we do not know what was
 * agreed, and an unknown agreement is not an agreement.
 */
export async function hasAiJournalConsent(): Promise<boolean> {
  return consentIsCurrent(await readAiJournalConsent());
}

/** The stored consent, or undefined when there is none (or none readable).
 *  The profile's copy wins; the VFS key covers users with no profile yet. */
export async function readAiJournalConsent(): Promise<AiJournalConsent | undefined> {
  try {
    const repo = await getRepository();
    const profile = await repo.getProfile();
    return profile?.aiJournalConsent ?? (await readVfsConsent());
  } catch {
    return undefined;
  }
}

/**
 * Record an accept. Returns false when the agreement could not be written —
 * the caller must then treat consent as absent rather than proceeding, or the
 * agreement would exist only in memory for this session. Never throws.
 *
 * Kept on the profile when one exists; otherwise in a VFS key, so a user who
 * has not built a plan can still consent (the profile is never fabricated).
 */
export async function recordAiJournalConsent(includeNotes: boolean): Promise<boolean> {
  try {
    const repo = await getRepository();
    const profile = await repo.getProfile();
    const consent: AiJournalConsent = {
      acceptedAt: new Date().toISOString(),
      version: DISCLOSURE_VERSION,
      includeNotes,
    };
    if (profile) await repo.saveProfile({ ...profile, aiJournalConsent: consent });
    else await writeJsonOrThrow(AI_CONSENT_VFS_PATH, consent);
    return true;
  } catch {
    return false;
  }
}

/**
 * Change the notes opt-in without re-accepting the whole disclosure. No-op
 * when there is no consent to amend — turning notes on cannot be a back door
 * to consenting. Amends whichever location holds the consent.
 */
export async function setAiJournalNotes(includeNotes: boolean): Promise<void> {
  const repo = await getRepository();
  const profile = await repo.getProfile();
  if (profile?.aiJournalConsent) {
    await repo.saveProfile({
      ...profile,
      aiJournalConsent: { ...profile.aiJournalConsent, includeNotes },
    });
    return;
  }
  const vfsConsent = await readVfsConsent();
  if (vfsConsent) await writeJsonOrThrow(AI_CONSENT_VFS_PATH, { ...vfsConsent, includeNotes });
}

/**
 * Withdraw consent. The next pattern-finder run asks again from scratch.
 * Withdrawal has to be as easy as granting, which is why it sits in Settings
 * next to the other health-data controls rather than behind a support email.
 * Clears both places consent can live.
 */
export async function withdrawAiJournalConsent(): Promise<void> {
  if (await vfs.exists(AI_CONSENT_VFS_PATH)) await vfs.rm(AI_CONSENT_VFS_PATH);
  const repo = await getRepository();
  const profile = await repo.getProfile();
  if (!profile) return;
  const { aiJournalConsent: _dropped, ...rest } = profile;
  await repo.saveProfile(rest as Profile);
}
