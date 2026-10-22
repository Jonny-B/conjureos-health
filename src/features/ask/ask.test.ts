import { describe, it, expect, vi, beforeEach } from "vitest";
import { ASK_SUGGESTIONS } from "./ask";
import { DISCLOSURE_VERSION } from "../aiConsent";
import { healthConsentGeneration, loadHealthConsent, recordHealthConsent } from "../healthConsent";
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

/** The app asks nothing until the person agrees to it keeping health data. */
const AGREED_TO_KEEP = JSON.stringify({ acceptedAt: "2026-01-01T00:00:00.000Z", version: 1 });

beforeEach(async () => {
  complete.mockReset();
  aiAvailable = true;
  for (const k of Object.keys(files)) delete files[k];
  consent = { version: DISCLOSURE_VERSION, acceptedAt: "2026-01-01T00:00:00.000Z", includeNotes: false };
  files["health-consent.json"] = AGREED_TO_KEEP;
  expect(await loadHealthConsent()).toBe(true);
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
   * own scope and limit lines, verbatim, plus the model tier. The answer's
   * length is the STYLE line's job; the cap is that answer plus room for the
   * capable tier to think (conjureos-health#10).
   */
  it("keeps its scope: everyday food and nutrition, general information, nothing changed", async () => {
    const { askHealth } = await import("./ask");
    complete.mockResolvedValue("ok");
    await askHealth("anything");
    const req = sentRequest();
    expect(req.tier).toBe("capable");
    expect(req.maxTokens).toBe(3000);
    for (const line of [
      "- Answer the question first, in one or two sentences. Then at most two more sentences of useful detail.",
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
    const at = new Date().toISOString();
    await askHealth("what about the green ones?", [
      { role: "user", content: "are bananas high in fiber?", at },
      { role: "assistant", content: "about 3 g", at },
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
    await saveAskHistory(many, healthConsentGeneration());
    const back = await loadAskHistory();
    expect(back).toHaveLength(40);
    expect(back[39]!.content).toBe("q49");
  });

  it("saves nothing without an agreement to keep health data", async () => {
    const { saveAskHistory } = await import("./ask");
    delete files["health-consent.json"];
    expect(await loadHealthConsent()).toBe(false);
    await saveAskHistory([{ role: "user", content: "and soy?" }], healthConsentGeneration());
    expect(files["ask-health.json"]).toBeUndefined();
  });

  it("saves nothing asked under an earlier agreement to keep health data", async () => {
    const { saveAskHistory } = await import("./ask");
    const asked = healthConsentGeneration();
    // Withdrawn and agreed again while the answer was out.
    await recordHealthConsent();
    await saveAskHistory([{ role: "user", content: "and soy?" }], asked);
    expect(files["ask-health.json"]).toBeUndefined();
  });

  it("keeps its conversation in a file of its own", async () => {
    const { loadAskHistory, saveAskHistory } = await import("./ask");
    await saveAskHistory([{ role: "user", content: "and soy?" }], healthConsentGeneration());
    expect(JSON.parse(files["ask-health.json"]!)).toEqual([{ role: "user", content: "and soy?" }]);
    expect(await loadAskHistory()).toEqual([{ role: "user", content: "and soy?" }]);
  });
});

/**
 * `coach-chat.json` is where older versions kept the questions asked in-app,
 * and the removed trainer's chat wrote its replies to the same file: offers to
 * change the plan, changes it made, and copy that names it. Nothing on a turn
 * says which feature wrote it. Ask Health must neither show those turns nor
 * send them to the model as its own, and must not delete the file either.
 */
describe("the older conversation file", () => {
  const OLD_TURNS = [
    { role: "user", content: "can you make my plan easier?" },
    {
      role: "assistant",
      content: "Your coach needs the ConjureOS AI service, which isn't available right now.",
    },
    { role: "user", content: "set my goal to 74 kg" },
    { role: "assistant", content: "Done, I set your goal weight to 74 kg." },
    {
      role: "assistant",
      content: "Want me to lower your daily calories?",
      proposal: { type: "single", question: "Lower to 1,900?", options: ["Yes", "No"] },
      answered: false,
    },
  ];

  it("is not shown as Ask Health's history", async () => {
    files["coach-chat.json"] = JSON.stringify(OLD_TURNS);
    const { loadAskHistory } = await import("./ask");
    expect(await loadAskHistory()).toEqual([]);
  });

  it("is not sent to the model as earlier turns", async () => {
    files["coach-chat.json"] = JSON.stringify(OLD_TURNS);
    const { askHealth, loadAskHistory } = await import("./ask");
    complete.mockResolvedValue("ok");
    await askHealth("is rice filling?", await loadAskHistory());
    const sent = sentRequest().messages.map((m) => m.content);
    expect(sent).toEqual(["is rice filling?"]);
  });

  it("stays on disk, untouched, when Ask Health saves", async () => {
    const before = JSON.stringify(OLD_TURNS);
    files["coach-chat.json"] = before;
    const { saveAskHistory } = await import("./ask");
    await saveAskHistory([{ role: "user", content: "is rice filling?" }], healthConsentGeneration());
    expect(files["coach-chat.json"]).toBe(before);
  });
});

describe("personal context requires consent", () => {
  /**
   * The bug: the ask path stapled today's data on regardless of consent, so
   * the home card (which never checked consent at all) and a stale "Find
   * patterns" consent both leaked today's symptoms, weight and goal
   * direction.
   *
   * Since the owner's decision of 2026-10-22 (ConjureOS #1163, "Withdrawn
   * consent means they have withdrawn consent"), no agreement means no call
   * at all: not a context-free question either. features/ask/withdrawal.test.ts
   * covers what a withdrawal does to the conversation.
   */
  it("sends nothing, so no personal context and no symptom label, when consent is absent", async () => {
    consent = undefined;
    const { askHealth } = await import("./ask");
    complete.mockResolvedValue("ok");
    expect(await askHealth("what should I eat for dinner?")).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  it("also sends nothing when the stored consent is stale wording", async () => {
    // Consent to v(N-1)'s wording is not consent to the current disclosure;
    // that is the entire point of DISCLOSURE_VERSION. A version bump must
    // re-close this gate, not just a missing record.
    consent = { version: DISCLOSURE_VERSION - 1, acceptedAt: "2026-01-01T00:00:00.000Z", includeNotes: false };
    const { askHealth } = await import("./ask");
    complete.mockResolvedValue("ok");
    expect(await askHealth("what should I eat for dinner?")).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  it("does not answer a question with no context, either: nothing goes without the agreement", async () => {
    consent = undefined;
    const { askHealth } = await import("./ask");
    complete.mockResolvedValue("Water and plain crackers are a gentle bet.");
    expect(await askHealth("what should I eat for dinner?")).toBeNull();
    expect(complete).not.toHaveBeenCalled();
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

  it("askNeedsConsent reports true exactly when askHealth would send nothing", async () => {
    const { askNeedsConsent } = await import("./ask");
    expect(await askNeedsConsent()).toBe(false); // beforeEach grants consent
    consent = undefined;
    expect(await askNeedsConsent()).toBe(true);
  });
});

/**
 * ConjureOS #1163. The consent sheet says what each entry point sends:
 *
 *   - "Find patterns: anything outside the range you asked about" is withheld
 *   - "Ask Health: anything from more than 2 days before today" is withheld
 *
 * and the request did not match: a Find patterns run also carried today's
 * context, and every question replayed the last 10 stored turns, a month of
 * journal from a Find patterns run and weeks-old questions included. These
 * assert what the request contains from each entry point (the home card, a
 * Find patterns run, and a follow-up typed in either sheet), not the wording.
 */
describe("what each entry point sends", () => {
  type Req = { system: string; messages: { role: string; content: string }[] };
  const req = (n = 0) => complete.mock.calls[n]![0] as Req;
  /** Everything one request puts in front of the model. */
  const everything = (r: Req) => [r.system, ...r.messages.map((m) => m.content)].join("\n");
  const contents = (r: Req) => r.messages.map((m) => m.content);

  const nowIso = () => new Date().toISOString();
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

  // A September run: a symptom and a food that appear nowhere in today's data.
  const SEPT_PATTERNS =
    "Here is my journal for 2026-09-01 to 2026-09-30. What patterns do you notice?\n\n" +
    "2026-09-03: 2140 cal from 9 items; symptoms: Migraine at 14:00 (4/5); ate: aged cheddar";

  const run = (id: string) => ({ kind: "patterns" as const, run: id });

  it("Find patterns sends its range and nothing from today, the 2 days before, or the profile", async () => {
    const { askHealth } = await import("./ask");
    complete.mockResolvedValue("ok");
    await askHealth(SEPT_PATTERNS, [], run("r1"));
    const all = everything(req());
    expect(all).toContain("Migraine"); // positive control: the range itself goes
    expect(all).not.toContain("Greek yogurt"); // today's diary
    expect(all).not.toContain("Tortilla chips");
    expect(all).not.toContain("Heartburn"); // today's symptom
    expect(all).not.toContain("2200 cal"); // targets
    expect(all).not.toContain("losing weight"); // goal
    expect(all).not.toContain("ABOUT THIS USER");
    expect(contents(req())).toEqual([SEPT_PATTERNS]);
  });

  it("Find patterns tells the model it has only the range, so it does not report an empty today", async () => {
    const { askHealth } = await import("./ask");
    complete.mockResolvedValue("ok");
    await askHealth(SEPT_PATTERNS, [], run("r1"));
    expect(req().system).toMatch(/not given today's diary/);
    expect(req().system).not.toContain("—");
  });

  it("Find patterns carries no home card turn and no earlier run", async () => {
    const { askHealth } = await import("./ask");
    complete.mockResolvedValue("ok");
    const at = nowIso();
    await askHealth(SEPT_PATTERNS, [
      { role: "user", content: "is 2x tortilla chips too much?", at },
      { role: "assistant", content: "about 600 cal of your 2200", at },
      { role: "user", content: "Here is my journal for 2026-08-01 to 2026-08-31.", at, patternsRun: "r0" },
      { role: "assistant", content: "August: hives after shellfish", at, patternsRun: "r0" },
    ], run("r1"));
    expect(contents(req())).toEqual([SEPT_PATTERNS]);
  });

  it("a follow-up in a Find patterns sheet carries that run, and still nothing from today", async () => {
    const { askHealth } = await import("./ask");
    complete.mockResolvedValue("ok");
    const at = nowIso();
    await askHealth("what about the cheese?", [
      { role: "user", content: "what should I eat tonight?", at },
      { role: "assistant", content: "you have 1450 cal left", at },
      { role: "user", content: SEPT_PATTERNS, at, patternsRun: "r1" },
      { role: "assistant", content: "Migraines follow aged cheddar.", at, patternsRun: "r1" },
    ], run("r1"));
    expect(contents(req())).toEqual([SEPT_PATTERNS, "Migraines follow aged cheddar.", "what about the cheese?"]);
    const all = everything(req());
    expect(all).not.toContain("Greek yogurt");
    expect(all).not.toContain("Heartburn");
    expect(all).not.toContain("1450 cal left");
  });

  it("the home card does not resend a Find patterns run", async () => {
    const { askHealth } = await import("./ask");
    complete.mockResolvedValue("ok");
    const at = nowIso();
    await askHealth("what should I eat tonight?", [
      { role: "user", content: SEPT_PATTERNS, at, patternsRun: "r1" },
      { role: "assistant", content: "Migraines follow aged cheddar.", at, patternsRun: "r1" },
    ]);
    const all = everything(req());
    expect(all).not.toContain("Migraine");
    expect(all).not.toContain("aged cheddar");
    expect(all).toContain("Greek yogurt"); // positive control: today's context still goes
    expect(contents(req())).toEqual(["what should I eat tonight?"]);
  });

  it("the home card resends only today's turns, never a turn from before today", async () => {
    const { askHealth } = await import("./ask");
    complete.mockResolvedValue("ok");
    const old = daysAgo(3).toISOString();
    const yday = daysAgo(1).toISOString();
    const at = nowIso();
    await askHealth("and the green ones?", [
      { role: "user", content: "I had heartburn all week, what should I avoid?", at: old },
      { role: "assistant", content: "skip the late coffee", at: old },
      // Answered with yesterday's window, which reached 3 days back.
      { role: "user", content: "anything for a 9pm snack?", at: yday },
      { role: "assistant", content: "the 180 cal yogurt from Sunday", at: yday },
      { role: "user", content: "are bananas high in fiber?", at },
      { role: "assistant", content: "about 3 g", at },
    ]);
    expect(contents(req())).toEqual(["are bananas high in fiber?", "about 3 g", "and the green ones?"]);
  });

  it("never resends a turn stored before turns carried a date", async () => {
    // Nothing on such a turn says which entry point or day it came from.
    const { askHealth } = await import("./ask");
    complete.mockResolvedValue("ok");
    await askHealth("anything else?", [
      { role: "user", content: "Here is my journal for 2026-07-01 to 2026-07-31." },
      { role: "assistant", content: "July: knee pain after runs" },
    ]);
    expect(contents(req())).toEqual(["anything else?"]);
  });

  it("opens the conversation with a question when the cap cuts a pair", async () => {
    const { turnsToSend } = await import("./ask");
    const at = nowIso();
    const turns = Array.from({ length: 11 }, (_, i) => ({
      role: (i % 2 === 0 ? "assistant" : "user") as "user" | "assistant",
      content: `t${i}`,
      at,
    }));
    const sent = turnsToSend(turns, { kind: "ask" });
    expect(sent[0]!.role).toBe("user");
    expect(sent.at(-1)!.content).toBe("t10");
  });

  /**
   * The sheet's own path: what it stores is what the next question reads, so
   * this runs a whole day through `askAndAppend` the way the sheet does.
   */
  it("the sheet stamps what it stores, so each later question sends only its own entry point's turns", async () => {
    const { askAndAppend, ASK_FROM_HOME } = await import("./ask");
    complete.mockImplementation(async (r: Req) => `reply ${r.messages.length}`);
    const sept = run("r1");

    // Three days ago, from the home card.
    let h = (await askAndAppend("I had heartburn all week, what should I avoid?", [], ASK_FROM_HOME, undefined, daysAgo(3)))!;
    // Today: Find patterns, then a follow-up typed in its sheet.
    let shown: unknown[] = [];
    h = (await askAndAppend(SEPT_PATTERNS, h, sept, (items) => (shown = items)))!;
    expect(shown.at(-1)).toMatchObject({ role: "user", content: SEPT_PATTERNS, patternsRun: "r1" });
    h = (await askAndAppend("what about the cheese?", h, sept))!;
    // Then the home card, and a follow-up typed in its sheet.
    h = (await askAndAppend("what should I eat tonight?", h, ASK_FROM_HOME))!;
    h = (await askAndAppend("and for dessert?", h, ASK_FROM_HOME))!;

    expect(h).toHaveLength(10);
    expect(h.every((m) => typeof m.at === "string")).toBe(true);

    // Find patterns: its range alone.
    expect(contents(req(1))).toEqual([SEPT_PATTERNS]);
    expect(everything(req(1))).not.toContain("Greek yogurt");
    // Its follow-up: the run, and nothing else.
    expect(contents(req(2))).toEqual([SEPT_PATTERNS, "reply 1", "what about the cheese?"]);
    expect(everything(req(2))).not.toContain("Greek yogurt");
    // The home card: today's context, no run, nothing from 3 days ago.
    expect(contents(req(3))).toEqual(["what should I eat tonight?"]);
    expect(everything(req(3))).toContain("Greek yogurt");
    // Its follow-up: today's home card turns only.
    expect(contents(req(4))).toEqual(["what should I eat tonight?", "reply 1", "and for dessert?"]);
    for (const n of [3, 4]) {
      expect(everything(req(n))).not.toContain("Migraine");
      expect(everything(req(n))).not.toContain("heartburn all week");
    }
  });
});

describe("ASK_SUGGESTIONS", () => {
  it("are real questions, so the placeholder teaches the shape of one", () => {
    expect(ASK_SUGGESTIONS.length).toBeGreaterThan(3);
    expect(ASK_SUGGESTIONS.every((q) => q.trim().endsWith("?"))).toBe(true);
  });
});
