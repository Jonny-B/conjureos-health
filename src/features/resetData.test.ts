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
      "diary", "weights", "workouts", "askHealth",
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
    expect(calls).toContain("rm:ask-health.json");
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

/**
 * Older versions kept the removed trainer's memory in `coach.json`, which
 * nothing reads, and the conversation in `coach-chat.json`, which Ask Health
 * reads while it has no file of its own. Nothing deletes a user's stored data
 * for them, so both stay on disk until the user clears them here.
 */
describe("stored files from older versions", () => {
  it("offers Ask Health as its own row, and it clears both conversation files", async () => {
    const { clearHistory } = await import("./resetData");
    const row = HISTORY_ITEMS.find((i) => i.kind === "askHealth");
    expect(row?.label).toBe("Ask Health");
    expect(row?.desc).toMatch(/Find patterns/);
    await clearHistory("askHealth");
    // Ask Health's own file, and the older one it falls back to, which would
    // otherwise bring the cleared conversation back.
    expect(calls).toEqual(["rm:ask-health.json", "rm:coach-chat.json"]);
  });

  it("clears the old trainer memory with Current plan, the only row that reaches it", async () => {
    const { clearHistory } = await import("./resetData");
    await clearHistory("plan");
    expect(calls).toEqual(["plan", "rm:coach.json"]);
  });

  it("names no coach and no old name in any row a person reads", () => {
    for (const i of HISTORY_ITEMS) {
      expect(`${i.kind} ${i.label} ${i.desc}`).not.toMatch(/coach|trainer|food questions|about food/i);
    }
  });
});

describe("visibleHistoryItems", () => {
  it("offers the food and wellbeing rows", () => {
    const kinds = visibleHistoryItems().map((i) => i.kind);
    expect(kinds).toContain("diary");
    expect(kinds).toContain("weights");
    expect(kinds).toContain("sleep");
    expect(kinds).toContain("water");
    expect(kinds).toContain("symptoms");
    expect(kinds).toContain("askHealth");
  });

  it("offers the exercise on the ring, which the user can see and add to", () => {
    expect(visibleHistoryItems().map((i) => i.kind)).toContain("workouts");
  });

  it("offers every row: no slice is hidden from Settings", () => {
    expect(visibleHistoryItems()).toEqual(HISTORY_ITEMS);
  });
});
