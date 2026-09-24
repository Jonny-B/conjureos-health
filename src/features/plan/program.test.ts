import { describe, expect, it } from "vitest";
import type { WorkoutSession } from "../../types";
import { parseProgram, recordBenchmarkResult } from "./program";
import { fallbackProgram } from "./fallbackTemplates";
import { normalizeExerciseKey } from "../explainers/normalizeKey";

const T = "2026-07-18T10:00:00Z";

describe("parseProgram — multi-benchmark", () => {
  it("parses a multi-part assessment (Murph-style) and links the assessment workout to every benchmark", () => {
    const prog = parseProgram({
      workouts: [
        {
          name: "Assessment",
          exercises: [
            { name: "Pull-ups", sets: [{ reps: 5, restSec: 60 }] },
            { name: "Push-ups", sets: [{ reps: 10, restSec: 60 }] },
          ],
        },
        { name: "Strength Day", exercises: [{ name: "Goblet Squat", sets: [{ reps: 10, restSec: 60 }] }] },
      ],
      benchmarks: [
        { exercise: "Pull-ups", metric: "reps", target: 20, unit: "reps" },
        { exercise: "Push-ups", metric: "reps", target: 50, unit: "reps" },
      ],
    });
    expect(prog).not.toBeNull();
    expect(prog!.benchmarks).toHaveLength(2);
    const assess = prog!.workouts[0]!;
    expect(assess.isBenchmark).toBe(true);
    expect(assess.benchmarkIds).toHaveLength(2);
    // The non-assessment workout measures nothing.
    expect(prog!.workouts[1]!.isBenchmark).toBeUndefined();
  });

  it("still accepts a legacy single `benchmark` object", () => {
    const prog = parseProgram({
      workouts: [{ name: "A", exercises: [{ name: "Squat", sets: [{ reps: 12, restSec: 45 }] }] }],
      benchmark: { exercise: "Squat", metric: "reps", target: 20, unit: "reps" },
    });
    expect(prog!.benchmarks).toHaveLength(1);
    expect(prog!.workouts[0]!.benchmarkIds).toEqual([prog!.benchmarks[0]!.id]);
  });

  it("caps benchmarks at 4 and dedupes by exercise", () => {
    const prog = parseProgram({
      workouts: [{ name: "A", exercises: [{ name: "Squat", sets: [{ reps: 12, restSec: 45 }] }] }],
      benchmarks: [
        { exercise: "Squat", metric: "reps", target: 20, unit: "reps" },
        { exercise: "Squat", metric: "reps", target: 30, unit: "reps" }, // dup key
        { exercise: "Push-ups", metric: "reps", target: 40, unit: "reps" },
        { exercise: "Pull-ups", metric: "reps", target: 15, unit: "reps" },
        { exercise: "Dips", metric: "reps", target: 25, unit: "reps" },
        { exercise: "Lunges", metric: "reps", target: 30, unit: "reps" },
      ],
    });
    expect(prog!.benchmarks.length).toBeLessThanOrEqual(4);
    // The duplicate Squat collapses to one.
    expect(prog!.benchmarks.filter((b) => b.exerciseKey === normalizeExerciseKey("Squat"))).toHaveLength(1);
  });
});

describe("recordBenchmarkResult — an assessment sets several baselines at once", () => {
  it("measures every benchmark tagged by benchmarkIds", () => {
    const prog = parseProgram({
      workouts: [
        {
          name: "Assessment",
          exercises: [
            { name: "Pull-ups", sets: [{ reps: 5, restSec: 60 }] },
            { name: "Push-ups", sets: [{ reps: 10, restSec: 60 }] },
          ],
        },
      ],
      benchmarks: [
        { exercise: "Pull-ups", metric: "reps", target: 20, unit: "reps" },
        { exercise: "Push-ups", metric: "reps", target: 50, unit: "reps" },
      ],
    })!;
    const session: WorkoutSession = {
      id: "s1",
      date: "2026-07-18",
      planned: [],
      actual: [],
      reprompts: [],
      benchmarkIds: prog.benchmarks.map((b) => b.id),
      byExercise: [
        { exerciseKey: normalizeExerciseKey("Pull-ups"), name: "Pull-ups", sets: [{ reps: 8, startedAt: T, completedAt: T }] },
        { exerciseKey: normalizeExerciseKey("Push-ups"), name: "Push-ups", sets: [{ reps: 15, startedAt: T, completedAt: T }] },
      ],
      completedAt: T,
    };
    const after = recordBenchmarkResult(prog, session);
    const pull = after.benchmarks.find((b) => b.exerciseKey === normalizeExerciseKey("Pull-ups"))!;
    const push = after.benchmarks.find((b) => b.exerciseKey === normalizeExerciseKey("Push-ups"))!;
    expect(pull.baseline).toBe(8);
    expect(push.baseline).toBe(15);
  });
});

describe("fallbackProgram — scaled to experience", () => {
  it("gives an advanced user a real session, never the beginner Sit-to-Stand", () => {
    const prog = fallbackProgram("both", [], "advanced")!;
    expect(prog.workouts[0]!.workout.name).not.toBe("Bodyweight Starter");
    const bench = prog.benchmarks[0]!;
    expect(bench.name).toBe("Push-ups");
    expect(bench.target).toBe(50);
    // No sit-to-stand anywhere in an advanced fallback.
    const names = prog.workouts[0]!.workout.exercises.map((e) => e.name.toLowerCase());
    expect(names.some((n) => n.includes("sit-to-stand"))).toBe(false);
  });

  it("keeps the beginner default gentle", () => {
    const prog = fallbackProgram("both", [], "beginner")!;
    expect(prog.workouts[0]!.workout.name).toBe("Bodyweight Starter");
    expect(prog.benchmarks[0]!.name).toBe("Sit-to-Stand");
  });
});
