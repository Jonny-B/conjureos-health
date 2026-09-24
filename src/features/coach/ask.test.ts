import { describe, it, expect, vi, beforeEach } from "vitest";
import { ASK_SUGGESTIONS } from "./ask";
import { DISCLOSURE_VERSION } from "../aiConsent";
import type { AiJournalConsent } from "../../types";

const complete = vi.fn();
const files: Record<string, string> = {};

vi.mock("../../bridge/ai", async (orig) => ({
  ...(await orig<typeof import("../../bridge/ai")>()),
  complete: (...a: unknown[]) => complete(...a),
  isAiAvailable: () => true,
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
// "does askCoach answer correctly", not re-litigating consent on every case.
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
    // A symptom on today, present regardless of consent — daySnapshot()
    // itself doesn't know about consent, askContext() is what must refuse
    // to forward it. See "personal context requires consent" below.
    listSymptoms: async (d: string) =>
      d === today ? [{ id: "s1", label: "Heartburn", loggedAt: `${d}T21:40:00Z`, severity: 3 }] : [],
    listWeights: async () => [],
  }),
}));
vi.mock("../exercise", () => ({ exerciseCaloriesForDate: async () => 0 }));

beforeEach(() => {
  complete.mockReset();
  for (const k of Object.keys(files)) delete files[k];
  consent = { version: DISCLOSURE_VERSION, acceptedAt: "2026-01-01T00:00:00.000Z", includeNotes: false };
});

describe("askCoach", () => {
  it("answers and never proposes a plan change", async () => {
    const { askCoach } = await import("./ask");
    complete.mockResolvedValue("A medium banana has about 3 g of fiber.");
    const reply = await askCoach("Are bananas high in fiber?");
    expect(reply).toContain("3 g of fiber");
    const req = complete.mock.calls[0]![0] as { system: string };
    expect(req.system).toMatch(/cannot change the user's plan/i);
  });

  it("tells the model the user's own targets so answers can be specific", async () => {
    const { askCoach } = await import("./ask");
    complete.mockResolvedValue("ok");
    await askCoach("What should I snack on?");
    const req = complete.mock.calls[0]![0] as { system: string };
    expect(req.system).toContain("2200 cal");
    expect(req.system).toContain("losing weight");
  });

  /**
   * The reported bug: asked what to eat "based on what I've eaten and what my
   * macros are", the coach replied that it didn't have today's diary loaded
   * and asked the user to paste it in. It was never given the diary.
   */
  it("sends what was eaten TODAY, by meal", async () => {
    const { askCoach } = await import("./ask");
    complete.mockResolvedValue("ok");
    await askCoach("what should I eat for dinner?");
    const sys = (complete.mock.calls[0]![0] as { system: string }).system;
    expect(sys).toContain("Greek yogurt");
    expect(sys).toContain("2× Tortilla chips");
    expect(sys).toMatch(/Breakfast:/);
    expect(sys).toMatch(/Lunch:/);
  });

  it("does the subtraction so the model doesn't have to", async () => {
    const { askCoach } = await import("./ask");
    complete.mockResolvedValue("ok");
    await askCoach("what's left?");
    const sys = (complete.mock.calls[0]![0] as { system: string }).system;
    // 150 + 600 eaten of 2200; 25 + 8 protein of 150.
    expect(sys).toContain("Eaten so far: 750 cal");
    expect(sys).toContain("Remaining, negative means over (1450 cal");
    expect(sys).toContain("117g protein");
  });

  it("forbids the 'I can't see your diary' answer", async () => {
    const { askCoach } = await import("./ask");
    complete.mockResolvedValue("ok");
    await askCoach("anything");
    const sys = (complete.mock.calls[0]![0] as { system: string }).system;
    expect(sys).toMatch(/never claim you cannot see their diary/i);
    expect(sys).toMatch(/Never ask them to paste in data you were given/i);
  });

  it("sends prior turns so follow-ups make sense", async () => {
    const { askCoach } = await import("./ask");
    complete.mockResolvedValue("ok");
    await askCoach("what about the green ones?", [
      { role: "user", content: "are bananas high in fiber?" },
      { role: "assistant", content: "about 3 g" },
    ]);
    const req = complete.mock.calls[0]![0] as { messages: { content: string }[] };
    expect(req.messages).toHaveLength(3);
    expect(req.messages[2]!.content).toBe("what about the green ones?");
  });

  it("returns a readable sentence instead of throwing when the call fails", async () => {
    const { askCoach } = await import("./ask");
    complete.mockRejectedValue(new Error("network"));
    await expect(askCoach("anything?")).resolves.toMatch(/try again/i);
  });

  it("ignores an empty question", async () => {
    const { askCoach } = await import("./ask");
    expect(await askCoach("   ")).toBe("");
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
});

describe("personal context requires consent", () => {
  /**
   * The bug: askCoach stapled today's data on regardless of consent, so
   * "Ask about food" (which never checked consent at all) and a stale
   * "Find patterns" consent both leaked today's symptoms, weight and goal
   * direction. This is the regression test for the chokepoint in
   * askContext() — every assertion here is something that must NOT appear
   * when there is no current agreement on file.
   */
  it("sends no personal context, and no symptom label, when consent is absent", async () => {
    consent = undefined;
    const { askCoach } = await import("./ask");
    complete.mockResolvedValue("ok");
    await askCoach("what should I eat for dinner?");
    const sys = (complete.mock.calls[0]![0] as { system: string }).system;
    expect(sys).not.toContain("ABOUT THIS USER");
    expect(sys).not.toContain("2200 cal");
    expect(sys).not.toContain("Greek yogurt");
    expect(sys).not.toContain("Tortilla chips");
    expect(sys).not.toContain("losing weight");
    expect(sys).not.toContain("Weight:");
    expect(sys).not.toContain("Heartburn");
  });

  it("also withholds context when the stored consent is stale wording", async () => {
    // Consent to v(N-1)'s wording is not consent to the current disclosure —
    // that is the entire point of DISCLOSURE_VERSION. A version bump must
    // re-close this gate, not just a missing record.
    consent = { version: DISCLOSURE_VERSION - 1, acceptedAt: "2026-01-01T00:00:00.000Z", includeNotes: false };
    const { askCoach } = await import("./ask");
    complete.mockResolvedValue("ok");
    await askCoach("what should I eat for dinner?");
    const sys = (complete.mock.calls[0]![0] as { system: string }).system;
    expect(sys).not.toContain("Heartburn");
    expect(sys).not.toContain("2200 cal");
  });

  it("still answers the question with no context at all", async () => {
    consent = undefined;
    const { askCoach } = await import("./ask");
    complete.mockResolvedValue("Water and plain crackers are a gentle bet.");
    const reply = await askCoach("what should I eat for dinner?");
    expect(reply).toContain("crackers");
  });

  it("sends the symptom label once a current agreement is on file (positive control)", async () => {
    // Guards against the negative-only assertions above passing for the
    // wrong reason (e.g. a typo breaking the whole context block).
    const { askCoach } = await import("./ask");
    complete.mockResolvedValue("ok");
    await askCoach("anything");
    const sys = (complete.mock.calls[0]![0] as { system: string }).system;
    expect(sys).toContain("Heartburn");
    expect(sys).toContain("2200 cal");
  });

  it("coachNeedsConsent reports true exactly when askCoach would run without context", async () => {
    const { coachNeedsConsent } = await import("./ask");
    expect(await coachNeedsConsent()).toBe(false); // beforeEach grants consent
    consent = undefined;
    expect(await coachNeedsConsent()).toBe(true);
  });
});

describe("ASK_SUGGESTIONS", () => {
  it("are real questions, so the placeholder teaches the shape of one", () => {
    expect(ASK_SUGGESTIONS.length).toBeGreaterThan(3);
    expect(ASK_SUGGESTIONS.every((q) => q.trim().endsWith("?"))).toBe(true);
  });
});
