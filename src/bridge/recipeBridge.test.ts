/**
 * Discovery-based provider resolution (Phase 45 self-describing apps).
 *
 * Exercises the three host generations the bridge must handle:
 *   - discover() present and matching   → invoke matched action, normalized
 *   - discover() present, empty result  → graceful "no recipes" degradation
 *   - discover() absent (older host)    → legacy actions.list() scan
 *   - no actions bridge at all          → bundled dev mocks
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getRecipe,
  getRecipeProviderMatches,
  listRecipes,
  markCooked,
  resetRecipeProviderCache,
  RecipesAppClosedError,
  type ListedRecipe,
  type ProviderMatch,
} from "./recipeBridge";

const RECIPE: ListedRecipe = {
  slug: "lemon-orzo",
  title: "Lemon Orzo",
  servings: 3,
  ingredients: ["1 cup orzo", "1 lemon", "2 tbsp olive oil"],
  savedAt: "2026-07-01T12:00:00.000Z",
  madeCount: 2,
  nutrition: { calories: 410, protein: 11, fat: 14, carbs: 60 },
};

const EXACT_MATCH: ProviderMatch = {
  appPath: "/apps/my-recipes",
  displayName: "My Recipes",
  action: "listRecipes",
  binding: "exact",
};

const AI_MATCH: ProviderMatch = {
  appPath: "/apps/meal-vault",
  displayName: "Meal Vault",
  action: "exportMeals",
  binding: "ai-mapped",
  confidence: 0.74,
};

type ActionsBridge = NonNullable<NonNullable<Window["__conjureos"]>["actions"]>;

function installBridge(bridge: ActionsBridge | undefined): void {
  (globalThis as { window?: unknown }).window = {
    __conjureos: bridge === undefined ? {} : { actions: bridge },
  };
}

beforeEach(() => {
  resetRecipeProviderCache();
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.restoreAllMocks();
});

describe("discover() present and matching", () => {
  it("invokes the matched appPath/action with normalize: recipeSource", async () => {
    const invoke = vi.fn().mockResolvedValue({ recipes: [RECIPE] });
    const discover = vi.fn().mockResolvedValue([EXACT_MATCH]);
    installBridge({ invoke, discover });

    const recipes = await listRecipes("orzo");

    expect(discover).toHaveBeenCalledWith("recipeSource");
    expect(invoke).toHaveBeenCalledWith(
      "/apps/my-recipes",
      "listRecipes",
      { filter: "orzo", limit: 100 },
      { normalize: "recipeSource" },
    );
    expect(recipes).toEqual([RECIPE]);
  });

  it("getRecipe picks the slug out of the normalized list", async () => {
    const invoke = vi.fn().mockResolvedValue({ recipes: [RECIPE] });
    installBridge({ invoke, discover: vi.fn().mockResolvedValue([EXACT_MATCH]) });

    expect(await getRecipe("lemon-orzo")).toEqual(RECIPE);
    expect(await getRecipe("not-a-recipe")).toBeNull();
    expect(invoke).toHaveBeenCalledWith(
      "/apps/my-recipes",
      "listRecipes",
      { limit: 500 },
      { normalize: "recipeSource" },
    );
  });

  it("prefers the first exact match over a higher-listed ai-mapped one, and exports the full list", async () => {
    const invoke = vi.fn().mockResolvedValue({ recipes: [] });
    installBridge({
      invoke,
      discover: vi.fn().mockResolvedValue([AI_MATCH, EXACT_MATCH]),
    });

    await listRecipes();

    expect(invoke.mock.calls[0]?.[0]).toBe("/apps/my-recipes");
    expect(getRecipeProviderMatches()).toEqual([AI_MATCH, EXACT_MATCH]);
  });

  it("falls back to the first ai-mapped match when no exact match exists", async () => {
    const invoke = vi.fn().mockResolvedValue({ recipes: [RECIPE] });
    installBridge({ invoke, discover: vi.fn().mockResolvedValue([AI_MATCH]) });

    await listRecipes();

    expect(invoke.mock.calls[0]?.[0]).toBe("/apps/meal-vault");
    expect(invoke.mock.calls[0]?.[1]).toBe("exportMeals");
  });

  it("discovery result is cached across calls", async () => {
    const discover = vi.fn().mockResolvedValue([EXACT_MATCH]);
    installBridge({ invoke: vi.fn().mockResolvedValue({ recipes: [] }), discover });

    await listRecipes();
    await listRecipes();
    await getRecipe("lemon-orzo");

    expect(discover).toHaveBeenCalledTimes(1);
  });

  it("getRecipe surfaces TARGET_NOT_RUNNING as RecipesAppClosedError with the matched appPath", async () => {
    const invoke = vi.fn().mockRejectedValue({ code: "TARGET_NOT_RUNNING" });
    installBridge({ invoke, discover: vi.fn().mockResolvedValue([EXACT_MATCH]) });

    await expect(getRecipe("lemon-orzo")).rejects.toThrow(RecipesAppClosedError);
    await expect(getRecipe("lemon-orzo")).rejects.toMatchObject({
      appPath: "/apps/my-recipes",
    });
  });

  it("markCooked invokes only when the matched provider exposes a markCooked action", async () => {
    const invoke = vi.fn().mockResolvedValue({});
    const list = vi.fn().mockResolvedValue([
      {
        appPath: "/apps/my-recipes",
        displayName: "My Recipes",
        actions: [
          { name: "listRecipes", permission: "actions.read" },
          { name: "markCooked", permission: "actions.write" },
        ],
      },
    ]);
    installBridge({ invoke, list, discover: vi.fn().mockResolvedValue([EXACT_MATCH]) });

    await markCooked("lemon-orzo");
    expect(invoke).toHaveBeenCalledWith("/apps/my-recipes", "markCooked", { slug: "lemon-orzo" });
  });

  it("markCooked silently no-ops when the matched provider lacks markCooked", async () => {
    const invoke = vi.fn().mockResolvedValue({});
    const list = vi.fn().mockResolvedValue([
      {
        appPath: "/apps/meal-vault",
        displayName: "Meal Vault",
        actions: [{ name: "exportMeals", permission: "actions.read" }],
      },
    ]);
    installBridge({ invoke, list, discover: vi.fn().mockResolvedValue([AI_MATCH]) });

    await expect(markCooked("lemon-orzo")).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("discover() present but empty (no provider, or cross-app disabled)", () => {
  it("degrades to [] / null / no-op without invoking anything", async () => {
    const invoke = vi.fn();
    installBridge({ invoke, discover: vi.fn().mockResolvedValue([]) });

    expect(await listRecipes()).toEqual([]);
    expect(await getRecipe("lemon-orzo")).toBeNull();
    await expect(markCooked("lemon-orzo")).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
    expect(getRecipeProviderMatches()).toEqual([]);
  });

  it("re-runs discovery on the next call, so a provider installed mid-session is picked up", async () => {
    const discover = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([EXACT_MATCH]);
    const invoke = vi.fn().mockResolvedValue({ recipes: [RECIPE] });
    installBridge({ invoke, discover });

    expect(await listRecipes()).toEqual([]);
    expect(await listRecipes()).toEqual([RECIPE]);
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("treats a discover() rejection like an empty result", async () => {
    const invoke = vi.fn();
    installBridge({ invoke, discover: vi.fn().mockRejectedValue(new Error("boom")) });

    expect(await listRecipes()).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("discover() undefined (older host) — legacy actions.list scan", () => {
  it("scans actions.list for an app exposing getRecipe and invokes literal names without normalize", async () => {
    const invoke = vi.fn().mockResolvedValue({ recipes: [RECIPE] });
    const list = vi.fn().mockResolvedValue([
      {
        appPath: "/apps/renamed-recipes",
        displayName: "Recipes",
        actions: [
          { name: "getRecipe", permission: "actions.read" },
          { name: "listRecipes", permission: "actions.read" },
          { name: "markCooked", permission: "actions.write" },
        ],
      },
    ]);
    installBridge({ invoke, list });

    const recipes = await listRecipes();

    expect(recipes).toEqual([RECIPE]);
    expect(invoke).toHaveBeenCalledWith("/apps/renamed-recipes", "listRecipes", {
      filter: undefined,
      limit: 100,
    });
  });

  it("falls back to /apps/recipes when the scan finds nothing", async () => {
    const invoke = vi.fn().mockResolvedValue({ recipe: RECIPE });
    installBridge({ invoke, list: vi.fn().mockResolvedValue([]) });

    expect(await getRecipe("lemon-orzo")).toEqual(RECIPE);
    expect(invoke).toHaveBeenCalledWith("/apps/recipes", "getRecipe", { slug: "lemon-orzo" });
  });

  it("legacy markCooked stays best-effort and unconditional", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("grant denied"));
    installBridge({ invoke, list: vi.fn().mockResolvedValue([]) });

    await expect(markCooked("lemon-orzo")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("/apps/recipes", "markCooked", { slug: "lemon-orzo" });
  });

  it("legacy getRecipe still maps TARGET_NOT_RUNNING to RecipesAppClosedError", async () => {
    const invoke = vi.fn().mockRejectedValue({ code: "TARGET_NOT_RUNNING" });
    installBridge({ invoke, list: vi.fn().mockResolvedValue([]) });

    await expect(getRecipe("lemon-orzo")).rejects.toMatchObject({
      name: "RecipesAppClosedError",
      appPath: "/apps/recipes",
    });
  });
});

describe("no actions bridge at all (non-ConjureOS dev)", () => {
  it("serves the bundled mock recipes", async () => {
    installBridge(undefined);

    const all = await listRecipes();
    expect(all.length).toBeGreaterThan(0);
    expect(await getRecipe(all[0]!.slug)).toEqual(all[0]);
    await expect(markCooked(all[0]!.slug)).resolves.toBeUndefined();
  });

  it("filters mocks by title or ingredient", async () => {
    installBridge(undefined);

    const hits = await listRecipes("spinach");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.slug).toBe("spinach-feta-scramble");
  });
});
