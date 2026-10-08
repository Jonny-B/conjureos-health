import { describe, it, expect } from "vitest";
import {
  isTrackingOnly,
  namesAWeight,
  renderAskContext,
  renderGapsForPrompt,
  renderPlanForPrompt,
  renderProfileForPrompt,
  renderSummaryBlocks,
  renderWeekForPrompt,
  renderWeightForPrompt,
  type AskFacts,
} from "./askSummary";
import type { DaySnapshot } from "../dataApi";
import { shiftDate } from "../diary";
import { DISCLOSURE_COACH_SAMPLE } from "../aiConsent";
import type { Plan, Profile, WeightEntry } from "../../types";
import askSource from "./ask.ts?raw";
import summarySource from "./askSummary.ts?raw";

const TODAY = "2026-10-08"; // a Thursday

function snap(date: string, cal: number, extra: Partial<DaySnapshot> = {}): DaySnapshot {
  const consumed = {
    calories: cal,
    protein: Math.round(cal * 0.061),
    carbs: Math.round(cal * 0.1035),
    fat: Math.round(cal * 0.0333),
  };
  return {
    date,
    targets: { calories: 1900, protein: 140, carbs: 180, fat: 65 },
    consumed,
    remaining: { calories: 1900 - cal, protein: 0, carbs: 0, fat: 0 },
    exerciseCalories: 0,
    foods: cal ? [{ name: "Oats", meal: "breakfast", quantity: 1, calories: cal, protein: 0, carbs: 0, fat: 0 }] : [],
    moreFoods: 0,
    waterMl: 0,
    sleepMinutes: 0,
    symptoms: [],
    ...extra,
  };
}

const PROFILE: Profile = {
  sex: "female",
  age: 41,
  heightCm: 165,
  weightKg: 80,
  activityLevel: "light",
  direction: "lose",
  units: "metric",
  goalWeightKg: 72,
};

function plan(over: Partial<Plan> = {}): Plan {
  return {
    id: "p",
    mode: "eat_better",
    durationWeeks: 4,
    startDate: "2026-09-24",
    endDate: "2026-10-21",
    goals: [],
    safety: { ageBand: "40_59", pregnant: false, cardiacFlag: false, injuries: [], activityLevel: "light" },
    liability: { acknowledged: true, acceptedAt: "2026-09-24T00:00:00Z" },
    createdAt: "2026-09-24T00:00:00Z",
    ...over,
  };
}

const WEIGHTS: WeightEntry[] = [
  { date: "2026-10-08", weightKg: 80.0 },
  { date: "2026-10-04", weightKg: 80.3 },
  { date: "2026-10-01", weightKg: 80.65 },
  { date: "2026-09-20", weightKg: 81.2 },
  { date: "2026-09-08", weightKg: 81.6 },
  { date: "2026-08-15", weightKg: 82.75 },
];

/** The fixture DISCLOSURE_COACH_SAMPLE was taken from. */
function sampleFacts(): AskFacts {
  const cals = [1700, 0, 1950, 1820, 1880, 1760, 1900];
  const sleeps = [420, 0, 450, 400, 440, 430, 440];
  const days = cals.map((c, i) => snap(shiftDate(TODAY, -(7 - i)), c, { sleepMinutes: sleeps[i]! }));
  days.push(snap(TODAY, 900));
  return {
    today: TODAY,
    units: "metric",
    profile: PROFILE,
    weights: WEIGHTS,
    plan: plan(),
    days,
    sleep: days
      .filter((d) => d.sleepMinutes)
      .map((d, i) => ({ id: d.date, date: d.date, bedAt: "x", wakeAt: "y", quality: i % 2 ? 4 : 3 })),
  };
}

describe("the consent sheet's coach sample", () => {
  it("is real output of these renderers, line for line", () => {
    const out = renderSummaryBlocks(sampleFacts()).split("\n");
    for (const line of DISCLOSURE_COACH_SAMPLE.split("\n")) expect(out).toContain(line);
  });
});

describe("renderWeightForPrompt", () => {
  it("gives the latest weigh-in and dated changes in the user's units", () => {
    const out = renderWeightForPrompt(WEIGHTS, undefined, "imperial");
    expect(out).toContain("Latest: 176.4 lb on 2026-10-08. 6 weigh-ins since 2026-08-15.");
    expect(out).toContain("-1.4 lb since 2026-10-01");
    expect(out).toContain("-3.5 lb since 2026-09-08");
    expect(out).toContain("-6.1 lb since the first weigh-in");
    expect(out).toMatch(/Pace: about -0\.8 lb a week since 2026-09-08\./);
    expect(out).not.toMatch(/\bkg\b/);
  });

  it("orders by date itself rather than trusting the store", () => {
    const shuffled = [WEIGHTS[3]!, WEIGHTS[0]!, WEIGHTS[5]!, WEIGHTS[1]!, WEIGHTS[4]!, WEIGHTS[2]!];
    expect(renderWeightForPrompt(shuffled, undefined, "metric")).toBe(
      renderWeightForPrompt(WEIGHTS, undefined, "metric"),
    );
  });

  it("is empty with no weigh-ins, even when the profile has a weight", () => {
    expect(renderWeightForPrompt([], 72, "metric")).toBe("");
  });

  it("handles a single weigh-in without inventing a change", () => {
    const out = renderWeightForPrompt([{ date: TODAY, weightKg: 80 }], undefined, "metric");
    expect(out).toBe("WEIGHT\nLatest: 80 kg on 2026-10-08, the only weigh-in.");
  });

  it("sends a believable goal weight and drops a pounds figure sitting in the kg slot", () => {
    const lose = { direction: "lose" as const };
    expect(renderWeightForPrompt(WEIGHTS, 72, "imperial", lose)).toContain("Goal weight: 158.7 lb (17.6 lb away).");
    // 160 typed as pounds while the app was metric: stored as 160 kg.
    expect(renderWeightForPrompt(WEIGHTS, 160, "imperial", { direction: "gain" })).not.toContain("Goal weight");
  });

  /**
   * The unit check above passes any goal within reach of their weight, and a
   * steady loss toward an underweight goal trips none of the prompt's
   * eating-disorder guardrails (pace under 1% a week, days above the floor).
   */
  it("never sends a goal weight below a healthy range for their height as a target", () => {
    const ws = [
      { date: "2026-10-08", weightKg: 52 },
      { date: "2026-09-10", weightKg: 53.6 },
    ];
    // 165 cm and 42 kg is a BMI of about 15.4, and 42 / 52 passes the unit check.
    const out = renderWeightForPrompt(ws, 42, "metric", { heightCm: 165, direction: "lose" });
    expect(out).toContain("Their goal weight is below a healthy range for their height.");
    expect(out).not.toMatch(/42 kg|10\.0 kg away|Goal weight:/);
    // Their weight and its trend are still there.
    expect(out).toContain("Latest: 52 kg on 2026-10-08.");
    expect(out).toContain("Pace: about -0.4 kg a week");
    // A healthy goal for the same height is sent as before (BMI about 20.2).
    expect(renderWeightForPrompt(ws, 55, "metric", { heightCm: 165, direction: "gain" })).toContain(
      "Goal weight: 55 kg (3.0 kg away).",
    );
    // A height that is not believable cannot judge it either way.
    expect(renderWeightForPrompt(ws, 42, "metric", { heightCm: 66, direction: "lose" })).toContain("Goal weight: 42 kg");
  });

  it("sends where their weight is but no goal weight or pace when tracking only", () => {
    const out = renderWeightForPrompt(WEIGHTS, 72, "metric", { heightCm: 165, trackingOnly: true });
    expect(out).toContain("Latest: 80 kg on 2026-10-08.");
    expect(out).toContain("since the first weigh-in");
    expect(out).not.toMatch(/Goal weight|Pace|healthy range/);
  });
});

describe("renderProfileForPrompt", () => {
  it("states goal direction and body stats, never the profile's weight", () => {
    const out = renderProfileForPrompt({ ...PROFILE, weightKg: 176 }, "imperial");
    expect(out).toBe(`PROFILE\nGoal: losing weight. Sex: female. Age: 41. Height: 5'5". Activity: lightly active.`);
    expect(out).not.toContain("176");
  });

  it("drops what it cannot trust or was not shared", () => {
    const out = renderProfileForPrompt({ ...PROFILE, sex: "not_shared", age: 3, heightCm: 66 }, "metric");
    expect(out).toBe("PROFILE\nGoal: losing weight. Activity: lightly active.");
  });

  it("is empty with no profile", () => {
    expect(renderProfileForPrompt(null, "metric")).toBe("");
  });

  it("states no goal direction when goals are withheld", () => {
    expect(renderProfileForPrompt({ ...PROFILE, age: 15 }, "metric", { goalsWithheld: true })).toBe(
      `PROFILE\nSex: female. Age: 15. Height: 165 cm. Activity: lightly active.`,
    );
  });

  /**
   * A logging-only plan never asks height, and a first plan merges onto
   * DEFAULT_PROFILE, so the 170 cm on file is that default's. Nothing the
   * coach does for a tracking-only user needs height or activity.
   */
  it("states no height or activity for a tracking-only user", () => {
    expect(
      renderProfileForPrompt({ ...PROFILE, age: 15 }, "metric", { goalsWithheld: true, trackingOnly: true }),
    ).toBe("PROFILE\nSex: female. Age: 15.");
    const f = sampleFacts();
    // Saved by a build that keeps the sex picked (see "sex from a plan that
    // may not have kept it" below).
    f.plan = plan({ mode: "logging_only", bodySavedAt: "2026-09-24T00:00:00Z" });
    const out = renderAskContext(f);
    expect(out).toContain("PROFILE\nSex: female. Age: 41.");
    expect(out).not.toMatch(/Height:|Activity:/);
  });
});

describe("isTrackingOnly", () => {
  it("is a plan that tracks no food or an age under 18, and nothing else", () => {
    expect(isTrackingOnly(plan({ mode: "logging_only" }), PROFILE)).toBe(true);
    expect(isTrackingOnly(plan({ mode: "get_fit" }), PROFILE)).toBe(true);
    expect(isTrackingOnly(null, { ...PROFILE, age: 15 })).toBe(true);
    expect(isTrackingOnly(plan(), { ...PROFILE, age: 17 })).toBe(true);
    // Too low to state as fact, but still treated with care.
    expect(isTrackingOnly(null, { ...PROFILE, age: 3 })).toBe(true);
    expect(isTrackingOnly(plan(), PROFILE)).toBe(false);
    expect(isTrackingOnly(plan({ mode: "both" }), { ...PROFILE, age: 18 })).toBe(false);
    expect(isTrackingOnly(null, null)).toBe(false);
    expect(isTrackingOnly(null, { ...PROFILE, age: Number.NaN })).toBe(false);
  });
});

describe("renderPlanForPrompt", () => {
  it("counts the day of the plan, inclusive at both ends", () => {
    expect(renderPlanForPrompt(plan(), TODAY, [])).toContain("2026-09-24 to 2026-10-21, day 15 of 28.");
    expect(renderPlanForPrompt(plan(), "2026-09-24", [])).toContain("day 1 of 28");
    expect(renderPlanForPrompt(plan(), "2026-10-21", [])).toContain("day 28 of 28");
    expect(renderPlanForPrompt(plan(), "2026-09-21", [])).toContain("starts in 3 days");
    expect(renderPlanForPrompt(plan(), "2026-10-22", [])).toContain("ended 1 day ago");
  });

  it("carries the goal in the user's words, capped, and up to three visible goals", () => {
    const out = renderPlanForPrompt(
      plan({
        goalText: `Feel stronger before my sister's wedding. ${"Really. ".repeat(40)}`,
        goals: [
          { id: "1", label: "Hit 140 g protein", kind: "nutrition" },
          { id: "2", label: "Murph benchmark", kind: "workout" },
          { id: "3", label: "Drink 2 L of water", kind: "habit" },
          { id: "4", label: "Log every meal", kind: "habit" },
          { id: "5", label: "Walk after dinner", kind: "habit" },
        ],
      }),
      TODAY,
      [],
    );
    const goalLine = out.split("\n").find((l) => l.startsWith("Goal in their words: "))!;
    expect(goalLine).toContain("Feel stronger before my sister's wedding.");
    expect(goalLine.length).toBeLessThanOrEqual("Goal in their words: ".length + 120);
    expect(out).toContain("Plan goals: Hit 140 g protein; Drink 2 L of water; Log every meal; and 1 more.");
    // A paused workout goal is not presented as something to do.
    expect(out).not.toContain("Murph");
  });

  it("counts exercise days this week (Monday on) against the weekly target", () => {
    const days = [
      snap("2026-10-04", 0, { exerciseCalories: 500 }), // Sunday, last week
      snap("2026-10-05", 0, { exerciseCalories: 300 }), // Monday
      snap("2026-10-07", 0, { exerciseCalories: 200 }),
      snap(TODAY, 0),
    ];
    expect(renderPlanForPrompt(plan({ weeklyExerciseDays: 3 }), TODAY, days)).toContain(
      "Exercise: 2 of 3 target days this week (Mon to Sun).",
    );
  });

  /**
   * The wizard asks "Want to move most days?" on every plan without workouts,
   * a logging-only one included, so a cardiac, pregnant or under-18 user can
   * carry a weekly target that the tracking-only line says the app never set.
   */
  it("sends no weekly exercise target to a tracking-only user", () => {
    const days = [snap("2026-10-05", 0, { exerciseCalories: 300 }), snap(TODAY, 0)];
    const loggingOnly = renderPlanForPrompt(plan({ mode: "logging_only", weeklyExerciseDays: 5 }), TODAY, days);
    expect(loggingOnly).toContain("Tracking only");
    expect(loggingOnly).not.toMatch(/target days|Exercise:/);
    const minor = renderPlanForPrompt(plan({ weeklyExerciseDays: 5 }), TODAY, days, { trackingOnly: true });
    expect(minor).not.toMatch(/target days|Exercise:/);
    // An ordinary plan keeps it (positive control).
    expect(renderPlanForPrompt(plan({ weeklyExerciseDays: 5 }), TODAY, days)).toContain(
      "Exercise: 1 of 5 target days this week (Mon to Sun).",
    );
  });

  it("says what a logging-only plan means for the coach, never why it is one", () => {
    const p = plan({
      mode: "logging_only",
      safety: { ageBand: "18_39", pregnant: true, cardiacFlag: false, injuries: [], activityLevel: "light" },
    });
    const out = renderPlanForPrompt(p, TODAY, []);
    expect(out).toBe(
      "PLAN\nLogging plan, 2026-09-24 to 2026-10-21, day 15 of 28.\n" +
        "Tracking only: the app sets no weight, calorie-cutting or exercise goals for this user.",
    );
    expect(renderPlanForPrompt(plan(), TODAY, [])).not.toContain("Tracking only");
  });

  it("never sends the safety intake, the liability record or the program", () => {
    const p = plan({
      safety: { ageBand: "18_39", pregnant: true, cardiacFlag: true, injuries: ["knee"], activityLevel: "light" },
      program: {
        workouts: [{ id: "w", workout: { id: "w", name: "Murph assessment" } as never }],
        benchmarks: [],
      },
    });
    const out = renderPlanForPrompt(p, TODAY, []);
    expect(out).not.toMatch(/pregnan|cardiac|knee|injur|Murph|acknowledged|18_39/i);
  });

  it("is empty with no plan", () => {
    expect(renderPlanForPrompt(null, TODAY, [])).toBe("");
  });
});

describe("renderWeekForPrompt", () => {
  it("averages over the days something was logged, not over all seven", () => {
    const f = sampleFacts();
    const out = renderWeekForPrompt(f);
    // 6 logged days averaging 1835; a 7-day average would read 1573.
    expect(out).toContain("Food: logged 6 of 7 days");
    expect(out).toContain("avg 1835 cal");
    expect(out).not.toContain("1573");
  });

  it("counts a logging run through yesterday while today is still empty", () => {
    const f = sampleFacts();
    f.days[f.days.length - 1] = snap(TODAY, 0);
    expect(renderWeekForPrompt(f)).toContain("(5 in a row through yesterday)");
  });

  it("does not say a run reaches today when today could not be read", () => {
    const f = sampleFacts();
    f.days.pop(); // today's snapshot failed
    const out = renderWeekForPrompt(f);
    expect(out).toContain("(5 in a row through yesterday)");
    expect(out).not.toContain("through today");
  });

  it("leaves a day whose diary could not be read out of the food count", () => {
    const f = sampleFacts();
    f.days[3] = { ...snap(f.days[3]!.date, 0), unreadable: ["diary"] };
    expect(renderWeekForPrompt(f)).toContain("Food: logged 5 of 6 days");
  });

  it("flags logged days under the calorie floor", () => {
    const f = sampleFacts();
    f.days[2] = snap(f.days[2]!.date, 900);
    expect(renderWeekForPrompt(f)).toContain("Logged days under 1200 cal: 1.");
    f.profile = { ...PROFILE, sex: "male" };
    f.days[3] = snap(f.days[3]!.date, 1400);
    expect(renderWeekForPrompt(f)).toContain("Logged days under 1500 cal: 2.");
  });

  it("counts symptoms by label and keeps the top five", () => {
    const f = sampleFacts();
    const s = (label: string) => ({ label, at: "x", severity: 2 });
    f.days[0] = { ...f.days[0]!, symptoms: [s("Headache"), s("Bloating")] };
    f.days[1] = { ...f.days[1]!, symptoms: [s("headache"), s("Nausea"), s("Cramps")] };
    f.days[2] = { ...f.days[2]!, symptoms: [s("Headache"), s("Fatigue"), s("Dizziness")] };
    expect(renderWeekForPrompt(f)).toContain(
      "Symptoms: Headache 3 times, Bloating once, Cramps once, Dizziness once, Fatigue once, and 1 other.",
    );
  });

  it("is empty for a week with nothing logged", () => {
    const days = Array.from({ length: 8 }, (_, i) => snap(shiftDate(TODAY, -(7 - i)), 0));
    expect(renderWeekForPrompt({ ...sampleFacts(), days, sleep: [] })).toBe("");
  });
});

describe("renderGapsForPrompt", () => {
  it("names every read that failed, in one line", () => {
    const f = sampleFacts();
    f.unreadable = ["plan", "weight", "rested"];
    expect(renderGapsForPrompt(f)).toBe(
      "COULD NOT READ THIS TIME\nTheir weigh-ins, their plan, how rested they felt.",
    );
  });

  it("names the parts of today that failed, and an earlier day once", () => {
    const f = sampleFacts();
    f.days[f.days.length - 1] = { ...f.days[f.days.length - 1]!, unreadable: ["diary", "targets", "weight"] };
    f.days[1] = { ...f.days[1]!, unreadable: ["water"] };
    f.days[2] = { ...f.days[2]!, unreadable: ["symptoms"] };
    expect(renderGapsForPrompt(f)).toBe(
      "COULD NOT READ THIS TIME\nToday's food, their daily targets, some of the 7 days before today.",
    );
  });

  it("ignores what an earlier day's summary does not use", () => {
    const f = sampleFacts();
    f.days[1] = { ...f.days[1]!, unreadable: ["targets", "weight"] };
    expect(renderGapsForPrompt(f)).toBe("");
  });

  it("is empty when every read worked", () => {
    expect(renderGapsForPrompt(sampleFacts())).toBe("");
    expect(renderGapsForPrompt({ ...sampleFacts(), unreadable: [] })).toBe("");
  });
});

describe("renderAskContext", () => {
  /**
   * The reviewers' case: a "lose" plan with a 60 kg goal, rebuilt after
   * ticking pregnant. The wizard sends no direction or goal weight for a
   * logging-only plan, so the profile keeps the old ones.
   */
  it("sends no weight-loss goal for a logging-only plan left with an earlier plan's goal", () => {
    const f = sampleFacts();
    f.profile = { ...PROFILE, direction: "lose", goalWeightKg: 60 };
    f.weights = [
      { date: "2026-10-08", weightKg: 68 },
      { date: "2026-09-20", weightKg: 67.2 },
      { date: "2026-08-20", weightKg: 66 },
    ];
    f.plan = plan({
      mode: "logging_only",
      weeklyExerciseDays: 3,
      safety: { ageBand: "18_39", pregnant: true, cardiacFlag: false, injuries: [], activityLevel: "light" },
    });
    const out = renderAskContext(f);
    expect(out).toContain("Tracking only: the app sets no weight, calorie-cutting or exercise goals for this user.");
    expect(out).toContain("Latest: 68 kg on 2026-10-08.");
    expect(out).not.toMatch(/losing weight|Goal weight|60 kg|Pace:|pregnan/i);
    // The plan's weekly exercise target is a goal too, and the coach is told
    // not to suggest exercise to do.
    expect(out).not.toMatch(/target days/);
  });

  it("sends no weight-loss goal for a 15-year-old", () => {
    const f = sampleFacts();
    f.profile = { ...PROFILE, age: 15, direction: "lose", goalWeightKg: 72 };
    f.plan = plan({ weeklyExerciseDays: 5 });
    const out = renderAskContext(f);
    expect(out).toContain("Age: 15.");
    expect(out).not.toMatch(/losing weight|Goal weight|72 kg|Pace:/);
    expect(out).not.toMatch(/target days/);
  });

  it("ends with what could not be read, and is not empty when that is all there is", () => {
    const out = renderAskContext({
      today: TODAY,
      units: "metric",
      profile: null,
      weights: [],
      plan: null,
      days: [],
      sleep: [],
      unreadable: ["today", "earlier", "weight"],
    });
    expect(out).toBe("COULD NOT READ THIS TIME\nToday's diary, some of the 7 days before today, their weigh-ins.");
  });

  it("leaves out every section that has nothing in it", () => {
    const out = renderAskContext({
      today: TODAY,
      units: "metric",
      profile: null,
      weights: [],
      plan: null,
      days: [snap(TODAY, 0)],
      sleep: [],
    });
    expect(out).toMatch(/^TODAY\n/);
    expect(out).not.toMatch(/PROFILE|WEIGHT|PLAN|LAST 7 DAYS|RECENT DAYS/);
    expect(out).not.toMatch(/undefined|NaN|null/);
    // The model repeats this line back, so it keeps to the copy rules.
    expect(out).toContain("Nothing logged today so far.");
    expect(out).not.toMatch(/\byet\b|\bnow\b|no longer/i);
  });

  it("stays within its budget on a heavy week", () => {
    const f = sampleFacts();
    f.weights = Array.from({ length: 400 }, (_, i) => ({ date: shiftDate(TODAY, -i), weightKg: 80 + i * 0.05 }));
    f.plan = plan({
      goalText: "x ".repeat(500),
      weeklyExerciseDays: 5,
      goals: Array.from({ length: 12 }, (_, i) => ({
        id: String(i),
        label: `A very long plan goal label number ${i} that keeps going well past any sensible length`,
        kind: "habit" as const,
      })),
    });
    f.days = f.days.map((d, i) => ({
      ...d,
      waterMl: 1800,
      sleepMinutes: 450,
      exerciseCalories: 250,
      symptoms: Array.from({ length: 6 }, (_, j) => ({ label: `Symptom number ${j} ${i % 2}`, at: "x", severity: 3 })),
    }));
    const blocks = renderSummaryBlocks(f);
    expect(blocks.length).toBeLessThan(1200);
  });
});

/**
 * The coach is read-only by construction, not by politeness: nothing on its
 * path may write. A behavioural test can only catch the writes it thinks to
 * look for, so this one reads the source instead.
 */
describe("no write path", () => {
  const sources = { "ask.ts": askSource, "askSummary.ts": summarySource };

  it("imports nothing that changes the plan, the coach's memory or the diary", () => {
    for (const [name, src] of Object.entries(sources)) {
      expect(src, name).not.toMatch(/from\s+["'][^"']*(planService|coach\/coach|\.\/coach|memory|bridge\/actions|saveFailure)["']/);
    }
  });

  it("calls no repository write method", () => {
    const writes = /\.(save|add|update|upsert|remove|clear|mark|persist)[A-Z]\w*\s*\(/;
    for (const [name, src] of Object.entries(sources)) expect(src, name).not.toMatch(writes);
  });

  it("writes only its own chat history", () => {
    expect(summarySource).not.toMatch(/writeJson|writeFile/);
    const calls = askSource.match(/writeJson\([^,)]*/g) ?? [];
    expect(calls).toEqual(["writeJson(CHAT_PATH"]);
  });
});

/**
 * The safety gate in renderSummaryBlocks has to fail closed and has to reach
 * every part of the summary: a goal left on the profile by an earlier plan, a
 * goal restated in the plan's own words, and the targets in TODAY are each
 * enough to coach a user the app sets no goals.
 */
describe("tracking only, everywhere it matters", () => {
  const leftover = (f: AskFacts) => {
    f.profile = { ...PROFILE, direction: "lose", goalWeightKg: 60 };
    f.weights = [
      { date: "2026-10-08", weightKg: 68 },
      { date: "2026-09-20", weightKg: 69 },
      { date: "2026-08-20", weightKg: 70 },
    ];
  };

  it("fails closed when the plan could not be read: no goal, goal weight or pace", () => {
    const f = sampleFacts();
    leftover(f);
    f.plan = null;
    f.unreadable = ["plan"];
    const out = renderAskContext(f);
    expect(out).not.toMatch(/losing weight|Goal weight|60 kg|Pace:/);
    expect(out).toContain(
      "PLAN\nTracking only for this question: their plan could not be read, so treat them as having no weight, calorie-cutting or exercise goals.",
    );
    expect(out).toContain("COULD NOT READ THIS TIME\nTheir plan.");
    // Positive control: the same facts with the plan read send the goal.
    const read = sampleFacts();
    leftover(read);
    expect(renderAskContext(read)).toContain("Goal weight: 60 kg (8.0 kg away).");
  });

  it("says tracking only for an age too low to state, with or without a plan", () => {
    for (const p of [null, plan()]) {
      const f = sampleFacts();
      f.profile = { ...PROFILE, age: 11 };
      f.plan = p;
      const out = renderAskContext(f);
      expect(out).not.toContain("Age:");
      expect(out).toContain("Tracking only: the app sets no weight, calorie-cutting or exercise goals for this user.");
      expect(out).not.toMatch(/losing weight|Goal weight/);
    }
  });

  it("sends no calorie target or what is left for a tracking-only user", () => {
    const f = sampleFacts();
    f.plan = plan({ mode: "logging_only" });
    const out = renderAskContext(f);
    expect(out).toContain("TODAY\nDate: 2026-10-08\nEaten so far: 900 cal");
    expect(out).not.toMatch(/Targets:|Remaining, negative/);
    // A failed targets read is not named either: they were never to be sent.
    f.days[f.days.length - 1] = { ...f.days[f.days.length - 1]!, unreadable: ["targets"] };
    expect(renderAskContext(f)).not.toMatch(/daily targets/);
    // An adult on an ordinary plan still gets both.
    expect(renderAskContext(sampleFacts())).toMatch(/Targets: 1900 cal[\s\S]*Remaining, negative means over \(1000 cal/);
  });

  it("sends no goal in their words and no plan goals for a tracking-only user", () => {
    const f = sampleFacts();
    f.plan = plan({
      mode: "logging_only",
      goalText: "lose the baby weight, about 20 lb",
      goals: [
        { id: "1", label: "Lose 1 lb a week", kind: "habit" },
        { id: "2", label: "Log everything you eat", kind: "nutrition" },
      ],
    });
    const out = renderAskContext(f);
    expect(out).toContain("Tracking only: the app sets no weight");
    expect(out).not.toMatch(/baby weight|20 lb|Lose 1 lb|Goal in their words|Plan goals/);
  });

  it("drops the goal in their words next to a goal weight below a healthy range", () => {
    const f = sampleFacts();
    f.profile = { ...PROFILE, heightCm: 165, direction: "lose", goalWeightKg: 42 };
    f.weights = [
      { date: "2026-10-08", weightKg: 52 },
      { date: "2026-09-10", weightKg: 53.6 },
    ];
    f.plan = plan({ goalText: "get down to 42 kg", goals: [{ id: "1", label: "Reach 42 kg", kind: "habit" }] });
    const out = renderAskContext(f);
    expect(out).toContain("Their goal weight is below a healthy range for their height.");
    expect(out).not.toMatch(/42 kg|Goal in their words|Plan goals/);
  });
});

describe("weight signals", () => {
  // 55 kg down to 50.5 kg in three weeks: 1.5 kg a week, about 3% of body weight.
  const FAST = [
    { date: "2026-10-07", weightKg: 50.5 },
    { date: "2026-09-30", weightKg: 52 },
    { date: "2026-09-23", weightKg: 53.5 },
    { date: "2026-09-16", weightKg: 55 },
  ];

  it("flags loss faster than 1% of body weight a week for every user, tracking only included", () => {
    const teen = renderWeightForPrompt(FAST, undefined, "imperial", { trackingOnly: true });
    expect(teen).toContain("Losing more than 1% of body weight a week since 2026-09-16.");
    expect(teen).not.toContain("Pace:");
    const adult = renderWeightForPrompt(FAST, undefined, "imperial");
    expect(adult).toContain("Pace: about -3.3 lb a week since 2026-09-16.");
    expect(adult).toContain("Losing more than 1% of body weight a week since 2026-09-16.");
    // About 0.15% a week: no flag.
    expect(renderWeightForPrompt(WEIGHTS, undefined, "metric")).not.toContain("1% of body weight");
    // Through the whole summary, for a 15-year-old.
    const f = sampleFacts();
    f.profile = { ...PROFILE, age: 15, units: "imperial" };
    f.units = "imperial";
    f.weights = FAST;
    expect(renderAskContext(f)).toContain("Losing more than 1% of body weight a week since 2026-09-16.");
  });

  it("sends no goal weight when their plan is to maintain, whatever the profile kept", () => {
    const ws = [
      { date: "2026-10-08", weightKg: 68 },
      { date: "2026-09-20", weightKg: 68.3 },
    ];
    const out = renderWeightForPrompt(ws, 55, "metric", { heightCm: 165, direction: "maintain" });
    expect(out).not.toMatch(/Goal weight|55 kg|13\.0/);
    const f = sampleFacts();
    f.profile = { ...PROFILE, direction: "maintain", goalWeightKg: 55 };
    f.weights = ws;
    expect(renderAskContext(f)).not.toMatch(/Goal weight|55 kg/);
    // A goal they have gone past reads as reached, not as more to lose.
    expect(renderWeightForPrompt(ws, 69, "metric", { direction: "lose" })).toContain("Goal weight: 69 kg (reached).");
  });

  it("says a goal under half their weight is below a healthy range, rather than nothing", () => {
    const ws = [
      { date: "2026-10-08", weightKg: 52 },
      { date: "2026-09-10", weightKg: 53 },
    ];
    for (const goal of [25, 27]) {
      expect(renderWeightForPrompt(ws, goal, "metric", { heightCm: 163, direction: "lose" })).toContain(
        "Their goal weight is below a healthy range for their height.",
      );
    }
  });
});

describe("the food-logging run", () => {
  const eightDays = () => Array.from({ length: 8 }, (_, i) => snap(shiftDate(TODAY, -(7 - i)), 1800));

  it("is a lower bound when it stops at a day whose diary could not be read", () => {
    const days = eightDays();
    days[3] = { ...snap(days[3]!.date, 0), unreadable: ["diary"] };
    expect(renderWeekForPrompt({ ...sampleFacts(), days })).toContain("(at least 4 in a row through today)");
  });

  it("is a lower bound when it stops at a day whose snapshot failed", () => {
    const days = eightDays().filter((_, i) => i !== 3);
    expect(renderWeekForPrompt({ ...sampleFacts(), days })).toContain("(at least 4 in a row through today)");
  });

  it("is exact when it stops at a day with nothing logged", () => {
    const days = eightDays();
    days[3] = snap(days[3]!.date, 0);
    expect(renderWeekForPrompt({ ...sampleFacts(), days })).toContain("(4 in a row through today)");
  });
});

/**
 * Below a healthy range for their height (BMI under 18.5), worked out in code
 * because the model can get the arithmetic wrong. 165 cm throughout: 44 kg is
 * a BMI of about 16.2, 47 kg 17.3, 48 kg 17.6, 50 kg 18.4, 52 kg 19.1.
 */
describe("a weight below a healthy range", () => {
  const at = (latest: number, earlier: number) => [
    { date: "2026-10-08", weightKg: latest },
    { date: "2026-09-10", weightKg: earlier },
  ];

  it("helps someone gain toward a goal that is still under it, and says where they are", () => {
    const out = renderWeightForPrompt(at(44, 43), 48, "metric", { heightCm: 165, direction: "gain" });
    expect(out).not.toContain("Their goal weight is below a healthy range");
    expect(out).toContain("Goal weight: 48 kg (4.0 kg away).");
    expect(out).toContain("Their current weight is below a healthy range for their height.");
    const f = sampleFacts();
    f.profile = { ...PROFILE, direction: "gain", goalWeightKg: 48 };
    f.weights = at(44, 43);
    f.plan = plan({ goalText: "gain weight back after being ill" });
    const ctx = renderAskContext(f);
    expect(ctx).toContain("Goal: gaining weight.");
    expect(ctx).toContain("Goal in their words: gain weight back after being ill");
    expect(ctx).toMatch(/Targets: 1900 cal[\s\S]*Remaining, negative means over/);
    expect(ctx).not.toContain("Their goal weight is below a healthy range");
  });

  it("still flags an underweight goal they would have to lose weight to reach", () => {
    // Gained past it: getting back to it means losing.
    const past = renderWeightForPrompt(at(52, 50), 48, "metric", { heightCm: 165, direction: "gain" });
    expect(past).toContain("Their goal weight is below a healthy range for their height.");
    expect(past).not.toMatch(/Goal weight:/);
    // Heading down to it, with or without a weigh-in to compare.
    expect(renderWeightForPrompt(at(52, 53), 45, "metric", { heightCm: 165, direction: "lose" })).toContain(
      "Their goal weight is below a healthy range for their height.",
    );
    expect(renderWeightForPrompt([], 45, "metric", { heightCm: 165, direction: "lose" })).toBe(
      "WEIGHT\nTheir goal weight is below a healthy range for their height.",
    );
  });

  /**
   * Withholding the goal weight is not enough when TODAY still budgets the day
   * inside the deficit that was set to reach it, and the prompt says to answer
   * what to eat from what is left.
   */
  it("sends no targets, what is left or goal direction beside a goal below a healthy range", () => {
    const f = sampleFacts();
    f.profile = { ...PROFILE, age: 22, direction: "lose", goalWeightKg: 45 };
    f.weights = at(55, 56);
    const out = renderAskContext(f);
    expect(out).toContain("Their goal weight is below a healthy range for their height.");
    expect(out).toContain("Eaten so far: 900 cal");
    expect(out).not.toMatch(/Targets:|Remaining, negative|losing weight/);
    // Not sent, so a failed targets read is no gap either.
    f.days[f.days.length - 1] = { ...f.days[f.days.length - 1]!, unreadable: ["targets"] };
    expect(renderAskContext(f)).not.toMatch(/daily targets/);
  });

  it("says their current weight is below a healthy range, whatever their goal", () => {
    // Maintaining, no goal weight, losing about 0.2 kg a week: under the 1% line.
    const ws = [
      { date: "2026-10-08", weightKg: 47 },
      { date: "2026-09-17", weightKg: 47.6 },
    ];
    const out = renderWeightForPrompt(ws, undefined, "metric", { heightCm: 165, direction: "maintain" });
    expect(out).toContain("Their current weight is below a healthy range for their height.");
    expect(out).not.toContain("1% of body weight");
    const f = sampleFacts();
    f.profile = { ...PROFILE, direction: "maintain", goalWeightKg: undefined };
    f.weights = ws;
    expect(renderAskContext(f)).toContain("Their current weight is below a healthy range for their height.");
    // Not at a healthy weight, and not with a height that cannot be believed.
    expect(renderWeightForPrompt(WEIGHTS, undefined, "metric", { heightCm: 165 })).not.toContain("healthy range");
    expect(renderWeightForPrompt(ws, undefined, "metric", { heightCm: 66 })).not.toContain("healthy range");
  });

  /**
   * The plan wizard keeps the weight it built the plan from on the profile
   * and logs no weigh-in, so a user who has just made a plan has none. 170 cm
   * and 47 kg is a BMI of about 16.3. With a blank goal the plan is to
   * maintain, so no goal weight is there to catch it either.
   */
  it("judges the weight their plan was built from when no weigh-in is logged, and never sends it", () => {
    const fresh = (weightKg: number): AskFacts => {
      const f = sampleFacts();
      f.profile = { ...PROFILE, age: 24, heightCm: 170, weightKg, direction: "maintain", goalWeightKg: undefined };
      f.weights = [];
      return f;
    };
    const out = renderAskContext(fresh(47));
    expect(out).toContain("WEIGHT\nTheir current weight is below a healthy range for their height.");
    expect(out).not.toMatch(/Targets:|Remaining, negative|Goal: maintaining/);
    expect(out).not.toMatch(/\b47\b/);
    // A healthy weight on the profile adds nothing.
    const healthy = renderAskContext(fresh(60));
    expect(healthy).not.toContain("WEIGHT");
    expect(healthy).toMatch(/Targets: 1900 cal/);
    // A weigh-in, once there is one, is what counts.
    const weighed = fresh(47);
    weighed.weights = [{ date: TODAY, weightKg: 60 }];
    expect(renderAskContext(weighed)).not.toContain("healthy range");
    // And the tracking-only rule still covers a tracking-only user.
    const teen = fresh(47);
    teen.profile = { ...teen.profile!, age: 15 };
    expect(renderAskContext(teen)).not.toContain("healthy range");
  });

  it("leaves it to the tracking-only rule, since adult ranges do not hold under 18 or in pregnancy", () => {
    const ws = at(47, 47.6);
    expect(renderWeightForPrompt(ws, undefined, "metric", { heightCm: 165, trackingOnly: true })).not.toContain(
      "healthy range",
    );
  });

  it("sends nothing to cut toward for someone under it who is not set to gain", () => {
    for (const direction of ["lose", "maintain"] as const) {
      const f = sampleFacts();
      // A healthy goal of 52 kg, gone past to 50 kg.
      f.profile = { ...PROFILE, direction, goalWeightKg: 52 };
      f.weights = at(50, 50.4);
      f.plan = plan({ weeklyExerciseDays: 5, goalText: "get lean" });
      const out = renderAskContext(f);
      expect(out, direction).toContain("Their current weight is below a healthy range for their height.");
      expect(out, direction).not.toMatch(/Targets:|Remaining, negative|losing weight|maintaining|get lean|target days/);
    }
  });
});

/**
 * The prompt reads a missing 1% line as "not losing too fast", so the line is
 * worked out from whatever earlier weigh-in can carry it, not only from one a
 * fortnight to a month back. 165 cm throughout, so no weight here is below a
 * healthy range and the 1% line is the only signal.
 */
describe("fast loss, however the weigh-ins are spaced", () => {
  const LOSE = { heightCm: 165, direction: "lose" as const };
  const FAST_LINE = (since: string) => `Losing more than 1% of body weight a week since ${since}.`;

  it("flags it from two weigh-ins under a fortnight apart", () => {
    // 5 kg in 13 days: about 2.7 kg, or 4.9% of body weight, a week.
    const ws = [
      { date: "2026-10-08", weightKg: 55 },
      { date: "2026-09-25", weightKg: 60 },
    ];
    expect(renderWeightForPrompt(ws, 52, "metric", LOSE)).toContain(FAST_LINE("2026-09-25"));
    const f = sampleFacts();
    f.profile = { ...PROFILE, age: 25, direction: "lose", goalWeightKg: 52 };
    f.weights = ws;
    expect(renderAskContext(f)).toContain(FAST_LINE("2026-09-25"));
  });

  it("flags it, and gives a pace, from weigh-ins more than a month apart", () => {
    // 8 kg in 37 days: about 1.5 kg, or 2.8% of body weight, a week.
    const ws = [
      { date: "2026-10-08", weightKg: 54 },
      { date: "2026-09-01", weightKg: 62 },
    ];
    const out = renderWeightForPrompt(ws, 52, "metric", LOSE);
    expect(out).toContain("Pace: about -1.5 kg a week since 2026-09-01.");
    expect(out).toContain(FAST_LINE("2026-09-01"));
  });

  it("flags a fast fortnight even when a slow month or more came before it", () => {
    // 2.6 kg in the last 10 days, after months of almost nothing.
    const ws = [
      { date: "2026-10-08", weightKg: 60 },
      { date: "2026-09-28", weightKg: 62.6 },
      { date: "2026-06-01", weightKg: 63 },
    ];
    expect(renderWeightForPrompt(ws, 55, "metric", LOSE)).toContain(FAST_LINE("2026-09-28"));
  });

  /**
   * A weigh-in in between must not hide it: weighing in more often should
   * never make the warning less likely.
   */
  it("flags a fast week or fortnight when a slower weigh-in inside the month came before it", () => {
    // 3 kg in the last 7 days (4.3%), averaged by one 29 days back to 0.5 kg a week.
    const week = [
      { date: "2026-10-08", weightKg: 70 },
      { date: "2026-10-01", weightKg: 73 },
      { date: "2026-09-09", weightKg: 72 },
    ];
    const out = renderWeightForPrompt(week, undefined, "metric", LOSE);
    expect(out).toContain("Pace: about -0.5 kg a week since 2026-09-09.");
    expect(out).toContain(FAST_LINE("2026-10-01"));
    // 2.5 kg in 12 days (3.3%), averaged by one 20 days back to 0.7 kg a week.
    const fortnight = [
      { date: "2026-10-08", weightKg: 76 },
      { date: "2026-09-26", weightKg: 78.5 },
      { date: "2026-09-18", weightKg: 78 },
    ];
    expect(renderWeightForPrompt(fortnight, undefined, "metric", LOSE)).toContain(FAST_LINE("2026-09-26"));
    const f = sampleFacts();
    f.profile = { ...PROFILE, age: 25, direction: "lose", goalWeightKg: 70 };
    f.weights = fortnight;
    expect(renderAskContext(f)).toContain(FAST_LINE("2026-09-26"));
  });

  it("leaves ordinary changes over the same spans alone, and a few days too short to tell", () => {
    const quiet = [
      // 0.5 kg in 13 days.
      [{ date: "2026-10-08", weightKg: 60 }, { date: "2026-09-25", weightKg: 60.5 }],
      // 1 kg in 37 days.
      [{ date: "2026-10-08", weightKg: 61 }, { date: "2026-09-01", weightKg: 62 }],
      // 2 kg in 3 days is water as often as not.
      [{ date: "2026-10-08", weightKg: 58 }, { date: "2026-10-05", weightKg: 60 }],
    ];
    for (const ws of quiet) {
      expect(renderWeightForPrompt(ws, 55, "metric", LOSE), ws[1]!.date).not.toContain("1% of body weight");
    }
    expect(renderWeightForPrompt(quiet[1]!, 55, "metric", LOSE)).toContain("Pace: about -0.2 kg a week since 2026-09-01.");
  });
});

/**
 * The healthy-range check needs a weigh-in and a height. When a read that
 * would have given one fails, the summary cannot tell whether the targets are
 * a deficit toward a weight below that range, so it fails closed the way it
 * does for an unread plan, and says why.
 */
describe("a read the healthy-range check needs, failing", () => {
  // 170 cm: 52 kg is a BMI of 18.0, under the range; the 55 kg goal is 19.0.
  const underweight = (): AskFacts => {
    const f = sampleFacts();
    f.profile = { ...PROFILE, heightCm: 170, direction: "lose", goalWeightKg: 55 };
    f.weights = [
      { date: "2026-10-08", weightKg: 52 },
      { date: "2026-09-10", weightKg: 52.4 },
    ];
    f.plan = plan({ goalText: "get down to 50 kg", goals: [{ id: "1", label: "Get down to 50 kg", kind: "habit" }] });
    return f;
  };
  const GOALS = /Goal: |Targets:|Remaining, negative|50 kg|Goal in their words|Plan goals/;

  it("withholds the goals when the weigh-ins could not be read", () => {
    // Positive control: read, the weigh-in itself withholds them.
    const read = renderAskContext(underweight());
    expect(read).toContain("Their current weight is below a healthy range for their height.");
    expect(read).not.toMatch(GOALS);

    const f = underweight();
    f.weights = [];
    f.unreadable = ["weight"];
    const out = renderAskContext(f);
    expect(out).not.toMatch(GOALS);
    expect(out).toContain(
      "Tracking only for this question: their weigh-ins could not be read, so treat them as having no weight, calorie-cutting or exercise goals.",
    );
    expect(out).toContain("COULD NOT READ THIS TIME\nTheir weigh-ins.");
  });

  it("withholds the goals when the profile could not be read", () => {
    const f = underweight();
    f.profile = null;
    f.unreadable = ["profile"];
    const out = renderAskContext(f);
    expect(out).not.toMatch(GOALS);
    expect(out).not.toContain("Pace:");
    expect(out).toContain(
      "Tracking only for this question: their profile could not be read, so treat them as having no weight, calorie-cutting or exercise goals.",
    );
    expect(out).toContain("COULD NOT READ THIS TIME\nTheir profile.");
  });

  it("names both when both could not be read, and the plan too", () => {
    const f = underweight();
    f.plan = null;
    f.profile = null;
    f.unreadable = ["plan", "profile"];
    expect(renderAskContext(f)).toContain(
      "PLAN\nTracking only for this question: their plan and their profile could not be read,",
    );
  });

  it("keeps the goals when the failed read could not change the answer", () => {
    // Set to gain: their targets aim up, whatever the weigh-in says.
    const gain = underweight();
    gain.profile = { ...gain.profile!, direction: "gain", goalWeightKg: 60 };
    gain.weights = [];
    gain.unreadable = ["weight"];
    expect(renderAskContext(gain)).toMatch(/Targets: 1900 cal[\s\S]*Remaining, negative means over/);
    // No height to check a weigh-in against, so the check was never possible.
    const tall = underweight();
    tall.profile = { ...tall.profile!, heightCm: undefined as unknown as number };
    tall.weights = [];
    tall.unreadable = ["weight"];
    const out = renderAskContext(tall);
    expect(out).toMatch(/Targets: 1900 cal/);
    expect(out).not.toContain("Tracking only");
  });
});

/**
 * The plan wizard logs no weigh-in, so the weight a plan is built from can be
 * newer than every weigh-in on file. 170 cm throughout: 45 kg is a BMI of
 * about 15.6, 51 kg 17.6, and the March weigh-in of 56 kg 19.4.
 */
describe("a plan built after the latest weigh-in", () => {
  const built = (weightKg: number, goalWeightKg: number | undefined): AskFacts => {
    const f = sampleFacts();
    const direction = goalWeightKg === undefined ? "maintain" : goalWeightKg > weightKg ? "gain" : "lose";
    f.profile = { ...PROFILE, age: 30, heightCm: 170, weightKg, goalWeightKg, direction };
    f.weights = [{ date: "2026-03-01", weightKg: 56 }];
    f.plan = plan({ createdAt: "2026-10-01T12:00:00Z", startDate: "2026-10-01" });
    return f;
  };

  it("judges the weight the plan was built from, and helps them gain", () => {
    const out = renderAskContext(built(45, 50));
    expect(out).toContain("Their current weight is below a healthy range for their height.");
    expect(out).not.toContain("Their goal weight is below a healthy range");
    expect(out).toContain("Goal: gaining weight.");
    expect(out).toMatch(/Targets: 1900 cal[\s\S]*Remaining, negative means over/);
    // No distance to the goal from a weigh-in that is not where they are,
    // and never the profile's weight itself.
    expect(out).not.toMatch(/Goal weight:|reached/);
    expect(out).not.toMatch(/\b45\b/);
  });

  it("judges the weight the plan was built from, and sends nothing to cut toward", () => {
    const out = renderAskContext(built(51, undefined));
    expect(out).toContain("Their current weight is below a healthy range for their height.");
    expect(out).not.toMatch(/Targets:|Remaining, negative|Goal: maintaining/);
  });

  it("goes by a weigh-in newer than the plan", () => {
    const f = built(51, undefined);
    f.weights = [{ date: "2026-10-05", weightKg: 60 }, ...f.weights];
    const out = renderAskContext(f);
    expect(out).not.toContain("healthy range");
    expect(out).toMatch(/Targets: 1900 cal/);
    expect(out).toContain("Goal: maintaining.");
  });
});

/**
 * The healthy-range check reads the numeric goal weight only, so a weight in
 * the goal's own words, or in a plan goal written from it, is one the coach
 * would be counting down to unchecked. 170 cm: 50 kg is a BMI of about 17.3.
 */
describe("a weight named in the plan's words", () => {
  it("never sends goal text or a plan goal that names one", () => {
    const f = sampleFacts();
    f.profile = { ...PROFILE, heightCm: 170, direction: "lose", goalWeightKg: 55 };
    f.weights = [
      { date: "2026-10-08", weightKg: 58 },
      { date: "2026-09-10", weightKg: 60 },
    ];
    f.plan = plan({
      goalText: "get down to 50 kg",
      goals: [
        { id: "1", label: "Get down to 50 kg", kind: "habit" },
        { id: "2", label: "Log every meal", kind: "nutrition" },
      ],
    });
    const out = renderAskContext(f);
    expect(out).not.toMatch(/50 kg|Goal in their words/);
    expect(out).toContain("Plan goals: Log every meal.");
    // The numeric goal is checked, so it still goes.
    expect(out).toContain("Goal weight: 55 kg (3.0 kg away).");
  });

  /** Built with a 42 kg goal at 165 cm, then Edit plan cleared the goal
   *  weight: that edit modifies the plan in place and keeps its goals. */
  it("drops a plan goal kept after the goal weight was cleared", () => {
    const f = sampleFacts();
    f.profile = { ...PROFILE, heightCm: 165, weightKg: 52, direction: "maintain", goalWeightKg: undefined };
    f.weights = [{ date: "2026-10-08", weightKg: 52 }];
    f.plan = plan({ goalText: "feel better", goals: [{ id: "1", label: "Reach 42 kg", kind: "habit" }] });
    const out = renderAskContext(f);
    expect(out).not.toMatch(/42 kg|Plan goals/);
    expect(out).toContain("Goal in their words: feel better");
  });

  it("knows a weight in kilograms, pounds, stone or bare, and leaves other numbers alone", () => {
    const sent = (goalText: string) => renderPlanForPrompt(plan({ goalText }), TODAY, []).includes("Goal in their words");
    for (const t of [
      "get down to 100 lb",
      "lose the baby weight, about 20 lbs",
      "be 9st 4lb by summer",
      "get under 9 stone",
      "Reach 42kg",
      "50 kilos by June",
      "lose 3 pounds a week",
      "get down to 50 by summer",
      "weigh 50",
      "Get down to 50.",
      "lose 10 by summer",
      "reach 8.5 st",
    ]) {
      expect(sent(t), t).toBe(false);
    }
    for (const t of [
      "Hit 120 g protein a day",
      "Hit 120g protein",
      "Run a 5k",
      "Walk 10000 steps",
      "Stay under 2000 calories",
      "Sleep 8 hours",
      "Drink 2 litres of water",
      "gain weight back after being ill",
      "Move 3 days a week",
      "Hit 3 workouts a week",
      "Under 3 drinks a week",
      "Lose 2 hours of screen time",
      "my 1st half marathon",
    ]) {
      expect(sent(t), t).toBe(true);
    }
  });
});

/**
 * Deleting the plan (Reset health data, Current plan) keeps the profile and
 * the stored daily targets, and the profile still holds the goal direction
 * and goal weight the deleted plan set. A profile with no plan is only ever
 * one whose plan was deleted.
 */
describe("a plan that was deleted", () => {
  const deleted = (): AskFacts => {
    const f = sampleFacts();
    f.profile = { ...PROFILE, direction: "lose", goalWeightKg: 60 };
    f.weights = [
      { date: "2026-10-08", weightKg: 68 },
      { date: "2026-09-20", weightKg: 69 },
    ];
    f.plan = null;
    return f;
  };

  it("sends none of the goals it left behind", () => {
    const out = renderAskContext(deleted());
    expect(out).not.toMatch(/Goal: |Goal weight|60 kg|Targets:|Remaining, negative/);
    expect(out).toContain("Latest: 68 kg on 2026-10-08.");
    expect(out).toContain("Eaten so far: 900 cal");
    // Nothing failed, so nothing is named as unread, and the targets are no gap.
    expect(out).not.toContain("COULD NOT READ");
    const f = deleted();
    f.days[f.days.length - 1] = { ...f.days[f.days.length - 1]!, unreadable: ["targets"] };
    expect(renderAskContext(f)).not.toMatch(/daily targets/);
  });

  /**
   * The deleted plan may have been a logging-only one, which never asked
   * height, so a weight is not judged against the height on file; the
   * tracking-only rule rules out any help to lose weight instead.
   */
  it("gives no help to lose weight, without judging it against a height that may not be theirs", () => {
    const f = deleted();
    f.weights = [{ date: "2026-10-08", weightKg: 48 }];
    const out = renderAskContext(f);
    expect(out).toContain("Tracking only: they have no current plan");
    expect(out).not.toMatch(/healthy range|Height:/);
  });
});

/**
 * Review round 6. A deleted plan may have been a logging-only one, set for a
 * pregnancy or a heart condition, and a logging-only plan never asks height,
 * so the 170 cm on file can be DEFAULT_PROFILE's. Once the plan is gone
 * nothing says which: the summary treats them as tracking only.
 */
describe("a plan that was deleted, round 6", () => {
  // A first plan forced to logging-only, merged onto DEFAULT_PROFILE, then
  // deleted. Her real height is 185 cm, so 60 kg is a BMI of 17.5; judged at
  // 170 cm it reads as 20.8.
  const gone = (): AskFacts => {
    const f = sampleFacts();
    f.profile = {
      sex: "female",
      age: 31,
      heightCm: 170,
      weightKg: 70,
      activityLevel: "moderate",
      direction: "maintain",
      units: "metric",
    };
    f.weights = [
      { date: "2026-10-08", weightKg: 60 },
      { date: "2026-09-10", weightKg: 61.6 },
    ];
    f.plan = null;
    return f;
  };

  it("says tracking only, with no height, activity or pace a plan may never have asked", () => {
    const out = renderAskContext(gone());
    expect(out).toContain(
      "PLAN\nTracking only: they have no current plan, so the app sets them no weight, calorie-cutting or exercise goals.",
    );
    expect(out).not.toMatch(/Height:|Activity:|Pace:|Targets:|Remaining, negative/);
    // Judged at a height that may not be theirs, a weight says nothing either way.
    expect(out).not.toContain("healthy range");
    expect(out).toContain("Latest: 60 kg on 2026-10-08.");
    expect(out).not.toContain("COULD NOT READ");
  });
});

/**
 * Review round 6. A legacy get_fit plan never asked height or weight (the
 * wizard sent neither for a plan that does not track food), so a first one
 * stored DEFAULT_PROFILE's 170 cm and 70 kg. It sets no weight or calorie
 * goals either, so it is tracking only, like a logging-only plan.
 */
describe("a legacy get_fit plan", () => {
  const getFit = (kg: number): AskFacts => {
    const f = sampleFacts();
    f.profile = { ...PROFILE, heightCm: 170, weightKg: 70, direction: "maintain", goalWeightKg: undefined };
    f.weights = [
      { date: "2026-10-08", weightKg: kg },
      { date: "2026-09-10", weightKg: kg + 0.6 },
    ];
    f.plan = plan({ mode: "get_fit", targets: { dailyCalories: null } });
    return f;
  };

  it("states no height it never asked, and judges no weight against it", () => {
    // 155 cm and 50 kg is a BMI of 20.8; at the default 170 cm it reads 17.3.
    const out = renderAskContext(getFit(50));
    expect(out).not.toMatch(/Height:|healthy range/);
    expect(out).toContain("Tracking only: the app sets no weight, calorie-cutting or exercise goals for this user.");
  });

  it("gives no weight-loss help either way round", () => {
    // 188 cm and 62 kg is a BMI of 17.5; at 170 cm it reads 21.5.
    const out = renderAskContext(getFit(62));
    expect(out).toContain("Tracking only");
    expect(out).not.toMatch(/Targets:|Remaining, negative|Goal: |Pace:/);
  });

});

/**
 * Review round 6. Builds before 1.40.4 dropped the sex picked on a plan that
 * does not track food, so a first logging-only or get_fit plan stored
 * DEFAULT_PROFILE's "female". Such a plan carries no bodySavedAt.
 */
describe("sex from a plan that may not have kept it", () => {
  const teen = (stamped: boolean): AskFacts => {
    const f = sampleFacts();
    f.profile = { ...PROFILE, sex: "female", age: 16, direction: "maintain", goalWeightKg: undefined };
    f.days = Array.from({ length: 7 }, (_, i) => snap(shiftDate(TODAY, -(7 - i)), 1300)).concat(snap(TODAY, 0));
    f.plan = plan({
      mode: "logging_only",
      ...(stamped ? { bodySavedAt: "2026-09-24T00:00:00Z" } : {}),
    });
    return f;
  };

  it("states no sex, and uses the higher floor, for a plan from an earlier build", () => {
    const out = renderAskContext(teen(false));
    expect(out).not.toContain("Sex:");
    expect(out).toContain("Age: 16.");
    expect(out).toContain("Logged days under 1500 cal: 7.");
  });

  it("states the sex a plan from this build kept", () => {
    const out = renderAskContext(teen(true));
    expect(out).toContain("Sex: female. Age: 16.");
    expect(out).not.toContain("Logged days under");
  });

  it("states it for a food plan from any build, which always kept it", () => {
    expect(renderAskContext(sampleFacts())).toContain("Sex: female.");
  });
});

/**
 * Review round 6. An in-place plan edit saves the weight typed in the wizard
 * onto the profile and keeps the plan's createdAt, and logs no weigh-in. 170
 * cm: 52 kg is a BMI of 18.0, the 57 kg weigh-in 19.7.
 */
describe("a weight saved by an in-place plan edit", () => {
  it("judges it when the edit is newer than the latest weigh-in", () => {
    const f = sampleFacts();
    f.profile = { ...PROFILE, age: 30, heightCm: 170, weightKg: 52, direction: "maintain", goalWeightKg: undefined };
    f.weights = [{ date: "2026-10-01", weightKg: 57 }];
    f.plan = plan({ createdAt: "2026-09-01T12:00:00Z", startDate: "2026-09-01", bodySavedAt: "2026-10-07T09:00:00Z" });
    const out = renderAskContext(f);
    expect(out).toContain("Their current weight is below a healthy range for their height.");
    expect(out).not.toMatch(/Targets:|Remaining, negative|Goal: maintaining/);
    // A weigh-in after the edit is what counts again.
    f.weights = [{ date: "2026-10-08", weightKg: 57 }, ...f.weights];
    expect(renderAskContext(f)).not.toContain("healthy range");
  });
});

/**
 * Review round 6. Daily targets > Adjust on the Plan tab saves any calorie
 * figure, below the floor the app itself never goes under, and the prompt
 * answers "what should I eat" from what is left of the targets it is given.
 */
describe("a calorie target below the app's minimum", () => {
  const low = (calories: number): AskFacts => {
    const f = sampleFacts();
    f.profile = { ...PROFILE, age: 30, heightCm: 168, weightKg: 58, direction: "lose", goalWeightKg: 56 };
    f.weights = [
      { date: "2026-10-08", weightKg: 58 },
      { date: "2026-09-10", weightKg: 58.4 },
    ];
    const targets = { calories, protein: 40, carbs: 60, fat: 20 };
    f.days = f.days.map((d) => ({ ...d, targets }));
    f.days[f.days.length - 1] = snap(TODAY, 450, {
      targets,
      remaining: { calories: calories - 450, protein: 0, carbs: 0, fat: 0 },
    });
    return f;
  };

  it("is not sent as a target to plan food around, and says why", () => {
    const out = renderAskContext(low(600));
    expect(out).not.toMatch(/Targets:|Remaining, negative/);
    expect(out).toContain("Their daily calorie target is below the app's minimum of 1200 cal.");
    expect(out).toContain("Eaten so far: 450 cal");
  });

  it("goes by the floor for their sex, and leaves a target at or above it alone", () => {
    const male = low(1400);
    male.profile = { ...male.profile!, sex: "male" };
    expect(renderAskContext(male)).toContain("Their daily calorie target is below the app's minimum of 1500 cal.");
    const ok = renderAskContext(low(1200));
    expect(ok).toMatch(/Targets: 1200 cal[\s\S]*Remaining, negative means over \(750 cal/);
    expect(ok).not.toContain("below the app's minimum");
  });
});

/**
 * Review round 6. The healthy-range check reads the numeric goal weight
 * only, so a weight in the goal's words in any form has to keep the goal out.
 */
describe("a weight named in words", () => {
  it("is known in number words, a stone, hyphenated units and shares of body weight", () => {
    for (const t of [
      "Lose twenty pounds before summer",
      "Get down to ninety pounds",
      "Lose a stone",
      "lose ten kilos",
      "Be a 100-pound bride",
      "Lose 15% body weight",
      "lose 10 percent of my body weight",
      "drop 5% by June",
      "lose half a stone",
      "Get down to a hundred and ten",
      "lose twenty-five lbs",
      "lose a couple of kilos",
      "get to nine stone",
    ]) {
      expect(namesAWeight(t), t).toBe(true);
    }
    for (const t of [
      "Eat five portions of veg a day",
      "Walk twenty minutes after dinner",
      "Hit 30% protein",
      "Keep carbs under 40% of calories",
      "Sleep eight hours",
      "Drink two litres of water",
      "Run a 5k",
      "Feel stronger before my sister's wedding",
    ]) {
      expect(namesAWeight(t), t).toBe(false);
    }
  });

  it("keeps a goal like that out of the summary", () => {
    const f = sampleFacts();
    f.units = "imperial";
    f.profile = { ...PROFILE, age: 22, heightCm: 165, units: "imperial", direction: "maintain", goalWeightKg: undefined };
    f.weights = [
      { date: "2026-10-08", weightKg: 52.2 },
      { date: "2026-09-10", weightKg: 52.4 },
    ];
    f.plan = plan({ goalText: "Get down to ninety pounds before the meet" });
    const out = renderAskContext(f);
    expect(out).not.toMatch(/ninety|Goal in their words/);
  });
});
