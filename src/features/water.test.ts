import { describe, it, expect } from "vitest";
import { fmtWater, mlToFlOz, flOzToMl, totalMl, waterPresets, waterUnit } from "./water";
import type { WaterEntry } from "../types";

const entry = (ml: number): WaterEntry => ({ id: String(ml), date: "2026-08-10", loggedAt: "x", ml });

describe("water units", () => {
  it("round-trips oz and ml", () => {
    expect(Math.round(mlToFlOz(flOzToMl(16)))).toBe(16);
  });

  it("formats in the user's own units", () => {
    expect(fmtWater(473, "imperial")).toBe("16 oz");
    expect(fmtWater(500, "metric")).toBe("500 ml");
  });

  it("never renders a negative or broken amount", () => {
    expect(fmtWater(0, "imperial")).toBe("0 oz");
    expect(fmtWater(NaN, "metric")).toBe("0 ml");
  });

  it("labels the unit", () => {
    expect(waterUnit("imperial")).toBe("oz");
    expect(waterUnit("metric")).toBe("ml");
  });

  it("offers containers people actually drink from", () => {
    expect(waterPresets("imperial").map((p) => p.label)).toEqual(["8 oz", "12 oz", "16 oz", "24 oz"]);
    expect(waterPresets("metric")[0]!.ml).toBe(250);
  });

  it("totals entries and ignores corrupt ones", () => {
    expect(totalMl([entry(250), entry(500)])).toBe(750);
    expect(totalMl([entry(250), { ...entry(0), ml: NaN }])).toBe(250);
    expect(totalMl([])).toBe(0);
  });
});
