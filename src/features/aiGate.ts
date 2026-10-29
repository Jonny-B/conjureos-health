/**
 * THE GATE: the one place Conjure Health sends a request to the AI.
 *
 * Owner decision, 2026-10-29 (ConjureOS #1163): "If you remove consent, we
 * should stop the plan builder and photo, and you would have to re-agree."
 * Every feature that sends anything to the AI (`AI_FEATURES` in
 * features/aiConsent.ts) needs the AI agreement, and follows the rules Ask
 * Health has followed since 2026-10-22 ("Withdrawn consent means they have
 * withdrawn consent"):
 *
 *   - No agreement in force: nothing is sent.
 *   - The agreement is checked again right before the request, with nothing
 *     awaited between that check and the send, so a withdrawal that landed
 *     while the feature read what it sends stops it.
 *   - An answer that lands after a withdrawal, or after a withdrawal and a new
 *     agreement, is thrown away: the caller gets `AiNotAgreedError` instead of
 *     it, failure included, and keeps nothing.
 *
 * Calling `complete()` from bridge/ai.ts anywhere else routes around all of
 * that, so nothing else does (features/aiAgreement.test.ts holds every
 * module to it).
 */

import { complete, type CompleteRequest } from "../bridge/ai";
import type { AiJournalConsent } from "../types";
import { aiConsentGeneration, currentAiAgreement } from "./aiConsent";

/**
 * Why nothing was sent, or nothing kept: there was no agreement in force
 * (`none`), or it was withdrawn while the request was out (`withdrawn`).
 * Callers show the agreement, or let go of what they were waiting for; they
 * never show it as an AI failure, and never fall back to something that reads
 * as the feature having worked.
 */
export class AiNotAgreedError extends Error {
  readonly why: "none" | "withdrawn";
  constructor(why: "none" | "withdrawn") {
    super(why === "none" ? "No AI agreement is in force." : "The AI agreement was withdrawn.");
    this.name = "AiNotAgreedError";
    this.why = why;
  }
}

/** Whether `err` is the gate saying no. */
export function isAiNotAgreed(err: unknown): err is AiNotAgreedError {
  return err instanceof AiNotAgreedError || (err instanceof Error && err.name === "AiNotAgreedError");
}

/** The agreement a request is made under, taken before anything is read for it. */
export interface AiTicket {
  readonly asked: number;
  readonly agreement: AiJournalConsent;
}

/**
 * The agreement in force for a request about to be made, or undefined when
 * there is none: then nothing may be sent. A feature that reads something
 * before it sends (Ask Health reads today) takes this first and hands it to
 * `completeUnderAgreement`, which checks it still holds after those reads.
 */
export async function takeAiTicket(): Promise<AiTicket | undefined> {
  const asked = aiConsentGeneration();
  const agreement = await currentAiAgreement();
  if (!agreement || asked !== aiConsentGeneration()) return undefined;
  return { asked, agreement };
}

/**
 * Whether the agreement a request was made under still holds: no withdrawal
 * or new agreement in this session since, and the same agreement on file,
 * since another device can withdraw, or withdraw and agree again, and this
 * session only sees the file change.
 */
export async function ticketHolds(t: AiTicket): Promise<boolean> {
  if (t.asked !== aiConsentGeneration()) return false;
  const still = await currentAiAgreement();
  return t.asked === aiConsentGeneration() && still?.acceptedAt === t.agreement.acceptedAt;
}

/**
 * Send one request under the agreement and return the model's text.
 *
 * Without `ticket`, the agreement is read here, and the request goes straight
 * after. With one, the agreement it was taken under is checked again here,
 * after whatever the caller read since.
 *
 * Throws `AiNotAgreedError` when nothing was sent (no agreement) or the
 * answer was thrown away (withdrawn while it was out). Any other failure of
 * the request rejects as `complete()` does.
 */
export async function completeUnderAgreement(req: CompleteRequest, ticket?: AiTicket): Promise<string> {
  let t: AiTicket;
  if (ticket) {
    if (!(await ticketHolds(ticket))) throw new AiNotAgreedError("withdrawn");
    t = ticket;
  } else {
    const fresh = await takeAiTicket();
    if (!fresh) throw new AiNotAgreedError("none");
    t = fresh;
  }
  // Nothing is awaited between the check above and the request.
  let raw: string;
  try {
    raw = await complete(req);
  } catch (err) {
    if (!(await ticketHolds(t))) throw new AiNotAgreedError("withdrawn");
    throw err;
  }
  if (!(await ticketHolds(t))) throw new AiNotAgreedError("withdrawn");
  return raw;
}
