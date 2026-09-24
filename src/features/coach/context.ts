/**
 * Coach context assembly — one compact snapshot of everything the coach may
 * reason about: the active plan, recent food days vs goal, weight trend,
 * recent workout sessions, check-in history, archived (past) plans, and the
 * coach's own memory. Built once per surface and shared by every coach call
 * in that surface so the prompts stay consistent.
 */

import type { DailyCheckoff, DiaryEntry, Goals, Plan, WeightEntry, WorkoutSession } from "../../types";
import { DEFAULT_GOALS } from "../../types";
import { getRepository } from "../../data/repository";
import { readJson } from "../../bridge/vfs";
import { buildDayView, shiftDate, todayISO } from "../diary";
import { normalizeExerciseKey } from "../explainers/normalizeKey";
import { summarize } from "../workoutHistory";
import { targetsToGoals } from "../plan/planService";
import { loadMemory } from "./memory";
import type { CoachContext } from "./model";

const ARCHIVE_PATH = "plan-archive.json";
const FOOD_DAYS = 7;
const SESSION_WINDOW = 8;

/**
 * Assemble everything the coach is allowed to know: active plan, profile,
 * goals, recent weigh-ins, recent sessions, its own memory, and archived
 * plans. Every read is individually fault-tolerant — a missing or failing
 * store degrades that slice to a default rather than failing the whole turn,
 * so the coach still answers with partial context.
 */
export async function buildCoachContext(): Promise<CoachContext> {
  const repo = await getRepository();
  const today = todayISO();

  const [plan, profile, storedGoals, weights, sessions, memory, archived] = await Promise.all([
    repo.getPlan().catch(() => null),
    repo.getProfile().catch(() => null),
    repo.getGoals().catch(() => ({ ...DEFAULT_GOALS })),
    repo.listWeights().catch(() => [] as WeightEntry[]),
    repo.listWorkoutSessions(SESSION_WINDOW).catch(() => [] as WorkoutSession[]),
    loadMemory(),
    readJson<Plan[]>(ARCHIVE_PATH, []),
  ]);
  const goals = targetsToGoals(plan, storedGoals);

  // Last N calendar days of food, oldest first, with the day's check-off.
  const days: string[] = [];
  for (let i = FOOD_DAYS - 1; i >= 0; i--) days.push(shiftDate(today, -i));
  const [diaryDays, dayLogs] = await Promise.all([
    Promise.all(days.map((d) => repo.listDiary(d).catch(() => []))),
    Promise.all(days.map((d) => repo.getDayLog(d).catch(() => null))),
  ]);

  const rendered = render({ plan, goals, weights, sessions, archived, days, diaryDays, dayLogs, today });
  return { plan, profile, goals, memory, rendered };
}

function render(x: {
  plan: Plan | null;
  goals: Goals;
  weights: WeightEntry[];
  sessions: WorkoutSession[];
  archived: Plan[];
  days: string[];
  diaryDays: DiaryEntry[][];
  dayLogs: (DailyCheckoff | null)[];
  today: string;
}): string {
  const lines: string[] = [];
  lines.push(`Today: ${x.today}.`);

  if (x.plan) {
    const p = x.plan;
    lines.push(
      `Active plan: ${p.mode}, ${p.startDate} → ${p.endDate}. Goals: ${p.goals.map((g) => g.label).join("; ")}.`,
    );
    if (p.targets?.dailyCalories != null) lines.push(`Daily calorie target: ${p.targets.dailyCalories}.`);
    const prog = p.program;
    if (prog) {
      lines.push(`Program workouts: ${prog.workouts.map((w) => w.workout.name).join(", ")}.`);
      const keys = new Set<string>();
      for (const pw of prog.workouts)
        for (const ex of pw.workout.exercises) keys.add(normalizeExerciseKey(ex.name));
      if (keys.size)
        lines.push(`Program exercise keys (for plan adjustments, use these exactly): ${[...keys].join(", ")}.`);
      const b = prog.benchmarks[0];
      if (b) {
        const latest = b.history.at(-1)?.value;
        lines.push(
          `Benchmark ${b.name}: baseline ${b.baseline ?? "unset"}, now ${latest ?? "—"}, target ${b.target} ${b.unit}${b.lowerIsBetter ? " (lower is better)" : ""}.`,
        );
      }
    }
  } else {
    lines.push("No active plan (logging only right now).");
  }

  // Food: last week vs goal, one line per day with data.
  const foodLines: string[] = [];
  x.days.forEach((d, i) => {
    const entries = x.diaryDays[i] ?? [];
    if (entries.length === 0) return;
    const total = buildDayView(d, entries).total;
    foodLines.push(`  ${d}: ${total.calories} kcal (goal ${x.goals.calories}), ${total.protein}g protein`);
  });
  lines.push(foodLines.length ? `Food, last ${FOOD_DAYS} days:\n${foodLines.join("\n")}` : "No food logged this week.");

  if (x.weights.length) {
    const recent = x.weights.slice(0, 5);
    const newest = recent[0]!;
    const oldest = x.weights[x.weights.length - 1]!;
    lines.push(
      `Weight: ${newest.weightKg} kg on ${newest.date} (was ${oldest.weightKg} kg on ${oldest.date}).`,
    );
  }

  if (x.sessions.length) {
    const sLines = x.sessions.map((s) => {
      if (s.cardio)
        return `  ${s.date}: cardio ${s.cardio.distanceKm.toFixed(2)} km in ${Math.round(s.cardio.durationSec / 60)} min`;
      const st = summarize(s.byExercise ?? []);
      const rpes = (s.byExercise ?? []).flatMap((e) => e.sets.map((set) => set.rpe)).filter((v): v is number => v != null);
      const rpe = rpes.length ? `, avg RPE ${(rpes.reduce((a, b) => a + b, 0) / rpes.length).toFixed(1)}` : "";
      return `  ${s.date}: ${st.totalSets} sets, ${st.totalReps} reps, ${Math.round(st.totalVolumeKg)} kg volume${rpe}`;
    });
    lines.push(`Recent workouts (newest first):\n${sLines.join("\n")}`);
  } else {
    lines.push("No workouts recorded yet.");
  }

  const checkins = x.dayLogs
    .filter((l): l is DailyCheckoff => Boolean(l?.checkin))
    .map((l) => `  ${l.date}: ${l.checkin!.answers.map((a) => `${a.question} → ${a.answer}`).join(" · ")}`);
  if (checkins.length) lines.push(`Recent day check-ins:\n${checkins.join("\n")}`);

  if (x.archived.length) {
    const past = x.archived
      .slice(0, 3)
      .map((p) => `  ${p.startDate} → ${p.endDate} (${p.mode}): ${p.goals.slice(0, 3).map((g) => g.label).join("; ")}`);
    lines.push(`Past plans (archived):\n${past.join("\n")}`);
  }

  return lines.join("\n");
}

/** The memory block appended to every coach prompt (kept separate from the
 *  history so prompts can order them consistently). */
export function renderMemory(ctx: CoachContext): string {
  const m = ctx.memory;
  const lines: string[] = [];
  if (m.summary) lines.push(`Running summary: ${m.summary}`);
  if (m.notes.length) lines.push(`Notes to remember:\n${m.notes.map((n) => `  - ${n}`).join("\n")}`);
  const ev = m.events.slice(0, 10);
  if (ev.length) lines.push(`Recent events:\n${ev.map((e) => `  ${e.at.slice(0, 10)} [${e.kind}] ${e.text}`).join("\n")}`);
  const met = m.metrics.slice(0, 14);
  if (met.length) lines.push(`Recent check-in metrics (1–5):\n${met.map((v) => `  ${v.date} ${v.key}=${v.value}`).join("\n")}`);
  return lines.length ? lines.join("\n") : "(no coach memory yet)";
}
