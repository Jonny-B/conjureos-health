import { describe, expect, it } from "vitest";
import type { FoodItem } from "../types";
import { fromServings, toServings, unitsFor } from "./servingUnits";

const coffee: FoodItem = {
  id: "1",
  source: "usda",
  name: "Coffee, brewed",
  perServing: { calories: 1, protein: 0.1, carbs: 0, fat: 0 },
  servingSize: "100 g",
  servingGrams: 100,
};

describe("servingUnits", () => {
  it("8 fl oz of a per-100 g drink is about 2.37 servings", () => {
    expect(toServings(8, "floz", coffee)).toBeCloseTo(2.366, 2);
  });
  it("8 oz by weight is about 2.27 servings", () => {
    expect(toServings(8, "oz", coffee)).toBeCloseTo(2.268, 2);
  });
  it("grams round-trip", () => {
    expect(fromServings(toServings(250, "g", coffee), "g", coffee)).toBe(250);
  });
  it("servings pass through unchanged", () => {
    expect(toServings(1.5, "serving", coffee)).toBe(1.5);
  });
  it("offers only servings when the gram weight is unknown", () => {
    expect(unitsFor({ ...coffee, servingGrams: undefined }, "metric")).toEqual(["serving"]);
  });
  it("leads with imperial units for imperial users", () => {
    expect(unitsFor(coffee, "imperial").slice(0, 2)).toEqual(["serving", "oz"]);
  });
});

import { servingRatio } from "./servingUnits";
import { parseServingGrams } from "./foods/serving";

describe("servingRatio", () => {
  const r = (a: string, b: string, g?: number) => servingRatio(a, b, g, parseServingGrams);
  it("rescales by gram weight", () => {
    expect(r("100 g", "150 g")).toBeCloseTo(1.5);
    expect(r("1 slice (28 g)", "56 g")).toBeCloseTo(2);
  });
  it("prefers the stored gram weight over the label", () => {
    expect(r("1 bar", "80 g", 40)).toBeCloseTo(2);
  });
  it("rescales a count of the same unit", () => {
    expect(r("1 cup", "2 cups")).toBeCloseTo(2);
    expect(r("2 slices", "1 slice")).toBeCloseTo(0.5);
    expect(r("1/2 cup", "1 cup")).toBeCloseTo(2);
  });
  it("leaves incomparable labels alone", () => {
    expect(r("1 cup", "1 bowl")).toBeNull();
    expect(r("1 serving", "1 serving")).toBeNull();
    expect(r("a handful", "two handfuls")).toBeNull();
  });
});
