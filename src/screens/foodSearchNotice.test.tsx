// @vitest-environment jsdom
/**
 * Add food's search says when a food database did not answer, instead of
 * "No matches" (conjureos-fitness#70). Driven through the real screen; only
 * the search itself and the stores beside it are stand-ins.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FoodItem } from "../types";
import type { FoodSearchResult } from "../features/foods/foodSearch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const searchFoods = vi.fn<(...a: unknown[]) => Promise<FoodSearchResult>>();

vi.mock("../features/foods/foodSearch", async (orig) => ({
  ...(await orig<typeof import("../features/foods/foodSearch")>()),
  searchFoods: (...a: unknown[]) => searchFoods(...a),
}));
vi.mock("../features/recentFoods", () => ({ recentFoodsForMeal: async () => [] }));
vi.mock("../bridge/recipeBridge", () => ({
  listRecipes: async () => [],
  markCooked: async () => {},
  getResolvedRecipeProviderName: () => null,
}));

const { AddFoodScreen } = await import("./AddFoodScreen");

const oats: FoodItem = {
  id: "oats",
  source: "openfoodfacts",
  name: "Rolled oats",
  servingSize: "40 g",
  perServing: { calories: 150, protein: 5, carbs: 27, fat: 3 },
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  searchFoods.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Open Add food on a search for `query` and let the debounced search land. */
async function searchFor(query: string) {
  await act(async () => {
    root.render(
      <AddFoodScreen
        date="2026-10-20"
        defaultMeal="lunch"
        defaultMode="search"
        initialQuery={query}
        onLogged={() => {}}
        onCancel={() => {}}
      />,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 400));
  });
}

describe("Add food search", () => {
  it("says USDA did not answer instead of no matches", async () => {
    searchFoods.mockResolvedValue({ foods: [], unanswered: ["usda"] });
    await searchFor("banana");
    const text = container.textContent ?? "";
    expect(text).toContain("USDA did not answer. Try again in a minute, or add it yourself.");
    expect(text).not.toContain("No matches");
    // Adding it yourself stays one tap away.
    expect(text).toContain('Add "banana" as your own food');
  });

  it("asks the food databases only once the query has settled", async () => {
    searchFoods.mockResolvedValue({ foods: [], unanswered: [] });
    await searchFor("banana");
    expect(searchFoods).toHaveBeenCalledTimes(1);
    const opts = searchFoods.mock.calls[0]![4] as { settleMs?: number } | undefined;
    expect(opts?.settleMs).toBeGreaterThan(0);
  });

  it("says no matches only when every database answered", async () => {
    searchFoods.mockResolvedValue({ foods: [], unanswered: [] });
    await searchFor("zzqx");
    expect(container.textContent).toContain("No matches. Try a simpler term, or add it yourself.");
    expect(container.textContent).not.toContain("did not answer");
  });

  it("keeps the foods it found and says which may be missing", async () => {
    searchFoods.mockResolvedValue({ foods: [oats], unanswered: ["usda"] });
    await searchFor("oats");
    expect(container.textContent).toContain("Rolled oats");
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toBe("USDA did not answer, so some foods may be missing. Try again in a minute.");
  });

  it("shows USDA's foods without a note when only Open Food Facts did not answer", async () => {
    searchFoods.mockResolvedValue({ foods: [{ ...oats, source: "usda" }], unanswered: ["openfoodfacts"] });
    await searchFor("oats");
    expect(container.textContent).toContain("Rolled oats");
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).not.toContain("did not answer");
  });

  it("still names Open Food Facts when nothing was found", async () => {
    searchFoods.mockResolvedValue({ foods: [], unanswered: ["openfoodfacts"] });
    await searchFor("kind bar");
    expect(container.textContent).toContain("Open Food Facts did not answer. Try again in a minute, or add it yourself.");
    expect(container.textContent).not.toContain("No matches");
  });
});
