import { describe, expect, it, vi, beforeEach } from "vitest";
import type { DiaryEntry, FoodItem, MealType } from "../types";
import { todayISO, shiftDate } from "./diary";

// Back the repository with a date→entries map so recentFoodsForMeal's day-window
// fan-out is exercised without a real VFS.
const byDate: Record<string, DiaryEntry[]> = {};
vi.mock("../data/repository", () => ({
  getRepository: async () => ({
    listDiary: async (date: string) => byDate[date] ?? [],
  }),
}));

import { recentFoodsForMeal } from "./recentFoods";

const food = (name: string, calories: number, brand?: string): FoodItem => ({
  id: name,
  source: "custom",
  name,
  brand,
  perServing: { calories, protein: 0, carbs: 0, fat: 0 },
  servingSize: "1 bar",
});

let seq = 0;
const entry = (
  date: string,
  meal: MealType,
  f: FoodItem,
  quantity: number,
  loggedAt: string,
): DiaryEntry => ({ id: `e${seq++}`, date, meal, food: f, quantity, loggedAt });

const today = todayISO();
const yesterday = shiftDate(today, -1);

describe("recentFoodsForMeal", () => {
  beforeEach(() => {
    for (const k of Object.keys(byDate)) delete byDate[k];
    seq = 0;
  });

  it("dedups the literal saved entry (same food + quantity) across days, newest first", async () => {
    const rx = food("RXBar", 210);
    byDate[yesterday] = [entry(yesterday, "snacks", rx, 0.5, "2026-07-15T09:00:00Z")];
    byDate[today] = [entry(today, "snacks", rx, 0.5, "2026-07-16T09:00:00Z")];

    const out = await recentFoodsForMeal("snacks");
    expect(out).toHaveLength(1);
    expect(out[0]!.food.name).toBe("RXBar");
    expect(out[0]!.quantity).toBe(0.5);
    expect(out[0]!.lastLoggedAt).toBe("2026-07-16T09:00:00Z"); // most recent kept
  });

  it("keeps different quantities of the same food as distinct suggestions", async () => {
    const rx = food("RXBar", 210);
    byDate[today] = [
      entry(today, "snacks", rx, 0.5, "2026-07-16T09:00:00Z"),
      entry(today, "snacks", rx, 1, "2026-07-16T10:00:00Z"),
    ];
    const out = await recentFoodsForMeal("snacks");
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.quantity).sort()).toEqual([0.5, 1]);
  });

  it("only returns entries for the requested meal", async () => {
    byDate[today] = [
      entry(today, "breakfast", food("Oatmeal", 150), 1, "2026-07-16T08:00:00Z"),
      entry(today, "snacks", food("RXBar", 210), 1, "2026-07-16T15:00:00Z"),
    ];
    const out = await recentFoodsForMeal("breakfast");
    expect(out).toHaveLength(1);
    expect(out[0]!.food.name).toBe("Oatmeal");
  });

  it("orders most-recent first and honors the limit", async () => {
    byDate[today] = [
      entry(today, "lunch", food("A", 100), 1, "2026-07-16T11:00:00Z"),
      entry(today, "lunch", food("B", 100), 1, "2026-07-16T12:00:00Z"),
      entry(today, "lunch", food("C", 100), 1, "2026-07-16T13:00:00Z"),
    ];
    const out = await recentFoodsForMeal("lunch", { limit: 2 });
    expect(out.map((r) => r.food.name)).toEqual(["C", "B"]);
  });
});
