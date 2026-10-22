/**
 * Ask Health: the app's own AI conversation. A person asks about what they
 * eat and what they have logged, and gets an answer. Opened from the home
 * card and from the journal's "Find patterns".
 *
 * It answers and changes nothing: not the plan, not the targets, not the
 * diary. The only thing it writes is its own conversation.
 *
 * Coaching is a Conjure Fitness feature. Health has no coach, and this is not
 * one: it never proposes or applies a change, and it keeps no memory beyond
 * the conversation.
 */

import { aiErrorMessage, complete, isAiAvailable, type ChatMessage } from "../../bridge/ai";
import { readJson, writeJson } from "../../bridge/vfs";
import { getRepository } from "../../data/repository";
import { daySnapshot, recentSnapshots, renderDayForPrompt, renderRecentForPrompt } from "../dataApi";
import { aiConsentGeneration, currentAiAgreement, hasAiJournalConsent } from "../aiConsent";
import type { AiJournalConsent } from "../../types";
import { ASK_CHAT_PATH } from "./conversationFile";
import { todayISO } from "../diary";
import { fmtWeight } from "../units";

/** One turn of the conversation, as stored and as sent. */
export interface AskChatItem {
  role: "user" | "assistant";
  content: string;
  /**
   * When the question was asked (ISO), on the question and on its answer
   * alike, so the pair is always kept or dropped together. Missing on turns
   * stored before it was recorded.
   */
  at?: string;
  /** The "Find patterns" run this turn belongs to. Missing on an ordinary question. */
  patternsRun?: string;
}

/**
 * Which entry point a question comes from. The two send different things
 * (the DISCLOSURE_* lines in features/aiConsent.ts), so every question names
 * its entry point and `askHealth` decides what goes with it.
 *
 *   - `ask`: the home card, and follow-ups in a sheet it opened.
 *   - `patterns`: one "Find patterns" run, and follow-ups in the sheet it
 *     opened. `run` ties the follow-ups to that run and no other.
 */
export type AskFrom = { kind: "ask" } | { kind: "patterns"; run: string };

/** The home card's entry point. */
export const ASK_FROM_HOME: AskFrom = { kind: "ask" };

/** A fresh "Find patterns" run. Each press of the button is a new one. */
export function newPatternsRun(): AskFrom {
  return { kind: "patterns", run: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` };
}

/**
 * Where the conversation is stored: a file of Ask Health's own.
 *
 * Older versions kept the questions asked in-app in `coach-chat.json`, a file
 * the removed coach's chat wrote to as well. Its replies are still in there
 * for anyone who used it: plan changes it offered or made, and copy naming
 * the removed coach. Nothing on a turn records which feature wrote it, so no
 * filter can pick them out. Showing that file under "Ask Health", or sending
 * it to the model as Ask Health's own earlier replies, would keep the
 * removed coach talking. So Ask Health never reads `coach-chat.json`.
 *
 * Nothing deletes a user's stored data for them: `coach-chat.json` stays on
 * disk, and Settings, Reset health data, "Ask Health" clears it along with
 * this file (features/resetData.ts). The one other thing that empties this
 * file is the person withdrawing the AI agreement, which takes the
 * conversation with it (features/aiConsent.ts, owner decision 2026-10-22).
 * `ASK_CHAT_PATH` lives in ./conversationFile.ts for that reason.
 */

/** Turns kept on disk. Old turns fall off the top; the cap keeps the doc small
 *  enough to stay cheap to read on every home render. */
const MAX_STORED = 40;

/** Turns sent as context on a new question. Enough for follow-ups ("what about
 *  the green ones?") without paying for the whole history every time. */
const MAX_CONTEXT_TURNS = 10;

/**
 * The rotating prompts under the ask box. They exist to teach the shape of a
 * good question, so they lean concrete and everyday rather than clever: the
 * point is "oh, I can just ask it things", not a feature tour.
 */
export const ASK_SUGGESTIONS: readonly string[] = [
  "Are bananas high in fiber?",
  "Is oat milk better than dairy?",
  "How much protein is in two eggs?",
  "What's a filling snack under 200 calories?",
  "Is air-popped popcorn a good late-night snack?",
  "Does cooking spinach change its iron?",
  "What should I eat after a long walk?",
  "Is Greek yogurt worth it over regular?",
];

const SYSTEM = `You answer everyday food and nutrition questions inside a calorie-tracking app.

STYLE
- Answer the question first, in one or two sentences. Then at most two more sentences of useful detail.
- Plain language. No headers, no bullet lists, no markdown. This renders as a chat bubble.
- Real numbers when they help ("about 3 g of fiber in a medium banana"), and say when a number is approximate.
- Never open with a greeting or a restatement of the question.

SCOPE
- Food, nutrition, hydration, and general healthy-eating habits.
- You are given the user's targets and what they have logged today. USE IT. When they ask what
  to eat, answer against what is actually left for the day and what they have already had.
  Never ask them to paste in data you were given, and never claim you cannot see their diary.
- If today shows nothing logged, say so plainly and answer generally. That is different from
  not having access.
- A question that is odd, vague or a joke still gets a straight, good-humoured answer. Do not lecture.

LIMITS
- You give general information, not medical or clinical advice. If the question is about a diagnosed
  condition, a medication interaction, a supplement regimen, disordered eating, or a child's diet, answer
  what is general and safely known, then say plainly that it is worth checking with a doctor or dietitian.
- Never suggest a calorie target below what the app already set, and never encourage restriction,
  purging, fasting as weight control, or "earning" food with exercise.
- You cannot change the user's plan, targets or diary. If asked, say that is done in the Plan tab.`;

/**
 * Added for a "Find patterns" run, which is sent without today's context
 * (see `askHealth`). Without it the SCOPE lines above tell the model it has
 * today's diary, and it would report an empty day it was never shown.
 */
const PATTERNS_SCOPE = `THIS CONVERSATION
- The user shared their journal for a range of dates in their first message here. That range is all you
  have. You were not given today's diary or their targets, so the SCOPE lines about today do not apply.
- Answer from that range. If a question needs today's diary, say it is best asked from the home screen.`;

/**
 * Everything Ask Health should already know before the user says a word.
 *
 * This used to be three lines (targets, weight, direction), which meant
 * "what should I eat, based on what I've had today" got answered with "I
 * don't have today's diary loaded, paste it in". The user's own assistant
 * asking the user to copy out their own data is the wrong shape entirely.
 *
 * So: today in full, plus a few days of context for trends. Silently
 * degrades to whatever it could read.
 *
 * THE CHOKEPOINT: today's symptoms, weight and goal direction are consumer
 * health data, and handing them to the AI is a disclosure exactly like
 * "Find patterns": same consent, same DISCLOSURE_* wording (see
 * features/aiConsent.ts). askContext is the only place that builds this
 * string, and every question (the home card, and whatever calls it next)
 * goes through askHealth, so gating here, instead of in each caller, is what
 * makes it impossible for a future caller to route around consent by
 * forgetting to check it. A "Find patterns" run never gets this context at
 * all: it sends only its own range (see `askHealth`). No consent, no context:
 * not a trimmed-down context, because deciding what's "safe enough" to leak
 * without asking is the same mistake with extra steps. Fails CLOSED like
 * `hasAiJournalConsent` itself: any failure to confirm consent is treated as
 * no consent. `askHealth` checks the agreement before it gets here and sends
 * nothing at all without one; this check stays as the second lock on the one
 * place that reads today.
 */
async function askContext(): Promise<string> {
  if (!(await hasAiJournalConsent())) return "";

  try {
    const repo = await getRepository();
    const profile = await repo.getProfile().catch(() => null);
    const units = profile?.units ?? "metric";

    const [today, recent] = await Promise.all([
      daySnapshot(),
      // Yesterday and the day before. Enough for "am I usually short on
      // protein" without turning every question into a week's audit.
      recentSnapshots(3).then((d) => d.slice(0, -1)),
    ]);

    const parts = [`TODAY\n${renderDayForPrompt(today, units)}`];

    const bio: string[] = [];
    if (profile?.weightKg) bio.push(`Weight: ${fmtWeight(profile.weightKg, units)}.`);
    if (profile?.direction) {
      const dir =
        profile.direction === "lose"
          ? "losing weight"
          : profile.direction === "gain"
            ? "gaining weight"
            : "maintaining";
      bio.push(`Goal: ${dir}.`);
    }
    if (bio.length) parts.push(bio.join(" "));

    const prior = renderRecentForPrompt(recent);
    if (prior) parts.push(`RECENT DAYS\n${prior}`);

    return parts.join("\n\n");
  } catch {
    return "";
  }
}

/**
 * Read the conversation, oldest first: the turns asked under the agreement in
 * force, and nothing without one. Never throws.
 */
export async function loadAskHistory(): Promise<AskChatItem[]> {
  const agreement = await currentAiAgreement();
  if (!agreement) return [];
  const raw = await readJson<AskChatItem[]>(ASK_CHAT_PATH, []).catch(() => []);
  return Array.isArray(raw) ? turnsUnderAgreement(raw, agreement) : [];
}

/**
 * The turns asked under `agreement`, oldest first. Agreeing again starts a
 * fresh conversation (owner decision 2026-10-22, ConjureOS #1163), so a turn
 * asked before the agreement in force is neither shown nor sent, and nor is
 * anything stored before it. A withdrawal clears the file as well; this is
 * what holds when that clear failed, or when an answer from another device
 * was saved after it.
 *
 * A turn stored before turns carried a date says nothing about when it was
 * asked. It stays (shown, never sent: see `turnsToSend`) unless a dated turn
 * after it shows the file reaches back past the agreement.
 */
export function turnsUnderAgreement(history: AskChatItem[], agreement: AiJournalConsent): AskChatItem[] {
  const since = Date.parse(agreement.acceptedAt);
  if (!Number.isFinite(since)) return [];
  let start = 0;
  history.forEach((m, i) => {
    if (typeof m.at === "string" && !(Date.parse(m.at) >= since)) start = i + 1;
  });
  return history.slice(start);
}

/** Persist the conversation, trimmed to the most recent MAX_STORED turns. */
export async function saveAskHistory(items: AskChatItem[]): Promise<void> {
  await writeJson(ASK_CHAT_PATH, items.slice(-MAX_STORED)).catch(() => {});
}

/**
 * The earlier turns that may go out with a new question, oldest first.
 *
 * Every stored turn shares one file and one sheet, but not one disclosure, so
 * the replay is cut to what the consent sheet says each entry point sends
 * (ConjureOS #1163):
 *
 *   - From the home card: only turns asked from the home card TODAY. A turn
 *     from yesterday was answered with yesterday's window (yesterday plus the
 *     2 days before it), so replaying it would send data from 3 days back,
 *     against "anything from more than 2 days before today". A "Find
 *     patterns" turn never goes: it holds a whole range of the journal.
 *   - From a "Find patterns" run: only that run's own turns. Another run is
 *     another range, and a home card turn is today's data, both outside "the
 *     range you asked about".
 *
 * A turn with no `at` was stored before any of this was recorded, so nothing
 * says which entry point or day it came from. It stays out: the sheet still
 * shows it, it just never goes to the model again.
 */
export function turnsToSend(history: AskChatItem[], from: AskFrom, now: Date = new Date()): AskChatItem[] {
  const today = todayISO(now);
  const kept = history.filter((m) =>
    from.kind === "patterns"
      ? m.patternsRun === from.run
      : m.patternsRun === undefined && typeof m.at === "string" && todayISO(new Date(m.at)) === today,
  );
  const recent = kept.slice(-MAX_CONTEXT_TURNS);
  // The conversation sent to the model opens with the user; the cap can leave
  // an answer at the front whose question fell off.
  while (recent[0]?.role === "assistant") recent.shift();
  return recent;
}

/**
 * Answer one question, given the conversation so far (oldest first, WITHOUT
 * the new question) and the entry point it was asked from.
 *
 * Returns the reply text, or null when there is nothing to keep: no
 * agreement is in force, so nothing was sent, or the agreement was withdrawn
 * while the question was out, so its answer is thrown away. Never throws and
 * never mutates anything but the conversation: a failed call comes back as a
 * sentence the user can read.
 *
 * THE GATE for every entry point. Owner decision, 2026-10-22 (ConjureOS
 * #1163): "Withdrawn consent means they have withdrawn consent." Without a
 * current agreement nothing leaves: not the question, not an earlier turn,
 * not today's context, not a Find patterns range. It used to send the
 * question and the earlier turns with no context, and a Find patterns
 * follow-up resent the whole month, unchecked. The agreement is checked
 * before anything is read, again after the last read and just before the
 * request, and again when the answer lands.
 */
export async function askHealth(
  question: string,
  history: AskChatItem[] = [],
  from: AskFrom = ASK_FROM_HOME,
): Promise<string | null> {
  const q = question.trim();
  if (!q) return "";
  const asked = aiConsentGeneration();
  const agreement = await currentAiAgreement();
  if (!agreement || asked !== aiConsentGeneration()) return null;
  if (!isAiAvailable()) {
    return "I need the ConjureOS AI service to answer, and I can't reach it from here. Open Conjure Health inside ConjureOS and try again.";
  }

  // A "Find patterns" run carries its own range in its opening question, and
  // nothing else: no today, no 2 days before.
  const ctx = from.kind === "patterns" ? "" : await askContext();
  // Reading today takes several reads, and a withdrawal can land during any
  // of them, here or on another device. So the agreement is checked again
  // after the last of them, and nothing below waits on anything before the
  // request goes: a question that passed the gate above does not go out
  // after a withdrawal with today's health data on it.
  if (!(await stillAgreed(asked, agreement))) return null;
  const messages: ChatMessage[] = [
    ...turnsToSend(turnsUnderAgreement(history, agreement), from).map(
      (m) => ({ role: m.role, content: m.content }) as ChatMessage,
    ),
    { role: "user", content: q },
  ];
  const system =
    from.kind === "patterns"
      ? `${SYSTEM}\n\n${PATTERNS_SCOPE}`
      : ctx
        ? `${SYSTEM}\n\nABOUT THIS USER\n${ctx}`
        : SYSTEM;

  let text: string;
  try {
    const reply = await complete({
      system,
      messages,
      maxTokens: 400,
      tier: "capable",
    });
    text = reply.trim() || "I couldn't come up with an answer to that one. Try asking it a different way?";
  } catch (err) {
    text = aiErrorMessage(err, "Something went wrong reaching the AI service. Try again in a moment.");
  }
  // A withdrawal that landed while the question was out, here or on another
  // device, throws the answer away, failure sentence included: nothing of it
  // is shown or kept. So does a withdrawal followed by a new agreement, which
  // starts a fresh conversation.
  if (!(await stillAgreed(asked, agreement))) return null;
  return text;
}

/**
 * Whether the agreement a question was asked under still holds: no
 * withdrawal or new agreement in this session since `asked`, and the same
 * agreement on file, since another device can withdraw, or withdraw and agree
 * again, and this session only sees the profile change.
 */
async function stillAgreed(asked: number, agreement: AiJournalConsent): Promise<boolean> {
  if (asked !== aiConsentGeneration()) return false;
  const still = await currentAiAgreement();
  return asked === aiConsentGeneration() && still?.acceptedAt === agreement.acceptedAt;
}

/**
 * One question asked from a sheet: the conversation with the question and its
 * answer added, both stamped with when it was asked and, for a "Find
 * patterns" run, the run. Those stamps are what `turnsToSend` reads on the
 * next question, so the sheet stores through this and never builds turns of
 * its own.
 *
 * `onAsked` gets the conversation with the question added, before the answer
 * arrives, so the sheet can show it in flight.
 *
 * Null when `askHealth` has nothing to keep (no agreement in force, or one
 * withdrawn while the question was out): the sheet then keeps nothing, on
 * screen or on disk.
 */
export async function askAndAppend(
  question: string,
  history: AskChatItem[],
  from: AskFrom,
  onAsked?: (items: AskChatItem[]) => void,
  now: Date = new Date(),
): Promise<AskChatItem[] | null> {
  const stamp = from.kind === "patterns" ? { at: now.toISOString(), patternsRun: from.run } : { at: now.toISOString() };
  const withUser: AskChatItem[] = [...history, { role: "user", content: question, ...stamp }];
  onAsked?.(withUser);
  const reply = await askHealth(question, history, from);
  if (reply === null) return null;
  return [...withUser, { role: "assistant", content: reply, ...stamp }];
}
