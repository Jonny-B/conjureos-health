import { describe, expect, it } from "vitest";
import { isQuantityEdit, nextFoodQuantity, nextWaterMl } from "./JournalEntrySheet";
import { fmtWater, flOzToMl, mlToFlOz } from "../features/water";

// Simulates what the sheet does when it opens: seed `amount` by parsing the
// number back out of the rounded display string, exactly like the
// `startAmount` line in JournalEntrySheet does from `event.detail`.
const displayedAmount = (ml: number, units: "metric" | "imperial"): number =>
  Number(/[\d.]+/.exec(fmtWater(ml, units))?.[0] ?? 0);

describe("nextWaterMl — open, don't touch, save must be a no-op", () => {
  it("never converts an untouched amount, regardless of the drift a round-trip would introduce", () => {
    // These are exactly the corrupting cases from the bug report: displaying
    // then blindly converting back would give 1005 / 237 / 59, not the
    // original. Confirm the drift is real (so this test would have caught
    // the bug), then confirm nextWaterMl refuses to reproduce it.
    for (const ml of [1000, 250, 50]) {
      const shown = displayedAmount(ml, "imperial");
      const naiveRoundTrip = Math.round(flOzToMl(shown));
      expect(naiveRoundTrip).not.toBe(ml); // the bug, still present in a bare round-trip
      expect(nextWaterMl(shown, /* edited */ false, "imperial")).toBeUndefined();
    }
  });

  it("metric round-trips cleanly even so — open and save unchanged is a no-op either way", () => {
    for (const ml of [1000, 250, 50, 2000]) {
      const shown = displayedAmount(ml, "metric");
      expect(shown).toBe(ml); // metric display has no rounding loss to begin with
      expect(nextWaterMl(shown, false, "metric")).toBeUndefined();
    }
  });

  it("does convert when the user actually changes the amount", () => {
    expect(nextWaterMl(16, true, "imperial")).toBe(Math.round(flOzToMl(16)));
    expect(nextWaterMl(500, true, "metric")).toBe(500);
  });

  it("treats a zero or missing edited amount as nothing to save", () => {
    expect(nextWaterMl(0, true, "imperial")).toBeUndefined();
    expect(nextWaterMl(undefined, true, "metric")).toBeUndefined();
  });

  it("sanity: mlToFlOz/flOzToMl are true inverses (the drift is rounding, not the formula)", () => {
    expect(mlToFlOz(flOzToMl(34))).toBeCloseTo(34, 9);
  });
});

describe("editing the true stored value, not a rounding of it", () => {
  // The band-aid (write nothing unless touched) narrowed the corruption but
  // did not remove it: merely touching the amount field on an imperial entry
  // still cost 13ml on a 250ml drink. With the real stored value in hand, a
  // touch that leaves the displayed number alone is now also a no-op.
  const cases: [number, number][] = [
    [1000, 34],
    [250, 8],
    [50, 2],
    [473, 16],
  ];

  it.each(cases)("keeps %ims when the shown %i oz is untouched but focused", (ml, shownOz) => {
    expect(nextWaterMl(shownOz, true, "imperial", ml)).toBe(ml);
  });

  it("still converts when the user actually changes the number", () => {
    // 250ml shows as 8 oz; typing 12 is a real change and must convert.
    expect(nextWaterMl(12, true, "imperial", 250)).toBe(355);
  });

  it("is unaffected in metric", () => {
    expect(nextWaterMl(250, true, "metric", 250)).toBe(250);
    expect(nextWaterMl(300, true, "metric", 250)).toBe(300);
  });

  it("falls back to conversion for a legacy event with no stored value", () => {
    expect(nextWaterMl(8, true, "imperial", undefined)).toBe(237);
  });
});

describe("nextFoodQuantity — an untouched servings field must not rewrite the entry", () => {
  it("omits quantity when the user did not edit it, even with extra stored precision", () => {
    expect(nextFoodQuantity(3, false)).toBeUndefined();
    expect(nextFoodQuantity(1.333, false)).toBeUndefined();
  });
  it("writes the edited value rounded to 2 decimals", () => {
    expect(nextFoodQuantity(2.456, true)).toBe(2.46);
    expect(nextFoodQuantity(2, true)).toBe(2);
  });
  it("omits a cleared or non-positive edit", () => {
    expect(nextFoodQuantity(undefined, true)).toBeUndefined();
    expect(nextFoodQuantity(0, true)).toBeUndefined();
  });
});

describe("isQuantityEdit — focusing the servings field and leaving is not an edit", () => {
  it("ignores the rounded or clamped value NumberField reports on blur", () => {
    expect(isQuantityEdit(1.33, 1.333)).toBe(false); // 2-decimal rounding
    expect(isQuantityEdit(0.1, 0.05)).toBe(false); // clamped to the field's minimum
    expect(isQuantityEdit(1, undefined)).toBe(false); // legacy entry shown as 1
    expect(nextFoodQuantity(1.33, isQuantityEdit(1.33, 1.333))).toBeUndefined();
  });

  it("counts a typed change, including clearing the field", () => {
    expect(isQuantityEdit(2, 1.333)).toBe(true);
    expect(isQuantityEdit(0.5, 0.05)).toBe(true);
    expect(isQuantityEdit(undefined, 1)).toBe(true);
  });
});
