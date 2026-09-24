import { describe, it, expect } from "vitest";
import { weekToDate } from "./exercise";

/**
 * The weekly movement goal counts days in the CURRENT week only, and only days
 * that have already happened — "2 of 3 this week" must never borrow from last
 * week or count ahead.
 */
describe("weekToDate", () => {
  it("starts the week on Monday", () => {
    // 2026-08-19 is a Wednesday.
    expect(weekToDate("2026-08-19")).toEqual(["2026-08-17", "2026-08-18", "2026-08-19"]);
  });

  it("treats Sunday as the END of the week, not the start", () => {
    // 2026-08-23 is a Sunday — a Sunday-start week would return just itself.
    const week = weekToDate("2026-08-23");
    expect(week).toHaveLength(7);
    expect(week[0]).toBe("2026-08-17");
    expect(week[6]).toBe("2026-08-23");
  });

  it("returns a single day on Monday itself", () => {
    expect(weekToDate("2026-08-17")).toEqual(["2026-08-17"]);
  });

  it("never runs past the given day", () => {
    const week = weekToDate("2026-08-19");
    expect(week[week.length - 1]).toBe("2026-08-19");
  });
});
