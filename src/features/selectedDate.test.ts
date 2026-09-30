import { describe, it, expect } from "vitest";
import { exerciseFor, msUntilNextMidnight, pinSelectedDate, resolveSelectedDate } from "./selectedDate";

describe("following today across midnight", () => {
  it("a user on today keeps following it when the day changes", () => {
    const selected = pinSelectedDate("2026-08-10", "2026-08-10");
    expect(selected).toBeNull();
    expect(resolveSelectedDate(selected, "2026-08-10")).toBe("2026-08-10");
    expect(resolveSelectedDate(selected, "2026-08-11")).toBe("2026-08-11");
  });

  it("a date the user navigated to does not jump at midnight", () => {
    const selected = pinSelectedDate("2026-08-09", "2026-08-10");
    expect(selected).toBe("2026-08-09");
    expect(resolveSelectedDate(selected, "2026-08-11")).toBe("2026-08-09");
  });
});

describe("msUntilNextMidnight", () => {
  it("lands just after the next local midnight", () => {
    const now = new Date(2026, 7, 10, 23, 59, 0);
    expect(msUntilNextMidnight(now)).toBe(60_000 + 1000);
  });

  it("is about a day just after midnight", () => {
    const now = new Date(2026, 7, 10, 0, 0, 1);
    const ms = msUntilNextMidnight(now);
    expect(ms).toBeGreaterThan(23 * 3600_000);
    expect(ms).toBeLessThanOrEqual(25 * 3600_000 + 1000);
  });
});

describe("exerciseFor", () => {
  it("shows 0 for a new date until its own burn has loaded", () => {
    const day = { date: "2026-08-10", calories: 400 };
    expect(exerciseFor(day, "2026-08-10")).toBe(400);
    expect(exerciseFor(day, "2026-08-09")).toBe(0);
    expect(exerciseFor(null, "2026-08-09")).toBe(0);
  });
});
