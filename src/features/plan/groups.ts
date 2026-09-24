/**
 * Workout GROUPS — the schedule-free progression unit.
 *
 * A program's workouts are organized into numbered groups (deliberately not
 * called "weeks": there are no dates to fall behind on — you finish a group
 * whenever you finish it, then start the next). Group 1 of every cycle is an
 * EVALUATION group that (re-)measures the benchmarks; the remaining groups of
 * the cycle are training groups. Completing every workout in the current group
 * unlocks the next:
 *   - next group already exists (the initial plan ships groups 1+2) → advance;
 *   - next is a training group → clone the latest training group and ask the AI
 *     for a small, validated progression (bad/failed AI = plain clone, never a
 *     blocker);
 *   - next starts a new cycle → clone the evaluation workouts so the user
 *     re-tests, and the benchmark history keeps growing.
 *
 * Retention: the program keeps only the latest evaluation group, the latest
 * training group, and the current group (history lives in WorkoutSessions).
 */

import type { Plan, ProgramWorkout, WorkoutProgram, WorkoutSession } from "../../types";
import { newId } from "../../data/id";
import { complete } from "../../bridge/ai";
import { applyAdjustment, buildAnalysisPrompt, parseAdjustment } from "./analyze";
import { validateProgram } from "./validate";

/** Default groups per cycle: 1 evaluation + 3 training groups. */
export const DEFAULT_GROUPS_PER_CYCLE = 4;

/** A workout's group, deriving legacy (pre-groups) plans: assessments are the
 *  evaluation group (1), everything else the first training group (2). */
export function groupOf(pw: ProgramWorkout): number {
  return pw.group ?? (pw.isBenchmark ? 1 : 2);
}

/** The group the user is on. Legacy plans derive it: still evaluating until
 *  every benchmark has a baseline, else the first training group. */
export function currentGroup(program: WorkoutProgram): number {
  if (program.currentGroup != null) return program.currentGroup;
  return program.benchmarks.some((b) => b.baseline == null) ? 1 : 2;
}

/** Groups in one cycle (1 evaluation + N training). Falls back to
 *  {@link DEFAULT_GROUPS_PER_CYCLE} for plans created before the field. */
export function groupsPerCycle(program: WorkoutProgram): number {
  return program.groupsPerCycle ?? DEFAULT_GROUPS_PER_CYCLE;
}

/** Whether group `n` is an evaluation (benchmark re-test) group. */
export function isEvaluationGroup(program: WorkoutProgram, n: number): boolean {
  return (n - 1) % groupsPerCycle(program) === 0;
}

/** Every workout belonging to group `n`, in program order. */
export function workoutsInGroup(program: WorkoutProgram, n: number): ProgramWorkout[] {
  return program.workouts.filter((pw) => groupOf(pw) === n);
}

/** Every workout in group `n` checked done. False for an empty group. */
export function isGroupComplete(program: WorkoutProgram, n: number): boolean {
  const ws = workoutsInGroup(program, n);
  return ws.length > 0 && ws.every((pw) => pw.completedAt != null);
}

/**
 * Toggle a workout's done state (runner finish stamps it; the user can also
 * check a workout off manually — skipped days shouldn't wedge the group).
 * Immutable; returns the same program when the id is unknown.
 */
export function setWorkoutDone(
  program: WorkoutProgram,
  programWorkoutId: string,
  done: boolean,
  at = new Date().toISOString(),
): WorkoutProgram {
  let changed = false;
  const workouts = program.workouts.map((pw) => {
    if (pw.id !== programWorkoutId) return pw;
    if (done === (pw.completedAt != null)) return pw;
    changed = true;
    if (done) return { ...pw, completedAt: at };
    const { completedAt: _drop, ...rest } = pw;
    return rest as ProgramWorkout;
  });
  return changed ? { ...program, workouts } : program;
}

/** Latest (highest-numbered) group of evaluation / training workouts — the
 *  templates the next cycle clones from. */
function latestGroupWhere(
  program: WorkoutProgram,
  pred: (pw: ProgramWorkout) => boolean,
): ProgramWorkout[] {
  const nums = program.workouts.filter(pred).map(groupOf);
  if (nums.length === 0) return [];
  const top = Math.max(...nums);
  return program.workouts.filter((pw) => pred(pw) && groupOf(pw) === top);
}

/** Fresh-id, un-done clone of a workout into group `n`. Evaluation clones keep
 *  their benchmark links so a re-test measures the benchmarks again. */
function cloneInto(pw: ProgramWorkout, n: number): ProgramWorkout {
  const { completedAt: _done, ...rest } = pw;
  return { ...rest, id: newId(), group: n };
}

const PROGRESSION_SYSTEM = `You are a wellness coach writing the NEXT GROUP of workouts by progressing the previous group from recent performance. You are NOT a doctor.
Return ONLY a JSON object describing a SMALL, safe progression:
  { "summary": string,
    "deload"?: boolean,
    "benchmarkTargetDelta"?: number,
    "changes": [ { "op": "setReps"|"setWeight"|"setRest"|"swap", "exerciseKey": string, "reps"?: number, "weightKg"?: number, "restSec"?: number, "toName"?: string } ] }
Rules:
- Make at most 4 changes. Progress gently: a rep or two, a small weight bump, or slightly less rest when recent sessions looked comfortable; hold steady or ease off ("deload": true) when they looked hard or sparse.
- "exerciseKey" MUST be one of the keys listed in the data. Never invent an exercise. A "swap" keeps the same body area and stays equipment-light.
- If the user's preferences/feedback are listed, HONOR them — swap away movements they disliked, respect constraints/niggles, and don't reintroduce things they asked to avoid.
- weightKg is in kilograms. Keep everything beginner-safe.
- Output ONLY the JSON. No prose, no markdown fences.`;

/**
 * Build the workouts for group `n` when it doesn't exist yet.
 *   - Evaluation group: clone the latest evaluation workouts as-is (a re-test
 *     must match what it measures).
 *   - Training group: clone the latest training workouts, then best-effort ask
 *     the AI for a bounded progression, validated on the CLONED group only. Any
 *     failure leaves the plain clone — the user is never blocked.
 */
async function buildGroup(
  plan: Plan,
  program: WorkoutProgram,
  n: number,
  sessions: WorkoutSession[],
  preferences?: string,
): Promise<ProgramWorkout[]> {
  const evaluation = isEvaluationGroup(program, n);
  const source = evaluation
    ? latestGroupWhere(program, (pw) => pw.isBenchmark === true)
    : latestGroupWhere(program, (pw) => !pw.isBenchmark);
  // A program with no training workouts (assessment-only) progresses by
  // re-testing: fall back to whatever exists so the group is never empty.
  const base = (source.length > 0 ? source : program.workouts).map((pw) => cloneInto(pw, n));
  if (evaluation || base.length === 0) return base;

  try {
    const temp: WorkoutProgram = { ...program, workouts: base };
    const raw = await complete({
      system: PROGRESSION_SYSTEM,
      messages: [
        {
          role: "user",
          content: `${buildAnalysisPrompt(temp, sessions, preferences)}\n\nWrite the progression for the user's next group of these workouts.`,
        },
      ],
      maxTokens: 1024,
      tier: "capable",
    });
    const adj = parseAdjustment(raw);
    if (adj && (adj.changes.length > 0 || adj.deload)) {
      // Never let a group progression move the benchmark targets — that's the
      // evaluation/adaptation loop's job.
      const progressed = applyAdjustment(temp, { ...adj, benchmarkTargetDelta: undefined });
      const reasons = validateProgram(progressed, plan.mode, plan.safety.injuries ?? []);
      if (reasons.length === 0) return progressed.workouts;
    }
  } catch {
    /* AI unavailable — the plain clone stands */
  }
  return base;
}

/**
 * Advance to the next group once the current one is complete. Returns a NEW
 * plan (the caller persists it), or the same plan when the current group isn't
 * finished. Prunes retention to: latest evaluation group ∪ latest training
 * group ∪ the new current group.
 */
export async function advanceToNextGroup(
  plan: Plan,
  sessions: WorkoutSession[],
  preferences?: string,
): Promise<Plan> {
  const program = plan.program;
  if (!program) return plan;
  const cur = currentGroup(program);
  if (!isGroupComplete(program, cur)) return plan;

  const next = cur + 1;
  const existing = workoutsInGroup(program, next);
  const nextWorkouts =
    existing.length > 0 ? existing : await buildGroup(plan, program, next, sessions, preferences);
  if (nextWorkouts.length === 0) return plan;

  // Retention: keep the templates (latest eval + latest training groups) and
  // the new group; drop older training clutter. Dedup by id.
  const keep = new Map<string, ProgramWorkout>();
  for (const pw of [
    ...latestGroupWhere(program, (w) => w.isBenchmark === true),
    ...latestGroupWhere(program, (w) => !w.isBenchmark),
    ...nextWorkouts,
  ]) {
    keep.set(pw.id, pw);
  }

  const updated: WorkoutProgram = {
    ...program,
    workouts: [...keep.values()].sort((a, b) => groupOf(a) - groupOf(b)),
    currentGroup: next,
  };
  return { ...plan, program: updated };
}
