import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Benchmark, Plan, ProgramWorkout, WorkoutProgram, WorkoutSession } from "../../types";

// Deterministic AI: the progression call returns a small valid adjustment.
const completeMock = vi.fn(async (_req?: unknown) =>
  JSON.stringify({
    summary: "add a rep",
    changes: [{ op: "setReps", exerciseKey: "push-up", reps: 9 }],
  }),
);
// Stub only the host-dependent surface; pure helpers (extractJson) stay real.
vi.mock("../../bridge/ai", async (orig) => ({
  ...(await orig<typeof import("../../bridge/ai")>()),
  complete: (req: unknown) => completeMock(req),
  isAiAvailable: () => true,
}));

import {
  advanceToNextGroup,
  currentGroup,
  groupOf,
  isEvaluationGroup,
  isGroupComplete,
  setWorkoutDone,
  workoutsInGroup,
} from "./groups";
import { measureSession, parseProgram, recordBenchmarkResult } from "./program";
import { __resetRepository } from "../../data/repository";
import { recordManualBenchmarkEntry } from "./planService";

// ── Fixtures ────────────────────────────────────────────────────────────

const bench = (over: Partial<Benchmark>): Benchmark => ({
  id: over.id ?? "b1",
  exerciseKey: over.exerciseKey ?? "pull-up",
  name: over.name ?? "Pull-up",
  metric: over.metric ?? "reps",
  baseline: over.baseline ?? null,
  target: over.target ?? 20,
  unit: over.unit ?? "reps",
  history: over.history ?? [],
  ...(over.lowerIsBetter ? { lowerIsBetter: true } : {}),
});

const strengthWorkout = (name: string, exercise: string): ProgramWorkout["workout"] => ({
  id: `w-${name}`,
  name,
  exercises: [
    { id: `e-${name}`, name: exercise, sets: [{ reps: 8, durationSec: null, restSec: 60 }] },
  ],
  origin: "built-in",
});

function makeProgram(): WorkoutProgram {
  return {
    benchmarks: [
      bench({ id: "b1", exerciseKey: "pull-up", name: "Pull-up" }),
      bench({ id: "b2", exerciseKey: "run", name: "1 mile run", metric: "durationSec", unit: "sec", lowerIsBetter: true, target: 480 }),
    ],
    workouts: [
      {
        id: "pw-eval",
        workout: strengthWorkout("Assessment", "Pull-Up"),
        isBenchmark: true,
        benchmarkId: "b1",
        benchmarkIds: ["b1", "b2"],
        group: 1,
      },
      { id: "pw-a", workout: strengthWorkout("Push Day", "Push-Up"), group: 2 },
      { id: "pw-b", workout: strengthWorkout("Leg Day", "Squat"), group: 2 },
    ],
    analysisCursor: 0,
    currentGroup: 1,
    groupsPerCycle: 4,
  };
}

const makePlan = (program: WorkoutProgram): Plan => ({
  id: "p1",
  mode: "both",
  durationWeeks: 4,
  startDate: "2026-07-01",
  endDate: "2026-07-28",
  goals: [],
  safety: { ageBand: "18_39", pregnant: false, cardiacFlag: false, injuries: [], activityLevel: "moderate" },
  liability: { acknowledged: true, acceptedAt: "2026-07-01T00:00:00Z" },
  createdAt: "2026-07-01T00:00:00Z",
  program,
});

// ── Group basics ────────────────────────────────────────────────────────

describe("group model", () => {
  it("parseProgram assigns evaluation workouts to group 1, training to group 2, currentGroup 1", () => {
    const parsed = parseProgram({
      workouts: [
        { name: "Assessment", exercises: [{ name: "Pull-Up", sets: [{ reps: 5 }] }] },
        { name: "Push Day", exercises: [{ name: "Push-Up", sets: [{ reps: 8 }] }] },
      ],
      benchmarks: [{ exercise: "Pull-Up", metric: "reps", target: 20 }],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.currentGroup).toBe(1);
    const evalW = parsed!.workouts.find((w) => w.isBenchmark)!;
    const trainW = parsed!.workouts.find((w) => !w.isBenchmark)!;
    expect(evalW.group).toBe(1);
    expect(trainW.group).toBe(2);
  });

  it("derives groups + currentGroup for legacy plans without group fields", () => {
    const legacy: WorkoutProgram = {
      ...makeProgram(),
      currentGroup: undefined,
      workouts: makeProgram().workouts.map(({ group: _g, ...pw }) => pw as ProgramWorkout),
    };
    expect(groupOf(legacy.workouts[0]!)).toBe(1); // assessment
    expect(groupOf(legacy.workouts[1]!)).toBe(2); // training
    expect(currentGroup(legacy)).toBe(1); // baselines still null → evaluating
    const measured: WorkoutProgram = {
      ...legacy,
      benchmarks: legacy.benchmarks.map((b) => ({ ...b, baseline: 5 })),
    };
    expect(currentGroup(measured)).toBe(2);
  });

  it("setWorkoutDone toggles and isGroupComplete requires every workout done", () => {
    let program = makeProgram();
    expect(isGroupComplete(program, 1)).toBe(false);
    program = setWorkoutDone(program, "pw-eval", true);
    expect(isGroupComplete(program, 1)).toBe(true);
    program = setWorkoutDone(program, "pw-eval", false);
    expect(isGroupComplete(program, 1)).toBe(false);
    expect(program.workouts.find((w) => w.id === "pw-eval")!.completedAt).toBeUndefined();
  });

  it("evaluation groups recur at the start of each cycle", () => {
    const program = makeProgram();
    expect(isEvaluationGroup(program, 1)).toBe(true);
    expect(isEvaluationGroup(program, 2)).toBe(false);
    expect(isEvaluationGroup(program, 4)).toBe(false);
    expect(isEvaluationGroup(program, 5)).toBe(true);
    expect(isEvaluationGroup(program, 9)).toBe(true);
  });
});

// ── Advancing groups ────────────────────────────────────────────────────

describe("advanceToNextGroup", () => {
  beforeEach(() => {
    completeMock.mockClear();
    __resetRepository();
  });

  it("does nothing while the current group is incomplete", async () => {
    const plan = makePlan(makeProgram());
    expect(await advanceToNextGroup(plan, [])).toBe(plan);
  });

  it("advances 1→2 using the pre-built training group (no generation)", async () => {
    const plan = makePlan(setWorkoutDone(makeProgram(), "pw-eval", true));
    const next = await advanceToNextGroup(plan, []);
    expect(next.program!.currentGroup).toBe(2);
    expect(workoutsInGroup(next.program!, 2).map((w) => w.id).sort()).toEqual(["pw-a", "pw-b"]);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("generates group 3 by cloning group 2 with an AI progression", async () => {
    let program = setWorkoutDone(makeProgram(), "pw-eval", true);
    program = { ...program, currentGroup: 2 };
    program = setWorkoutDone(program, "pw-a", true);
    program = setWorkoutDone(program, "pw-b", true);
    const next = await advanceToNextGroup(makePlan(program), []);
    const g3 = workoutsInGroup(next.program!, 3);
    expect(next.program!.currentGroup).toBe(3);
    expect(g3).toHaveLength(2);
    // Fresh clones: new ids, not done, group 3.
    for (const pw of g3) {
      expect(["pw-a", "pw-b"]).not.toContain(pw.id);
      expect(pw.completedAt).toBeUndefined();
    }
    // The AI progression applied (push-up reps 8 → 9 in the CLONE only).
    const pushClone = g3.find((w) => w.workout.name === "Push Day")!;
    expect(pushClone.workout.exercises[0]!.sets[0]!.reps).toBe(9);
    const pushOrig = next.program!.workouts.find((w) => w.id === "pw-a");
    if (pushOrig) expect(pushOrig.workout.exercises[0]!.sets[0]!.reps).toBe(8);
  });

  it("falls back to a plain clone when the AI call fails", async () => {
    completeMock.mockRejectedValueOnce(new Error("offline"));
    let program: WorkoutProgram = { ...setWorkoutDone(makeProgram(), "pw-eval", true), currentGroup: 2 };
    program = setWorkoutDone(program, "pw-a", true);
    program = setWorkoutDone(program, "pw-b", true);
    const next = await advanceToNextGroup(makePlan(program), []);
    const g3 = workoutsInGroup(next.program!, 3);
    expect(g3).toHaveLength(2);
    expect(g3.find((w) => w.workout.name === "Push Day")!.workout.exercises[0]!.sets[0]!.reps).toBe(8);
  });

  it("starts the next cycle with a fresh evaluation group (benchmark links intact, not done)", async () => {
    // Simulate being at the end of the first cycle: current group 4, complete.
    let program = makeProgram();
    program = {
      ...program,
      currentGroup: 4,
      workouts: [
        ...program.workouts,
        { id: "pw-g4", workout: strengthWorkout("Push Day", "Push-Up"), group: 4, completedAt: "2026-07-20T00:00:00Z" },
      ],
    };
    const next = await advanceToNextGroup(makePlan(program), []);
    expect(next.program!.currentGroup).toBe(5);
    const g5 = workoutsInGroup(next.program!, 5);
    expect(g5).toHaveLength(1);
    expect(g5[0]!.isBenchmark).toBe(true);
    expect(g5[0]!.benchmarkIds).toEqual(["b1", "b2"]);
    expect(g5[0]!.completedAt).toBeUndefined();
    expect(g5[0]!.id).not.toBe("pw-eval");
  });
});

// ── Mixed-session measurement + manual entry ────────────────────────────

describe("manual benchmark entry", () => {
  beforeEach(() => {
    completeMock.mockClear();
    __resetRepository();
  });

  it("measureSession reads each benchmark's own slice of a mixed session", () => {
    const now = "2026-07-22T10:00:00.000Z";
    const session: WorkoutSession = {
      id: "s1",
      date: "2026-07-22",
      planned: [],
      actual: [],
      reprompts: [],
      byExercise: [
        { exerciseKey: "pull-up", name: "Pull-up", sets: [{ reps: 12, startedAt: now, completedAt: now }] },
      ],
      cardio: { distanceKm: 0, durationSec: 540, source: "manual" },
      benchmarkIds: ["b1", "b2"],
      completedAt: now,
    };
    const pullups = bench({ id: "b1" });
    const run = bench({ id: "b2", exerciseKey: "run", metric: "durationSec", lowerIsBetter: true, target: 480 });
    expect(measureSession(pullups, session)).toBe(12);
    expect(measureSession(run, session)).toBe(540);
    const folded = recordBenchmarkResult({ ...makeProgram() }, session);
    expect(folded.benchmarks.find((b) => b.id === "b1")!.baseline).toBe(12);
    expect(folded.benchmarks.find((b) => b.id === "b2")!.baseline).toBe(540);
  });

  it("records typed-in results: baselines set, evaluation checked off, group completable", async () => {
    const plan = makePlan(makeProgram());
    const next = await recordManualBenchmarkEntry(plan, "pw-eval", [
      { benchmarkId: "b1", value: 12 },
      { benchmarkId: "b2", value: 540 },
    ]);
    expect(next).not.toBeNull();
    const program = next!.program!;
    expect(program.benchmarks.find((b) => b.id === "b1")!.baseline).toBe(12);
    expect(program.benchmarks.find((b) => b.id === "b2")!.baseline).toBe(540);
    expect(program.workouts.find((w) => w.id === "pw-eval")!.completedAt).toBeTruthy();
    expect(isGroupComplete(program, 1)).toBe(true);
  });

  it("ignores empty/invalid entries and no-ops when nothing is measurable", async () => {
    const plan = makePlan(makeProgram());
    const next = await recordManualBenchmarkEntry(plan, "pw-eval", [
      { benchmarkId: "b1", value: 0 },
      { benchmarkId: "nope", value: 10 },
    ]);
    expect(next).toBe(plan);
  });
});
