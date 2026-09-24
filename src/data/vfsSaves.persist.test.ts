import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { ExerciseExplainer, Plan } from "../types";
import { vfs } from "../bridge/vfs";
import { loadMemory, recordPlanStarted, remember } from "../features/coach/memory";
import { saveUserExplainer } from "../features/explainers/resolve";
import { SAVE_FAILED_EVENT, persist } from "./saveFailure";

// Coach memory, the plan-started record and the user's own explanations live
// in the app's VFS, which is the same on every backend.

function installWindow(): string[] {
  const seen: string[] = [];
  const events = new EventTarget();
  events.addEventListener(SAVE_FAILED_EVENT, (e) =>
    seen.push((e as CustomEvent<{ message: string }>).detail.message),
  );
  (globalThis as unknown as { window: unknown }).window = events;
  return seen;
}

const plan = {
  id: "p1",
  mode: "eat_better",
  durationWeeks: 2,
  startDate: "2026-09-24",
  endDate: "2026-10-07",
  goals: [],
} as unknown as Plan;

const explainer: ExerciseExplainer = {
  exerciseKey: "goblet-squat",
  howTo: "Hold the weight at your chest and sit down between your heels.",
  worksMuscles: ["quads", "glutes"],
  source: "user",
};

describe("VFS saves persist and report failures", () => {
  let seen: string[];
  beforeEach(async () => {
    seen = installWindow();
    await vfs.write("coach.json", "");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("saves coach memory", async () => {
    await remember({ notes: ["Trains early"] });
    expect((await loadMemory()).notes).toContain("Trains early");
    expect(JSON.parse(await vfs.read("coach.json")).notes).toContain("Trains early");
    expect(seen).toEqual([]);
  });

  it("saves the plan-started record", async () => {
    await recordPlanStarted(plan, null);
    expect((await loadMemory()).events[0]?.kind).toBe("plan_started");
  });

  it("tells the user when coach memory or the plan-started record does not save", async () => {
    vi.spyOn(vfs, "write").mockRejectedValue(new Error("disk full"));
    await remember({ notes: ["Knee is cranky"] });
    await recordPlanStarted(plan, null);
    expect(seen).toEqual([
      "We couldn't save what your coach remembers. Please try again.",
      "We couldn't save what your coach remembers. Please try again.",
    ]);
  });

  it("saves your own explanation", async () => {
    await saveUserExplainer(explainer);
    const stored = JSON.parse(await vfs.read("explainers/user/goblet-squat.json"));
    expect(stored.howTo).toBe(explainer.howTo);
  });

  it("tells the user when your explanation does not save", async () => {
    vi.spyOn(vfs, "write").mockRejectedValue(new Error("disk full"));
    expect(await persist("your explanation", saveUserExplainer(explainer))).toBe(false);
    expect(seen).toEqual(["We couldn't save your explanation. Please try again."]);
  });
});
