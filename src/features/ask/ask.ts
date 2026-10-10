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
import { hasAiJournalConsent } from "../aiConsent";
import { fmtWeight } from "../units";

/** One turn of the conversation, as stored and as sent. */
export interface AskChatItem {
  role: "user" | "assistant";
  content: string;
}

/**
 * Where the conversation is stored. The name predates Ask Health and stays:
 * renaming the file would orphan every existing user's questions. Older
 * versions may have left extra fields on a turn here; only `role` and
 * `content` are read.
 */
const CHAT_PATH = "coach-chat.json";

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
 * string, and every caller (the home card, the journal's "Find patterns",
 * and whatever calls it next) goes through askHealth, so gating here,
 * instead of in each caller, is what makes it impossible for a future caller
 * to route around consent by forgetting to check it. No consent, no context:
 * not a trimmed-down context, because deciding what's "safe enough" to leak
 * without asking is the same mistake with extra steps. Fails CLOSED like
 * `hasAiJournalConsent` itself: any failure to confirm consent is treated as
 * no consent.
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

/** Read the stored conversation, oldest first. Never throws. */
export async function loadAskHistory(): Promise<AskChatItem[]> {
  const raw = await readJson<AskChatItem[]>(CHAT_PATH, []).catch(() => []);
  return Array.isArray(raw) ? raw : [];
}

/** Persist the conversation, trimmed to the most recent MAX_STORED turns. */
export async function saveAskHistory(items: AskChatItem[]): Promise<void> {
  await writeJson(CHAT_PATH, items.slice(-MAX_STORED)).catch(() => {});
}

/**
 * Answer one question, given the conversation so far (oldest first, WITHOUT
 * the new question).
 *
 * Returns the reply text. Never throws and never mutates anything but the
 * conversation: a failed call comes back as a sentence the user can read.
 */
export async function askHealth(question: string, history: AskChatItem[] = []): Promise<string> {
  const q = question.trim();
  if (!q) return "";
  if (!isAiAvailable()) {
    return "I need the ConjureOS AI service to answer, and I can't reach it from here. Open Conjure Health inside ConjureOS and try again.";
  }

  const ctx = await askContext();
  const messages: ChatMessage[] = [
    ...history
      .slice(-MAX_CONTEXT_TURNS)
      .map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
    { role: "user", content: q },
  ];

  try {
    const reply = await complete({
      system: ctx ? `${SYSTEM}\n\nABOUT THIS USER\n${ctx}` : SYSTEM,
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
