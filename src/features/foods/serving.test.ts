import { describe, it, expect } from "vitest";
import { parseServingGrams } from "./serving";

/**
 * The reported case: a front-and-back scan produced the serving label
 * "1 doughnut 43 grams" and stored no grams at all.
 */
describe("parseServingGrams", () => {
  it("reads the reported label", () => {
    expect(parseServingGrams("1 doughnut 43 grams")).toBe(43);
  });

  it("reads the usual parenthetical form", () => {
    expect(parseServingGrams("1 doughnut (43 g)")).toBe(43);
    expect(parseServingGrams("16 chips (28 g)")).toBe(28);
    expect(parseServingGrams("1 package (28.349 g)")).toBe(28.3);
  });

  it("reads a bare weight", () => {
    expect(parseServingGrams("30g")).toBe(30);
    expect(parseServingGrams("100 g")).toBe(100);
    expect(parseServingGrams("45 gm")).toBe(45);
  });

  it("prefers the gram figure over the count or the imperial one", () => {
    expect(parseServingGrams("2 oz (56 g)")).toBe(56);
    expect(parseServingGrams("1 bar (1.4 oz / 40 g)")).toBe(40);
    expect(parseServingGrams("6 crackers (43 g)")).toBe(43);
  });

  it("returns nothing for a volume — inventing a mass would be a guess", () => {
    expect(parseServingGrams("1 cup (240 ml)")).toBeNull();
    expect(parseServingGrams("12 fl oz")).toBeNull();
  });

  it("is not fooled by milligrams or kilograms", () => {
    expect(parseServingGrams("1 tablet (250 mg)")).toBeNull();
    expect(parseServingGrams("1 sack (2 kg)")).toBeNull();
  });

  it("returns nothing when the label carries no weight", () => {
    expect(parseServingGrams("1 serving")).toBeNull();
    expect(parseServingGrams("1 sandwich")).toBeNull();
    expect(parseServingGrams("")).toBeNull();
    expect(parseServingGrams(undefined)).toBeNull();
  });

  it("rejects an implausible weight rather than storing it", () => {
    expect(parseServingGrams("1 pallet (90000 g)")).toBeNull();
    expect(parseServingGrams("0 g")).toBeNull();
  });

  it("is reusable — a global regex must not carry lastIndex between calls", () => {
    expect(parseServingGrams("1 doughnut (43 g)")).toBe(43);
    expect(parseServingGrams("1 doughnut (43 g)")).toBe(43);
    expect(parseServingGrams("1 doughnut (43 g)")).toBe(43);
  });
});
