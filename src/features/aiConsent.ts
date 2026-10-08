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
 * Two features gate on this, sharing one consent: asking the health coach a
 * question (today in full plus summaries of the week before, their weight,
 * profile and plan; see features/coach/askSummary.ts), and "Find patterns" in
 * the journal, which sends a chosen date range AND opens the same coach chat,
 * so it sends everything the coach does as well. features/coach/ask.ts is the
 * one chokepoint both the home screen's "Ask your health coach" card and the
 * journal's coach chat run through. One agreement, one wording, because a user
 * who consents to the AI reading their journal is consenting to the same
 * disclosure regardless of which button triggered it.
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
 *     send anywhere. Only Find patterns sends them, once, with the question
 *     that asked for it: the coach summary never carries a note of any kind,
 *     and later questions resend the conversation without that journal, or
 *     the coach's answer to it, which can quote a note back
 *     (coach/ask.ts historyForPrompt).
 *
 * Bump `DISCLOSURE_VERSION` whenever the wording below changes materially.
 * Consent to old wording is not consent to new wording, and a bump re-asks.
 *
 * Where the agreement lives: on the profile, once there is one. A new user
 * has no profile until they build a plan, but can log and ask the coach from
 * the first day, so until then it waits in a file of its own (PENDING_PATH),
 * the way healthConsent.ts keeps the consent to collect. The first profile
 * written (every write goes through withStoredConsent) carries it over. Once
 * a profile exists, the profile's answer is the only one read.
 */

import type { AiJournalConsent, Profile } from "../types";
import { getRepository } from "../data/repository";
import { readJson, writeJsonOrThrow } from "../bridge/vfs";

/** The agreement while there is no profile to keep it on. */
const PENDING_PATH = "ai-consent.json";

/**
 * Current disclosure wording. Bump on any material change to `DISCLOSURE_*`
 * below. v2 (2026-09) added the coach path (it was disclosing today's data
 * and the user's goal direction with no wording covering either). v3
 * (2026-10) widened the coach to everything the user logs: a 7-day summary,
 * weight history and goal weight, body stats, targets and the plan, and said
 * plainly that Find patterns sends what the coach does too, because it opens
 * the same chat, and that each question resends the recent conversation.
 */
export const DISCLOSURE_VERSION = 3;

/**
 * Exactly what leaves the device, in the order the sheet shows it. Kept as
 * data so the consent sheet and the privacy policy cannot drift apart: both
 * render this list, so there is one description of the disclosure, not two.
 *
 * Two different scopes share this one list, called out explicitly rather than
 * averaged into something vaguer than either. Asking the coach always sends
 * today, the 2 days before and the summaries built in
 * features/coach/askSummary.ts, plus the last MAX_CONTEXT_TURNS messages of
 * the chat (coach/ask.ts). Find patterns sends a range you pick, once, and
 * because it asks through the coach chat, everything the coach sends as well.
 */
export const DISCLOSURE_SENDS: string[] = [
  "Asking your health coach: today in full, daily totals for the 2 days before, a summary of the 7 days before today, and the last 10 messages of your conversation with it, its replies included",
  "Find patterns: everything the coach gets, plus each date in the range you asked about, sent once with that question and not with later ones",
  "Daily totals and the 7-day summary: calories, protein, carbs, fat, water, sleep length and how rested you felt, exercise calories, and how many days you logged each",
  "Your daily calorie and macro targets",
  "Your weight: your latest weigh-in, how many you have logged, how it changed over the last week, the last month and since your first, and your goal weight (Find patterns also sends each weigh-in in its range)",
  "Your goal (losing, gaining, or maintaining), height, age, sex and activity level",
  "Your plan: its type and dates, your goal in your own words, its daily goals, and your weekly exercise target with this week's progress",
  "Symptoms you logged, with the severity you picked, and how often each came up in the 7-day summary (Find patterns also sends the time of day)",
  "The names of foods you ate (up to 12 a day for Find patterns; up to 25 for today, when asking the coach)",
];

/** What is held back regardless, so the sheet can be specific about limits. */
export const DISCLOSURE_WITHHOLDS: string[] = [
  "Your name, email, or account details",
  "Notes you type on a night's sleep",
  "The free-text note on a symptom, unless you turn that on below; then Find patterns sends it once, with the question that asked for it",
  "Workout names and types, including any read from Apple Health or Health Connect",
  "Asking the coach: anything logged more than 7 days before today, apart from the weight summary above and what its earlier replies mention",
];

/**
 * A realistic sample of one line, so the user can see the shape of what they
 * are agreeing to rather than trusting a description of it. Matches what
 * `summarizeRange` actually produces for "Find patterns".
 */
export const DISCLOSURE_SAMPLE =
  "2026-09-03: 2140 cal from 9 items; 118g protein; 1900ml water; " +
  "slept 7h30m; 82.4kg; symptoms: Heartburn at 21:40 (3/5); ate: coffee, oats, pizza";

/**
 * A few lines of the coach's summary, for the same reason. Each line is real
 * output of the renderers in features/coach/askSummary.ts for a fixed
 * fixture, and askSummary.test.ts checks that it still is, so this cannot
 * drift into describing a format the code does not produce. Today's diary
 * is not sampled: it is the same fields as the line above, laid out by meal.
 */
export const DISCLOSURE_COACH_SAMPLE = [
  "Change: -0.7 kg since 2026-10-01, -1.6 kg since 2026-09-08, -2.8 kg since the first weigh-in.",
  "Eat better plan, 2026-09-24 to 2026-10-21, day 15 of 28.",
  "Food: logged 6 of 7 days (6 in a row through today), avg 1835 cal, 112g protein, 190g carbs, 61g fat.",
  "Sleep: 6 nights, avg 7h 10m, rested 3.5/5.",
].join("\n");

/** Whether a stored consent still covers the current disclosure wording. */
export function consentIsCurrent(consent: AiJournalConsent | undefined): boolean {
  return consent !== undefined && consent.version === DISCLOSURE_VERSION;
}

/** The agreement waiting in PENDING_PATH, or undefined. Never throws: a file
 *  that cannot be read holds no agreement. */
async function readPending(): Promise<AiJournalConsent | undefined> {
  const raw = await readJson<AiJournalConsent | null>(PENDING_PATH, null).catch(() => null);
  return raw && typeof raw === "object" && typeof raw.version === "number" ? raw : undefined;
}

/**
 * The agreement on file: the profile's once there is a profile, the pending
 * file's until then. Throws when the profile cannot be read, so each caller
 * fails closed: an unreadable profile may hold a withdrawal the file does
 * not know about.
 */
async function consentOnFile(): Promise<AiJournalConsent | undefined> {
  const repo = await getRepository();
  const profile = await repo.getProfile();
  return profile ? profile.aiJournalConsent : readPending();
}

/**
 * Whether the AI pattern-finder may run without asking first.
 *
 * Fails CLOSED: a profile that cannot be read means we do not know what was
 * agreed, and an unknown agreement is not an agreement.
 */
export async function hasAiJournalConsent(): Promise<boolean> {
  try {
    return consentIsCurrent(await consentOnFile());
  } catch {
    return false;
  }
}

/** The stored consent, or undefined when there is none (or none readable). */
export async function readAiJournalConsent(): Promise<AiJournalConsent | undefined> {
  try {
    return await consentOnFile();
  } catch {
    return undefined;
  }
}

/**
 * `next` carrying the agreement on file instead of whatever agreement it
 * carries. Every profile write outside this module goes through this.
 *
 * Those writes start from a copy of the profile read earlier (App reads it
 * once at startup), and accepting or withdrawing here never updates that
 * copy. Saved as it stands, the copy would put back an agreement the user
 * withdrew, with no prompt, or replace a fresh one with older wording, so
 * the coach re-asked after every plan edit. Only this module changes the
 * agreement; everything else keeps the stored one.
 *
 * The first profile written carries over an agreement made before there was
 * one (PENDING_PATH).
 *
 * Fails CLOSED like hasAiJournalConsent: a profile that cannot be read keeps
 * no agreement, and the next question asks again.
 */
export async function withStoredConsent(next: Profile): Promise<Profile> {
  let onFile: AiJournalConsent | undefined;
  try {
    onFile = await consentOnFile();
  } catch {
    onFile = undefined;
  }
  const { aiJournalConsent: _carried, ...rest } = next;
  return onFile ? { ...rest, aiJournalConsent: onFile } : (rest as Profile);
}

/**
 * Record an accept: on the profile, or in PENDING_PATH while there is no
 * profile. Returns false when the pending file cannot be written; the caller
 * must then treat consent as absent rather than proceeding, or the agreement
 * would exist only in memory for this session.
 */
export async function recordAiJournalConsent(includeNotes: boolean): Promise<boolean> {
  const consent: AiJournalConsent = {
    acceptedAt: new Date().toISOString(),
    version: DISCLOSURE_VERSION,
    includeNotes,
  };
  const repo = await getRepository();
  const profile = await repo.getProfile();
  if (!profile) {
    try {
      await writeJsonOrThrow(PENDING_PATH, consent);
      return true;
    } catch {
      return false;
    }
  }
  await repo.saveProfile({ ...profile, aiJournalConsent: consent });
  return true;
}

/**
 * Change the notes opt-in without re-accepting the whole disclosure. No-op
 * when there is no consent to amend — turning notes on cannot be a back door
 * to consenting.
 */
export async function setAiJournalNotes(includeNotes: boolean): Promise<void> {
  const repo = await getRepository();
  const profile = await repo.getProfile();
  if (!profile) {
    const pending = await readPending();
    if (pending) await writeJsonOrThrow(PENDING_PATH, { ...pending, includeNotes });
    return;
  }
  if (!profile.aiJournalConsent) return;
  await repo.saveProfile({
    ...profile,
    aiJournalConsent: { ...profile.aiJournalConsent, includeNotes },
  });
}

/**
 * Withdraw consent. The next pattern-finder run asks again from scratch.
 * Withdrawal has to be as easy as granting, which is why it sits in Settings
 * next to the other health-data controls rather than behind a support email.
 *
 * Clears the pending file as well as the profile, so an agreement made
 * before there was a profile cannot come back. That clear only matters
 * without a profile, so only then can its failure fail the withdrawal.
 */
export async function withdrawAiJournalConsent(): Promise<void> {
  const repo = await getRepository();
  const profile = await repo.getProfile();
  if (!profile) {
    await writeJsonOrThrow(PENDING_PATH, null);
    return;
  }
  const { aiJournalConsent: _dropped, ...rest } = profile;
  await repo.saveProfile(rest as Profile);
  await writeJsonOrThrow(PENDING_PATH, null).catch(() => {});
}
