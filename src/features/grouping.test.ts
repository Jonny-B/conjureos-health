import { describe, it, expect } from "vitest";
import { GROUP_NAME_MAX, groupEntries, groupItems, suggestGroupName } from "./grouping";
import type { DiaryEntry, FoodItem } from "../types";

const f = (name: string, cal: number, p = 0, c = 0, fat = 0): FoodItem => ({
  id: name, source: "custom", name, servingSize: "1 serving",
  perServing: { calories: cal, protein: p, carbs: c, fat },
});

describe("suggestGroupName", () => {
  it("leads with the biggest item — that's what the meal was", () => {
    // The hotdog is the meal; the bun and mustard are trimmings.
    expect(suggestGroupName([f("Hotdog bun", 120), f("Hotdog", 300), f("Mustard", 5)]))
      .toBe("Hotdog +2 more");
  });

  it("says 'with X' for exactly two", () => {
    expect(suggestGroupName([f("Hotdog", 300), f("Mustard", 5)])).toBe("Hotdog with mustard");
  });

  it("uses the single item's own name", () => {
    expect(suggestGroupName([f("Chicken sandwich", 500)])).toBe("Chicken sandwich");
  });

  it("counts the rest rather than listing them — the sprawl is the point", () => {
    const board = ["Brie", "Cheddar", "Crackers", "Grapes", "Walnuts", "Fig jam"]
      .map((n, i) => f(n, 200 - i));
    const name = suggestGroupName(board);
    expect(name).toBe("Brie +5 more");
    expect(name.length).toBeLessThanOrEqual(GROUP_NAME_MAX);
  });

  it("never exceeds the cap, even with absurd names", () => {
    const long = f("Slow-roasted heritage pork shoulder with apple", 400);
    const other = f("Buttered heritage new potatoes with parsley", 300);
    expect(suggestGroupName([long, other]).length).toBeLessThanOrEqual(GROUP_NAME_MAX);
    expect(suggestGroupName([long, other, f("Gravy", 50)]).length).toBeLessThanOrEqual(GROUP_NAME_MAX);
  });

  it("is empty for nothing", () => {
    expect(suggestGroupName([])).toBe("");
  });
});

describe("groupItems", () => {
  it("sums the macros", () => {
    const one = groupItems([f("Hotdog", 300, 12, 25, 18), f("Mustard", 5, 0, 1, 0)])!;
    expect(one.perServing).toEqual({ calories: 305, protein: 12, carbs: 26, fat: 18 });
  });

  it("labels the serving by count, not a fake '1 serving'", () => {
    expect(groupItems([f("A", 1), f("B", 2), f("C", 3)])!.servingSize).toBe("3 items");
    // A single item keeps its real serving label.
    expect(groupItems([f("A", 1)])!.servingSize).toBe("1 serving");
  });

  it("prefers a supplied name but still caps it", () => {
    expect(groupItems([f("A", 1), f("B", 2)], "Hotdog with mustard")!.name).toBe("Hotdog with mustard");
    const long = groupItems([f("A", 1)], "x".repeat(80))!;
    expect(long.name.length).toBe(GROUP_NAME_MAX);
  });

  it("falls back to a derived name when given a blank one", () => {
    expect(groupItems([f("Hotdog", 300), f("Mustard", 5)], "   ")!.name).toBe("Hotdog with mustard");
  });

  it("stays flagged as an AI estimate so the diary still badges it", () => {
    expect(groupItems([f("A", 1)])!.provenance?.sourceTag).toBe("ai_estimate");
  });

  it("is null for nothing", () => {
    expect(groupItems([])).toBeNull();
  });
});

describe("groupEntries", () => {
  const entry = (name: string, cal: number, quantity: number, ai = false): DiaryEntry => ({
    id: name, date: "2026-09-01", meal: "breakfast", quantity, loggedAt: "x",
    food: {
      id: name, source: ai ? "custom" : "openfoodfacts", name, servingSize: "1 serving",
      perServing: { calories: cal, protein: 10, carbs: 20, fat: 5 },
      ...(ai ? { provenance: { sourceTag: "ai_estimate" as const } } : {}),
    },
  });

  it("respects each entry's quantity — the smoothie case", () => {
    // Half a scoop of protein powder is half its macros, not all of them.
    const g = groupEntries([
      entry("Frozen berries", 80, 1),
      entry("Greek yogurt", 120, 2),
      entry("Protein powder", 100, 0.5),
    ], "My smoothie")!;
    expect(g.perServing.calories).toBe(80 + 240 + 50);
    expect(g.perServing.protein).toBe(10 + 20 + 5);
  });

  it("re-logs as a single serving of the whole thing", () => {
    const g = groupEntries([entry("A", 100, 3), entry("B", 50, 1)])!;
    expect(g.servingSize).toBe("2 items");
  });

  it("uses the given name, capped", () => {
    expect(groupEntries([entry("A", 1, 1)], "My smoothie")!.name).toBe("My smoothie");
    expect(groupEntries([entry("A", 1, 1)], "z".repeat(90))!.name.length).toBe(GROUP_NAME_MAX);
  });

  it("derives a name when none is given", () => {
    const g = groupEntries([entry("Greek yogurt", 300, 1), entry("Honey", 60, 1)])!;
    expect(g.name).toBe("Greek yogurt with honey");
  });

  it("keeps the AI-estimate tag only when every part was estimated", () => {
    const allAi = groupEntries([entry("A", 10, 1, true), entry("B", 10, 1, true)])!;
    expect(allAi.provenance?.sourceTag).toBe("ai_estimate");
    // One scanned barcode in the mix means it is no longer purely a guess.
    const mixed = groupEntries([entry("A", 10, 1, true), entry("B", 10, 1, false)])!;
    expect(mixed.provenance).toBeUndefined();
  });

  it("survives a corrupt quantity instead of poisoning the totals", () => {
    const bad = { ...entry("A", 100, 1), quantity: NaN } as DiaryEntry;
    expect(groupEntries([bad])!.perServing.calories).toBe(100);
  });

  it("is null for nothing", () => {
    expect(groupEntries([])).toBeNull();
  });
});
