/**
 * Check-in question selection. The bank is hardcoded (so wording stays vetted
 * and answers map to stable metric keys); which 3–4 get asked is decided from
 * the recorded stats — the AI picks when the bridge is available, with a
 * deterministic stat-priority fallback so the form always appears.
 */

import type { WorkoutSession } from "../../types";
import { complete, isAiAvailable } from "../../bridge/ai";
import { detectPRs } from "../workoutHistory";
import type { CheckinKind, CoachQuestion } from "./model";

const MAX_QUESTIONS = 4;

// ── The bank ─────────────────────────────────────────────────────────
// Order within each bank = deterministic-fallback priority. The free-text
// closer is always included and always last.

const WORKOUT_BANK: CoachQuestion[] = [
  { id: "w_difficulty", text: "How hard did that feel overall?", kind: "scale", low: "Easy", high: "Max effort", metricKey: "workout_difficulty" },
  { id: "w_pr", text: "New PR today — what clicked for you?", kind: "text" },
  { id: "w_rpe_high", text: "A few sets were near max effort. Which movement felt toughest?", kind: "text" },
  { id: "w_slow", text: "How was your energy today?", kind: "scale", low: "Running on empty", high: "Fresh", metricKey: "workout_energy" },
  { id: "w_pace", text: "How did the pace feel?", kind: "scale", low: "Too easy", high: "Too hard", metricKey: "cardio_pace_feel" },
  { id: "w_enjoy", text: "Did you enjoy this workout?", kind: "scale", low: "Not really", high: "Loved it", metricKey: "workout_enjoyment" },
  { id: "w_pain", text: "Any aches or pain during the session? Say where, or “none”.", kind: "text" },
];
const WORKOUT_CLOSER: CoachQuestion = { id: "w_free", text: "Anything else your coach should know?", kind: "text" };

const DAY_BANK: CoachQuestion[] = [
  { id: "d_rating", text: "How did your day go overall?", kind: "scale", low: "Rough", high: "Great", metricKey: "day_rating" },
  { id: "d_over", text: "You finished over your calorie budget — what got in the way?", kind: "text" },
  { id: "d_under", text: "You logged well under budget. Intentional, or did some food go unlogged?", kind: "text" },
  { id: "d_nolog", text: "Nothing logged today — how did eating actually go?", kind: "text" },
  { id: "d_goals", text: "Which of your plan goals felt hardest today?", kind: "text" },
  { id: "d_energy", text: "How was your energy?", kind: "scale", low: "Drained", high: "Energized", metricKey: "day_energy" },
  { id: "d_tomorrow", text: "One thing you want to do differently tomorrow?", kind: "text" },
];
const DAY_CLOSER: CoachQuestion = { id: "d_free", text: "Anything else on your mind?", kind: "text" };

// ── Stat gathering ───────────────────────────────────────────────────

/** Signals derived from a finished session that the question bank filters on
 *  — so the coach asks about what actually happened, not a generic prompt. */
export interface WorkoutStats {
  cardio: boolean;
  avgRpe: number | null;
  /** Rep sets whose wall-clock ran long (proxy for grinding/over-resting). */
  slowSets: number;
  prCount: number;
  totalSets: number;
}

/**
 * Reduce a finished session (and the sessions before it) into the signals the
 * question bank filters on: effort, grinding, PRs, volume. Pure — takes
 * history explicitly rather than reading it, so it's directly testable.
 */
export function workoutStatsFrom(session: WorkoutSession, prior: WorkoutSession[]): WorkoutStats {
  const sets = (session.byExercise ?? []).flatMap((e) => e.sets);
  const rpes = sets.map((s) => s.rpe).filter((v): v is number => v != null);
  const slowSets = sets.filter((s) => {
    const elapsed = (Date.parse(s.completedAt) - Date.parse(s.startedAt)) / 1000;
    return s.reps != null && Number.isFinite(elapsed) && elapsed > 90;
  }).length;
  return {
    cardio: Boolean(session.cardio),
    avgRpe: rpes.length ? rpes.reduce((a, b) => a + b, 0) / rpes.length : null,
    slowSets,
    prCount: session.byExercise ? detectPRs(session.byExercise, prior).length : 0,
    totalSets: sets.length,
  };
}

/** End-of-day signals the check-in question bank filters on. */
export interface DayStats {
  calories: number;
  goal: number;
  /** Labels of plan goals NOT checked off today. */
  missedGoals: string[];
}

// ── Applicability + deterministic pick ───────────────────────────────

function workoutCandidates(s: WorkoutStats): CoachQuestion[] {
  const ok = (q: CoachQuestion): boolean => {
    switch (q.id) {
      case "w_pr": return s.prCount > 0;
      case "w_rpe_high": return s.avgRpe != null && s.avgRpe >= 8;
      case "w_slow": return s.slowSets >= 2;
      case "w_pace": return s.cardio;
      default: return true;
    }
  };
  return WORKOUT_BANK.filter(ok);
}

function dayCandidates(s: DayStats): CoachQuestion[] {
  const ok = (q: CoachQuestion): boolean => {
    switch (q.id) {
      case "d_over": return s.calories > s.goal * 1.05 && s.goal > 0;
      case "d_under": return s.calories > 0 && s.calories < s.goal * 0.6;
      case "d_nolog": return s.calories === 0;
      case "d_goals": return s.missedGoals.length > 0;
      default: return true;
    }
  };
  return DAY_BANK.filter(ok);
}

// ── AI pick with deterministic fallback ──────────────────────────────

const PICK_SYSTEM = `You are a wellness coach choosing which short check-in questions to ask right now.
From the numbered candidates, pick the ${MAX_QUESTIONS - 1} MOST relevant to the stats (most specific first).
Return ONLY a JSON array of question ids, e.g. ["w_pr","w_difficulty","w_pain"]. No prose.`;

async function aiPick(statsLine: string, candidates: CoachQuestion[]): Promise<CoachQuestion[] | null> {
  if (!isAiAvailable() || candidates.length <= MAX_QUESTIONS - 1) return null;
  try {
    const raw = await complete({
      system: PICK_SYSTEM,
      messages: [
        {
          role: "user",
          content: `${statsLine}\nCandidates:\n${candidates.map((c) => `- ${c.id}: ${c.text}`).join("\n")}`,
        },
      ],
      maxTokens: 128,
      tier: "cheap",
    });
    const match = raw.match(/\[[\s\S]*?\]/);
    if (!match) return null;
    const ids = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(ids)) return null;
    const byId = new Map(candidates.map((c) => [c.id, c]));
    const picked = ids
      .filter((id): id is string => typeof id === "string")
      .map((id) => byId.get(id))
      .filter((q): q is CoachQuestion => Boolean(q))
      .slice(0, MAX_QUESTIONS - 1);
    return picked.length >= 2 ? picked : null;
  } catch {
    return null;
  }
}

async function pick(
  kind: CheckinKind,
  statsLine: string,
  candidates: CoachQuestion[],
): Promise<CoachQuestion[]> {
  const closer = kind === "workout" ? WORKOUT_CLOSER : DAY_CLOSER;
  const picked = (await aiPick(statsLine, candidates)) ?? candidates.slice(0, MAX_QUESTIONS - 1);
  return [...picked, closer];
}

/** Questions for the post-workout reflect form. */
export async function workoutQuestions(
  session: WorkoutSession,
  prior: WorkoutSession[],
): Promise<CoachQuestion[]> {
  const s = workoutStatsFrom(session, prior);
  const statsLine = s.cardio
    ? `Just finished a cardio session (${session.cardio!.distanceKm.toFixed(2)} km in ${Math.round(session.cardio!.durationSec / 60)} min).`
    : `Just finished a strength session: ${s.totalSets} sets, avg RPE ${s.avgRpe?.toFixed(1) ?? "unrecorded"}, ${s.slowSets} slow sets, ${s.prCount} new PR(s).`;
  return pick("workout", statsLine, workoutCandidates(s));
}

/** Questions for the end-of-day check-in. */
export async function dayQuestions(stats: DayStats): Promise<CoachQuestion[]> {
  const statsLine = `End of day: ${stats.calories} kcal eaten vs a ${stats.goal} kcal goal; plan goals missed today: ${
    stats.missedGoals.length ? stats.missedGoals.join(", ") : "none"
  }.`;
  return pick("day", statsLine, dayCandidates(stats));
}
