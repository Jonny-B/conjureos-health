import { describe, expect, it } from "vitest";
import type { WeightEntry } from "../types";
import { pickWeightKg } from "./WeightCard";

const w = (weightKg: number, date = "2026-07-16"): WeightEntry => ({ date, weightKg });

describe("pickWeightKg", () => {
  it("uses the newest weigh-in when one exists", () => {
    expect(pickWeightKg([w(78), w(80)])).toBe(78);
  });

  it("returns null when there are no weigh-ins — the cards show a prompt, never a fabricated stat", () => {
    // Even though the profile carries a weight, we do NOT surface it here: a
    // pounds-in-kg profile value was the source of the phantom "399 lb default".
    expect(pickWeightKg([])).toBeNull();
  });
});
