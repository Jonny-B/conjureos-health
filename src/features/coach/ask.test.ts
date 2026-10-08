import { describe, it, expect, vi, beforeEach } from "vitest";
import { ASK_SUGGESTIONS, MAX_CONTEXT_TURNS } from "./ask";
import { DISCLOSURE_SENDS, DISCLOSURE_VERSION } from "../aiConsent";
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
    getGoals: async () => {
      if (failing.has("getGoals")) throw new Error("goals unreadable");
      return { calories: 2200, protein: 150, carbs: 200, fat: 70 };
    },
    getProfile: async () => ({
      units: "imperial",
      weightKg: 81,
      direction: "lose",
      aiJournalConsent: consent,
      ...profileExtra,
    }),
    listDiary: async (d: string) => {
      if (failing.has(`listDiary:${d}`)) throw new Error("diary unreadable");
      return d === today
        ? [
            { id: "1", date: d, meal: "breakfast", quantity: 1, loggedAt: `${d}T08:00:00Z`,
              food: food("Greek yogurt", 150, 25) },
            { id: "2", date: d, meal: "lunch", quantity: 2, loggedAt: `${d}T12:00:00Z`,
              food: food("Tortilla chips", 300, 4) },
          ]
        : d >= shiftDate(today, -7) && d !== shiftDate(today, -3)
          ? [{ id: `f${d}`, date: d, meal: "dinner", quantity: 1, loggedAt: `${d}T19:00:00Z`,
               food: food("Lentil soup", 1650, 90) }]
          : [];
    },
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

  /**
   * Every user sees every suggestion, and some are sent no targets (tracking
   * only, or a goal below a healthy range), so a question that needs what is
   * left of them cannot be answered for them, while the Diary still shows a
   * calorie budget behind the sheet.
   */
  it("ask nothing that needs the daily targets", () => {
    for (const q of ASK_SUGGESTIONS) expect(q).not.toMatch(/\bleft\b|budget|target|remaining/i);
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
    // Exercise is in scope, and the coach is told nothing about injuries.
    expect(sys).toMatch(/You are not told about injuries or health conditions/);
    expect(sys).toMatch(/Never prescribe a workout, specific exercises or an\s+intensity/);
    expect(sys).toMatch(/check\s+with a doctor or physio/);
    // Logging-only plans and minors, and a goal weight below a healthy range.
    expect(sys).toMatch(/tracking only, or gives an age under 18, do not suggest weight loss, a goal weight, eating\s+less or exercise/);
    expect(sys).toMatch(/goal weight is below a healthy range, never help them toward it or say how long it\s+would take/);
    // A current weight below a healthy range: no help losing, help gaining.
    expect(sys).toMatch(/current weight is below a healthy range, never help them lose weight or eat\s+less/);
    expect(sys).toMatch(/Helping them gain weight or eat enough is fine/);
  });

  it("does not deny the one streak it is sent", async () => {
    const sys = await systemFor();
    expect(sys).not.toMatch(/Streaks and body\s+measurements are not tracked/);
    expect(sys).toMatch(/only streak the app keeps is the "in a row" count of days with food logged/);
  });

  /**
   * A logging-only plan (forced by the safety intake for pregnancy, a heart
   * condition or an under-18) used to reach the model as "Logging plan" with
   * no meaning attached, next to a goal direction and goal weight left over
   * from the user's earlier food plan.
   */
  it("tells the model a logging-only plan sets no goals, and sends none, without saying why", async () => {
    fill();
    plan = { ...plan!, mode: "logging_only" };
    const ctx = (await systemFor("How has my weight changed this month?")).split("ABOUT THIS USER")[1]!;
    expect(ctx).toContain("Logging plan");
    expect(ctx).toContain("Tracking only: the app sets no weight, calorie-cutting or exercise goals for this user.");
    expect(ctx).toContain("WEIGHT\nLatest: 176.4 lb");
    expect(ctx).not.toMatch(/losing weight|Goal weight|Pace:|158\.7/);
    // The fixture's intake is pregnant and cardiac with a knee injury.
    expect(ctx).not.toMatch(/pregnan|cardiac|under.?18|injur|knee/i);
  });

  it("loses only the section whose read failed, and says it could not read it", async () => {
    fill();
    failing = new Set(["getPlan", "listWeights"]);
    const sys = await systemFor();
    expect(sys).toContain("Greek yogurt");
    expect(sys).toContain("PROFILE");
    expect(sys).toContain("LAST 7 DAYS");
    expect(sys).not.toMatch(/\nWEIGHT\n/);
    // An unread plan may be a logging-only one: the summary fails closed on
    // it, and PLAN says only that, with no goal left over on the profile.
    expect(sys).toMatch(/\nPLAN\nTracking only for this question: their plan could not be read[^\n]*\n\n/);
    expect(sys).not.toMatch(/losing weight|Goal weight|Targets:/);
    // Not "no weigh-ins": the prompt reads a missing section as nothing logged.
    expect(sys).toMatch(/\nCOULD NOT READ THIS TIME\nTheir weigh-ins, their plan\.$/);
  });

  it("writes no em-dashes into what the model reads", async () => {
    fill();
    const sys = await systemFor();
    expect(sys).not.toContain("\u2014");
  });
});

/**
 * A read that fails leaves the same empty value as a store with nothing in
 * it, and the prompt tells the model to say "nothing logged" for a missing
 * section. These check a failure is named as one instead.
 */
describe("a failed read is not 'nothing logged'", () => {
  const systemFor = async (question = "What should I eat with what I have left today?") => {
    const { askCoach } = await import("./ask");
    complete.mockResolvedValue("ok");
    await askCoach(question);
    return (complete.mock.calls[0]![0] as { system: string }).system;
  };

  it("tells the model what a COULD NOT READ section means", async () => {
    const sys = await systemFor();
    expect(sys).toMatch(/COULD NOT READ THIS TIME failed to load for this question: say you could not read it this\s+time, never that it was not logged/);
  });

  /** The model answers in the prompt's own words, so what it is told to say
   *  keeps to the copy rules: "could not read it just now" came back as "now". */
  it("tells the model to say nothing the copy rules ban", async () => {
    failing = new Set(["listWeights"]);
    const sys = await systemFor();
    expect(sys).toContain("COULD NOT READ THIS TIME\nTheir weigh-ins.");
    expect(sys).not.toMatch(/\bnow\b|\byet\b|no longer/i);
  });

  it("keeps the whole diary when the targets cannot be read", async () => {
    failing = new Set(["getGoals"]);
    const sys = await systemFor();
    // Today and the week survive: one failed goals read used to throw away
    // all eight day snapshots.
    expect(sys).toContain("Greek yogurt");
    expect(sys).toMatch(/LAST 7 DAYS \(before today\)\nFood: logged 6 of 7 days/);
    expect(sys).toContain("RECENT DAYS");
    // No made-up targets, and no "what's left" worked out from them.
    expect(sys).not.toMatch(/Targets:|Remaining, negative/);
    expect(sys).toMatch(/\nCOULD NOT READ THIS TIME\nTheir daily targets\.$/);
  });

  it("never says nothing was logged today when today's diary could not be read", async () => {
    failing = new Set([`listDiary:${today}`]);
    const sys = await systemFor();
    expect(sys).not.toMatch(/Nothing logged|Eaten so far|Remaining, negative/);
    expect(sys).toContain("Targets: 2200 cal");
    expect(sys).toMatch(/\nCOULD NOT READ THIS TIME\nToday's food\.$/);
    // The logging run is counted through yesterday, the last day it can see.
    expect(sys).toContain("(2 in a row through yesterday)");
  });

  it("names an earlier day whose diary could not be read, and leaves it out of the count", async () => {
    failing = new Set([`listDiary:${shiftDate(today, -2)}`]);
    const sys = await systemFor();
    expect(sys).toMatch(/Food: logged 5 of 6 days/);
    expect(sys).toMatch(/\nCOULD NOT READ THIS TIME\nSome of the 7 days before today\.$/);
  });

  it("adds nothing when every read worked", async () => {
    expect(await systemFor()).not.toMatch(/\nCOULD NOT READ THIS TIME\n/);
  });
});

/**
 * Find patterns opens this chat with a whole range of the journal (and any
 * symptom notes the user opted in to) as its question. That question is saved
 * with the rest of the conversation, which goes with every later question.
 */
describe("the conversation sent with a question", () => {
  const NOTE = "after a fight with my partner";
  const JOURNAL = [
    `2026-09-03: 2140 cal from 9 items; 118g protein; symptoms: Headache at 14:00 (3/5) \u2014 ${NOTE}; ate: coffee, oats`,
    "2026-09-04: 1800 cal from 6 items; 95g protein",
  ].join("\n");
  type Req = { messages: { role: string; content: string }[] };

  it("sends a Find patterns journal once, with its own question, and never again", async () => {
    const { askCoach, loadAskHistory, saveAskHistory, patternsQuestion } = await import("./ask");
    const opening = patternsQuestion("2026-09-01", "2026-09-30", JOURNAL);
    complete.mockResolvedValue("Your headaches land on busy days.");
    await askCoach(opening, await loadAskHistory());
    // Positive control: the run itself carries the range, note included.
    expect((complete.mock.calls[0]![0] as Req).messages.at(-1)!.content).toContain(NOTE);

    await saveAskHistory([
      { role: "user", content: opening },
      { role: "assistant", content: "Your headaches land on busy days." },
    ]);
    complete.mockClear();
    await askCoach("Is my water on track today?", await loadAskHistory());
    const req = complete.mock.calls[0]![0] as Req;
    const sent = JSON.stringify(req.messages);
    expect(sent).not.toContain(NOTE);
    expect(sent).not.toMatch(/2026-09-0[34]:|cal from|Headache at/);
    expect(req.messages).toHaveLength(3);
    expect(req.messages[0]!.content).toBe(
      "Here is my journal for 2026-09-01 to 2026-09-30. What patterns do you notice? Anything that seems to go together?" +
        "\n\n[Their journal for 2026-09-01 to 2026-09-30 went with that question only, and is not repeated here.]",
    );
    // That journal carried a note, so the answer to it stays behind as well
    // (a journal without notes keeps its answer: see below).
    expect(req.messages[1]!.content).toMatch(/^\[The answer to that journal is not repeated here/);
    expect(req.messages[2]!.content).toBe("Is my water on track today?");
  });

  it("also leaves out the journal from a Find patterns question saved by an earlier build", async () => {
    const { askCoach } = await import("./ask");
    complete.mockResolvedValue("ok");
    const old = `Here is my journal for 2026-08-01 to 2026-08-31. What patterns do you notice \u2014 anything that seems to go together?\n\n${JOURNAL}`;
    await askCoach("How has my sleep been this week?", [
      { role: "user", content: old },
      { role: "assistant", content: "ok" },
    ]);
    const sent = JSON.stringify((complete.mock.calls[0]![0] as Req).messages);
    expect(sent).not.toContain(NOTE);
    expect(sent).not.toContain("cal from");
    expect(sent).toContain("[Their journal for 2026-08-01 to 2026-08-31 went with that question only");
  });

  it("leaves every other turn word for word, and keeps only the last few", async () => {
    const { askCoach, patternsQuestion } = await import("./ask");
    complete.mockResolvedValue("ok");
    const typed = "Here is my journal for today: eggs and toast. Is that enough protein?";
    const reply = patternsQuestion("2026-09-01", "2026-09-30", JOURNAL); // as if the model echoed one
    const history = [
      ...Array.from({ length: 6 }, (_, i) => ({ role: "user" as const, content: `old ${i}` })),
      { role: "user" as const, content: typed },
      { role: "assistant" as const, content: reply },
      ...Array.from({ length: 8 }, (_, i) => ({ role: "user" as const, content: `q${i}` })),
    ];
    await askCoach("and now?", history);
    const msgs = (complete.mock.calls[0]![0] as Req).messages;
    expect(msgs).toHaveLength(MAX_CONTEXT_TURNS + 1);
    expect(msgs[0]!.content).toBe(typed);
    expect(msgs[1]!.content).toBe(reply);
  });

  /**
   * Pattern-finding replies quote the journal back, notes included. The note
   * goes to the AI once, with the question that asked for it, so the answer
   * to a journal that carried one does not travel with later questions either.
   */
  it("does not resend the answer to a journal that carried a symptom note", async () => {
    const { askCoach, patternsQuestion } = await import("./ask");
    complete.mockResolvedValue("ok");
    const quoted = `On the 3rd you noted '${NOTE}', and the headache came two hours later.`;
    await askCoach("How was my sleep?", [
      { role: "user", content: patternsQuestion("2026-09-01", "2026-09-30", JOURNAL) },
      { role: "assistant", content: quoted },
    ]);
    const msgs = (complete.mock.calls[0]![0] as Req).messages;
    expect(JSON.stringify(msgs)).not.toContain(NOTE);
    expect(msgs[1]!.role).toBe("assistant");
    expect(msgs[1]!.content).toBe(
      "[The answer to that journal is not repeated here, because the journal carried symptom notes, which go with that question only.]",
    );
  });

  it("does so even when the journal's own question has fallen out of the window", async () => {
    const { askCoach, patternsQuestion } = await import("./ask");
    complete.mockResolvedValue("ok");
    const quoted = `You wrote '${NOTE}' on the 3rd.`;
    const history = [
      { role: "user" as const, content: patternsQuestion("2026-09-01", "2026-09-30", JOURNAL) },
      { role: "assistant" as const, content: quoted },
      ...Array.from({ length: MAX_CONTEXT_TURNS - 1 }, (_, i) => ({ role: "user" as const, content: `q${i}` })),
    ];
    await askCoach("and now?", history);
    const msgs = (complete.mock.calls[0]![0] as Req).messages;
    expect(msgs).toHaveLength(MAX_CONTEXT_TURNS + 1);
    expect(JSON.stringify(msgs)).not.toContain(NOTE);
  });

  it("knows a note in a journal this build wrote, as well as one an earlier build wrote", async () => {
    const { askCoach, patternsQuestion } = await import("./ask");
    const { summarizeRange } = await import("../journal");
    complete.mockResolvedValue("ok");
    const journal = summarizeRange(
      [
        {
          date: "2026-09-03",
          events: [{ id: "s", editable: true, at: Date.parse("2026-09-03T14:00:00Z"), timed: true, kind: "symptom",
                     label: "Headache", detail: "3/5", note: NOTE }],
          totals: { calories: 0, protein: 0, carbs: 0, fat: 0, waterMl: 0, exerciseKcal: 0, sleepMinutes: 0, symptomCount: 1 },
        } as unknown as import("../journal").DayJournal,
      ],
      { includeNotes: true },
    );
    expect(journal).toContain(NOTE);
    await askCoach("How was my sleep?", [
      { role: "user", content: patternsQuestion("2026-09-01", "2026-09-30", journal) },
      { role: "assistant", content: `You noted '${NOTE}'.` },
    ]);
    expect(JSON.stringify((complete.mock.calls[0]![0] as Req).messages)).not.toContain(NOTE);
  });

  it("keeps the answer to a journal without notes, so a follow-up still makes sense", async () => {
    const { askCoach, patternsQuestion } = await import("./ask");
    complete.mockResolvedValue("ok");
    const plain = "2026-09-03: 2140 cal from 9 items; symptoms: Headache at 14:00 (3/5); ate: coffee";
    await askCoach("Why do you think that is?", [
      { role: "user", content: patternsQuestion("2026-09-01", "2026-09-30", plain) },
      { role: "assistant", content: "Your headaches land on days with coffee." },
    ]);
    const msgs = (complete.mock.calls[0]![0] as Req).messages;
    expect(msgs[1]!.content).toBe("Your headaches land on days with coffee.");
  });

  it("asks about an empty range in words that follow the copy rules", async () => {
    const { patternsQuestion } = await import("./ask");
    const q = patternsQuestion("2026-10-01", "2026-10-31", "");
    expect(q).toBe("I have nothing recorded for 2026-10-01 to 2026-10-31. What would be worth tracking to spot patterns?");
    expect(q).not.toMatch(/\byet\b|\bnow\b|no longer|\u2014/i);
  });

  it("is the conversation the consent wording describes", () => {
    expect(DISCLOSURE_SENDS.join("\n")).toContain(`the last ${MAX_CONTEXT_TURNS} messages of your conversation`);
  });
});

/**
 * The summary leaves out targets for a tracking-only user and states a fast
 * loss outright; the prompt has to read both the same way.
 */
describe("the prompt and the summary agree", () => {
  const promptAndContext = async () => {
    const { askCoach } = await import("./ask");
    complete.mockResolvedValue("ok");
    await askCoach("What should I eat with what I have left today?");
    return (complete.mock.calls[0]![0] as { system: string }).system;
  };

  it("answers from what is left only when it is given targets", async () => {
    plan = {
      id: "p", mode: "logging_only", durationWeeks: 4, startDate: shiftDate(today, -7), endDate: shiftDate(today, 20),
      goals: [], safety: { ageBand: "18_39", pregnant: true, cardiacFlag: false, injuries: [], activityLevel: "light" },
      liability: { acknowledged: true, acceptedAt: "2026-01-01T00:00:00.000Z" }, createdAt: "2026-01-01T00:00:00.000Z",
    };
    const sys = await promptAndContext();
    expect(sys).toMatch(/when TODAY gives their targets, answer what to eat from what is left of them/);
    expect(sys).not.toMatch(/answer what to eat from what is left today/);
    const ctx = sys.split("ABOUT THIS USER")[1]!;
    expect(ctx).toContain("Tracking only: the app sets no weight");
    expect(ctx).not.toMatch(/Targets:|Remaining, negative|2200 cal/);
    expect(ctx).toContain("Eaten so far: 750 cal");
  });

  it("says where the fast-loss line and a weight they name come in", async () => {
    const sys = await promptAndContext();
    expect(sys).toMatch(/1% of body weight a week \(the summary says so when it is\)/);
    expect(sys).toMatch(/Treat a weight they name\s+themselves the same way when it is below a healthy range for their height/);
    expect(sys).not.toContain("—");
  });
});
