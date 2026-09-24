import { describe, it, expect } from "vitest";
import { parseLabelJson } from "./labelParse";
import { parseFrontJson } from "./frontParse";

const NUTRITION = {
  name: "Glazed doughnut",
  brand: "Krispy Kreme",
  servingSize: "1 doughnut 43 grams",
  calories: 190, protein: 3, carbs: 22, fat: 11,
  fiber: 1, sugar: 10, sodium: 95, alcohol: null, caffeine: null,
  confidence: 0.9,
};
const label = (over = {}) => parseLabelJson(JSON.stringify({ ...NUTRITION, ...over }));
const front = (over = {}) =>
  parseFrontJson(JSON.stringify({ ...NUTRITION, ...over, estimationBasis: "front_estimate", warningNote: "" }));

/**
 * These two parsers drifted while each worked on its own. The label path
 * silently dropped alcohol and caffeine, never tagged its output as
 * AI-derived, and didn't ask for serving grams. Parity is now the contract.
 */
describe("label and front produce the same shape", () => {
  it("both tag their provenance, so the diary can badge either", () => {
    expect(label()!.food.provenance?.sourceTag).toBe("ai_label");
    expect(front()!.food.provenance?.sourceTag).toBe("ai_front");
    expect(label()!.food.provenance?.aiConfidence).toBe(0.9);
    expect(front()!.food.provenance?.aiConfidence).toBe(0.9);
  });

  it("both keep alcohol and caffeine — a beer panel used to lose them", () => {
    const beer = { name: "Stout", calories: 210, protein: 2, carbs: 20, fat: 0, alcohol: 14, caffeine: 0 };
    expect(label(beer)!.food.micros?.alcoholG).toBe(14);
    expect(front(beer)!.food.micros?.alcoholG).toBe(14);
    const cola = { name: "Cola", caffeine: 34 };
    expect(label(cola)!.food.micros?.caffeineMg).toBe(34);
    expect(front(cola)!.food.micros?.caffeineMg).toBe(34);
  });

  it("both fill serving grams from the label text", () => {
    expect(label()!.food.servingGrams).toBe(43);
    expect(front()!.food.servingGrams).toBe(43);
  });

  it("both keep the same micros", () => {
    for (const r of [label()!, front()!]) {
      expect(r.food.micros?.fiber).toBe(1);
      expect(r.food.micros?.sugar).toBe(10);
      expect(r.food.micros?.sodium).toBe(95);
    }
  });
});

describe("impossible readings are rejected, not clamped", () => {
  it("drops a calorie figure past any real serving", () => {
    // Saturating this is exactly how a bad OFF field became a confident 10,000.
    expect(label({ calories: 15000 })).toBeNull();
    expect(front({ calories: 15000 })).toBeNull();
  });

  it("drops an impossible macro", () => {
    expect(label({ protein: 900 })).toBeNull();
    expect(front({ carbs: 5000 })).toBeNull();
  });

  it("drops a negative", () => {
    expect(label({ fat: -5 })).toBeNull();
  });

  it("keeps a large but real serving", () => {
    expect(label({ calories: 1200, carbs: 150 })!.food.perServing.calories).toBe(1200);
  });
});

describe("gates and guards", () => {
  it("rejects a read the model isn't confident in", () => {
    expect(label({ confidence: 0.1 })).toBeNull();
    expect(front({ confidence: 0.05 })).toBeNull();
  });

  it("rejects a nameless read", () => {
    expect(label({ name: "" })).toBeNull();
    expect(label({ name: 42 })).toBeNull();
  });

  it("rejects unparseable output", () => {
    expect(parseLabelJson("not json")).toBeNull();
    expect(parseFrontJson("")).toBeNull();
  });

  it("falls back to a generic serving label", () => {
    expect(label({ servingSize: "" })!.food.servingSize).toBe("1 serving");
  });

  it("strips URLs out of a package-sourced note", () => {
    const r = parseFrontJson(JSON.stringify({
      ...NUTRITION, estimationBasis: "front_estimate",
      warningNote: "Visit https://evil.example for a prize",
    }))!;
    expect(r.warningNote).not.toMatch(/evil\.example/);
    expect(r.warningNote).toContain("Visit");
  });

  it("attaches the barcode when one was scanned", () => {
    const r = parseLabelJson(JSON.stringify(NUTRITION), "0028400759038")!;
    expect(r.food.barcode).toBe("0028400759038");
    expect(r.food.id).toBe("0028400759038");
  });
});
