import { describe, it, expect } from "vitest";
import {
  renderAskContext,
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
    expect(renderWeightForPrompt(WEIGHTS, 72, "imperial")).toContain("Goal weight: 158.7 lb (17.6 lb away).");
    // 160 typed as pounds while the app was metric: stored as 160 kg.
    expect(renderWeightForPrompt(WEIGHTS, 160, "imperial")).not.toContain("Goal weight");
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
        goalText: `Lose about 10 lb before my sister's wedding. ${"Really. ".repeat(40)}`,
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
    expect(goalLine).toContain("Lose about 10 lb before my sister's wedding.");
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

describe("renderAskContext", () => {
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
