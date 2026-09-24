import { describe, it, expect } from "vitest";
import {
  buildSleepEntry,
  clocksOf,
  formatSleep,
  isImplausible,
  parseClock,
  resolveNight,
  sleepMinutes,
  averageSleepMinutes,
} from "./sleep";

/**
 * The point of this module is the date boundary, so most of these are about
 * which DAY each end of the night lands on.
 */
describe("resolveNight", () => {
  it("puts a before-midnight bedtime on the previous day", () => {
    const n = resolveNight("2026-03-10", "23:10", "06:40")!;
    expect(n.bedAt.getDate()).toBe(9);
    expect(n.wakeAt.getDate()).toBe(10);
    expect(n.bedAt.getHours()).toBe(23);
  });

  it("keeps an after-midnight bedtime on the wake day", () => {
    const n = resolveNight("2026-03-10", "00:40", "08:15")!;
    expect(n.bedAt.getDate()).toBe(10);
    expect(n.wakeAt.getDate()).toBe(10);
  });

  it("handles the worst case: bed at 00:00, up at 23:59 the same day", () => {
    const n = resolveNight("2026-03-10", "00:00", "23:59")!;
    expect(n.bedAt.getDate()).toBe(10);
    expect(Math.round((n.wakeAt.getTime() - n.bedAt.getTime()) / 60000)).toBe(1439);
  });

  it("treats identical clocks as a zero-length night, not 24 hours", () => {
    const n = resolveNight("2026-03-10", "07:00", "07:00")!;
    expect(n.bedAt.getTime()).toBe(n.wakeAt.getTime());
  });

  it("crosses a month boundary backwards", () => {
    const n = resolveNight("2026-03-01", "22:30", "06:00")!;
    expect(n.bedAt.getMonth()).toBe(1); // February
    expect(n.bedAt.getDate()).toBe(28);
  });

  it("crosses a year boundary backwards", () => {
    const n = resolveNight("2026-01-01", "23:45", "07:30")!;
    expect(n.bedAt.getFullYear()).toBe(2025);
    expect(n.bedAt.getMonth()).toBe(11);
    expect(n.bedAt.getDate()).toBe(31);
  });

  it("rejects nonsense clocks", () => {
    expect(resolveNight("2026-03-10", "25:00", "07:00")).toBeNull();
    expect(resolveNight("2026-03-10", "23:70", "07:00")).toBeNull();
    expect(resolveNight("2026-03-10", "bedtime", "07:00")).toBeNull();
  });
});

describe("sleepMinutes", () => {
  it("measures a normal night across midnight", () => {
    const e = buildSleepEntry("s1", "2026-03-10", "23:10", "06:40")!;
    expect(sleepMinutes(e)).toBe(450); // 7h30
  });

  it("measures a night that began after midnight", () => {
    const e = buildSleepEntry("s2", "2026-03-10", "01:15", "09:00")!;
    expect(sleepMinutes(e)).toBe(465); // 7h45
  });

  it("reports elapsed time, so a DST night is not off by an hour", () => {
    // Whatever the runner's zone, the two instants define real elapsed time.
    const e = buildSleepEntry("s3", "2026-03-08", "23:00", "07:00")!;
    const elapsed = (new Date(e.wakeAt).getTime() - new Date(e.bedAt).getTime()) / 60000;
    expect(sleepMinutes(e)).toBe(Math.round(elapsed));
  });

  it("never goes negative on corrupt data", () => {
    expect(sleepMinutes({ bedAt: "2026-03-10T08:00:00Z", wakeAt: "2026-03-10T01:00:00Z" })).toBe(0);
    expect(sleepMinutes({ bedAt: "nope", wakeAt: "also nope" })).toBe(0);
  });
});

describe("buildSleepEntry", () => {
  it("files the night under the wake date", () => {
    const e = buildSleepEntry("s4", "2026-03-10", "23:10", "06:40")!;
    expect(e.date).toBe("2026-03-10");
  });

  it("derives the date from the instant, ignoring a bogus wakeDate", () => {
    expect(buildSleepEntry("s5", "not-a-date", "23:00", "07:00")).toBeNull();
  });

  it("round-trips the clock faces for editing", () => {
    const e = buildSleepEntry("s6", "2026-03-10", "23:10", "06:40")!;
    expect(clocksOf(e)).toEqual({ bedClock: "23:10", wakeClock: "06:40" });
  });

  it("keeps quality and note only when given", () => {
    const bare = buildSleepEntry("s7", "2026-03-10", "23:00", "07:00")!;
    expect(bare.quality).toBeUndefined();
    expect(bare.note).toBeUndefined();
    const full = buildSleepEntry("s8", "2026-03-10", "23:00", "07:00", { quality: 4, note: "woke twice" })!;
    expect(full.quality).toBe(4);
    expect(full.note).toBe("woke twice");
  });
});

describe("formatSleep + isImplausible", () => {
  it("formats hours and minutes", () => {
    expect(formatSleep(450)).toBe("7h 30m");
    expect(formatSleep(480)).toBe("8h");
    expect(formatSleep(45)).toBe("45m");
    expect(formatSleep(0)).toBe("");
  });

  it("flags a night long enough to be a mis-entry", () => {
    expect(isImplausible(8 * 60)).toBe(false);
    expect(isImplausible(17 * 60)).toBe(true);
  });
});

describe("averageSleepMinutes", () => {
  it("averages across nights and returns 0 for none", () => {
    const a = buildSleepEntry("a", "2026-03-10", "23:00", "07:00")!; // 480
    const b = buildSleepEntry("b", "2026-03-11", "00:00", "06:00")!; // 360
    expect(averageSleepMinutes([a, b])).toBe(420);
    expect(averageSleepMinutes([])).toBe(0);
  });
});

describe("parseClock", () => {
  it("accepts one- and two-digit hours", () => {
    expect(parseClock("7:05")).toBe(425);
    expect(parseClock("07:05")).toBe(425);
    expect(parseClock(" 23:59 ")).toBe(1439);
  });
});
