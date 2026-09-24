import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../bridge/health", () => ({ readWorkouts: vi.fn(async () => []) }));

import { readWorkouts, type WorkoutBurn } from "../bridge/health";
import { __resetRepository, getRepository } from "../data/repository";
import {
  exerciseCaloriesForDate,
  listCompletedWorkouts,
  excludeWearable,
  restoreWearable,
  setWearableKcal,
  setSessionKcal,
  removeSession,
  wearableKey,
  addManualExercise,
} from "./exercise";
import type { WorkoutSession } from "../types";

const DATE = "2026-08-02";
const mockReadWorkouts = readWorkouts as unknown as ReturnType<typeof vi.fn>;

const wear = (over: Partial<WorkoutBurn> = {}): WorkoutBurn => ({
  workoutType: "running",
  start: Date.parse(`${DATE}T08:00:00Z`),
  end: Date.parse(`${DATE}T08:30:00Z`),
  caloriesBurned: 250,
  source: "Apple Watch",
  ...over,
});
const session = (over: Partial<WorkoutSession> = {}): WorkoutSession => ({
  id: "s1",
  date: DATE,
  completedAt: `${DATE}T09:00:00Z`,
  caloriesBurned: 150,
  workoutName: "Full body",
  ...over,
});

beforeEach(() => {
  __resetRepository();
  mockReadWorkouts.mockResolvedValue([]);
});

describe("exercise combine (wearable + in-app)", () => {
  it("ADDS wearable and in-app calories together", async () => {
    mockReadWorkouts.mockResolvedValue([wear()]);
    const repo = await getRepository();
    await repo.saveWorkoutSession(session());
    expect(await exerciseCaloriesForDate(DATE)).toBe(400); // 250 + 150
    const items = await listCompletedWorkouts(DATE);
    expect(items).toHaveLength(2);
    expect(items.some((i) => i.source === "wearable")).toBe(true);
    expect(items.some((i) => i.source === "app")).toBe(true);
  });

  it("excludes a removed wearable workout from the total but keeps it listed", async () => {
    mockReadWorkouts.mockResolvedValue([wear()]);
    const repo = await getRepository();
    await repo.saveWorkoutSession(session());
    const key = wearableKey(wear());
    await excludeWearable(DATE, key);
    expect(await exerciseCaloriesForDate(DATE)).toBe(150); // wearable no longer counted
    const items = await listCompletedWorkouts(DATE);
    expect(items.find((i) => i.key === key)?.excluded).toBe(true);
    // …and restoring brings it back.
    await restoreWearable(DATE, key);
    expect(await exerciseCaloriesForDate(DATE)).toBe(400);
  });

  it("applies a wearable calorie override", async () => {
    mockReadWorkouts.mockResolvedValue([wear()]);
    const key = wearableKey(wear());
    await setWearableKcal(DATE, key, 300);
    expect(await exerciseCaloriesForDate(DATE)).toBe(300);
  });

  it("edits and deletes an in-app session", async () => {
    const repo = await getRepository();
    await repo.saveWorkoutSession(session());
    await setSessionKcal("s1", 220);
    expect(await exerciseCaloriesForDate(DATE)).toBe(220);
    await removeSession("s1");
    expect(await exerciseCaloriesForDate(DATE)).toBe(0);
  });
});

import { manualExerciseProblem } from "./exercise";

describe("manualExerciseProblem", () => {
  it("accepts a named exercise with calories", () => {
    expect(manualExerciseProblem({ name: "Walk", calories: 150, durationMin: 30 })).toBeNull();
  });
  it("asks for what is missing", () => {
    expect(manualExerciseProblem({ name: " ", calories: 100 })).toMatch(/name/i);
    expect(manualExerciseProblem({ name: "Walk" })).toMatch(/calories/i);
    expect(manualExerciseProblem({ name: "Walk", calories: 9000 })).toMatch(/5,000/);
  });
});

describe("where an entry came from", () => {
  it("adds a hand-entered exercise to the day's calories, labelled as the user's", async () => {
    await addManualExercise(DATE, { name: "Evening walk", durationMin: 30, calories: 120 });
    expect(await exerciseCaloriesForDate(DATE)).toBe(120);
    expect(await listCompletedWorkouts(DATE)).toMatchObject([
      { name: "Evening walk", kcal: 120, durationSec: 1800, sourceLabel: "Added by you" },
    ]);
  });

  it("labels an entry another app logged, and one from the old workout player", async () => {
    const repo = await getRepository();
    await repo.saveWorkoutSession(session({ id: "a", source: "logWorkout", workoutName: "Running" }));
    await repo.saveWorkoutSession(session({ id: "b", completedAt: `${DATE}T07:00:00Z` }));
    const labels = Object.fromEntries((await listCompletedWorkouts(DATE)).map((i) => [i.key, i.sourceLabel]));
    expect(labels).toEqual({ a: "From an app", b: "In-app" });
  });
});
