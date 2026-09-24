import { describe, it, expect } from "vitest";
import type { Profile, Workout, WorkoutSession } from "../types";
import { estimateWorkoutBurn, sessionMinutes } from "./calories";

const profile = (weightKg: number): Profile =>
  ({ sex: "male", age: 40, heightCm: 180, weightKg, activityLevel: "moderate", direction: "maintain", units: "metric" });

const strengthWorkout: Workout = { id: "w1", name: "Full body", exercises: [] };
const runWorkout: Workout = { id: "w2", name: "Run", kind: "run", exercises: [] };

const baseSession = (over: Partial<WorkoutSession>): WorkoutSession => ({
  id: "s1",
  date: "2026-07-30",
  planned: [],
  actual: [],
  reprompts: [],
  completedAt: "2026-07-30T10:00:00Z",
  ...over,
});

describe("estimateWorkoutBurn", () => {
  it("uses the local MET formula for a strength session (MET 5 × kg × hours)", async () => {
    const session = baseSession({ durationSec: 1800 }); // 30 min
    const res = await estimateWorkoutBurn(session, strengthWorkout, profile(80));
    // 5 × 80 × 0.5 = 200
    expect(res).toEqual({ kcal: 200, method: "formula" });
  });

  it("scales a run's MET by pace from distance + duration", async () => {
    // 5 km in 30 min = ~6.2 mph → MET 10; 10 × 70 × 0.5 = 350
    const session = baseSession({ durationSec: 1800, cardio: { distanceKm: 5, durationSec: 1800, source: "manual" } });
    const res = await estimateWorkoutBurn(session, runWorkout, profile(70));
    expect(res.method).toBe("formula");
    expect(res.kcal).toBe(350);
  });

  it("falls back to a coarse per-minute default when bodyweight is unknown (no AI in test)", async () => {
    const session = baseSession({ durationSec: 1200 }); // 20 min
    const res = await estimateWorkoutBurn(session, strengthWorkout, null);
    // ~6 kcal/min × 20 = 120
    expect(res).toEqual({ kcal: 120, method: "default" });
  });

  it("returns 0/default when there is no duration to estimate from", async () => {
    const res = await estimateWorkoutBurn(baseSession({}), strengthWorkout, profile(80));
    expect(res.kcal).toBe(0);
  });

  it("sessionMinutes prefers durationSec, else cardio duration", () => {
    expect(sessionMinutes(baseSession({ durationSec: 600 }))).toBe(10);
    expect(sessionMinutes(baseSession({ cardio: { distanceKm: 2, durationSec: 300, source: "manual" } }))).toBe(5);
    expect(sessionMinutes(baseSession({}))).toBe(0);
  });
});
