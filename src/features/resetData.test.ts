import { describe, it, expect, vi, beforeEach } from "vitest";
import { HISTORY_ITEMS, clearAllHistories, visibleHistoryItems, type HistoryKind } from "./resetData";

const calls: string[] = [];
const repo = {
  clearDiary: async () => void calls.push("diary"),
  clearWeights: async () => void calls.push("weights"),
  clearWorkoutHistory: async () => void calls.push("workouts"),
  clearSleep: async () => void calls.push("sleep"),
  clearWater: async () => void calls.push("water"),
  clearSymptoms: async () => void calls.push("symptoms"),
  clearPlan: async () => void calls.push("plan"),
};
vi.mock("../data/repository", () => ({ getRepository: async () => repo }));
vi.mock("../bridge/vfs", () => ({
  vfs: { rm: async (p: string) => void calls.push(`rm:${p}`) },
}));

beforeEach(() => {
  calls.length = 0;
});

/**
 * The bug this guards: sleep, water and symptoms shipped with storage but no
 * Settings row, so they were unclearable AND survived "Clear all history" —
 * which iterates this very list. Any future slice hits the same trap.
 */
describe("every clearable slice is actually offered", () => {
  it("lists a row for each HistoryKind", () => {
    const listed = new Set(HISTORY_ITEMS.map((i) => i.kind));
    const known: HistoryKind[] = [
      "diary", "weights", "workouts", "coach", "coachChat",
      "sleep", "water", "symptoms", "planHistory", "plan",
    ];
    for (const k of known) expect(listed.has(k)).toBe(true);
    expect(listed.size).toBe(known.length);
  });

  it("gives every row a label and a description", () => {
    for (const i of HISTORY_ITEMS) {
      expect(i.label.length).toBeGreaterThan(0);
      expect(i.desc.length).toBeGreaterThan(0);
    }
  });
});

describe("clearAllHistories", () => {
  it("really does clear everything, including the wellbeing slices", async () => {
    await clearAllHistories();
    for (const kind of ["diary", "weights", "workouts", "sleep", "water", "symptoms", "plan"]) {
      expect(calls).toContain(kind);
    }
    // The VFS-backed slices go too.
    expect(calls).toContain("rm:coach.json");
    expect(calls).toContain("rm:coach-chat.json");
    expect(calls).toContain("rm:plan-archive.json");
    expect(calls).toContain("rm:food-cache.json");
  });

  it("covers every kind in the list, not a hand-maintained subset", async () => {
    await clearAllHistories();
    // One clear per row (some rows clear more than one thing, hence >=).
    expect(calls.length).toBeGreaterThanOrEqual(HISTORY_ITEMS.length);
  });
});

describe("visibleHistoryItems", () => {
  it("still offers the wellbeing rows while the coach is paused", () => {
    const kinds = visibleHistoryItems().map((i) => i.kind);
    expect(kinds).toContain("sleep");
    expect(kinds).toContain("water");
    expect(kinds).toContain("symptoms");
  });

  it("hides only the paused coach + workout slices", () => {
    const kinds = visibleHistoryItems().map((i) => i.kind);
    expect(kinds).not.toContain("coach");
    expect(kinds).not.toContain("workouts");
  });
});
