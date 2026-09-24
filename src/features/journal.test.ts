import { describe, it, expect, vi, beforeEach } from "vitest";
import { datesBetween, isEmptyDay, summarizeRange, type DayJournal } from "./journal";

vi.mock("./exercise", () => ({ listCompletedWorkouts: async () => [] }));

const day = (over: Partial<DayJournal> & { date: string }): DayJournal => ({
  events: [],
  totals: { calories: 0, protein: 0, carbs: 0, fat: 0, waterMl: 0, exerciseKcal: 0,
            sleepMinutes: 0, symptomCount: 0, foodCount: 0 },
  ...over,
});

describe("datesBetween", () => {
  it("is inclusive on both ends", () => {
    expect(datesBetween("2026-08-09", "2026-08-11")).toEqual(["2026-08-09", "2026-08-10", "2026-08-11"]);
  });
  it("handles a single day", () => {
    expect(datesBetween("2026-08-09", "2026-08-09")).toEqual(["2026-08-09"]);
  });
  it("crosses a month boundary", () => {
    expect(datesBetween("2026-01-30", "2026-02-02")).toEqual(
      ["2026-01-30", "2026-01-31", "2026-02-01", "2026-02-02"]);
  });
  it("returns nothing for a backwards range instead of spinning", () => {
    expect(datesBetween("2026-08-11", "2026-08-09")).toEqual([]);
  });
  it("is bounded so a runaway range can't hang the app", () => {
    expect(datesBetween("2000-01-01", "2030-01-01").length).toBeLessThanOrEqual(800);
  });
});

describe("summarizeRange and symptom notes", () => {
  const withNote = (): DayJournal =>
    day({
      date: "2026-08-09",
      events: [
        {
          id: "s1",
          kind: "symptom",
          label: "Heartburn",
          detail: "3/5",
          note: "after the antibiotics",
          at: Date.parse("2026-08-09T21:40:00.000Z"),
          timed: true,
          editable: true,
        },
      ],
    });

  it("holds back the free-text note by default, but keeps the severity", () => {
    const out = summarizeRange([withNote()]);
    expect(out).toContain("Heartburn at");
    expect(out).toContain("(3/5)");
    expect(out).not.toContain("antibiotics");
  });

  it("includes the note only when the user opted in", () => {
    const out = summarizeRange([withNote()], { includeNotes: true });
    expect(out).toContain("antibiotics");
  });
});

describe("summarizeRange", () => {
  beforeEach(() => vi.useRealTimers());

  it("skips days with nothing recorded", () => {
    expect(summarizeRange([day({ date: "2026-08-09" })])).toBe("");
  });

  it("keeps symptom TIMES, because that is usually the question", () => {
    const at = new Date(2026, 7, 10, 21, 30).getTime();
    const d = day({
      date: "2026-08-10",
      events: [{ id: "y1", editable: true, at, timed: true, kind: "symptom", label: "Heartburn", detail: "3/5" }],
      totals: { calories: 0, protein: 0, carbs: 0, fat: 0, waterMl: 0, exerciseKcal: 0,
                sleepMinutes: 0, symptomCount: 1, foodCount: 0 },
    });
    const out = summarizeRange([d]);
    expect(out).toContain("Heartburn");
    expect(out).toContain("(3/5)");
    expect(out).toMatch(/at \d{2}:\d{2}/);
  });

  it("names foods so a pattern is findable, but does not time them", () => {
    const d = day({
      date: "2026-08-10",
      events: [
        { id: "f1", editable: true, at: 1, timed: true, kind: "food", label: "Pizza", detail: "800 cal" },
        { id: "f2", editable: true, at: 2, timed: true, kind: "food", label: "Coffee", detail: "5 cal" },
      ],
      totals: { calories: 805, protein: 30, carbs: 90, fat: 35, waterMl: 0, exerciseKcal: 0,
                sleepMinutes: 0, symptomCount: 0, foodCount: 2 },
    });
    const out = summarizeRange([d]);
    expect(out).toContain("ate: Pizza, Coffee");
    expect(out).toContain("805 cal from 2 items");
  });

  it("renders sleep as hours and minutes", () => {
    const d = day({
      date: "2026-08-10",
      events: [{ id: "s1", editable: true, at: 1, timed: true, kind: "sleep", label: "Slept", detail: "7h 30m" }],
      totals: { calories: 0, protein: 0, carbs: 0, fat: 0, waterMl: 0, exerciseKcal: 0,
                sleepMinutes: 450, symptomCount: 0, foodCount: 0 },
    });
    expect(summarizeRange([d])).toContain("slept 7h30m");
  });

  it("caps a very long food list so one day can't eat the prompt", () => {
    const events = Array.from({ length: 30 }, (_, i) => ({
      id: `f${i}`, editable: true, at: i, timed: true as const, kind: "food" as const, label: `Item${i}`,
    }));
    const d = day({
      date: "2026-08-10", events,
      totals: { calories: 100, protein: 0, carbs: 0, fat: 0, waterMl: 0, exerciseKcal: 0,
                sleepMinutes: 0, symptomCount: 0, foodCount: 30 },
    });
    const out = summarizeRange([d]);
    expect(out).toContain("Item11");
    expect(out).not.toContain("Item12");
  });
});

describe("isEmptyDay", () => {
  it("is true only with no events at all", () => {
    expect(isEmptyDay(day({ date: "2026-08-09" }))).toBe(true);
    expect(isEmptyDay(day({ date: "2026-08-09",
      events: [{ id: "w1", editable: true, at: 1, timed: true, kind: "water", label: "Water" }] }))).toBe(false);
  });
});
