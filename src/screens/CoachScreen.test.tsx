import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatMessage } from "../bridge/ai";
import type { CoachChatItem } from "../features/coach/model";
import { patternsQuestion } from "../features/coach/ask";
import { runtime } from "../testing/hooks";

vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  const { runtime: rt } = await import("../testing/hooks");
  const api = { ...actual, ...rt.hooks };
  return { ...api, default: api };
});

/** What coach-chat.json holds when the screen opens, and what was written. */
let stored: CoachChatItem[] = [];
let written: CoachChatItem[] | null = null;
vi.mock("../bridge/vfs", () => ({
  readJson: async () => stored,
  writeJson: async (_p: string, v: CoachChatItem[]) => void (written = v),
}));
vi.mock("../features/coach/context", () => ({ buildCoachContext: async () => ({}) }));
/** Every conversation the trainer was sent. */
const sent: ChatMessage[][] = [];
vi.mock("../features/coach/coach", () => ({
  coachChat: async (history: ChatMessage[]) => {
    sent.push(history);
    return { reply: "ok" };
  },
}));

const NOTE = "after a fight with my partner";
const JOURNAL = `2026-09-03: 2140 cal from 9 items; symptoms: Headache at 14:00 (3/5) (note: ${NOTE}); ate: coffee`;

beforeEach(() => {
  runtime.reset();
  sent.length = 0;
  stored = [];
  written = null;
});

/**
 * The trainer (paused with the workouts) reads the same chat file as "Ask
 * your health coach", where Find patterns stores its question with the whole
 * range of the journal, symptom notes included when they were opted in. The
 * consent wording promises that journal goes once, with that question, so
 * turning the trainer back on must not resend it.
 */
describe("the trainer's conversation", () => {
  it("leaves out a Find patterns journal, and the answer that can quote its notes", async () => {
    stored = [
      { role: "user", content: patternsQuestion("2026-09-01", "2026-09-30", JOURNAL) },
      { role: "assistant", content: `You noted "${NOTE}" before the headache.` },
    ];
    const { CoachScreen } = await import("./CoachScreen");
    await runtime.render(CoachScreen, { onPlanChange: () => {}, initialPrompt: "How is my week going?" });
    expect(sent).toHaveLength(1);
    const history = sent[0]!;
    expect(JSON.stringify(history)).not.toContain(NOTE);
    expect(JSON.stringify(history)).not.toContain("cal from");
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(history[2]!.content).toBe("How is my week going?");
  });

  it("keeps its own answers after such a journal, since it was asked without the notes", async () => {
    const { CoachScreen } = await import("./CoachScreen");
    const { historyForPrompt } = await import("../features/coach/ask");
    stored = [
      { role: "user", content: patternsQuestion("2026-09-01", "2026-09-30", JOURNAL) },
      { role: "assistant", content: `You noted "${NOTE}" before the headache.` },
    ];
    await runtime.render(CoachScreen, { onPlanChange: () => {}, initialPrompt: "How is my week going?" });
    expect(written).toHaveLength(4);
    // Its reply is resent whole with the next question, here or from the home card.
    expect(historyForPrompt(written!).at(-1)).toEqual({ role: "assistant", content: "ok" });
  });

  it("sends everything else as it was stored", async () => {
    stored = [
      { role: "user", content: "Can I swap Monday's run?" },
      { role: "assistant", content: "Sure, Tuesday works.", redactedHistory: true },
    ];
    const { CoachScreen } = await import("./CoachScreen");
    await runtime.render(CoachScreen, { onPlanChange: () => {}, initialPrompt: "Here is my journal for today: eggs." });
    expect(sent[0]).toEqual([
      { role: "user", content: "Can I swap Monday's run?" },
      { role: "assistant", content: "Sure, Tuesday works." },
      { role: "user", content: "Here is my journal for today: eggs." },
    ]);
  });
});
