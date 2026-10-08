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
 * one failing read drops one section instead of the whole context. A failed
 * read is also named (COULD NOT READ THIS TIME), because a dropped section
 * otherwise reads exactly like one with nothing logged. The renderers are
 * pure.
 *
 * Safety is applied here as well as in the prompt. For a user the app sets no
 * weight, calorie or exercise goals (a logging-only plan, which the safety
 * intake forces for under-18s, pregnancy and heart conditions, or an age
 * under 18) the summary says "Tracking only" and leaves out the goal
 * direction, goal weight, weekly pace, today's targets and what is left of
 * them, and the plan's goals in any words. A plan that could not be read is
 * treated the same way, since it may be a logging-only one. A goal weight
 * below a healthy range for their height is never sent as a target, and
 * weight falling faster than 1% of body weight a week is said outright, for
 * everyone. The reason a plan is logging-only is never sent.
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
import {
  daySnapshot,
  renderDayForPrompt,
  renderRecentForPrompt,
  type DaySnapshot,
  type SnapshotPart,
} from "../dataApi";
import { shiftDate, todayISO } from "../diary";
import { weekToDate } from "../exercise";
import { bmi } from "../goals";
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

/** Below this BMI a goal weight is not sent as a target (WHO underweight). */
const MIN_GOAL_BMI = 18.5;

/** Weekly loss, as a share of body weight, past which it is called out. */
const FAST_LOSS_SHARE = 0.01;

/** The line the prompt's tracking-only rule keys on. */
const TRACKING_ONLY = "Tracking only: the app sets no weight, calorie-cutting or exercise goals for this user.";

/** The same rule, when the plan that would say so could not be read. */
const TRACKING_UNREAD =
  "Tracking only for this question: their plan could not be read, so treat them as having no weight, calorie-cutting or exercise goals.";

const GOAL_TOO_LOW = "Their goal weight is below a healthy range for their height.";

/** Heights outside this range are treated as a typo, in PROFILE and for BMI. */
const MIN_HEIGHT_CM = 120;
const MAX_HEIGHT_CM = 230;

/**
 * A read in loadAskFacts that failed: the user's profile, weigh-ins, plan,
 * sleep ratings, today's snapshot, or one of the earlier days' snapshots.
 * Parts of a snapshot that failed are in its own `unreadable`.
 */
export type AskGap = "profile" | "weight" | "plan" | "rested" | "today" | "earlier";

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
  /** Reads that failed. Absent or empty when every read worked. */
  unreadable?: AskGap[];
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

  // Await a read, turning a throw (sync or async) into the fallback and a
  // note of what was lost. A method missing on some backend throws a
  // TypeError before any promise exists, and that must cost one section, not
  // the whole context.
  const lost = new Set<AskGap>();
  const read = async <T>(gap: AskGap, run: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run();
    } catch {
      lost.add(gap);
      return fallback;
    }
  };

  const [profile, weights, plan, sleep, snaps] = await Promise.all([
    read("profile", () => repo.getProfile(), null),
    read("weight", () => repo.listWeights(), [] as WeightEntry[]),
    read("plan", () => repo.getPlan(), null),
    read("rested", () => repo.listSleepRange(dates[0]!, shiftDate(today, -1)), [] as SleepEntry[]),
    Promise.all(
      dates.map((d) => read<DaySnapshot | null>(d === today ? "today" : "earlier", () => daySnapshot(d), null)),
    ),
  ]);

  return {
    today,
    units: profile?.units ?? "metric",
    profile,
    weights: Array.isArray(weights) ? weights : [],
    plan,
    days: snaps.filter((s): s is DaySnapshot => s !== null),
    sleep: Array.isArray(sleep) ? sleep : [],
    unreadable: [...lost],
  };
}

/**
 * Whether the app sets this user no weight, calorie-cutting or exercise
 * goals: their plan is logging-only, or their profile gives an age under 18.
 * An age too low to state as fact (see renderProfileForPrompt) still counts,
 * since being careful with an adult costs far less than the reverse.
 */
export function isTrackingOnly(plan: Plan | null, profile: Profile | null): boolean {
  if (plan?.mode === "logging_only") return true;
  return !!profile && Number.isFinite(profile.age) && profile.age < 18;
}

/**
 * How the summary treats this user's goals. Fails closed: a plan that could
 * not be read may be a logging-only one, so it counts as tracking only. One
 * cautious answer to an adult costs far less than counting a pregnant user
 * down to a goal weight left over from an earlier plan.
 */
function goalsFor(f: AskFacts): { trackingOnly: boolean; planUnread: boolean } {
  const planUnread = !f.plan && (f.unreadable ?? []).includes("plan");
  return { trackingOnly: planUnread || isTrackingOnly(f.plan, f.profile), planUnread };
}

/**
 * The goal weight as their plan means it, or undefined. Only with a lose or
 * gain direction: a blank goal in the wizard means maintain, and a profile
 * from before that rule kept the old number beside it.
 */
function activeGoalKg(goalWeightKg: number | undefined, direction: Profile["direction"] | undefined) {
  if (direction !== "lose" && direction !== "gain") return undefined;
  return goalWeightKg && Number.isFinite(goalWeightKg) && goalWeightKg > 0 ? goalWeightKg : undefined;
}

/** Whether a goal weight is below a healthy range for a believable height. */
export function goalBelowHealthyRange(goalWeightKg: number | undefined, heightCm: number | undefined): boolean {
  if (!goalWeightKg || !Number.isFinite(goalWeightKg) || goalWeightKg <= 0 || !heightKnown(heightCm)) return false;
  return bmi({ heightCm, weightKg: goalWeightKg } as Profile) < MIN_GOAL_BMI;
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

/** Whether a snapshot's diary was read, so "no food" means nothing was logged. */
const diaryRead = (d: DaySnapshot) => !d.unreadable?.includes("diary");

const heightKnown = (cm: number | undefined): cm is number =>
  typeof cm === "number" && Number.isFinite(cm) && cm >= MIN_HEIGHT_CM && cm <= MAX_HEIGHT_CM;

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
 *
 * No goal direction when `trackingOnly` (see isTrackingOnly): it can be left
 * over from an earlier plan, since a logging-only plan does not set one, and
 * "Goal: losing weight" next to a pregnancy or a 15-year-old invites the
 * coaching the safety gate exists to prevent.
 */
export function renderProfileForPrompt(
  p: Profile | null,
  units: Units,
  opts: { trackingOnly?: boolean } = {},
): string {
  if (!p) return "";
  const bits: string[] = [];
  if (!opts.trackingOnly && p.direction && DIRECTION_WORDS[p.direction]) {
    bits.push(`Goal: ${DIRECTION_WORDS[p.direction]}.`);
  }
  if (p.sex === "female" || p.sex === "male") bits.push(`Sex: ${p.sex}.`);
  if (Number.isFinite(p.age) && p.age >= 13 && p.age <= 110) bits.push(`Age: ${Math.round(p.age)}.`);
  if (heightKnown(p.heightCm)) bits.push(`Height: ${fmtHeight(p.heightCm, units)}.`);
  if (p.activityLevel && ACTIVITY_WORDS[p.activityLevel]) bits.push(`Activity: ${ACTIVITY_WORDS[p.activityLevel]}.`);
  return bits.length ? `PROFILE\n${bits.join(" ")}` : "";
}

// ── WEIGHT ────────────────────────────────────────────────────────────

/**
 * Newest weigh-in, its change over the last week, the last month and since
 * the first weigh-in, and the goal weight. Every change names the date it is
 * measured from, so the model never has to guess what "this week" meant.
 *
 * The goal weight is only sent for a lose or gain direction (see
 * activeGoalKg), next to a real weigh-in, and only when it is within reach
 * of it: it is typed into the same unit-sensitive field as the profile
 * weight, so a goal of "160" entered as pounds while the app was in metric
 * reads as 160 kg, and the coach should not be told that is the goal. Nor is
 * it sent when it is below a healthy weight for their height, however far
 * below: the coach is told that instead, so it can say so rather than count
 * down to it.
 *
 * Loss faster than 1% of body weight a week is said outright, for every
 * user, because the prompt's guardrail depends on it and the model can get
 * the arithmetic wrong. With `trackingOnly` (see isTrackingOnly) neither the
 * goal weight nor the weekly pace is sent, only where their weight is, how
 * it has changed, and that warning.
 */
export function renderWeightForPrompt(
  entries: WeightEntry[],
  goalWeightKg: number | undefined,
  units: Units,
  opts: { heightCm?: number; direction?: Profile["direction"]; trackingOnly?: boolean } = {},
): string {
  const goal = opts.trackingOnly ? undefined : activeGoalKg(goalWeightKg, opts.direction);
  const goalTooLow = goalBelowHealthyRange(goal, opts.heightCm);
  const ws = entries
    .filter((w) => w && typeof w.date === "string" && Number.isFinite(w.weightKg) && w.weightKg > 0)
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const latest = ws[0];
  if (!latest) return goalTooLow ? `WEIGHT\n${GOAL_TOO_LOW}` : "";
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
      if (!opts.trackingOnly) lines.push(`Pace: about ${fmtWeightChange(perWeek, units)} a week since ${base.date}.`);
      // A safety signal, not a goal: sent whatever the plan is.
      if (-perWeek > latest.weightKg * FAST_LOSS_SHARE) {
        lines.push(`Losing more than 1% of body weight a week since ${base.date}.`);
      }
    }
  }

  if (goalTooLow) {
    lines.push(GOAL_TOO_LOW);
  } else if (goal !== undefined) {
    const ratio = goal / latest.weightKg;
    if (ratio >= 0.5 && ratio <= 1.6) {
      // Gone past it in the direction they were heading counts as reached.
      const reached = opts.direction === "lose" ? latest.weightKg <= goal : latest.weightKg >= goal;
      const gap = weightToDisplay(Math.abs(latest.weightKg - goal), units);
      const away = reached || gap === 0 ? "reached" : `${gap.toFixed(1)} ${weightUnit(units)} away`;
      lines.push(`Goal weight: ${fmtWeight(goal, units)} (${away}).`);
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
 * described as something to do. A logging-only plan says what that means for
 * the coach, and never why the plan is one: the safety intake that decided it
 * stays on the device.
 *
 * With `trackingOnly` (see isTrackingOnly) the tracking-only line is sent
 * whatever the plan is, and with no plan at all, since an age too young to
 * state in PROFILE would otherwise reach the model as nothing. With
 * `planUnread` it says the plan could not be read and to treat it the same
 * way. Tracking only, or beside a goal weight below a healthy range
 * (`goalTooLow`), neither their goal in their own words nor the plan's goals
 * are sent: either can name the weight the rest of the summary leaves out.
 */
export function renderPlanForPrompt(
  plan: Plan | null,
  today: string,
  days: DaySnapshot[],
  opts: { trackingOnly?: boolean; planUnread?: boolean; goalTooLow?: boolean } = {},
): string {
  const tracking = !!opts.trackingOnly || plan?.mode === "logging_only";
  if (!plan || !plan.startDate || !plan.endDate) {
    if (opts.planUnread) return `PLAN\n${TRACKING_UNREAD}`;
    return tracking ? `PLAN\n${TRACKING_ONLY}` : "";
  }
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
  if (tracking) lines.push(TRACKING_ONLY);
  const goalsSent = !tracking && !opts.goalTooLow;

  if (goalsSent && plan.goalText && plan.goalText.trim()) {
    lines.push(`Goal in their words: ${clip(plan.goalText, MAX_GOAL_TEXT)}`);
  }

  const stored = Array.isArray(plan.goals) ? plan.goals.filter(Boolean) : [];
  const goals = (goalsSent ? visiblePlanGoals({ ...plan, goals: stored }) : []).filter(
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
 * oldest first. Returns the count, the day it ends on in words, and whether
 * it reached the start of the window, in which case the real run may be
 * longer than we can see. A day whose snapshot or diary could not be read
 * ends the run too, and for the same reason the count is then only a lower
 * bound: the day is named under COULD NOT READ, and the run may go on past it.
 */
function foodRun(days: DaySnapshot[], today: string): { n: number; through: string; capped: boolean } {
  let i = days.length - 1;
  if (days[i]?.date === today && !hasFood(days[i]!)) i--;
  const end = days[i]?.date ?? today;
  const through = end === today ? "today" : end === shiftDate(today, -1) ? "yesterday" : end;
  let n = 0;
  let expected = days[i]?.date;
  while (i >= 0 && expected && days[i]!.date === expected && hasFood(days[i]!)) {
    n++;
    expected = shiftDate(expected, -1);
    i--;
  }
  // Stopped at a day that is missing (its snapshot failed) or unread, not at
  // one with nothing logged.
  const stoppedOnUnknown = i >= 0 && (days[i]!.date !== expected || !diaryRead(days[i]!));
  return { n, through, capped: n > 0 && (i < 0 || stoppedOnUnknown) };
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

  // Out of the days whose diary was read: an unreadable one is not a day
  // with nothing logged.
  const diaryDays = before.filter(diaryRead);
  const food = diaryDays.filter(hasFood);
  const run = foodRun(f.days, f.today);
  if (food.length) {
    const avg = (k: "calories" | "protein" | "carbs" | "fat") =>
      Math.round(average(food.map((d) => d.consumed[k])));
    // The only streak the app has: consecutive days with food logged. Shown
    // only once it is a run (2 or more). The prompt says so, so the model
    // neither denies it nor invents another.
    const streak = run.n >= 2 ? ` (${run.capped ? "at least " : ""}${run.n} in a row through ${run.through})` : "";
    lines.push(
      `Food: logged ${food.length} of ${diaryDays.length} days${streak}, avg ${avg("calories")} cal, ` +
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

// ── COULD NOT READ ────────────────────────────────────────────────────

const GAP_WORDS: Record<AskGap, string> = {
  today: "today's diary",
  earlier: "some of the 7 days before today",
  profile: "their profile",
  weight: "their weigh-ins",
  plan: "their plan",
  rested: "how rested they felt",
};

/** What a failed part of TODAY is called. The weigh-in is left to the WEIGHT
 *  read, which is the one the coach answers weight questions from. */
const TODAY_PART_WORDS: Record<SnapshotPart, string | null> = {
  diary: "today's food",
  targets: "their daily targets",
  exercise: "today's exercise",
  water: "today's water",
  sleep: "today's sleep",
  symptoms: "today's symptoms",
  weight: null,
};

/**
 * Everything that failed to load for this question, in one line. A missing
 * section otherwise reads exactly like one with nothing logged, and the
 * prompt tells the model to say "nothing logged" for those. Empty when every
 * read worked.
 */
export function renderGapsForPrompt(f: AskFacts): string {
  const words: string[] = [];
  const note = (w: string | null) => {
    if (w && !words.includes(w)) words.push(w);
  };
  const gaps = new Set(f.unreadable ?? []);
  // Targets are not sent to a tracking-only user, so losing them is no gap.
  const { trackingOnly } = goalsFor(f);
  if (gaps.has("today")) note(GAP_WORDS.today);
  for (const part of f.days.find((d) => d.date === f.today)?.unreadable ?? []) {
    if (!(trackingOnly && part === "targets")) note(TODAY_PART_WORDS[part]);
  }
  // Earlier days feed LAST 7 DAYS, which uses neither the targets nor the
  // day's weigh-in.
  const earlierLost = f.days.some(
    (d) => d.date < f.today && (d.unreadable ?? []).some((p) => p !== "targets" && p !== "weight"),
  );
  if (gaps.has("earlier") || earlierLost) note(GAP_WORDS.earlier);
  for (const g of ["weight", "plan", "profile", "rested"] as const) if (gaps.has(g)) note(GAP_WORDS[g]);
  if (!words.length) return "";
  const line = words.join(", ");
  return `COULD NOT READ THIS TIME\n${line.charAt(0).toUpperCase()}${line.slice(1)}.`;
}

// ── Assembly ──────────────────────────────────────────────────────────

/** PROFILE, WEIGHT, PLAN and LAST 7 DAYS, in that order, each only when it
 *  has something to say. Split out so its size can be held to a budget. */
export function renderSummaryBlocks(f: AskFacts): string {
  const { trackingOnly, planUnread } = goalsFor(f);
  const p = f.profile;
  const goalTooLow = !trackingOnly && goalBelowHealthyRange(activeGoalKg(p?.goalWeightKg, p?.direction), p?.heightCm);
  return [
    section(() => renderProfileForPrompt(p, f.units, { trackingOnly })),
    section(() =>
      renderWeightForPrompt(f.weights, p?.goalWeightKg, f.units, {
        heightCm: p?.heightCm,
        direction: p?.direction,
        trackingOnly,
      }),
    ),
    section(() => renderPlanForPrompt(f.plan, f.today, f.days, { trackingOnly, planUnread, goalTooLow })),
    section(() => renderWeekForPrompt(f)),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The whole ABOUT THIS USER block, ending with what could not be read.
 *  Empty string when nothing was read and nothing is known to have failed.
 *  TODAY carries no targets, and so nothing "left", for a tracking-only
 *  user: those can be a deficit left over from an earlier plan. */
export function renderAskContext(f: AskFacts): string {
  const today = f.days.find((d) => d.date === f.today);
  const { trackingOnly } = goalsFor(f);
  const prior = section(() =>
    renderRecentForPrompt(f.days.filter((d) => d.date < f.today).slice(-RECENT_DAYS)),
  );
  return [
    today ? section(() => `TODAY\n${renderDayForPrompt(today, f.units, { targets: !trackingOnly })}`) : "",
    renderSummaryBlocks(f),
    prior ? `RECENT DAYS\n${prior}` : "",
    section(() => renderGapsForPrompt(f)),
  ]
    .filter(Boolean)
    .join("\n\n");
}
