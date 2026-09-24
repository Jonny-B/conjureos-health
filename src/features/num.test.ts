import { describe, it, expect } from "vitest";
import { clamp, toIntInRange, toNumInRange } from "./num";

/**
 * `toNumInRange` / `toIntInRange` coerce values that crossed a network or
 * model boundary. The bug this guards against: `Number(v)` treats `null`,
 * `""`, `[]`, and `false` as `0` — a legitimate, finite number — so each one
 * used to sail past `Number.isFinite` and get clamped to `min` instead of
 * being rejected. A model reply of `{ reps: null }` became "1 rep" instead of
 * failing the caller's `== null` guard. Every case below is a value the
 * docstring promises returns null; none of them may become a number.
 */
describe("toIntInRange — non-numeric input never coerces to a number", () => {
  const NON_NUMERIC: [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
    ["a whitespace-only string", "   "],
    ["an empty array", []],
    ["a non-empty array", [1, 2]],
    ["false", false],
    ["true", true],
    ["a plain object", {}],
    ["a non-numeric string", "abc"],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
  ];

  for (const [label, v] of NON_NUMERIC) {
    it(`returns null for ${label}`, () => {
      expect(toIntInRange(v, 1, 100)).toBeNull();
    });
  }

  it("still accepts a genuine number and a numeric string", () => {
    expect(toIntInRange(5, 1, 100)).toBe(5);
    expect(toIntInRange("5", 1, 100)).toBe(5);
    expect(toIntInRange(" 5 ", 1, 100)).toBe(5); // model JSON can carry stray whitespace
  });
});

describe("toIntInRange / toNumInRange — clamping an in-range-able number is unchanged", () => {
  // The documented, intended contract: a real number outside [min, max] is
  // clamped to the nearest bound, not rejected. Bug 1's fix must not touch
  // this — reps/rest-seconds/Plan-screen fields all depend on it.
  it("clamps a number below min up to min", () => {
    expect(toIntInRange(0, 1, 100)).toBe(1);
    expect(toIntInRange(-5, 1, 100)).toBe(1);
  });

  it("clamps a number above max down to max", () => {
    expect(toIntInRange(9999, 1, 100)).toBe(100);
  });

  it("rounds before clamping so a fractional bound still yields an in-range int", () => {
    expect(toIntInRange(0.6, 1, 100)).toBe(1);
  });

  it("toNumInRange clamps without rounding", () => {
    expect(toNumInRange(500.5, 0, 500)).toBe(500);
    expect(toNumInRange(-1, 0, 500)).toBe(0);
    expect(toNumInRange(12.34, 0, 500)).toBe(12.34);
  });
});

describe("clamp", () => {
  it("constrains an already-finite number to [min, max]", () => {
    expect(clamp(5, 1, 10)).toBe(5);
    expect(clamp(-5, 1, 10)).toBe(1);
    expect(clamp(50, 1, 10)).toBe(10);
  });
});
