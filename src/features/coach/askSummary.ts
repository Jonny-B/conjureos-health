/**
 * What "Ask your health coach" knows about the user, as prompt text.
 *
 * Today's diary in full (renderDayForPrompt), then short summaries of the rest
 * of what they log: who they are (PROFILE), where their weight is heading
 * (WEIGHT), how far through their plan they are (PLAN) and a roll-up of the
 * week before today (LAST 7 DAYS), then the two days before today as one line
 * each (RECENT DAYS).
 *
 * Aggregates, never dumps. Every summary line is a count, an average or a
 * dated change, so a year of weigh-ins costs the same as a week of them. An
 * empty section is left out entirely rather than rendered as "none", which
 * keeps the prompt small and stops the model reading "not logged" as "zero".
 *
 * Read-only. `loadAskFacts` only reads, and reads each store on its own, so
 * one failing read drops one section instead of the whole context. The
 * renderers are pure.
 *
 * What may appear here is bounded by the AI consent wording in
 * features/aiConsent.ts (DISCLOSURE_SENDS). A new field means new wording
 * there and a DISCLOSURE_VERSION bump in the same change. Deliberately never
 * sent: free-text notes (sleep and symptom), the plan's safety answers and
 * liability record, the paused workout program and benchmarks, coach memory,
 * and wearable workout names.
 */

import type { Plan, Profile, SleepEntry, WeightEntry } from "../../types";
import { getRepository } from "../../data/repository";
import { daySnapshot, renderDayForPrompt, renderRecentForPrompt, type DaySnapshot } from "../dataApi";
import { shiftDate, todayISO } from "../diary";
import { weekToDate } from "../exercise";
import { kcalFloor } from "../plan/model";
import { planModeLabel, visiblePlanGoals } from "../plan/display";
import { formatSleep } from "../sleep";
import { fmtHeight, fmtWeight, weightToDisplay, weightUnit } from "../units";
import { fmtWater } from "../water";

type Units = Profile["units"];

/** Days summarised in LAST 7 DAYS, not counting today. */
export const WEEK_DAYS = 7;

/** Earlier days given one line each in RECENT DAYS. */
const RECENT_DAYS = 2;

/** Weight-change windows, in days back from the newest weigh-in. */
const WEIGHT_WINDOWS = [7, 30] as const;

/** Caps on the free text a plan carries, so a long goal cannot crowd out the
 *  question being asked. */
const MAX_GOAL_TEXT = 120;
const MAX_GOAL_LABEL = 50;
const MAX_PLAN_GOALS = 3;
const MAX_SYMPTOM_LABELS = 5;

/** Everything the coach summary is built from. Plain data, so the renderers
 *  can be tested without a repository. */
export interface AskFacts {
  /** YYYY-MM-DD, local. */
  today: string;
  units: Units;
  profile: Profile | null;
  /** Weigh-ins, newest first. */
  weights: WeightEntry[];
  plan: Plan | null;
  /** Oldest first, ending with today when today could be read. At most
   *  WEEK_DAYS + 1 entries. */
  days: DaySnapshot[];
  /** Nights filed in the WEEK_DAYS before today, for the rested average. */
  sleep: SleepEntry[];
}

/** Await a read, turning a throw (sync or async) into a fallback. A method
 *  missing on some backend throws a TypeError before any promise exists, and
 *  that must cost one section, not the whole context. */
async function safely<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

/**
 * Read everything the summary needs. Never throws.
 *
 * One `daySnapshot` per day for today and the WEEK_DAYS before it, each
 * guarded on its own, plus one read each of weigh-ins, the plan and the
 * week's sleep (the snapshots carry sleep length but not how rested it felt).
 */
export async function loadAskFacts(today = todayISO()): Promise<AskFacts> {
  const repo = await getRepository();
  const dates: string[] = [];
  for (let i = WEEK_DAYS; i >= 0; i--) dates.push(shiftDate(today, -i));

  const [profile, weights, plan, sleep, snaps] = await Promise.all([
    safely(() => repo.getProfile(), null),
    safely(() => repo.listWeights(), [] as WeightEntry[]),
    safely(() => repo.getPlan(), null),
    safely(() => repo.listSleepRange(dates[0]!, shiftDate(today, -1)), [] as SleepEntry[]),
    Promise.all(dates.map((d) => safely<DaySnapshot | null>(() => daySnapshot(d), null))),
  ]);

  return {
    today,
    units: profile?.units ?? "metric",
    profile,
    weights: Array.isArray(weights) ? weights : [],
    plan,
    days: snaps.filter((s): s is DaySnapshot => s !== null),
    sleep: Array.isArray(sleep) ? sleep : [],
  };
}

// ── Small formatting helpers ──────────────────────────────────────────

/** Whole days from `a` to `b` (both YYYY-MM-DD). Calendar arithmetic in UTC,
 *  so a daylight-saving change cannot make a day 23 hours long. */
function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** A weight difference in the user's units, always signed: "-1.2 lb". */
function fmtWeightChange(kg: number, units: Units): string {
  const v = weightToDisplay(Math.abs(kg), units);
  if (v === 0) return `no change`;
  return `${kg < 0 ? "-" : "+"}${v.toFixed(1)} ${weightUnit(units)}`;
}

/** Collapse whitespace and cap length, ending a cut string with "...". */
function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 3).trimEnd()}...`;
}

function average(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

const hasFood = (d: DaySnapshot) => d.foods.length > 0 || d.consumed.calories > 0;

/** A day count that reads naturally: "1 day", "3 days". */
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── PROFILE ───────────────────────────────────────────────────────────

const DIRECTION_WORDS: Record<Profile["direction"], string> = {
  lose: "losing weight",
  gain: "gaining weight",
  maintain: "maintaining",
};

const ACTIVITY_WORDS: Record<Profile["activityLevel"], string> = {
  sedentary: "sedentary",
  light: "lightly active",
  moderate: "moderately active",
  active: "active",
  very_active: "very active",
};

/**
 * Goal direction and the body stats the plan was built from. Body weight is
 * NOT taken from the profile: that field can hold a pounds figure in the
 * kilogram slot (see components/WeightCard), so the WEIGHT section uses real
 * weigh-ins instead. Out-of-range age and height are dropped for the same
 * reason: a wrong number stated as fact is worse than no number.
 */
export function renderProfileForPrompt(p: Profile | null, units: Units): string {
  if (!p) return "";
  const bits: string[] = [];
  if (p.direction && DIRECTION_WORDS[p.direction]) bits.push(`Goal: ${DIRECTION_WORDS[p.direction]}.`);
  if (p.sex === "female" || p.sex === "male") bits.push(`Sex: ${p.sex}.`);
  if (Number.isFinite(p.age) && p.age >= 13 && p.age <= 110) bits.push(`Age: ${Math.round(p.age)}.`);
  if (Number.isFinite(p.heightCm) && p.heightCm >= 120 && p.heightCm <= 230) {
    bits.push(`Height: ${fmtHeight(p.heightCm, units)}.`);
  }
  if (p.activityLevel && ACTIVITY_WORDS[p.activityLevel]) bits.push(`Activity: ${ACTIVITY_WORDS[p.activityLevel]}.`);
  return bits.length ? `PROFILE\n${bits.join(" ")}` : "";
}

// ── WEIGHT ────────────────────────────────────────────────────────────

/**
 * Newest weigh-in, its change over the last week, the last month and since
 * the first weigh-in, and the goal weight. Every change names the date it is
 * measured from, so the model never has to guess what "this week" meant.
 *
 * The goal weight is only sent next to a real weigh-in and only when it is
 * within reach of it: it is typed into the same unit-sensitive field as the
 * profile weight, so a goal of "160" entered as pounds while the app was in
 * metric reads as 160 kg, and the coach should not be told that is the goal.
 */
export function renderWeightForPrompt(
  entries: WeightEntry[],
  goalWeightKg: number | undefined,
  units: Units,
): string {
  const ws = entries
    .filter((w) => w && typeof w.date === "string" && Number.isFinite(w.weightKg) && w.weightKg > 0)
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const latest = ws[0];
  if (!latest) return "";
  const first = ws[ws.length - 1]!;
  const lines: string[] = [];

  lines.push(
    ws.length === 1
      ? `Latest: ${fmtWeight(latest.weightKg, units)} on ${latest.date}, the only weigh-in.`
      : `Latest: ${fmtWeight(latest.weightKg, units)} on ${latest.date}. ${ws.length} weigh-ins since ${first.date}.`,
  );

  if (ws.length > 1) {
    // The oldest weigh-in inside a window: the fairest "where it started".
    const oldestWithin = (days: number) => {
      const from = shiftDate(latest.date, -days);
      return [...ws].reverse().find((w) => w.date >= from && w.date < latest.date);
    };

    const changes: string[] = [];
    const used = new Set<string>();
    for (const days of WEIGHT_WINDOWS) {
      const ref = oldestWithin(days);
      if (!ref || used.has(ref.date) || ref.date === first.date) continue;
      used.add(ref.date);
      changes.push(`${fmtWeightChange(latest.weightKg - ref.weightKg, units)} since ${ref.date}`);
    }
    changes.push(`${fmtWeightChange(latest.weightKg - first.weightKg, units)} since the first weigh-in`);
    lines.push(`Change: ${changes.join(", ")}.`);

    // A weekly pace over the last month, when there is a fortnight or more to
    // measure it on. This is what the "losing too fast" guardrail needs, and
    // working it out from two dates is arithmetic the model can get wrong.
    const base = oldestWithin(WEIGHT_WINDOWS[WEIGHT_WINDOWS.length - 1]!);
    const span = base ? daysBetween(base.date, latest.date) : 0;
    if (base && span >= 14) {
      const perWeek = ((latest.weightKg - base.weightKg) / span) * 7;
      lines.push(`Pace: about ${fmtWeightChange(perWeek, units)} a week since ${base.date}.`);
    }
  }

  if (goalWeightKg && Number.isFinite(goalWeightKg) && goalWeightKg > 0) {
    const ratio = goalWeightKg / latest.weightKg;
    if (ratio >= 0.5 && ratio <= 1.6) {
      const gap = weightToDisplay(Math.abs(latest.weightKg - goalWeightKg), units);
      const away = gap === 0 ? "reached" : `${gap.toFixed(1)} ${weightUnit(units)} away`;
      lines.push(`Goal weight: ${fmtWeight(goalWeightKg, units)} (${away}).`);
    }
  }

  return `WEIGHT\n${lines.join("\n")}`;
}

// ── PLAN ──────────────────────────────────────────────────────────────

/**
 * Where the user is in their plan: its kind and dates, day N of M, their goal
 * in their own words, its daily goals, and this week's exercise days against
 * the weekly target.
 *
 * Only the fields named here. A plan also carries the safety intake, the
 * liability record and (while paused) a workout program; none of those leave.
 * Goals are filtered through visiblePlanGoals so a paused workout goal is not
 * described as something to do.
 */
export function renderPlanForPrompt(plan: Plan | null, today: string, days: DaySnapshot[]): string {
  if (!plan || !plan.startDate || !plan.endDate) return "";
  const lines: string[] = [];

  const total = daysBetween(plan.startDate, plan.endDate) + 1;
  const dayN = daysBetween(plan.startDate, today) + 1;
  let where: string;
  if (!Number.isFinite(total) || total < 1 || !Number.isFinite(dayN)) where = "";
  else if (dayN < 1) where = `starts in ${plural(1 - dayN, "day")}`;
  else if (dayN > total) where = `ended ${plural(dayN - total, "day")} ago`;
  else where = `day ${dayN} of ${total}`;
  lines.push(
    `${planModeLabel(plan)} plan, ${plan.startDate} to ${plan.endDate}${where ? `, ${where}` : ""}.`,
  );

  if (plan.goalText && plan.goalText.trim()) {
    lines.push(`Goal in their words: ${clip(plan.goalText, MAX_GOAL_TEXT)}`);
  }

  const stored = Array.isArray(plan.goals) ? plan.goals.filter(Boolean) : [];
  const goals = visiblePlanGoals({ ...plan, goals: stored }).filter(
    (g) => typeof g.label === "string" && g.label.trim(),
  );
  if (goals.length) {
    const shown = goals.slice(0, MAX_PLAN_GOALS).map((g) => clip(g.label, MAX_GOAL_LABEL));
    const more = goals.length - shown.length;
    lines.push(`Plan goals: ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}.`);
  }

  const target = plan.weeklyExerciseDays ?? 0;
  if (target > 0) {
    // Same definition as the Plan tab's tracker (weekExerciseProgress): a day
    // counts when any exercise reached the calorie ring. Read from the
    // snapshots already loaded rather than asking Apple Health again.
    const week = new Set(weekToDate(today));
    const active = days.filter((d) => week.has(d.date) && d.exerciseCalories > 0).length;
    lines.push(`Exercise: ${active} of ${target} target days this week (Mon to Sun).`);
  }

  return `PLAN\n${lines.join("\n")}`;
}

// ── LAST 7 DAYS ───────────────────────────────────────────────────────

/**
 * The run of consecutive days with food logged, ending today, or ending
 * yesterday when nothing is logged today (the day is not over). `days` is
 * oldest first. Returns the count and whether it reached the start of the
 * window, in which case the real run may be longer than we can see.
 */
function foodRun(days: DaySnapshot[], today: string): { n: number; through: string; capped: boolean } {
  let i = days.length - 1;
  let through = "today";
  if (days[i]?.date === today && !hasFood(days[i]!)) {
    i--;
    through = "yesterday";
  }
  let n = 0;
  let expected = days[i]?.date;
  while (i >= 0 && expected && days[i]!.date === expected && hasFood(days[i]!)) {
    n++;
    expected = shiftDate(expected, -1);
    i--;
  }
  return { n, through, capped: n > 0 && i < 0 };
}

/**
 * The week before today in one short block: how many days had food logged and
 * the averages on those days, water, sleep and how rested it felt, exercise,
 * a run of days logged, and how often each symptom came up.
 *
 * Averages are over the days something was logged, not over all seven: a day
 * nobody logged is missing, not a day of eating nothing, and averaging it in
 * would make every forgetful week look like under-eating.
 */
export function renderWeekForPrompt(f: AskFacts): string {
  const before = f.days.filter((d) => d.date < f.today).slice(-WEEK_DAYS);
  const lines: string[] = [];

  const food = before.filter(hasFood);
  const run = foodRun(f.days, f.today);
  if (food.length) {
    const avg = (k: "calories" | "protein" | "carbs" | "fat") =>
      Math.round(average(food.map((d) => d.consumed[k])));
    // The closest thing to a streak the app has: consecutive days with food
    // logged. Shown only once it is a run (2 or more).
    const streak = run.n >= 2 ? ` (${run.capped ? "at least " : ""}${run.n} in a row through ${run.through})` : "";
    lines.push(
      `Food: logged ${food.length} of ${before.length} days${streak}, avg ${avg("calories")} cal, ` +
        `${avg("protein")}g protein, ${avg("carbs")}g carbs, ${avg("fat")}g fat.`,
    );
    const floor = kcalFloor(f.profile?.sex);
    const low = food.filter((d) => d.consumed.calories < floor).length;
    if (low > 0) lines.push(`Logged days under ${floor} cal: ${low}.`);
  }

  const water = before.filter((d) => d.waterMl > 0);
  if (water.length) {
    lines.push(`Water: ${plural(water.length, "day")}, avg ${fmtWater(average(water.map((d) => d.waterMl)), f.units)}.`);
  }

  const slept = before.filter((d) => d.sleepMinutes > 0);
  if (slept.length) {
    const from = before[0]?.date ?? f.today;
    const rated = f.sleep
      .filter((s) => s.date >= from && s.date < f.today)
      .map((s) => s.quality)
      .filter((q): q is number => typeof q === "number" && q >= 1 && q <= 5);
    const rested = rated.length ? `, rested ${average(rated).toFixed(1)}/5` : "";
    const avgSleep = formatSleep(Math.round(average(slept.map((d) => d.sleepMinutes))));
    lines.push(`Sleep: ${plural(slept.length, "night")}, avg ${avgSleep}${rested}.`);
  }

  const moved = before.filter((d) => d.exerciseCalories > 0);
  if (moved.length) {
    const kcal = moved.reduce((n, d) => n + d.exerciseCalories, 0);
    lines.push(`Exercise: ${plural(moved.length, "day")}, ${kcal} cal total.`);
  }

  // Count by label, case-insensitively, keeping the first spelling seen.
  const counts = new Map<string, { label: string; n: number }>();
  for (const d of before) {
    for (const s of d.symptoms) {
      const label = clip(String(s.label ?? ""), 30);
      if (!label) continue;
      const key = label.toLowerCase();
      const hit = counts.get(key);
      if (hit) hit.n++;
      else counts.set(key, { label, n: 1 });
    }
  }
  if (counts.size) {
    const ranked = [...counts.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
    const shown = ranked.slice(0, MAX_SYMPTOM_LABELS).map((c) => `${c.label} ${c.n === 1 ? "once" : `${c.n} times`}`);
    const more = ranked.length - shown.length;
    lines.push(`Symptoms: ${shown.join(", ")}${more > 0 ? `, and ${plural(more, "other")}` : ""}.`);
  }

  return lines.length ? `LAST ${WEEK_DAYS} DAYS (before today)\n${lines.join("\n")}` : "";
}

// ── Assembly ──────────────────────────────────────────────────────────

/** Render one section, or nothing if its data is malformed enough to throw.
 *  Stored data outlives the code that wrote it; one odd record should cost
 *  its own section only. */
function section(render: () => string): string {
  try {
    return render();
  } catch {
    return "";
  }
}

/** PROFILE, WEIGHT, PLAN and LAST 7 DAYS, in that order, each only when it
 *  has something to say. Split out so its size can be held to a budget. */
export function renderSummaryBlocks(f: AskFacts): string {
  return [
    section(() => renderProfileForPrompt(f.profile, f.units)),
    section(() => renderWeightForPrompt(f.weights, f.profile?.goalWeightKg, f.units)),
    section(() => renderPlanForPrompt(f.plan, f.today, f.days)),
    section(() => renderWeekForPrompt(f)),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The whole ABOUT THIS USER block. Empty string when nothing could be read. */
export function renderAskContext(f: AskFacts): string {
  const today = f.days.find((d) => d.date === f.today);
  const prior = section(() =>
    renderRecentForPrompt(f.days.filter((d) => d.date < f.today).slice(-RECENT_DAYS)),
  );
  return [
    today ? section(() => `TODAY\n${renderDayForPrompt(today, f.units)}`) : "",
    renderSummaryBlocks(f),
    prior ? `RECENT DAYS\n${prior}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
