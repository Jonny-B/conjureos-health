import { describe, it, expect, vi, beforeEach } from "vitest";
import { ASK_SUGGESTIONS } from "./ask";
import { DISCLOSURE_VERSION } from "../aiConsent";
import { shiftDate, todayISO } from "../diary";
import type { AiJournalConsent, Plan, Profile, SleepEntry, WeightEntry } from "../../types";

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
const today = todayISO();
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

// The rest of what the user has logged. Empty by default so the older tests
// below read exactly as they did; the "widened scope" tests fill them in.
let profileExtra: Partial<Profile> = {};
let weights: WeightEntry[] = [];
let plan: Plan | null = null;
let sleepRange: SleepEntry[] = [];
let symptomNote: string | undefined;
// Store reads made, by method, so a test can prove no consent means no reads.
const reads: string[] = [];
// Every write method the Repository has. Each records itself if called.
const writes: string[] = [];
const WRITE_METHODS = [
  "saveProfile", "saveGoals", "addDiaryEntry", "updateDiaryEntry", "removeDiaryEntry",
  "saveSleep", "removeSleep", "addWater", "updateWater", "removeWater",
  "addSymptom", "updateSymptom", "removeSymptom", "upsertWeight", "removeWeight",
  "clearDiary", "clearWeights", "clearWorkoutHistory", "clearSleep", "clearWater", "clearSymptoms",
  "savePlan", "clearPlan", "saveDayLog", "markCheckoff", "saveWorkoutSession", "removeWorkoutSession",
];
// Reads that should fail, to show one bad slice costs only its own section.
let failing = new Set<string>();

vi.mock("../../data/repository", () => ({
  getRepository: async () => ({
    ...Object.fromEntries(
      WRITE_METHODS.map((m) => [m, async () => void writes.push(m)]),
    ),
    getGoals: async () => ({ calories: 2200, protein: 150, carbs: 200, fat: 70 }),
    getProfile: async () => ({
      units: "imperial",
      weightKg: 81,
      direction: "lose",
      aiJournalConsent: consent,
      ...profileExtra,
    }),
    listDiary: async (d: string) =>
      d === today
        ? [
            { id: "1", date: d, meal: "breakfast", quantity: 1, loggedAt: `${d}T08:00:00Z`,
              food: food("Greek yogurt", 150, 25) },
            { id: "2", date: d, meal: "lunch", quantity: 2, loggedAt: `${d}T12:00:00Z`,
              food: food("Tortilla chips", 300, 4) },
          ]
        : d >= shiftDate(today, -7) && d !== shiftDate(today, -3)
          ? [{ id: `f${d}`, date: d, meal: "dinner", quantity: 1, loggedAt: `${d}T19:00:00Z`,
               food: food("Lentil soup", 1650, 90) }]
          : [],
    listWater: async () => [],
    listSleep: async (d: string) => sleepRange.filter((n) => n.date === d),
    listSleepRange: async () => {
      reads.push("listSleepRange");
      return sleepRange;
    },
    // A symptom on today, present regardless of consent — daySnapshot()
    // itself doesn't know about consent, askContext() is what must refuse
    // to forward it. See "personal context requires consent" below.
    listSymptoms: async (d: string) =>
      d === today
        ? [{ id: "s1", date: d, label: "Heartburn", loggedAt: `${d}T21:40:00Z`, severity: 3,
             ...(symptomNote ? { note: symptomNote } : {}) }]
        : [],
    listWeights: async () => {
      reads.push("listWeights");
      if (failing.has("listWeights")) throw new Error("weights unreadable");
      return weights;
    },
    // Not async on purpose: a backend missing this method throws before any
    // promise exists, and that must not take the rest of the context with it.
    getPlan: () => {
      reads.push("getPlan");
      if (failing.has("getPlan")) throw new TypeError("repo.getPlan is not a function");
      return Promise.resolve(plan);
    },
  }),
}));
vi.mock("../exercise", async (orig) => ({
  ...(await orig<typeof import("../exercise")>()),
  exerciseCaloriesForDate: async () => 0,
}));

beforeEach(() => {
  complete.mockReset();
  for (const k of Object.keys(files)) delete files[k];
  consent = { version: DISCLOSURE_VERSION, acceptedAt: "2026-01-01T00:00:00.000Z", includeNotes: false };
  profileExtra = {};
  weights = [];
  plan = null;
  sleepRange = [];
  symptomNote = undefined;
  reads.length = 0;
  writes.length = 0;
  failing = new Set();
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
    // 81 kg is 178.6 lb: the profile weight must not leak in any label.
    expect(sys).not.toContain("178.6");
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

/**
 * The coach answers about everything the user logs, not just food. These
 * fill in a whole profile, weight history, plan and a night's sleep, and
 * check each reaches the model in the user's units, only with consent, and
 * without anything the consent wording leaves out.
 */
describe("widened scope", () => {
  const night = (date: string, quality: number, note?: string): SleepEntry => ({
    id: `n${date}`,
    date,
    bedAt: `${shiftDate(date, -1)}T23:00:00.000Z`,
    wakeAt: `${date}T06:30:00.000Z`,
    quality,
    ...(note ? { note } : {}),
  });

  const fill = () => {
    profileExtra = { sex: "female", age: 41, heightCm: 165, activityLevel: "light", goalWeightKg: 72 };
    weights = [
      { date: today, weightKg: 80.0 },
      { date: shiftDate(today, -7), weightKg: 80.65 },
      { date: shiftDate(today, -30), weightKg: 81.6 },
      { date: shiftDate(today, -54), weightKg: 82.75 },
    ];
    plan = {
      id: "p1",
      mode: "eat_better",
      durationWeeks: 4,
      startDate: shiftDate(today, -14),
      endDate: shiftDate(today, 13),
      goals: [{ id: "g1", label: "Hit 140 g protein", kind: "nutrition" }],
      goalText: "Fit into my hiking trousers by November",
      weeklyExerciseDays: 3,
      safety: { ageBand: "40_59", pregnant: true, cardiacFlag: true, injuries: ["knee"], activityLevel: "light" },
      liability: { acknowledged: true, acceptedAt: "2026-01-01T00:00:00.000Z" },
      createdAt: "2026-01-01T00:00:00.000Z",
      program: { workouts: [{ id: "w", workout: { id: "w", name: "Murph assessment" } as never }], benchmarks: [] },
    };
    sleepRange = [
      night(shiftDate(today, -1), 2, "woke at 3am worrying about money"),
      night(shiftDate(today, -2), 2),
    ];
    symptomNote = "after the argument with my boss";
    files["coach.json"] = JSON.stringify({ notes: ["Hates burpees"], summary: "Struggles with knees" });
  };

  const systemFor = async (question = "how am I doing?") => {
    const { askCoach } = await import("./ask");
    complete.mockResolvedValue("ok");
    await askCoach(question);
    return (complete.mock.calls[0]![0] as { system: string }).system;
  };

  it("is not told to keep to food: its scope names everything the user logs", async () => {
    consent = undefined; // the bare prompt, with no data appended
    const sys = await systemFor();
    expect(sys).not.toMatch(/everyday food and nutrition questions inside a calorie-tracking app/i);
    const scope = sys.split("SCOPE")[1]!.split("LIMITS")[0]!;
    for (const kind of ["food", "water", "sleep", "symptoms", "exercise", "weight", "targets", "plan"]) {
      expect(scope).toContain(kind);
    }
    // General food questions are still in scope.
    expect(scope).toMatch(/everyday food and nutrition questions/);
  });

  it("sends weight trend, goal weight, body stats, plan progress and the week, in the user's units", async () => {
    fill();
    const sys = await systemFor();
    expect(sys).toContain(`WEIGHT\nLatest: 176.4 lb on ${today}. 4 weigh-ins since ${shiftDate(today, -54)}.`);
    expect(sys).toContain(`-1.4 lb since ${shiftDate(today, -7)}`);
    expect(sys).toContain("Goal weight: 158.7 lb (17.6 lb away).");
    expect(sys).toContain(`Age: 41. Height: 5'5". Activity: lightly active.`);
    expect(sys).toContain("Goal in their words: Fit into my hiking trousers by November");
    expect(sys).toContain(`${shiftDate(today, -14)} to ${shiftDate(today, 13)}, day 15 of 28.`);
    expect(sys).toContain("Plan goals: Hit 140 g protein.");
    expect(sys).toContain("Exercise: 0 of 3 target days this week");
    expect(sys).toMatch(/LAST 7 DAYS \(before today\)\nFood: logged 6 of 7 days/);
    expect(sys).toContain("rested 2.0/5");
    // Today's weigh-in too: an imperial user never sees a kg figure.
    expect(sys).toContain("Weighed in at 176.4 lb.");
    expect(sys).not.toMatch(/\bkg\b/);
  });

  it("omits each section cleanly when nothing of that kind is logged", async () => {
    const sys = await systemFor();
    expect(sys).toContain("ABOUT THIS USER\nTODAY\n");
    expect(sys).toContain("PROFILE\nGoal: losing weight.");
    expect(sys).not.toMatch(/\nWEIGHT\n|\nPLAN\n|Goal weight|Plan goals|rested/);
    // The profile's own weight is not a weigh-in and is never stated as one.
    expect(sys).not.toContain("178.6");
    expect(sys).not.toMatch(/undefined|NaN|\bnull\b/);
  });

  it("withholds every widened field without consent, and does not even read them", async () => {
    fill();
    for (const c of [undefined, { version: DISCLOSURE_VERSION - 1, acceptedAt: "2026-01-01T00:00:00.000Z", includeNotes: true }]) {
      consent = c;
      complete.mockReset();
      reads.length = 0;
      const sys = await systemFor();
      for (const leak of ["176.4", "158.7", "hiking trousers", "day 15 of 28", "rested", "PROFILE", "LAST 7 DAYS", "Age: 41", "lb"]) {
        expect(sys).not.toContain(leak);
      }
      expect(reads).toEqual([]);
    }
  });

  it("sends them once a current agreement is on file (positive control)", async () => {
    fill();
    const sys = await systemFor();
    for (const field of ["176.4 lb", "158.7 lb", "hiking trousers", "day 15 of 28", "rested 2.0/5", "PROFILE", "LAST 7 DAYS", "Age: 41"]) {
      expect(sys).toContain(field);
    }
  });

  it("never sends notes, the safety intake, the workout program or coach memory", async () => {
    fill();
    for (const includeNotes of [false, true]) {
      consent = { version: DISCLOSURE_VERSION, acceptedAt: "2026-01-01T00:00:00.000Z", includeNotes };
      complete.mockReset();
      const ctx = (await systemFor()).split("ABOUT THIS USER")[1]!;
      expect(ctx).toContain("hiking trousers"); // the context really was sent
      expect(ctx).not.toMatch(/3am|money|argument|boss|pregnan|cardiac|knee|injur|Murph|burpees/i);
    }
  });

  it("is read-only: writes nothing, offers no tool, and says where to make a change", async () => {
    fill();
    const before = JSON.stringify(files);
    const { askCoach } = await import("./ask");
    complete.mockResolvedValue('Done. <planchange>{"dailyCalories": 1000}</planchange>');
    await askCoach("Lower my calorie target to 1000 and delete yesterday's dinner");
    const req = complete.mock.calls[0]![0] as { system: string; tools?: unknown };
    expect(writes).toEqual([]);
    expect(JSON.stringify(files)).toBe(before);
    expect(req.tools).toBeUndefined();
    expect(req.system).not.toMatch(/<\w+>|planchange|<adjust|<propose/);
    expect(req.system).toMatch(/You are read-only/);
    expect(req.system).toMatch(/never say you did/i);
    expect(req.system).toMatch(/Diary tab/);
    expect(req.system).toMatch(/Edit plan on the Plan tab/);
  });

  it("keeps every medical-safety guardrail", async () => {
    const sys = await systemFor();
    expect(sys).toMatch(/not a doctor and never diagnose/i);
    expect(sys).toMatch(/not medical or clinical advice/i);
    expect(sys).toMatch(/disordered eating/);
    expect(sys).toMatch(/doctor or dietitian/);
    expect(sys).toMatch(/chest pain, shortness of breath or dizziness/);
    expect(sys).toMatch(/Never suggest a calorie target below what the app already set/);
    expect(sys).toMatch(/purging, fasting as weight control, or "earning" food with exercise/);
    expect(sys).toMatch(/1% of body weight a week/);
  });

  it("loses only the section whose read failed", async () => {
    fill();
    failing = new Set(["getPlan", "listWeights"]);
    const sys = await systemFor();
    expect(sys).toContain("Greek yogurt");
    expect(sys).toContain("PROFILE");
    expect(sys).toContain("LAST 7 DAYS");
    expect(sys).not.toMatch(/\nWEIGHT\n|\nPLAN\n/);
  });

  it("writes no em-dashes into what the model reads", async () => {
    fill();
    const sys = await systemFor();
    expect(sys).not.toContain("\u2014");
  });
});
