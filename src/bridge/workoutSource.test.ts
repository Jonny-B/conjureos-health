/**
 * Reading workouts from a linked fitness app (the `workoutSource` need). The
 * provider is another app, so these tests are mostly about what it can NOT do:
 * break the ring, slip in malformed data, or cost a call per date.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { linkedWorkoutsForDate, resetWorkoutSourceCache } from "./workoutSource";

// 2026-09-30 is a Wednesday; its week runs Mon 2026-09-28 to Sun 2026-10-04.
const WED = "2026-09-30";
const MON = "2026-09-28";
const SUN = "2026-10-04";

const fitness = { appPath: "/apps/conjure-fitness", displayName: "Conjure Fitness", action: "listWorkouts", binding: "exact" as const };

let discover: ReturnType<typeof vi.fn>;
let invoke: ReturnType<typeof vi.fn>;

function install(bridge: Record<string, unknown> | undefined) {
  (globalThis as { window?: unknown }).window = bridge === undefined ? {} : { __conjureos: { actions: bridge } };
}

const item = (over: Record<string, unknown> = {}) => ({
  id: "w1",
  date: WED,
  name: "Morning Run",
  type: "cardio",
  durationMin: 30,
  caloriesBurned: 320,
  caloriesEstimated: false,
  completedAt: `${WED}T07:30:00.000Z`,
  ...over,
});

beforeEach(() => {
  resetWorkoutSourceCache();
  discover = vi.fn(async () => [fitness]);
  invoke = vi.fn(async () => ({ from: MON, to: SUN, workouts: [item()] }));
  install({ discover, invoke });
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("linkedWorkoutsForDate", () => {
  it("reads the provider's workouts for the day, keyed per app", async () => {
    const out = await linkedWorkoutsForDate(WED);
    expect(out).toEqual([
      {
        key: "linked:/apps/conjure-fitness:w1",
        id: "w1",
        appName: "Conjure Fitness",
        date: WED,
        name: "Morning Run",
        caloriesBurned: 320,
        durationSec: 1800,
        completedAtMs: Date.parse(`${WED}T07:30:00.000Z`),
      },
    ]);
    expect(discover).toHaveBeenCalledWith("workoutSource");
    expect(invoke).toHaveBeenCalledWith(
      "/apps/conjure-fitness",
      "listWorkouts",
      { from: MON, to: SUN, limit: 100 },
      expect.objectContaining({ normalize: "workoutSource" }),
    );
  });

  it("asks once per week, not once per date", async () => {
    invoke.mockResolvedValue({ workouts: [item(), item({ id: "w2", date: MON })] });
    expect(await linkedWorkoutsForDate(WED)).toHaveLength(1);
    expect(await linkedWorkoutsForDate(MON)).toHaveLength(1);
    expect(await linkedWorkoutsForDate("2026-10-01")).toHaveLength(0);
    expect(invoke).toHaveBeenCalledTimes(1);
    await linkedWorkoutsForDate("2026-10-05"); // next week
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("drops malformed items and clamps the rest", async () => {
    invoke.mockResolvedValue({
      workouts: [
        item({ id: "" }),
        item({ id: "bad-date", date: "30/09/2026" }),
        item({ id: "no-kcal", caloriesBurned: "320" }),
        item({ id: "huge", caloriesBurned: 999999, name: "x".repeat(200), durationMin: -5 }),
        item({ id: "w1" }),
        item({ id: "w1" }), // duplicate
        "not an object",
      ],
    });
    const out = await linkedWorkoutsForDate(WED);
    expect(out.map((w) => w.key)).toEqual(["linked:/apps/conjure-fitness:huge", "linked:/apps/conjure-fitness:w1"]);
    const huge = out[0]!;
    expect(huge.caloriesBurned).toBe(5000);
    expect(huge.name).toHaveLength(60);
    expect(huge.durationSec).toBeUndefined();
  });

  it("prefers an exact match over an AI-mapped one", async () => {
    discover.mockResolvedValue([
      { appPath: "/apps/other", displayName: "Other", action: "workouts", binding: "ai-mapped", confidence: 0.9 },
      fitness,
    ]);
    await linkedWorkoutsForDate(WED);
    expect(invoke.mock.calls[0]![0]).toBe("/apps/conjure-fitness");
  });

  it("returns nothing, quietly, when there is no provider or no bridge", async () => {
    discover.mockResolvedValue([]);
    expect(await linkedWorkoutsForDate(WED)).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();

    resetWorkoutSourceCache();
    install({ invoke }); // a host without discover
    expect(await linkedWorkoutsForDate(WED)).toEqual([]);

    resetWorkoutSourceCache();
    install(undefined);
    expect(await linkedWorkoutsForDate(WED)).toEqual([]);

    resetWorkoutSourceCache();
    delete (globalThis as { window?: unknown }).window;
    expect(await linkedWorkoutsForDate(WED)).toEqual([]);
  });

  it("never throws when the provider fails or answers junk", async () => {
    invoke.mockRejectedValue(Object.assign(new Error("gone"), { code: "TARGET_NOT_RUNNING" }));
    expect(await linkedWorkoutsForDate(WED)).toEqual([]);

    resetWorkoutSourceCache();
    invoke.mockResolvedValue(null);
    expect(await linkedWorkoutsForDate(WED)).toEqual([]);

    resetWorkoutSourceCache();
    discover.mockRejectedValue(new Error("connections off"));
    expect(await linkedWorkoutsForDate(WED)).toEqual([]);
  });

  it("ignores a date that isn't one", async () => {
    expect(await linkedWorkoutsForDate("today")).toEqual([]);
    expect(discover).not.toHaveBeenCalled();
  });

  it("does not cache TIMEOUT errors, so the next read retries", async () => {
    // First call: timeout error
    const timeoutError = Object.assign(new Error("Request timed out"), { code: "TIMEOUT" });
    invoke.mockRejectedValueOnce(timeoutError);
    expect(await linkedWorkoutsForDate(WED)).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(1);

    // Second call within cache window: should retry, not return cached []
    invoke.mockResolvedValueOnce({ workouts: [item()] });
    expect(await linkedWorkoutsForDate(WED)).toHaveLength(1);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("caches non-TIMEOUT errors for the failure cache period", async () => {
    // First call: non-timeout error
    const error = Object.assign(new Error("Provider error"), { code: "PROVIDER_ERROR" });
    invoke.mockRejectedValueOnce(error);
    expect(await linkedWorkoutsForDate(WED)).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(1);

    // Second call immediately after: should return cached []
    invoke.mockResolvedValueOnce({ workouts: [item()] });
    expect(await linkedWorkoutsForDate(WED)).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(1); // No second invoke call
  });

  it("handles timeout errors with message pattern matching", async () => {
    // Test with 'timed out' message pattern
    invoke.mockRejectedValueOnce(new Error("Request timed out"));
    expect(await linkedWorkoutsForDate(WED)).toEqual([]);

    // Second call should retry
    invoke.mockResolvedValueOnce({ workouts: [item()] });
    expect(await linkedWorkoutsForDate(WED)).toHaveLength(1);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("gives the invoke a budget that covers the consent dialog", async () => {
    await linkedWorkoutsForDate(WED);
    const opts = invoke.mock.calls[0]![3] as { timeoutMs: number };
    expect(opts.timeoutMs).toBeGreaterThanOrEqual(30_000);
  });
});
