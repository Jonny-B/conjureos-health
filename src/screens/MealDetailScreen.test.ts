import { describe, expect, it } from "vitest";
import type { DiaryEntry, FoodItem } from "../types";
import { collapseIntoGroup, roundPerServing } from "./MealDetailScreen";

function food(name: string): FoodItem {
  return {
    id: name,
    name,
    servingSize: "1 serving",
    perServing: { calories: 100, protein: 1, carbs: 2, fat: 0.5 },
  } as FoodItem;
}

describe("roundPerServing", () => {
  it("keeps one decimal on protein, carbs and fat, calories whole", () => {
    expect(roundPerServing({ calories: 99.6, protein: 0.4, carbs: 2.4, fat: 0.5 })).toEqual({
      calories: 100,
      protein: 0.4,
      carbs: 2.4,
      fat: 0.5,
    });
  });

  it("rounds to one decimal and never goes negative", () => {
    const m = roundPerServing({ calories: -3, protein: 1.26, carbs: -1, fat: 0.04 });
    expect(m).toMatchObject({ calories: 0, protein: 1.3, carbs: 0, fat: 0 });
  });
});

function fakeRepo(failRemoveAt: number | null) {
  const diary: DiaryEntry[] = [];
  let n = 0;
  let removes = 0;
  return {
    diary,
    repo: {
      async addDiaryEntry(e: Omit<DiaryEntry, "id" | "loggedAt">) {
        const full = { ...e, id: `id${++n}`, loggedAt: "t" } as DiaryEntry;
        diary.push(full);
        return full;
      },
      async removeDiaryEntry(id: string) {
        if (failRemoveAt !== null && removes++ === failRemoveAt) throw new Error("disk full");
        const i = diary.findIndex((x) => x.id === id);
        if (i >= 0) diary.splice(i, 1);
      },
    },
  };
}

describe("collapseIntoGroup", () => {
  async function seed(r: ReturnType<typeof fakeRepo>) {
    const a = await r.repo.addDiaryEntry({ date: "d", meal: "lunch", quantity: 2, food: food("a") });
    const b = await r.repo.addDiaryEntry({ date: "d", meal: "lunch", quantity: 1, food: food("b") });
    return [a, b];
  }

  it("replaces the parts with the group", async () => {
    const r = fakeRepo(null);
    const parts = await seed(r);
    await collapseIntoGroup(r.repo, "d", "lunch", food("grp"), parts);
    expect(r.diary.map((e) => e.food.name)).toEqual(["grp"]);
  });

  it("leaves the parts and no group when a remove fails, and rethrows", async () => {
    const r = fakeRepo(1); // first part removed, second fails
    const parts = await seed(r);
    await expect(collapseIntoGroup(r.repo, "d", "lunch", food("grp"), parts)).rejects.toThrow("disk full");
    expect(r.diary.map((e) => e.food.name).sort()).toEqual(["a", "b"]);
    expect(r.diary.find((e) => e.food.name === "a")?.quantity).toBe(2);
    expect(r.diary.some((e) => e.food.name === "grp")).toBe(false);
  });
});
