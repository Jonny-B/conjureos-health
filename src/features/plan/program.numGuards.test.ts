import { describe, it, expect } from "vitest";
import { parseProgram } from "./program";

/**
 * Regression for num.ts's non-numeric-coercion bug (fixed alongside this
 * file): `toIntInRange(null, 1, 100)` used to return `1` instead of `null`,
 * so `parseSet`'s "reps or duration, at least one" guard and
 * `parseBenchmark`'s "target must exist" guard never fired for AI output
 * that explicitly nulled a field. These exercise the guards through the
 * public `parseProgram` entry point, the way a real model reply would.
 */
describe("parseProgram rejects sets/benchmarks with null numeric fields", () => {
  const baseWorkout = (sets: unknown[]) => ({
    workouts: [{ name: "Day 1", exercises: [{ name: "Squat", sets }] }],
    benchmark: { exercise: "Squat", metric: "reps", target: 20, unit: "reps" },
  });

  it("drops a set that is neither rep-based nor timed ({reps: null, durationSec: null})", () => {
    const prog = parseProgram(
      baseWorkout([
        { reps: null, durationSec: null, restSec: 60 },
        { reps: 10, restSec: 60 },
      ]),
    );
    // The garbage set is dropped, not turned into "1 rep / 1 second" — the
    // exercise still has exactly the one real set.
    expect(prog).not.toBeNull();
    expect(prog!.workouts[0]!.workout.exercises[0]!.sets).toHaveLength(1);
    expect(prog!.workouts[0]!.workout.exercises[0]!.sets[0]!.reps).toBe(10);
  });

  it("drops an exercise (and fails the program) whose only set has null reps/duration", () => {
    const prog = parseProgram(baseWorkout([{ reps: null, durationSec: null }]));
    expect(prog).toBeNull();
  });

  it("rejects a benchmark with a null target instead of treating it as 0.1", () => {
    const prog = parseProgram({
      workouts: [{ name: "Day 1", exercises: [{ name: "Squat", sets: [{ reps: 10, restSec: 60 }] }] }],
      benchmark: { exercise: "Squat", metric: "reps", target: null, unit: "reps" },
    });
    // No usable benchmark survives, so the whole program is rejected — same
    // as if `benchmark` had been omitted entirely.
    expect(prog).toBeNull();
  });
});
