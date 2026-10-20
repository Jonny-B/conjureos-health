import { describe, expect, it } from "vitest";
import { findPatternsAsk, loadedFor, type LoadedRange } from "./findPatterns";
import type { DayJournal } from "../journal";

const food = (date: string, label: string): DayJournal => ({
  date,
  events: [{ id: label, kind: "food", label, at: Date.parse(`${date}T12:00:00Z`), timed: true, editable: true }],
  totals: { calories: 300, protein: 10, carbs: 0, fat: 0, waterMl: 0, exerciseKcal: 0,
            sleepMinutes: 0, symptomCount: 0, foodCount: 1 },
});

const SEPT: LoadedRange = { from: "2026-09-01", to: "2026-09-30", days: [food("2026-09-03", "Aged cheddar")] };
const OCT: LoadedRange = { from: "2026-10-01", to: "2026-10-31", days: [food("2026-10-05", "Pumpkin soup")] };

/**
 * A press of "Find patterns" (ConjureOS #1163): it asks as a Find patterns
 * run, never from the home card, and only with the month on screen.
 */
describe("findPatternsAsk", () => {
  it("asks as a Find patterns run, a new one each press", () => {
    const a = findPatternsAsk(SEPT, SEPT.from, SEPT.to, { includeNotes: false });
    const b = findPatternsAsk(SEPT, SEPT.from, SEPT.to, { includeNotes: false });
    expect(a?.from.kind).toBe("patterns");
    expect(b?.from.kind).toBe("patterns");
    expect(a?.from).not.toEqual(b?.from);
  });

  it("carries the month on screen, under its own name", () => {
    const a = findPatternsAsk(SEPT, SEPT.from, SEPT.to, { includeNotes: false });
    expect(a?.question).toContain("Here is my journal for 2026-09-01 to 2026-09-30.");
    expect(a?.question).toContain("Aged cheddar");
  });

  it("sends nothing while the days on hand are another month", () => {
    // Moved to September; October's days are still the last ones read.
    expect(findPatternsAsk(OCT, SEPT.from, SEPT.to, { includeNotes: false })).toBeNull();
    expect(findPatternsAsk(null, SEPT.from, SEPT.to, { includeNotes: false })).toBeNull();
  });
});

describe("loadedFor", () => {
  it("is the days on hand only when they were read for the range shown", () => {
    expect(loadedFor(SEPT, SEPT.from, SEPT.to)).toBe(SEPT);
    expect(loadedFor(OCT, SEPT.from, SEPT.to)).toBeNull();
    expect(loadedFor(null, SEPT.from, SEPT.to)).toBeNull();
  });
});
