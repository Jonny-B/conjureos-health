import { describe, it, expect } from "vitest";
import { COACH_AND_WORKOUTS_ENABLED } from "./flags";
import { HISTORY_ITEMS, visibleHistoryItems } from "./resetData";

/**
 * The coach + workout pause is a product decision, so it gets a test: the whole
 * point is that the feature is HIDDEN, not deleted, and that the data behind it
 * survives to be revived.
 */
describe("coach + workout pause", () => {
  it("is off — the app ships as a nutrition-only tracker", () => {
    expect(COACH_AND_WORKOUTS_ENABLED).toBe(false);
  });

  it("hides the coach + workout reset rows while paused", () => {
    const kinds = visibleHistoryItems().map((i) => i.kind);
    expect(kinds).not.toContain("coach");
    expect(kinds).not.toContain("workouts");
  });

  it("still offers the nutrition-side resets", () => {
    const kinds = visibleHistoryItems().map((i) => i.kind);
    expect(kinds).toContain("diary");
    expect(kinds).toContain("weights");
    expect(kinds).toContain("planHistory");
  });

  it("hides rows without removing them — every slice is still clearable", () => {
    // visibleHistoryItems only filters the UI; HISTORY_ITEMS (what clearAll
    // walks) must keep every kind, or paused data would become unwipeable.
    const all = HISTORY_ITEMS.map((i) => i.kind);
    expect(all).toContain("coach");
    expect(all).toContain("workouts");
    expect(visibleHistoryItems().length).toBeLessThan(HISTORY_ITEMS.length);
  });
});
