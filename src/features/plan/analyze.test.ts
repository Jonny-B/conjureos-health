import { describe, it, expect } from "vitest";
import type { WorkoutProgram } from "../../types";
import { buildAnalysisPrompt } from "./analyze";

const program: WorkoutProgram = {
  workouts: [{ id: "pw1", group: 1, workout: { id: "w1", name: "A", exercises: [{ id: "e1", name: "Push-Ups", sets: [{ reps: 10, durationSec: null, restSec: 60 }] }] } }],
  benchmarks: [],
  currentGroup: 1,
  groupsPerCycle: 4,
};

describe("buildAnalysisPrompt preferences", () => {
  it("includes the coach-feedback block so progression honors it", () => {
    const out = buildAnalysisPrompt(program, [], "Preferences/constraints:\n  - hates burpees");
    expect(out).toMatch(/HONOR these/);
    expect(out).toMatch(/hates burpees/);
  });
  it("omits the block when there are no preferences", () => {
    const out = buildAnalysisPrompt(program, []);
    expect(out).not.toMatch(/HONOR these/);
  });
});
