/**
 * A text search says which providers did not answer, so an empty list is a
 * real "no match" only when every provider answered (conjureos-fitness#70).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FoodItem } from "../../types";
import * as off from "./openFoodFacts";
import * as usda from "./usda";
import * as custom from "./customFoods";
import { ProviderUnavailableError } from "./http";
import { clearSearchAnswers, SEARCH_ANSWER_TTL_MS, searchFoods, unansweredNote } from "./foodSearch";

const food = (name: string, source: FoodItem["source"]): FoodItem => ({
  id: name,
  source,
  name,
  servingSize: "100 g",
  perServing: { calories: 100, protein: 1, carbs: 20, fat: 1 },
});

beforeEach(() => clearSearchAnswers());
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

/**
 * USDA is asked through usda-proxy on one key shared by every Health and
 * Recipes user (conjureos-fitness#70 review), so a search must not spend it on
 * a query it already has the answer to, or on one still being typed.
 */
describe("searchFoods spends the shared USDA quota once per settled query", () => {
  function providers() {
    vi.spyOn(custom, "searchCustomFoods").mockResolvedValue([]);
    const u = vi.spyOn(usda, "searchText").mockResolvedValue([food("Banana, raw", "usda")]);
    const o = vi.spyOn(off, "searchText").mockResolvedValue([food("Banana chips", "openfoodfacts")]);
    return { u, o };
  }

  it("asks each provider once for a query searched again", async () => {
    const { u, o } = providers();
    const first = await searchFoods("banana");
    const again = await searchFoods("  Banana ");
    expect(u).toHaveBeenCalledTimes(1);
    expect(o).toHaveBeenCalledTimes(1);
    expect(again).toEqual(first);
  });

  it("asks again after a provider did not answer", async () => {
    const { u } = providers();
    u.mockRejectedValueOnce(new ProviderUnavailableError("usda", 429));
    expect((await searchFoods("banana")).unanswered).toEqual(["usda"]);
    const again = await searchFoods("banana");
    expect(u).toHaveBeenCalledTimes(2);
    expect(again.unanswered).toEqual([]);
    expect(again.foods.map((f) => f.name)).toContain("Banana, raw");
  });

  it("does not keep what a cancelled search got back", async () => {
    const { u } = providers();
    const controller = new AbortController();
    u.mockImplementationOnce(async () => {
      controller.abort();
      return [];
    });
    await searchFoods("banana", 20, controller.signal);
    await searchFoods("banana");
    expect(u).toHaveBeenCalledTimes(2);
  });

  it("asks again once the answer is older than the time it is kept", async () => {
    const { u } = providers();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    await searchFoods("banana");
    now.mockReturnValue(1_000_000 + SEARCH_ANSWER_TTL_MS + 1);
    await searchFoods("banana");
    expect(u).toHaveBeenCalledTimes(2);
  });

  it("asks nothing for a query that changed before it settled", async () => {
    const { u, o } = providers();
    const typing = new AbortController();
    const early = searchFoods("chi", 20, typing.signal, undefined, { settleMs: 60 });
    setTimeout(() => typing.abort(), 10);
    expect(await early).toEqual({ foods: [], unanswered: [] });
    await searchFoods("chicken", 20, new AbortController().signal, undefined, { settleMs: 20 });
    expect(u.mock.calls.map((c) => c[0])).toEqual(["chicken"]);
    expect(o.mock.calls.map((c) => c[0])).toEqual(["chicken"]);
  });

  it("shows a remembered answer without waiting to settle", async () => {
    providers();
    await searchFoods("banana");
    const t0 = performance.now();
    const res = await searchFoods("banana", 20, new AbortController().signal, undefined, { settleMs: 5000 });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(res.foods).toHaveLength(2);
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
    expect(unansweredNote(["usda", "openfoodfacts"], true)).toBe(
      "USDA did not answer, so some foods may be missing. Try again in a minute.",
    );
    expect(unansweredNote(["openfoodfacts"], false)).toBe(
      "Open Food Facts did not answer. Try again in a minute, or add it yourself.",
    );
  });

  // Open Food Facts' search is often slow or 503s. Beside a list its silence
  // is routine, and a note on every other search would teach people to skip
  // the one about USDA.
  it("says nothing beside a list when only Open Food Facts did not answer", () => {
    expect(unansweredNote(["openfoodfacts"], true)).toBeNull();
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
