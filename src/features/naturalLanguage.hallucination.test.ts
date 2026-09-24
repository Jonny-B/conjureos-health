import { describe, it, expect, vi, beforeEach } from "vitest";

const complete = vi.fn();
vi.mock("../bridge/ai", async (orig) => ({
  ...(await orig<typeof import("../bridge/ai")>()),
  complete: (...a: unknown[]) => complete(...a),
  isAiAvailable: () => true,
}));

beforeEach(() => complete.mockReset());

/**
 * Regression for the macro-laundering bug: `macro()` used to be
 * `toIntInRange(v, 0, max) ?? 0`, so an out-of-range value got clamped to the
 * cap instead of rejected — a hallucinated 15000-kcal reply became a
 * confident-looking 5000-kcal food with no review screen in between
 * (`logFood` in bridge/actions.ts calls this headless). `macro()` now returns
 * null on out-of-range, and `toFoodItem` drops the whole item rather than
 * save a partly-fabricated one — see the comment on `toFoodItem` for why
 * "drop" and not "zero the field."
 */
describe("parseMeal rejects implausible macros instead of capping them", () => {
  it("drops an item whose calories/protein blow past the plausible ceiling", async () => {
    const { parseMeal } = await import("./naturalLanguage");
    complete.mockResolvedValue(
      JSON.stringify({
        items: [
          { name: "Mystery meal", servingSize: "1 plate", calories: 15000, protein: 4000, carbs: 3, fat: 2 },
        ],
      }),
    );
    const items = await parseMeal({ text: "a huge plate of something" });
    // Must NOT come back as a 5000/500 kcal/protein item (the old clamp-to-cap
    // behaviour) — the item is dropped entirely.
    expect(items).toEqual([]);
  });

  it("keeps the other items in the same reply when only one is implausible", async () => {
    const { parseMeal } = await import("./naturalLanguage");
    complete.mockResolvedValue(
      JSON.stringify({
        items: [
          { name: "Mystery meal", servingSize: "1 plate", calories: 15000, protein: 4000, carbs: 3, fat: 2 },
          { name: "Apple", servingSize: "1 medium", calories: 95, protein: 0, carbs: 25, fat: 0 },
        ],
      }),
    );
    const items = await parseMeal({ text: "an apple and something huge" });
    expect(items).toHaveLength(1);
    expect(items[0]!.name).toBe("Apple");
    expect(items[0]!.perServing).toMatchObject({ calories: 95, protein: 0, carbs: 25, fat: 0 });
  });

  it("still accepts a plausible, in-range reply unchanged", async () => {
    const { parseMeal } = await import("./naturalLanguage");
    complete.mockResolvedValue(
      JSON.stringify({
        items: [{ name: "Chicken sandwich", servingSize: "1 sandwich", calories: 450, protein: 30, carbs: 40, fat: 15 }],
      }),
    );
    const items = await parseMeal({ text: "a chicken sandwich" });
    expect(items).toHaveLength(1);
    expect(items[0]!.perServing).toMatchObject({ calories: 450, protein: 30, carbs: 40, fat: 15 });
  });

  it("a genuinely non-numeric macro (not just out-of-range) also drops the item", async () => {
    const { parseMeal } = await import("./naturalLanguage");
    complete.mockResolvedValue(
      JSON.stringify({
        items: [{ name: "Broken item", servingSize: "1 serving", calories: null, protein: 10, carbs: 5, fat: 2 }],
      }),
    );
    const items = await parseMeal({ text: "something" });
    expect(items).toEqual([]);
  });
});
