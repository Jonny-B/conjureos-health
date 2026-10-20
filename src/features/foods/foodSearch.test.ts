/**
 * A text search says which providers did not answer, so an empty list is a
 * real "no match" only when every provider answered (conjureos-fitness#70).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FoodItem } from "../../types";
import * as off from "./openFoodFacts";
import * as usda from "./usda";
import * as custom from "./customFoods";
import { ProviderUnavailableError } from "./http";
import { searchFoods, unansweredNote } from "./foodSearch";

const food = (name: string, source: FoodItem["source"]): FoodItem => ({
  id: name,
  source,
  name,
  servingSize: "100 g",
  perServing: { calories: 100, protein: 1, carbs: 20, fat: 1 },
});

afterEach(() => vi.restoreAllMocks());

describe("searchFoods", () => {
  it("names a provider that did not answer and keeps the other's foods", async () => {
    vi.spyOn(custom, "searchCustomFoods").mockResolvedValue([]);
    vi.spyOn(usda, "searchText").mockRejectedValue(new ProviderUnavailableError("usda", 429));
    vi.spyOn(off, "searchText").mockResolvedValue([food("Banana chips", "openfoodfacts")]);

    const res = await searchFoods("banana");
    expect(res.foods.map((f) => f.name)).toEqual(["Banana chips"]);
    expect(res.unanswered).toEqual(["usda"]);
  });

  it("names both when neither answered", async () => {
    vi.spyOn(custom, "searchCustomFoods").mockResolvedValue([]);
    vi.spyOn(usda, "searchText").mockRejectedValue(new ProviderUnavailableError("usda"));
    vi.spyOn(off, "searchText").mockRejectedValue(new Error("unexpected"));

    const res = await searchFoods("banana");
    expect(res).toEqual({ foods: [], unanswered: ["usda", "openfoodfacts"] });
  });

  it("names nobody when both answered, even with nothing found", async () => {
    vi.spyOn(custom, "searchCustomFoods").mockResolvedValue([]);
    vi.spyOn(usda, "searchText").mockResolvedValue([]);
    vi.spyOn(off, "searchText").mockResolvedValue([]);

    expect(await searchFoods("zzqx")).toEqual({ foods: [], unanswered: [] });
  });

  it("names nobody for a search the caller cancelled", async () => {
    vi.spyOn(custom, "searchCustomFoods").mockResolvedValue([]);
    const controller = new AbortController();
    vi.spyOn(usda, "searchText").mockImplementation(async () => {
      controller.abort();
      throw new ProviderUnavailableError("usda");
    });
    vi.spyOn(off, "searchText").mockResolvedValue([]);

    expect((await searchFoods("banana", 20, controller.signal)).unanswered).toEqual([]);
  });
});

describe("unansweredNote", () => {
  it("says nothing when every provider answered", () => {
    expect(unansweredNote([], false)).toBeNull();
    expect(unansweredNote([], true)).toBeNull();
  });

  it("names who did not answer, and never passes it off as no match", () => {
    expect(unansweredNote(["usda"], false)).toBe("USDA did not answer. Try again in a minute, or add it yourself.");
    expect(unansweredNote(["usda", "openfoodfacts"], false)).toBe(
      "USDA and Open Food Facts did not answer. Try again in a minute, or add it yourself.",
    );
    expect(unansweredNote(["openfoodfacts"], true)).toBe(
      "Open Food Facts did not answer, so some foods may be missing. Try again in a minute.",
    );
  });

  it("follows the copy rules", () => {
    for (const note of [
      unansweredNote(["usda"], false),
      unansweredNote(["usda", "openfoodfacts"], true),
    ]) {
      expect(note).not.toMatch(/—|\bnow\b|no longer|\byet\b/i);
    }
  });
});
