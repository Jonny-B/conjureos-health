import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { vfs } from "../../bridge/vfs";
import { SAVE_FAILED_EVENT } from "../../data/saveFailure";
import * as off from "./openFoodFacts";
import * as usda from "./usda";
import { CUSTOM_FOODS_PATH, customFoodProblem, saveCustomFood, searchCustomFoods } from "./customFoods";
import { searchFoods } from "./foodSearch";

const base = {
  name: "Grandma's Oat Bar",
  brand: "Home",
  servingAmount: 40,
  servingUnit: "g",
  calories: 180,
  protein: 5,
  carbs: 24,
  fat: 7,
};

describe("custom foods", () => {
  let seen: string[];
  beforeEach(async () => {
    seen = [];
    const events = new EventTarget();
    events.addEventListener(SAVE_FAILED_EVENT, (e) =>
      seen.push((e as CustomEvent<{ message: string }>).detail.message),
    );
    (globalThis as unknown as { window: unknown }).window = events;
    await vfs.write(CUSTOM_FOODS_PATH, "");
  });
  afterEach(() => vi.restoreAllMocks());

  it("validates the form", () => {
    expect(customFoodProblem(base)).toBeNull();
    expect(customFoodProblem({ ...base, name: " " })).not.toBeNull();
    expect(customFoodProblem({ ...base, servingAmount: 0 })).not.toBeNull();
    expect(customFoodProblem({ ...base, calories: NaN })).not.toBeNull();
  });

  it("saves to the VFS with serving, calories and macros", async () => {
    const food = await saveCustomFood(base);
    expect(food).toMatchObject({
      source: "custom",
      name: "Grandma's Oat Bar",
      servingSize: "40 g",
      servingGrams: 40,
      perServing: { calories: 180, protein: 5, carbs: 24, fat: 7 },
    });
    const stored = JSON.parse(await vfs.read(CUSTOM_FOODS_PATH));
    expect(stored.foods[0].id).toBe(food!.id);
    expect(seen).toEqual([]);
  });

  it("is searchable afterwards, ahead of provider results", async () => {
    await saveCustomFood(base);
    expect((await searchCustomFoods("oat bar")).map((f) => f.name)).toEqual(["Grandma's Oat Bar"]);
    vi.spyOn(off, "searchText").mockResolvedValue([]);
    vi.spyOn(usda, "searchText").mockResolvedValue([]);
    const found = await searchFoods("grandma oat");
    expect(found[0]?.name).toBe("Grandma's Oat Bar");
  });

  it("tells the user when the save fails", async () => {
    vi.spyOn(vfs, "write").mockRejectedValue(new Error("disk full"));
    expect(await saveCustomFood(base)).toBeNull();
    expect(seen).toHaveLength(1);
  });
});
