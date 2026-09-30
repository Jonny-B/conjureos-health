/**
 * Pins the declared `recipeSource` need against REAL provider shapes, with the
 * kernel's own matcher (`schemaSatisfies` from @conjureos/bridge, the module
 * ConjureOS/src/kernel/connectionMap.ts imports). It fails closed and silently:
 * a need that asks for one field too many means `actions.discover` finds
 * nothing and Health quietly shows no recipes.
 */
import { describe, expect, it } from "vitest";
import { schemaSatisfies } from "@conjureos/bridge";
import pkg from "../../package.json";

type Need = { id: string; description?: string; shape: unknown };
const manifest = (pkg as unknown as { conjureos: { permissions: string[]; needs: Need[] } }).conjureos;
const shape = () => manifest.needs.find((n) => n.id === "recipeSource")!.shape as never;
const check = (provided: unknown) => schemaSatisfies(provided as never, shape());

// Conjure Recipes' own `returns`, verbatim from its package.json.
const RECIPES_LIST = {
  type: "object",
  properties: {
    recipes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          slug: { type: "string" },
          title: { type: "string" },
          difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
          cookTime: { type: "integer" },
          servings: { type: "integer" },
          ingredients: { type: "array", items: { type: "string" } },
          savedAt: { type: "string" },
          madeCount: { type: "integer" },
          lastMadeAt: { type: ["string", "null"] },
          nutrition: {
            type: ["object", "null"],
            properties: {
              calories: { type: "integer" }, protein: { type: "integer" },
              fat: { type: "integer" }, carbs: { type: "integer" },
              matched: { type: "integer" }, total: { type: "integer" }, est: { type: "boolean" },
            },
            required: ["calories", "protein", "fat", "carbs", "matched", "total", "est"],
          },
        },
        required: [
          "slug", "title", "difficulty", "cookTime", "servings",
          "ingredients", "savedAt", "madeCount", "lastMadeAt", "nutrition",
        ],
      },
    },
  },
  required: ["recipes"],
};

const RECIPES_SEARCH = {
  type: "object",
  properties: {
    recipes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          ingredients: { type: "array", items: { type: "string" } },
          category: { type: "string" },
          difficulty: { type: "string" },
          cookTime: { type: "integer" },
          servings: { type: "integer" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["id", "title", "ingredients"],
      },
    },
  },
  required: ["recipes"],
};

describe("recipeSource need", () => {
  it("is declared, with actions.read so discover() is allowed", () => {
    expect(manifest.needs.map((n) => n.id)).toContain("recipeSource");
    expect(manifest.permissions).toContain("actions.read");
    expect((manifest.needs[0]!.description ?? "").length).toBeGreaterThan(40);
  });

  it("Conjure Recipes' listRecipes is an exact match", () => {
    expect(check(RECIPES_LIST)).toEqual({ ok: true });
  });

  it("searchRecipes has no slug, so it is not exact and goes through AI mapping", () => {
    // recipeBridge.getRecipe finds a recipe by slug; a match without one would
    // hand back recipes that can never be logged.
    const r = check(RECIPES_SEARCH);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join(" ")).toContain("recipes[].slug");
  });

  it("refuses providers that are not recipe lists", () => {
    expect(check({ type: "object", properties: { items: { type: "array" } } }).ok).toBe(false);
    expect(
      check({ type: "object", properties: { recipes: { type: "array", items: { type: "string" } } }, required: ["recipes"] }).ok,
    ).toBe(false);
    // recipes present but optional: may be absent at runtime.
    const optional = { ...RECIPES_LIST, required: [] };
    expect(check(optional).ok).toBe(false);
  });

  it("names only fields recipeBridge reads", () => {
    const items = (shape() as { properties: { recipes: { items: { properties: object } } } })
      .properties.recipes.items.properties;
    expect(Object.keys(items).sort()).toEqual(
      ["ingredients", "madeCount", "nutrition", "savedAt", "servings", "slug", "title"],
    );
  });
});
