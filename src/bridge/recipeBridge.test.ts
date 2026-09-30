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

  it("treats a discover() rejection with another code (e.g. PERMISSION_DENIED) like an empty result", async () => {
    const invoke = vi.fn();
    const list = vi.fn();
    installBridge({
      invoke,
      list,
      discover: vi.fn().mockRejectedValue(Object.assign(new Error("no"), { code: "PERMISSION_DENIED" })),
    });

    expect(await listRecipes()).toEqual([]);
    expect(await getRecipe("lemon-orzo")).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(getRecipeProviderMatches()).toEqual([]);
  });
});

describe("discover() present but rejecting NOT_REGISTERED / code-less (mobile shell)", () => {
  const LEGACY_APP = [
    {
      appPath: "/apps/renamed-recipes",
      displayName: "Recipes",
      actions: [
        { name: "getRecipe", permission: "actions.read" },
        { name: "listRecipes", permission: "actions.read" },
      ],
    },
  ];

  it("falls back to the legacy list() scan with literal action names and no normalize", async () => {
    const invoke = vi.fn().mockImplementation(async (_p: string, action: string) =>
      action === "getRecipe" ? { recipe: RECIPE } : { recipes: [RECIPE] },
    );
    const discover = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("nope"), { code: "NOT_REGISTERED" }));
    installBridge({ invoke, discover, list: vi.fn().mockResolvedValue(LEGACY_APP) });

    expect(await listRecipes()).toEqual([RECIPE]);
    expect(await getRecipe("lemon-orzo")).toEqual(RECIPE);
    expect(invoke).toHaveBeenCalledWith("/apps/renamed-recipes", "listRecipes", {
      filter: undefined,
      limit: 100,
    });
    expect(invoke).toHaveBeenCalledWith("/apps/renamed-recipes", "getRecipe", {
      slug: "lemon-orzo",
    });
    for (const call of invoke.mock.calls) expect(call).toHaveLength(3); // no opts / normalize
    expect(getRecipeProviderMatches()).toEqual([]);
  });

  it("also falls back when the rejection carries no code", async () => {
    const invoke = vi.fn().mockResolvedValue({ recipes: [RECIPE] });
    installBridge({
      invoke,
      discover: vi.fn().mockRejectedValue(new Error("boom")),
      list: vi.fn().mockResolvedValue(LEGACY_APP),
    });

    expect(await listRecipes()).toEqual([RECIPE]);
    expect(invoke.mock.calls[0]?.[0]).toBe("/apps/renamed-recipes");
  });
});

describe("provider output is validated (h-bridge#7)", () => {
  function installProvider(recipes: unknown[]) {
    installBridge({
      invoke: vi.fn().mockResolvedValue({ recipes }),
      discover: vi.fn().mockResolvedValue([EXACT_MATCH]),
    });
  }

  it("defaults missing macros to 0 and accepts numeric strings", async () => {
    installProvider([
      { ...RECIPE, slug: "a", nutrition: { calories: 320, protein: 22 } },
      { ...RECIPE, slug: "b", nutrition: { calories: "320", protein: "22", carbs: "x", fat: -5 } },
    ]);

    const [a, b] = await listRecipes();
    expect(a!.nutrition).toEqual({ calories: 320, protein: 22, fat: 0, carbs: 0 });
    expect(b!.nutrition).toEqual({ calories: 320, protein: 22, fat: 0, carbs: 0 });
  });

  it("nulls nutrition without a valid calories value, and clamps absurd values", async () => {
    installProvider([
      { ...RECIPE, slug: "a", nutrition: {} },
      { ...RECIPE, slug: "b", nutrition: { calories: Number.NaN, protein: 1 } },
      { ...RECIPE, slug: "c", nutrition: { calories: -1 } },
      { ...RECIPE, slug: "d", nutrition: "lots" },
      { ...RECIPE, slug: "e", nutrition: undefined },
      { ...RECIPE, slug: "f", nutrition: { calories: 1e9, protein: 1e9, fat: 1, carbs: 1 } },
    ]);

    const out = await listRecipes();
    expect(out.slice(0, 5).map((r) => r.nutrition)).toEqual([null, null, null, null, null]);
    expect(out[5]!.nutrition).toEqual({ calories: 20000, protein: 2000, fat: 1, carbs: 1 });
  });

  it("drops items without a string slug/title instead of throwing, and fills defaults", async () => {
    installProvider([
      { ...RECIPE, title: undefined },
      { ...RECIPE, slug: 7 },
      null,
      "junk",
      { slug: "bare", title: "Bare", servings: 0, ingredients: ["ok", 3], madeCount: -2 },
    ]);

    expect(await listRecipes()).toEqual([
      {
        slug: "bare",
        title: "Bare",
        servings: 1,
        ingredients: ["ok"],
        savedAt: "",
        madeCount: 0,
        nutrition: null,
      },
    ]);
  });

  it("returns [] when the provider's recipes is not an array", async () => {
    installProvider([]);
    installBridge({
      invoke: vi.fn().mockResolvedValue({ recipes: { not: "an array" } }),
      discover: vi.fn().mockResolvedValue([EXACT_MATCH]),
    });
    expect(await listRecipes()).toEqual([]);
  });

  it("getRecipe normalises on the discovered path", async () => {
    installProvider([{ ...RECIPE, nutrition: { calories: 100 } }]);
    expect((await getRecipe("lemon-orzo"))!.nutrition).toEqual({
      calories: 100,
      protein: 0,
      fat: 0,
      carbs: 0,
    });
  });

  it("getRecipe / listRecipes normalise on the legacy path", async () => {
    const invoke = vi.fn().mockImplementation(async (_p: string, action: string) =>
      action === "getRecipe"
        ? { recipe: { ...RECIPE, nutrition: { calories: 100, protein: "5" } } }
        : { recipes: [{ ...RECIPE, title: undefined }, RECIPE] },
    );
    installBridge({ invoke, list: vi.fn().mockResolvedValue([]) });

    expect((await getRecipe("lemon-orzo"))!.nutrition).toEqual({
      calories: 100,
      protein: 5,
      fat: 0,
      carbs: 0,
    });
    expect(await listRecipes()).toEqual([RECIPE]);
  });

  it("getRecipe returns null for a legacy recipe lacking a title", async () => {
    installBridge({
      invoke: vi.fn().mockResolvedValue({ recipe: { ...RECIPE, title: "" } }),
      list: vi.fn().mockResolvedValue([]),
    });
    expect(await getRecipe("lemon-orzo")).toBeNull();
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
