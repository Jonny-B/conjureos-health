import { afterEach, describe, it, expect, vi } from "vitest";
import { searchText } from "./usda";

function stubFoods(foods: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ foods }),
    }),
  );
}

function srLegacy(fdcId: number, description: string, kcal: number) {
  return {
    fdcId,
    description,
    dataType: "SR Legacy",
    foodNutrients: [
      { nutrientName: "Energy", value: kcal },
      { nutrientName: "Protein", value: 20 },
      { nutrientName: "Total lipid (fat)", value: 3 },
      { nutrientName: "Carbohydrate, by difference", value: 0 },
    ],
  };
}

describe("usda.ts - titleCase fix for h-foods#8", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("distinguishes raw from cooked chicken breast by keeping the full description", async () => {
    stubFoods([
      srLegacy(1, "Chicken, broilers or fryers, breast, meat only, raw", 120),
      srLegacy(2, "Chicken, broilers or fryers, breast, meat only, cooked, roasted", 165),
    ]);

    const results = await searchText("chicken breast", 10);

    expect(results.map((r) => [r.name, r.perServing.calories])).toEqual([
      ["Chicken, Broilers Or Fryers, Breast, Meat Only, Raw", 120],
      ["Chicken, Broilers Or Fryers, Breast, Meat Only, Cooked, Roasted", 165],
    ]);
  });

  it("keeps qualifiers after the first comma (cheddar vs swiss)", async () => {
    stubFoods([srLegacy(1, "Cheese, cheddar", 400), srLegacy(2, "Cheese, swiss", 380)]);

    const results = await searchText("cheese", 10);

    expect(results.map((r) => r.name)).toEqual(["Cheese, Cheddar", "Cheese, Swiss"]);
  });

  it("does not capitalise the letter after an apostrophe in branded names", async () => {
    stubFoods([
      {
        fdcId: 3,
        description: "CAMPBELL'S CHUNKY SOUP (CHICKEN/NOODLE) LOW-SODIUM",
        dataType: "Branded",
        brandOwner: "Campbell Soup Company",
        servingSize: 240,
        servingSizeUnit: "g",
        labelNutrients: {
          calories: { value: 200 },
          protein: { value: 10 },
          carbohydrates: { value: 20 },
          fat: { value: 5 },
        },
      },
    ]);

    const results = await searchText("soup", 10);

    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("Campbell's Chunky Soup (Chicken/Noodle) Low-Sodium");
    expect(results[0]!.perServing.calories).toBe(200);
  });
});
