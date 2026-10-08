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
 * conversation started here is still there when the trainer comes back.
 */

import { aiErrorMessage, complete, isAiAvailable, type ChatMessage } from "../../bridge/ai";
import { readJson, writeJson } from "../../bridge/vfs";
import { hasAiJournalConsent } from "../aiConsent";
import { loadAskFacts, renderAskContext } from "./askSummary";
import type { CoachChatItem } from "./model";

const CHAT_PATH = "coach-chat.json";

/** Turns kept on disk. Old turns fall off the top; the cap keeps the doc small
 *  enough to stay cheap to read on every home render. */
const MAX_STORED = 40;

/** Turns sent as context on a new question. Enough for follow-ups ("what about
 *  the green ones?") without paying for the whole history every time. */
const MAX_CONTEXT_TURNS = 10;

/**
 * The rotating prompts under the ask box. They exist to teach the shape of a
 * good question, so they lean concrete and everyday rather than clever. Half
 * are about the user's own numbers and half are general food questions,
 * alternating, so a few seconds of watching shows both kinds. Only ask what
 * the coach can answer from what it is sent: nothing about streaks or body
 * measurements, which the app does not track.
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
  "What should I eat with what I have left today?",
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
  dates, and answer what to eat from what is left today.
- Never ask them to paste in data you were given, and never claim you cannot see their diary.
- A missing section means nothing of that kind was logged: say so and answer generally. Streaks and body
  measurements are not tracked, so do not invent them. Water is shown against a 2 litre (64 oz) rule of thumb.
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
  1% of body weight a week, mention it gently once and suggest a doctor or dietitian. Low days may be unlogged meals.
- Never suggest a calorie target below what the app already set, and never encourage restriction,
  purging, fasting as weight control, or "earning" food with exercise.
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
 * forgetting to check it. No consent, no context, and nothing is even read:
 * not a trimmed-down context, because deciding what is "safe enough" to leak
 * without asking is the same mistake with extra steps. Fails CLOSED like
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
  const messages: ChatMessage[] = [
    ...history
      .slice(-MAX_CONTEXT_TURNS)
      .map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
    { role: "user", content: q },
  ];

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
