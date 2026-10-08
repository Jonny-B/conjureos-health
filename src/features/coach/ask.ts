/**
 * "Ask your health coach": the always-available Q&A on the home screen, and
 * the chat that "Find patterns" in the journal opens.
 *
 * It answers questions about anything the user has logged (food, water,
 * sleep, symptoms, exercise, weight and its trend, their targets and how far
 * through their plan they are) from their real data, and everyday food and
 * nutrition questions besides.
 *
 * Strictly read-only, and deliberately NOT the trainer in coach.ts. That one
 * proposes and applies plan changes through tags it emits, adjusts programs
 * and writes long-term memory, and it is paused with the rest of the workout
 * features (see features/flags). This one has no tags, no tools and no write
 * path: asked to change something, it says what to change and where in the
 * app, and the user does it. The only thing this module writes is the chat
 * history document.
 *
 * History shares `coach-chat.json` with the full coach screen, so a
 * conversation started here is still there when the trainer comes back. The
 * last MAX_CONTEXT_TURNS turns of it go with each question, except the journal
 * a Find patterns question carried and any answer that can quote its notes
 * (see redactHistory, which the coach screen sends its history through too),
 * and none of it without consent.
 */

import { aiErrorMessage, complete, isAiAvailable, type ChatMessage } from "../../bridge/ai";
import { readJson, writeJson } from "../../bridge/vfs";
import { hasAiJournalConsent } from "../aiConsent";
import { SYMPTOM_NOTE_OPEN } from "../journal";
import { loadAskFacts, renderAskContext } from "./askSummary";
import type { CoachChatItem } from "./model";

const CHAT_PATH = "coach-chat.json";

/** Turns kept on disk. Old turns fall off the top; the cap keeps the doc small
 *  enough to stay cheap to read on every home render. */
const MAX_STORED = 40;

/** Turns sent as context on a new question. Enough for follow-ups ("what about
 *  the green ones?") without paying for the whole history every time. The
 *  consent wording names this number (DISCLOSURE_SENDS), and a test holds
 *  them together. */
export const MAX_CONTEXT_TURNS = 10;

/**
 * The rotating prompts under the ask box. They exist to teach the shape of a
 * good question, so they lean concrete and everyday rather than clever. Half
 * are about the user's own numbers and half are general food questions,
 * alternating, so a few seconds of watching shows both kinds. Only ask what
 * the coach can answer from what it is sent, for every user, since every user
 * sees them: nothing about body measurements, which the app does not track,
 * streaks beyond the food-logging run, or what is left of the daily targets,
 * which some users are not sent (askSummary.ts gateFor).
 */
export const ASK_SUGGESTIONS: readonly string[] = [
  "How has my weight changed this month?",
  "Are bananas high in fiber?",
  "Am I getting enough protein this week?",
  "What's a filling snack under 200 calories?",
  "How am I doing against my plan?",
  "How much protein is in two eggs?",
  "Is my water on track today?",
  "Is Greek yogurt worth it over regular?",
  "How has my sleep been this week?",
  "What should I eat next, given what I've had today?",
];

const SYSTEM = `You are the health coach inside Conjure Health, a calorie and health tracking app.

STYLE
- Answer the question first, in one or two sentences. Then at most two more sentences of useful detail.
- Plain language. No headers, no bullet lists, no markdown. This renders as a chat bubble.
- Real numbers when they help ("about 3 g of fiber in a medium banana"), and say when a number is approximate.
- No greeting, no restating the question, no em-dashes.

SCOPE
- Anything they have logged (food, water, sleep, symptoms, exercise, weight trend, targets, plan progress), plus
  everyday food and nutrition questions.
- What they have logged is summarised at the end of this prompt. USE IT: answer from their real numbers and
  dates, and, when TODAY gives their targets, answer what to eat from what is left of them.
- Never ask them to paste in data you were given, and never claim you cannot see their diary.
- A section missing from the summary means nothing of that kind was logged: say so and answer generally. What
  is listed under COULD NOT READ THIS TIME failed to load for this question: say you could not read it this
  time, never that it was not logged.
- The only streak the app keeps is the "in a row" count of days with food logged; do not invent any other.
  Body measurements are not tracked. Water is shown against a 2 litre (64 oz) rule of thumb.
- A question that is odd, vague or a joke still gets a straight, good-humoured answer. Do not lecture.

LIMITS
- You are not a doctor and never diagnose. You give general information, not medical or clinical advice. If the
  question is about a diagnosed condition, a medication interaction, a supplement regimen, disordered eating, or
  a child's diet, answer what is general and safely known, then say plainly that it is worth checking with a
  doctor or dietitian.
- Discuss logged symptoms, but never name their cause. For pain, injury or a worrying symptom, suggest a
  professional; for chest pain, shortness of breath or dizziness, say to stop and seek medical help.
- Talk about weight neutrally; never praise fast loss or eating very little. If several logged days are far
  below target or under 1200 cal (1500 for men or sex not given), or weight is falling faster than about
  1% of body weight a week (the summary says so when its weigh-ins can show it; with too few to tell, judge
  from the dated changes), mention it gently once and suggest a doctor or dietitian. Low days may be
  unlogged meals.
- Never suggest a calorie target below what the app already set, and never encourage restriction,
  purging, fasting as weight control, or "earning" food with exercise.
- If the summary says their goal weight is below a healthy range, never help them toward it or say how long it
  would take. Say gently that it is worth talking over with a doctor or dietitian. Treat a weight they name
  themselves the same way when it is below a healthy range for their height.
- If the summary says their current weight is below a healthy range, never help them lose weight or eat
  less, whatever they ask. Helping them gain weight or eat enough is fine. Say gently, once, that it is worth
  talking over with a doctor or dietitian.
- If the summary says tracking only, or gives an age under 18, do not suggest weight loss, a goal weight, eating
  less or exercise to do, and do not tell them to drink more or less, since a doctor may have set how much they
  drink. Answer from what they logged, keep the rest general, and suggest their doctor.
- You are not told about injuries or health conditions. Never prescribe a workout, specific exercises or an
  intensity. For exercise ideas keep to general, gentle movement, and say to work around any injury and check
  with a doctor or physio first.
- You are read-only. You cannot change the user's plan, targets, diary or any entry, and never say you did. If
  asked, say what to change and where: entries on the Diary tab (past days on the Journal tab); the plan, goal
  weight and targets in Edit plan on the Plan tab.`;

/** Appended in place of the user's data when they have not agreed to share
 *  it, so the model neither invents a diary nor pretends to see one. */
const NO_CONSENT_NOTE = `NO USER DATA
There is no summary this time: the user has not agreed to share what they log, so you cannot see it. Answer
generally. If they ask about their entries, say the app asks for that agreement when they ask from the home
screen card or use Find patterns.`;

/** Appended when consent is on file but nothing could be read. */
const UNREADABLE_NOTE = `NO USER DATA
Their logged data could not be read for this question. Answer generally, and say so if they asked about their own entries.`;

/**
 * Everything the coach should already know before the user says a word: today
 * in full, then short summaries of their profile, weight, plan and the week
 * before today (see askSummary.ts for what each holds and what it leaves out).
 * Silently degrades to whatever it could read.
 *
 * THE CHOKEPOINT: this is consumer health data, and handing it to the AI is a
 * disclosure exactly like "Find patterns": same consent, same DISCLOSURE_*
 * wording (see features/aiConsent.ts). askContext is the only place that
 * builds this string, and every caller of askCoach (the journal's coach chat,
 * the home screen's "Ask your health coach" card, and whatever calls it next)
 * goes through askCoach, so gating here, instead of in each caller, is what
 * makes it impossible for a future caller to route around consent by
 * forgetting to check it. No consent, no context, and nothing is even read
 * (askCoach sends no stored conversation either, since its answers quote
 * what they logged): not a trimmed-down context, because deciding what is
 * "safe enough" to leak without asking is the same mistake with extra
 * steps. Fails CLOSED like
 * `hasAiJournalConsent` itself: any failure to confirm consent is treated as
 * no consent.
 *
 * Returns null when there is no consent, and "" when there is consent but
 * nothing could be read.
 */
async function askContext(): Promise<string | null> {
  if (!(await hasAiJournalConsent())) return null;
  try {
    return renderAskContext(await loadAskFacts());
  } catch {
    return "";
  }
}

/**
 * Whether the next `askCoach()` call will run WITHOUT personal context,
 * because there's no current consent on file — so a caller can show
 * `AiConsentSheet` first instead of silently getting a generic answer.
 *
 * `askContext()` enforces the actual rule (see above); this just exposes the
 * same check under a name that makes sense to a caller who has never heard of
 * `aiConsent.ts`. `JournalScreen.askPatterns` checks the lower-level
 * `hasAiJournalConsent()` directly for the same reason — either is fine, this
 * one just lives next to `askCoach` for callers that only import from here.
 */
export async function coachNeedsConsent(): Promise<boolean> {
  return !(await hasAiJournalConsent());
}

/**
 * The opening of a Find patterns question: one line, a blank line, then the
 * journal for the range, symptom notes included when the user opted in.
 * Matches what patternsQuestion builds and what JournalScreen built before it
 * (same first sentence), so history saved by either is recognised.
 */
const JOURNAL_TURN = /^Here is my journal for (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})\.[^\n]*\n\n/;

/** What a Find patterns question asks, after the sentence naming the range. */
const PATTERNS_ASK = "What patterns do you notice? Anything that seems to go together?";

/**
 * The question "Find patterns" asks, with the journal for the range (from
 * journal.summarizeRange) after it. Built here so historyForPrompt can find
 * the journal again and leave it out of later questions.
 */
export function patternsQuestion(from: string, to: string, summary: string): string {
  return summary
    ? `Here is my journal for ${from} to ${to}. ${PATTERNS_ASK}\n\n${summary}`
    : `I have nothing recorded for ${from} to ${to}. What would be worth tracking to spot patterns?`;
}

/** Sent in place of the coach's answer to a journal that carried notes. It
 *  gives no reason: the check below can be wrong about an earlier build's
 *  journal, and the model must never tell a user their notes were sent when
 *  they may not have been. */
const NOTED_ANSWER = "[The answer to that journal is not repeated here. Like the journal, it went with that question only.]";

/** Sent in place of an answer stored by a build before 1.40.4 (see
 *  redactHistory). */
const EARLIER_ANSWER = "[This answer is from an earlier version of the app, and is not repeated here.]";

/**
 * Whether a stored Find patterns question carried a symptom note.
 * summarizeRange opens one with SYMPTOM_NOTE_OPEN. Builds before 1.40.4
 * opened one with a spaced em-dash, and asked a question with a dash in it
 * too, so a dash counts only in a question that is not this build's: in this
 * build's journal a dash can only be part of a food or symptom name (smart
 * punctuation turns "--" into one), and reading it as a note would hide the
 * answer to a journal that carried none. Any wording but this build's counts
 * as earlier, so a journal from a build this check has not seen is treated
 * the careful way.
 */
function journalHadNotes(content: string): boolean {
  const head = JOURNAL_TURN.exec(content);
  if (!head) return false;
  const journal = content.slice(head[0].length);
  if (journal.includes(SYMPTOM_NOTE_OPEN)) return true;
  const thisBuild = head[0] === `Here is my journal for ${head[1]} to ${head[2]}. ${PATTERNS_ASK}\n\n`;
  return !thisBuild && journal.includes(" \u2014 ");
}

/**
 * How an answer from askCoach is stored: marked as asked with the
 * conversation as redactHistory leaves it, so no journal and no note from an
 * earlier question went with it, and a later question can resend it whole.
 * CoachChatModal stores every answer through this, and so does the trainer's
 * CoachScreen, whose history goes through redactHistory too.
 */
export function answerItem(reply: string): CoachChatItem {
  return { role: "assistant", content: reply, redactedHistory: true };
}

/**
 * The stored conversation as it may go to the AI again, one item for each
 * stored one and in the same order: the journal taken out of any Find
 * patterns question, and an answer left out when it can quote a symptom
 * note. Anything else on an item (a trainer's proposal) is kept.
 *
 * That journal is sent once, with the question that asked for it. Sent again
 * with each later question it would carry a month of data, and any symptom
 * notes, into coach questions whose consent wording (aiConsent.ts) promises
 * the 7 days before today and notes only through Find patterns, once; it
 * would keep doing so after notes were switched off in Settings; and it would
 * cost a month of tokens per follow-up. The question itself stays, marked,
 * so the coach's own answer to it still makes sense.
 *
 * The answer stays too, unless the journal carried notes: a pattern-finding
 * answer quotes the journal back, and a note it quotes would go out again
 * with every follow-up.
 *
 * Every answer without the answerItem mark is left out as well, journal or
 * no journal. Builds before 1.40.4 resent the recent conversation word for
 * word, journal included, so any answer they gave can quote a note, or quote
 * an answer that did. Which ones did cannot be told from the file: the
 * journal they followed is trimmed off the front (MAX_STORED) long before
 * they are, by this build or by the one that wrote them. Answers given
 * since are asked without it, carry the mark, and are kept.
 */
export function redactHistory(items: CoachChatItem[]): CoachChatItem[] {
  return items.map((m, i): CoachChatItem => {
    if (m.role === "user") {
      const head = JOURNAL_TURN.exec(m.content);
      if (!head) return m;
      return {
        ...m,
        content: `${head[0].trimEnd()}\n\n[Their journal for ${head[1]} to ${head[2]} went with that question only, and is not repeated here.]`,
      };
    }
    const asked = items[i - 1];
    if (asked?.role === "user" && journalHadNotes(asked.content)) return { ...m, content: NOTED_ANSWER };
    if (!m.redactedHistory) return { ...m, content: EARLIER_ANSWER };
    return m;
  });
}

/**
 * The stored conversation as it goes with a new question: the last
 * MAX_CONTEXT_TURNS turns of redactHistory. Worked out over the whole history
 * before the last turns are taken, since an answer can be inside them when
 * the journal it could quote is not.
 */
export function historyForPrompt(items: CoachChatItem[]): ChatMessage[] {
  return redactHistory(items)
    .slice(-MAX_CONTEXT_TURNS)
    .map(({ role, content }) => ({ role, content }));
}

/** Read the stored conversation, oldest first. Never throws. */
export async function loadAskHistory(): Promise<CoachChatItem[]> {
  const raw = await readJson<CoachChatItem[]>(CHAT_PATH, []).catch(() => []);
  return Array.isArray(raw) ? raw : [];
}

/** Persist the conversation, trimmed to the most recent MAX_STORED turns. */
export async function saveAskHistory(items: CoachChatItem[]): Promise<void> {
  await writeJson(CHAT_PATH, items.slice(-MAX_STORED)).catch(() => {});
}

/**
 * Answer one question, given the conversation so far (oldest first, WITHOUT
 * the new question).
 *
 * Returns the reply text. Never throws and never writes anything (the caller
 * saves the conversation with saveAskHistory); a failed call comes back as a
 * sentence the user can read.
 */
export async function askCoach(question: string, history: CoachChatItem[] = []): Promise<string> {
  const q = question.trim();
  if (!q) return "";
  if (!isAiAvailable()) {
    return "I need the ConjureOS AI service to answer, and it isn't available at the moment. Open Conjure Health inside ConjureOS and try again.";
  }

  const ctx = await askContext();
  const system =
    ctx === null
      ? `${SYSTEM}\n\n${NO_CONSENT_NOTE}`
      : ctx
        ? `${SYSTEM}\n\nABOUT THIS USER\n${ctx}`
        : `${SYSTEM}\n\n${UNREADABLE_NOTE}`;
  // No consent, no conversation either: the coach's earlier answers quote
  // what they logged (their weigh-ins, symptoms, meals), and a sheet left
  // open while consent is withdrawn still asks its follow-ups through here.
  const prior = ctx === null ? [] : historyForPrompt(history);
  const messages: ChatMessage[] = [...prior, { role: "user", content: q }];

  try {
    const reply = await complete({
      system,
      messages,
      maxTokens: 400,
      tier: "capable",
    });
    const text = reply.trim();
    return text || "I couldn't come up with an answer to that one. Try asking it a different way?";
  } catch (err) {
    return aiErrorMessage(err, "Something went wrong reaching the AI service. Try again in a moment.");
  }
}
