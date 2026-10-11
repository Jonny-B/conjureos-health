import { describe, it, expect, vi, beforeEach } from "vitest";
import { ASK_SUGGESTIONS } from "./ask";
import { DISCLOSURE_VERSION } from "../aiConsent";
import type { AiJournalConsent } from "../../types";

const complete = vi.fn();
const files: Record<string, string> = {};
let aiAvailable = true;

vi.mock("../../bridge/ai", async (orig) => ({
  ...(await orig<typeof import("../../bridge/ai")>()),
  complete: (...a: unknown[]) => complete(...a),
  isAiAvailable: () => aiAvailable,
}));
vi.mock("../../bridge/vfs", () => ({
  readJson: async (p: string, d: unknown) => (files[p] ? JSON.parse(files[p]) : d),
  writeJson: async (p: string, v: unknown) => {
    files[p] = JSON.stringify(v);
  },
}));
const today = new Date().toISOString().slice(0, 10);
const food = (name: string, cal: number, p: number) => ({
  id: name, source: "usda", name, servingSize: "1 serving",
  perServing: { calories: cal, protein: p, carbs: 10, fat: 5 },
});
// Whether the standing profile has a current AI-journal agreement on file.
// Every test in "personal context requires consent" below drives this
// directly; every other test leaves it granted, because THIS file's job is
// "does askHealth answer correctly", not re-litigating consent on every case.
let consent: AiJournalConsent | undefined = {
  version: DISCLOSURE_VERSION,
  acceptedAt: "2026-01-01T00:00:00.000Z",
  includeNotes: false,
};
vi.mock("../../data/repository", () => ({
  getRepository: async () => ({
    getGoals: async () => ({ calories: 2200, protein: 150, carbs: 200, fat: 70 }),
    getProfile: async () => ({
      units: "imperial",
      weightKg: 81,
      direction: "lose",
      aiJournalConsent: consent,
    }),
    listDiary: async (d: string) =>
      d === today
        ? [
            { id: "1", date: d, meal: "breakfast", quantity: 1, loggedAt: `${d}T08:00:00Z`,
              food: food("Greek yogurt", 150, 25) },
            { id: "2", date: d, meal: "lunch", quantity: 2, loggedAt: `${d}T12:00:00Z`,
              food: food("Tortilla chips", 300, 4) },
          ]
        : [],
    listWater: async () => [],
    listSleep: async () => [],
    // A symptom on today, present regardless of consent. daySnapshot()
    // itself doesn't know about consent; askContext() is what must refuse
    // to forward it. See "personal context requires consent" below.
    listSymptoms: async (d: string) =>
      d === today ? [{ id: "s1", label: "Heartburn", loggedAt: `${d}T21:40:00Z`, severity: 3 }] : [],
    listWeights: async () => [],
  }),
}));
vi.mock("../exercise", () => ({ exerciseCaloriesForDate: async () => 0 }));

beforeEach(() => {
  complete.mockReset();
  aiAvailable = true;
  for (const k of Object.keys(files)) delete files[k];
  consent = { version: DISCLOSURE_VERSION, acceptedAt: "2026-01-01T00:00:00.000Z", includeNotes: false };
});

/** The system prompt and settings askHealth sent on its one call. */
function sentRequest(): { system: string; tier: string; maxTokens: number; messages: { content: string }[] } {
  return complete.mock.calls[0]![0];
}

describe("askHealth", () => {
  it("answers and never proposes a plan change", async () => {
    const { askHealth } = await import("./ask");
    complete.mockResolvedValue("A medium banana has about 3 g of fiber.");
    const reply = await askHealth("Are bananas high in fiber?");
    expect(reply).toContain("3 g of fiber");
    expect(sentRequest().system).toMatch(/cannot change the user's plan/i);
  });

  /**
   * Renaming the feature must not move what it does. These are the prompt's
   * own scope and limit lines, verbatim, plus the model tier and answer
   * length it has always run at.
   */
  it("keeps its scope: everyday food and nutrition, general information, nothing changed", async () => {
    const { askHealth } = await import("./ask");
    complete.mockResolvedValue("ok");
    await askHealth("anything");
    const req = sentRequest();
    expect(req.tier).toBe("capable");
    expect(req.maxTokens).toBe(400);
    for (const line of [
      "You answer everyday food and nutrition questions inside a calorie-tracking app.",
      "- Food, nutrition, hydration, and general healthy-eating habits.",
      "- A question that is odd, vague or a joke still gets a straight, good-humoured answer. Do not lecture.",
      "- You give general information, not medical or clinical advice.",
      "- Never suggest a calorie target below what the app already set, and never encourage restriction,",
      "  purging, fasting as weight control, or \"earning\" food with exercise.",
      "- You cannot change the user's plan, targets or diary. If asked, say that is done in the Plan tab.",
    ]) {
      expect(req.system).toContain(line);
    }
  });

  it("keeps its prompt inside the copy rules: no em-dashes", async () => {
    const { askHealth } = await import("./ask");
    complete.mockResolvedValue("ok");
    await askHealth("anything");
    expect(sentRequest().system).not.toContain("—");
  });

  it("tells the model the user's own targets so answers can be specific", async () => {
    const { askHealth } = await import("./ask");
    complete.mockResolvedValue("ok");
    await askHealth("What should I snack on?");
    const req = sentRequest();
    expect(req.system).toContain("2200 cal");
    expect(req.system).toContain("losing weight");
  });

  /**
   * The reported bug: asked what to eat "based on what I've eaten and what my
   * macros are", the assistant replied that it didn't have today's diary
   * loaded and asked the user to paste it in. It was never given the diary.
   */
  it("sends what was eaten TODAY, by meal", async () => {
    const { askHealth } = await import("./ask");
    complete.mockResolvedValue("ok");
    await askHealth("what should I eat for dinner?");
    const sys = sentRequest().system;
    expect(sys).toContain("Greek yogurt");
    expect(sys).toContain("2× Tortilla chips");
    expect(sys).toMatch(/Breakfast:/);
    expect(sys).toMatch(/Lunch:/);
  });

  it("does the subtraction so the model doesn't have to", async () => {
    const { askHealth } = await import("./ask");
    complete.mockResolvedValue("ok");
    await askHealth("what's left?");
    const sys = sentRequest().system;
    // 150 + 600 eaten of 2200; 25 + 8 protein of 150.
    expect(sys).toContain("Eaten so far: 750 cal");
    expect(sys).toContain("Remaining, negative means over (1450 cal");
    expect(sys).toContain("117g protein");
  });

  it("forbids the 'I can't see your diary' answer", async () => {
    const { askHealth } = await import("./ask");
    complete.mockResolvedValue("ok");
    await askHealth("anything");
    const sys = sentRequest().system;
    expect(sys).toMatch(/never claim you cannot see their diary/i);
    expect(sys).toMatch(/Never ask them to paste in data you were given/i);
  });

  it("sends prior turns so follow-ups make sense", async () => {
    const { askHealth } = await import("./ask");
    complete.mockResolvedValue("ok");
    await askHealth("what about the green ones?", [
      { role: "user", content: "are bananas high in fiber?" },
      { role: "assistant", content: "about 3 g" },
    ]);
    const req = sentRequest();
    expect(req.messages).toHaveLength(3);
    expect(req.messages[2]!.content).toBe("what about the green ones?");
  });

  it("returns a readable sentence instead of throwing when the call fails", async () => {
    const { askHealth } = await import("./ask");
    complete.mockRejectedValue(new Error("network"));
    await expect(askHealth("anything?")).resolves.toMatch(/try again/i);
  });

  /**
   * A rejected call comes back as the reply bubble, worded by aiErrorMessage.
   * These are the host's "no AI here", "no permission" and rate-limit
   * rejections: the same unavailable situations as the branch below, reached
   * from inside ConjureOS, so the reply is held to the same copy rules.
   */
  it.each([
    ["AI provider not configured", /isn't available here/i],
    ["Supabase isn't configured.", /isn't available here/i],
    ["ai.complete is not available in this host", /isn't available here/i],
    ["app does not have ai.complete permission", /AI permission/i],
    ["ai.complete rate limit (per-minute): too many AI calls", /wait/i],
  ])("words a host rejection (%s) inside the copy rules", async (reason, shape) => {
    const { askHealth } = await import("./ask");
    complete.mockRejectedValue(new Error(reason));
    const reply = await askHealth("Are bananas high in fiber?");
    expect(reply).toMatch(shape);
    expect(reply).not.toMatch(/\b(now|no longer|yet)\b/i);
    expect(reply).not.toContain("\u2014");
  });

  it("explains, inside the copy rules, when there is no AI service to ask", async () => {
    aiAvailable = false;
    const { askHealth } = await import("./ask");
    const reply = await askHealth("anything?");
    expect(reply).toMatch(/ConjureOS AI service/);
    expect(reply).not.toMatch(/\b(now|no longer|yet)\b/i);
    expect(reply).not.toContain("—");
    expect(complete).not.toHaveBeenCalled();
  });

  it("ignores an empty question", async () => {
    const { askHealth } = await import("./ask");
    expect(await askHealth("   ")).toBe("");
    expect(complete).not.toHaveBeenCalled();
  });

  it("round-trips history and caps what it stores", async () => {
    const { loadAskHistory, saveAskHistory } = await import("./ask");
    expect(await loadAskHistory()).toEqual([]);
    const many = Array.from({ length: 50 }, (_, i) => ({ role: "user" as const, content: `q${i}` }));
    await saveAskHistory(many);
    const back = await loadAskHistory();
    expect(back).toHaveLength(40);
    expect(back[39]!.content).toBe("q49");
  });

  it("keeps its conversation in a file of its own", async () => {
    const { loadAskHistory, saveAskHistory } = await import("./ask");
    await saveAskHistory([{ role: "user", content: "and soy?" }]);
    expect(JSON.parse(files["ask-health.json"]!)).toEqual([{ role: "user", content: "and soy?" }]);
    expect(await loadAskHistory()).toEqual([{ role: "user", content: "and soy?" }]);
  });
});

/**
 * `coach-chat.json` is where versions before the rename kept this
 * conversation (the home card and Find patterns both saved into it). Ask
 * Health keeps its conversation in `ask-health.json`, the file it uses on the
 * main line, so a person updating from either line keeps what they had: when
 * Ask Health has no file of its own yet, the older conversation is shown,
 * sent as context for a follow-up, and carried into the new file on the next
 * save. The older file is never changed or deleted.
 */
describe("a conversation from before the rename", () => {
  // An older conversation, as dev 1.43.1 stored it. The last turn is the
  // shape the removed trainer's chat wrote: extra fields beside role and
  // content, which were never read.
  const OLD_TURNS = [
    { role: "user", content: "are bananas high in fiber?" },
    { role: "assistant", content: "A medium banana has about 3 g of fiber." },
    { role: "user", content: "what can I have for a snack?" },
    {
      role: "assistant",
      content: "You have about 400 calories left, so Greek yogurt with berries fits.",
      proposal: { type: "single", question: "Pick one", options: ["Yes", "No"] },
      answered: true,
    },
  ];
  const AS_SHOWN = OLD_TURNS.map(({ role, content }) => ({ role, content }));

  it("is shown as Ask Health's history when Ask Health has none of its own", async () => {
    files["coach-chat.json"] = JSON.stringify(OLD_TURNS);
    const { loadAskHistory } = await import("./ask");
    expect(await loadAskHistory()).toEqual(AS_SHOWN);
  });

  it("is sent as the earlier turns of a follow-up", async () => {
    files["coach-chat.json"] = JSON.stringify(OLD_TURNS);
    const { askHealth, loadAskHistory } = await import("./ask");
    complete.mockResolvedValue("ok");
    await askHealth("and what about the green ones?", await loadAskHistory());
    expect(sentRequest().messages).toEqual([...AS_SHOWN, { role: "user", content: "and what about the green ones?" }]);
  });

  it("is carried into Ask Health's own file on the next save, and the older file is left as it was", async () => {
    const before = JSON.stringify(OLD_TURNS);
    files["coach-chat.json"] = before;
    const { loadAskHistory, saveAskHistory } = await import("./ask");
    const history = await loadAskHistory();
    await saveAskHistory([...history, { role: "user", content: "is rice filling?" }]);
    const carried = [...AS_SHOWN, { role: "user", content: "is rice filling?" }];
    expect(JSON.parse(files["ask-health.json"]!)).toEqual(carried);
    expect(files["coach-chat.json"]).toBe(before);
    // Read back from Ask Health's own file from here on.
    expect(await loadAskHistory()).toEqual(carried);
  });

  it("gives way to Ask Health's own file once there is one", async () => {
    files["coach-chat.json"] = JSON.stringify(OLD_TURNS);
    files["ask-health.json"] = JSON.stringify([{ role: "user", content: "and soy?" }]);
    const { loadAskHistory } = await import("./ask");
    expect(await loadAskHistory()).toEqual([{ role: "user", content: "and soy?" }]);
  });

  it("skips a stored turn it cannot show, and starts empty with neither file", async () => {
    const { loadAskHistory } = await import("./ask");
    expect(await loadAskHistory()).toEqual([]);
    files["coach-chat.json"] = JSON.stringify([
      { role: "user", content: "is tofu high in protein?" },
      { role: "system", content: "x" },
      { role: "assistant" },
      null,
    ]);
    expect(await loadAskHistory()).toEqual([{ role: "user", content: "is tofu high in protein?" }]);
  });
});

describe("personal context requires consent", () => {
  /**
   * The bug: the ask path stapled today's data on regardless of consent, so
   * the home card (which never checked consent at all) and a stale "Find
   * patterns" consent both leaked today's symptoms, weight and goal
   * direction. This is the regression test for the chokepoint in
   * askContext(): every assertion here is something that must NOT appear
   * when there is no current agreement on file.
   */
  it("sends no personal context, and no symptom label, when consent is absent", async () => {
    consent = undefined;
    const { askHealth } = await import("./ask");
    complete.mockResolvedValue("ok");
    await askHealth("what should I eat for dinner?");
    const sys = sentRequest().system;
    expect(sys).not.toContain("ABOUT THIS USER");
    expect(sys).not.toContain("2200 cal");
    expect(sys).not.toContain("Greek yogurt");
    expect(sys).not.toContain("Tortilla chips");
    expect(sys).not.toContain("losing weight");
    expect(sys).not.toContain("Weight:");
    expect(sys).not.toContain("Heartburn");
  });

  it("also withholds context when the stored consent is stale wording", async () => {
    // Consent to v(N-1)'s wording is not consent to the current disclosure;
    // that is the entire point of DISCLOSURE_VERSION. A version bump must
    // re-close this gate, not just a missing record.
    consent = { version: DISCLOSURE_VERSION - 1, acceptedAt: "2026-01-01T00:00:00.000Z", includeNotes: false };
    const { askHealth } = await import("./ask");
    complete.mockResolvedValue("ok");
    await askHealth("what should I eat for dinner?");
    const sys = sentRequest().system;
    expect(sys).not.toContain("Heartburn");
    expect(sys).not.toContain("2200 cal");
  });

  it("still answers the question with no context at all", async () => {
    consent = undefined;
    const { askHealth } = await import("./ask");
    complete.mockResolvedValue("Water and plain crackers are a gentle bet.");
    const reply = await askHealth("what should I eat for dinner?");
    expect(reply).toContain("crackers");
  });

  it("sends the symptom label once a current agreement is on file (positive control)", async () => {
    // Guards against the negative-only assertions above passing for the
    // wrong reason (e.g. a typo breaking the whole context block).
    const { askHealth } = await import("./ask");
    complete.mockResolvedValue("ok");
    await askHealth("anything");
    const sys = sentRequest().system;
    expect(sys).toContain("Heartburn");
    expect(sys).toContain("2200 cal");
  });

  it("askNeedsConsent reports true exactly when askHealth would run without context", async () => {
    const { askNeedsConsent } = await import("./ask");
    expect(await askNeedsConsent()).toBe(false); // beforeEach grants consent
    consent = undefined;
    expect(await askNeedsConsent()).toBe(true);
  });
});

describe("ASK_SUGGESTIONS", () => {
  it("are real questions, so the placeholder teaches the shape of one", () => {
    expect(ASK_SUGGESTIONS.length).toBeGreaterThan(3);
    expect(ASK_SUGGESTIONS.every((q) => q.trim().endsWith("?"))).toBe(true);
  });
});
