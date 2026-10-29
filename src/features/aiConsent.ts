/**
 * Consent for sending anything to the AI.
 *
 * Journal entries (symptoms, weight, sleep, what you ate) are consumer health
 * data. ConjureOS is not a HIPAA covered entity and this app does not make it
 * one, but the consumer-health-privacy statutes that DO apply (Washington's My
 * Health My Data Act most sharply, since it carries a private right of action)
 * treat COLLECTING that data and SHARING it with a third party as two
 * different acts needing two different permissions. Logging a headache is
 * collection; asking the AI to find patterns in it is a disclosure to a
 * processor.
 *
 * Every feature that sends anything to the AI gates on this one agreement
 * (owner decision 2026-10-29, ConjureOS #1163: "If you remove consent, we
 * should stop the plan builder and photo, and you would have to re-agree"):
 * building a plan, adding food from a description or a photo, the food
 * estimates ConjureOS's assistant and other apps ask for, Find patterns, and
 * Ask Health. `AI_FEATURES`
 * names them, and features/aiGate.ts is the one place a request is sent from.
 * One agreement, one wording, because a person who agrees to the AI reading
 * what they give it agrees to the same thing whichever button sent it.
 *
 * So this module exists to make that disclosure deliberate:
 *
 *   - It never happens without a stored, dated agreement to specific wording.
 *   - It only ever happens because the user pressed a button. Nothing here
 *     may be called from a timer, a background refresh, or app startup: the
 *     statutory carve-out for a processor leans on the sharing being needed
 *     to deliver something the consumer actually asked for.
 *   - Free-text symptom notes are a second, separate opt-in, because that is
 *     the field where someone eventually types the thing they would hate to
 *     send anywhere.
 *
 * Bump `DISCLOSURE_VERSION` whenever the wording below changes materially.
 * Consent to old wording is not consent to new wording, and a bump re-asks.
 *
 * Stored in a file of its own (`AI_CONSENT_PATH`), not on the profile, since
 * version 3. A new person has no profile until their first plan is saved, and
 * the plan builder is behind this agreement, so it has to be recordable before
 * there is one. A file of its own also keeps a profile save from bringing it
 * back: Settings and the plan builder save the profile App read at startup,
 * which carried the agreement it had then, after a withdrawal too. VFS files
 * sync through the ConjureOS account, so the agreement and a withdrawal follow
 * the person between devices, as the profile did.
 */

import type { AiJournalConsent, Profile } from "../types";
import { getRepository } from "../data/repository";
import { readJson, writeJsonOrThrow } from "../bridge/vfs";
import { clearAskConversation } from "./ask/conversationFile";

/** Where the agreement is kept: a file of its own (see the note above). */
export const AI_CONSENT_PATH = "ai-consent.json";

/**
 * Every feature that sends anything to the AI, by the name a person knows it
 * by. All of them need the agreement, and a withdrawal stops all of them. The
 * consent sheet, Settings and the privacy policy list exactly these, so a
 * feature added here is named everywhere at once. Anything new that calls the
 * AI joins this list and goes through features/aiGate.ts
 * (`aiAgreement.test.ts` holds both).
 */
export const AI_FEATURES: readonly string[] = [
  "Building a plan",
  "Adding food from a description",
  "Adding food from a photo",
  "Food estimates for ConjureOS's assistant and other apps",
  "Find patterns",
  "Ask Health",
];

/**
 * Current disclosure wording. Bump on any material change to `DISCLOSURE_*`
 * below. v2 (2026-09) added the ask path (it was disclosing today's data and
 * the user's goal direction with no wording covering either).
 *
 * Not bumped for the 2026-10-10 rename of "asking the coach" to "Ask Health"
 * in the three lines below. The header rule asks for a bump on a MATERIAL
 * change, and this is not one. What is sent (today in full plus daily totals
 * from the 2 days before, up to 25 food names for today), what is withheld,
 * and the two entry points that send it (the home card, renamed from "Ask
 * about food", and the conversation Find patterns opens) are what they were
 * under v2. The one code change sends less, not more: the conversation moved
 * to a file of its own, and the older `coach-chat.json`, which v2 replayed as
 * earlier turns, is never read (features/ask/ask.ts). The old lines always
 * named exactly this path, so nothing new is sent and nothing new is named,
 * and v2 agreements still cover what goes. A bump would close the gate on every
 * agreed person over a label, and re-asking them to agree to the same
 * disclosure would authorize nothing new.
 *
 * Not bumped for ConjureOS #1163 either. Find patterns used to carry Ask
 * Health's today-plus-2-days context, and every question replayed the last
 * 10 stored turns, a Find patterns range and turns weeks old included, so two
 * withheld lines below were untrue of the code. The code was narrowed to
 * match them (features/ask/ask.ts, `turnsToSend`); the wording did not move,
 * and sending less needs no new agreement.
 *
 * Nor for the owner's withdrawal decision (2026-10-22, same issue): without
 * an agreement nothing is sent at all, where a question and its earlier turns
 * used to go with no context, and a withdrawal clears the conversation. Less
 * is sent, and the sheet's withdraw line ("neither sends anything more from
 * your journal") was already true of it.
 *
 * v3 (2026-10-29, ConjureOS #1163): the owner's decision "If you remove
 * consent, we should stop the plan builder and photo, and you would have to
 * re-agree." Building a plan, adding food from a description or a photo, and
 * the food estimates ConjureOS's assistant and other apps ask for used to
 * send without this agreement; they are behind it, and the wording names each
 * of them and what it sends. The disclosure got wider, so everyone who agreed
 * to v2 is asked once more, and until they agree again none of these features
 * sends anything. The v2 agreement was kept on the profile and is not read
 * again (see the note at the top on where it is kept).
 *
 * The v3 wording was corrected in review before it shipped, so it stays v3:
 * nobody had agreed to it. The estimates are named for ConjureOS's assistant,
 * their most common caller; the plan line names the kind of plan, which tells
 * the AI when the safety check picked one that does not count calories, and
 * the safety answers themselves are listed as not sent.
 */
export const DISCLOSURE_VERSION = 3;

/**
 * Exactly what leaves the device, in the order the sheet shows it. Kept as
 * data so the consent sheet and the privacy policy cannot drift apart: both
 * render this list, so there is one description of the disclosure, not two.
 *
 * One line per feature in `AI_FEATURES`, then the journal fields Find
 * patterns and Ask Health send. Their two scopes are called out explicitly
 * rather than averaged into something vaguer than either: Find patterns sends
 * a range you pick, Ask Health always sends today plus the 2 days before (see
 * features/ask/ask.ts). The plan line is `buildUserPrompt` in
 * features/plan/generate.ts: its `Mode:` is the kind of plan, and
 * `logging_only` is the safety gate's (features/safety/intakeGate.ts), so the
 * line says what picks it; the food lines are the prompts in
 * features/naturalLanguage.ts, features/foods/labelParse.ts and
 * features/foods/frontParse.ts, and `estimateNutrition` / `logFood` in
 * bridge/actions.ts.
 */
export const DISCLOSURE_SENDS: string[] = [
  "Building a plan: your goal in your words, the plan's length, and the kind of plan, which says whether it counts calories (one that does not is the kind picked for someone under 18, pregnant or recently postpartum, or with a heart condition); for a plan that counts calories, also your height, weight, goal weight, age and sex",
  "Adding food from a description: the words you type",
  "Adding food from a photo: the photo of your meal, or of a package's label or front, with the barcode if you scanned one",
  "Food estimates for ConjureOS's assistant and other apps: the food or the ingredients they name, when one of them asks Conjure Health for an estimate",
  "Find patterns: the dates in the range you asked about",
  "Ask Health: today in full, plus daily totals from the 2 days before",
  "For Find patterns and Ask Health, daily totals: calories, protein, water, sleep length, exercise calories",
  "For Find patterns and Ask Health, your weight on days you recorded one, and your goal (losing, gaining, or maintaining)",
  "Symptoms you logged, with the severity you picked (Find patterns also sends the time of day)",
  "The names of foods you ate (up to 12 a day for Find patterns; up to 25 for today, with Ask Health)",
];

/**
 * What is held back regardless, so the sheet can be specific about limits.
 *
 * Building a plan, adding food and the food estimates send only what their
 * own line above names: none of them reads the journal. The plan request
 * carries no safety answer (`buildUserPrompt` never reads `input.safety`).
 *
 * The two windows hold for the conversation history as well as the context:
 * `turnsToSend` in features/ask/ask.ts cuts the turns replayed with each
 * question to that question's entry point, and ask.test.ts ("what each entry
 * point sends") checks the request, not this wording (ConjureOS #1163).
 * The range line holds for Find patterns' opening question too:
 * `patternsQuestion` drops any day outside the range it names, and the
 * journal sends nothing until the month on screen has been read
 * (features/ask/findPatterns.ts). screens/askEntryPoints.test.tsx drives the
 * real screens and sheet to check what each one sends.
 */
export const DISCLOSURE_WITHHOLDS: string[] = [
  "Your name, email, or account details",
  "The free-text note on a symptom, unless you turn that on below",
  "Building a plan, adding food, and food estimates: your food diary, symptoms, sleep, water and past weigh-ins",
  "Building a plan: your safety check answers, beyond the kind of plan they pick",
  "Find patterns: anything outside the range you asked about",
  "Ask Health: anything from more than 2 days before today",
];

/**
 * A realistic sample of one line, so the user can see the shape of what they
 * are agreeing to rather than trusting a description of it. Matches what
 * `summarizeRange` actually produces for "Find patterns". Ask Health
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

/*
 * Withdrawal in this session. Owner decision, 2026-10-22 (ConjureOS #1163):
 * "Withdrawn consent means they have withdrawn consent." After a withdrawal
 * no feature sends anything to the AI: no question, no earlier turn, no
 * health data, no photo, no plan, no follow-up (2026-10-29: every feature in
 * `AI_FEATURES`, through features/aiGate.ts).
 *
 *   - `withdrawnHere`: the person withdrew in this session. It stands until
 *     they agree again, whatever the file says. The write that drops the
 *     agreement can fail or still be in progress, and an agreement read back
 *     from before it must never let anything go.
 *   - `generation`: moves on every withdrawal and every new agreement. A
 *     request carries the generation it was made under, and an answer that
 *     lands under another is thrown away (features/aiGate.ts).
 *   - listeners: a screen holding something the AI sent (an open Ask Health
 *     sheet, Add food's estimates) lets go of it the moment a withdrawal
 *     lands, and a feature that is on turns off.
 *   - `notSaved`: the last withdrawal could not drop the agreement or clear
 *     the conversation, which Settings says, with a retry. The next session
 *     reads the file, so a failure kept quiet would let a reload send again.
 */
let withdrawnHere = false;
let notSaved = false;
let generation = 0;
const withdrawalListeners = new Set<() => void>();

/** Which agreement-or-withdrawal this session is on. See the note above. */
export function aiConsentGeneration(): number {
  return generation;
}

/** Run `fn` when the agreement is withdrawn in this session. Returns the unsubscribe. */
export function onAiConsentWithdrawn(fn: () => void): () => void {
  withdrawalListeners.add(fn);
  return () => {
    withdrawalListeners.delete(fn);
  };
}

/** Whether the last withdrawal in this session could not be saved. */
export function aiWithdrawalNotSaved(): boolean {
  return notSaved;
}

/**
 * Shown in Settings when a withdrawal could not be saved, with a "Try again".
 * Not part of the versioned DISCLOSURE_* wording: it says nothing about what
 * is sent while the agreement holds.
 */
export const AI_WITHDRAW_NOT_SAVED =
  "Your withdrawal was not saved. Nothing is sent while the app stays open. Try again so it holds after you close it.";

/**
 * Shown where a feature asked for the agreement and the person agreed, but
 * the agreement could not be saved: nothing was sent.
 */
export const AI_AGREEMENT_NOT_SAVED = "Your agreement was not saved, so nothing was sent. Try again.";

/**
 * The agreement in force: the stored one, when it covers the current wording
 * and was not withdrawn in this session. Undefined otherwise.
 *
 * Fails CLOSED: a file that cannot be read means we do not know what was
 * agreed, and an unknown agreement is not an agreement.
 */
export async function currentAiAgreement(): Promise<AiJournalConsent | undefined> {
  const stored = await readAiJournalConsent();
  return consentIsCurrent(stored) ? stored : undefined;
}

/** Whether the features in `AI_FEATURES` may send without asking first. */
export async function hasAiJournalConsent(): Promise<boolean> {
  return (await currentAiAgreement()) !== undefined;
}

/**
 * The stored consent, or undefined when there is none (or none readable), or
 * when it was withdrawn in this session.
 */
export async function readAiJournalConsent(): Promise<AiJournalConsent | undefined> {
  if (withdrawnHere) return undefined;
  const stored = await readJson<unknown>(AI_CONSENT_PATH, null).catch(() => null);
  // A withdrawal can land while the read is out.
  if (withdrawnHere) return undefined;
  return asAgreement(stored);
}

/** A stored agreement, or undefined when the file holds anything else. */
function asAgreement(v: unknown): AiJournalConsent | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.acceptedAt !== "string" || typeof o.version !== "number") return undefined;
  return { acceptedAt: o.acceptedAt, version: o.version, includeNotes: o.includeNotes === true };
}

/**
 * Record an accept. Returns false when it could not be saved: the caller must
 * then treat consent as absent rather than proceeding, or the agreement would
 * exist only in memory for this session. Needs no profile (see the note at
 * the top).
 */
export async function recordAiJournalConsent(includeNotes: boolean): Promise<boolean> {
  const agreement: AiJournalConsent = {
    acceptedAt: new Date().toISOString(),
    version: DISCLOSURE_VERSION,
    includeNotes,
  };
  try {
    await writeJsonOrThrow(AI_CONSENT_PATH, agreement);
  } catch {
    return false;
  }
  withdrawnHere = false;
  notSaved = false;
  generation++;
  return true;
}

/**
 * Change the notes opt-in without re-accepting the whole disclosure. No-op
 * when there is no current consent to amend: turning notes on cannot be a
 * back door to consenting.
 */
export async function setAiJournalNotes(includeNotes: boolean): Promise<void> {
  const agreement = await currentAiAgreement();
  if (!agreement) return;
  await writeJsonOrThrow(AI_CONSENT_PATH, { ...agreement, includeNotes });
}

/**
 * Withdraw consent. Every feature in `AI_FEATURES` stops, and asks again from
 * scratch. Withdrawal has to be as easy as granting, which is why it sits in
 * Settings next to the other health-data controls rather than behind a
 * support email.
 *
 * It takes effect before anything is saved, and holds for the session
 * whatever the saves do: nothing is sent from here on, an answer still on its
 * way is thrown away, a screen holding what the AI sent lets go of it, and
 * the stored Ask Health conversation is cleared, so agreeing again starts a
 * fresh one (owner decisions 2026-10-22 and 2026-10-29, ConjureOS #1163).
 *
 * Returns whether it was saved: the agreement cleared, the agreement older
 * versions kept on the profile dropped (an older version of the app on
 * another device still reads that one), and the conversation cleared.
 * Calling it again is the retry.
 */
export async function withdrawAiJournalConsent(): Promise<boolean> {
  withdrawnHere = true;
  generation++;
  for (const fn of [...withdrawalListeners]) {
    try {
      fn();
    } catch {
      /* one listener failing must not stop the others, or the withdrawal */
    }
  }
  const results = await Promise.all([clearAskConversation(), clearAgreement(), dropProfileAgreement()]);
  const saved = results.every(Boolean);
  // Agreeing again meanwhile overrules the withdrawal: nothing left to say.
  if (withdrawnHere) notSaved = !saved;
  return saved;
}

/** Clear the stored agreement. Returns whether that was saved. */
async function clearAgreement(): Promise<boolean> {
  try {
    await writeJsonOrThrow(AI_CONSENT_PATH, null);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the agreement versions 1 and 2 kept on the profile. This version
 * never reads it, but an older version of the app does. Returns whether that
 * was saved. A profile save never writes it back (data/mockRepository.ts,
 * `saveProfile`), whatever copy of the profile the caller holds.
 */
async function dropProfileAgreement(): Promise<boolean> {
  try {
    const repo = await getRepository();
    const profile = await repo.getProfile();
    if (!profile?.aiJournalConsent) return true;
    const { aiJournalConsent: _dropped, ...rest } = profile;
    await repo.saveProfile(rest as Profile);
    return true;
  } catch {
    return false;
  }
}
