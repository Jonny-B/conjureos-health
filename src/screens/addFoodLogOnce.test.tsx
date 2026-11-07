// @vitest-environment jsdom
/**
 * The AI-mode review's "Log N items" button logs each item once, even on a
 * double tap: a second press while the first save is still on its way does
 * nothing, and the button works again once the save has finished.
 *
 * Driven through the real AddFoodScreen (AI mode, text description). Only the
 * estimator, the stored diary and the AI agreement are stand-ins.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiaryEntry, FoodItem } from "../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const parseMealWithGroup = vi.fn();
vi.mock("../features/naturalLanguage", () => ({
  parseMealWithGroup: (...a: unknown[]) => parseMealWithGroup(...a),
}));

vi.mock("../components/useAiAgreement", () => ({
  useAiAgreement: () => ({
    agreed: true,
    lost: () => {},
    withAgreement: () => {},
    notSaved: false,
    sheet: null,
  }),
}));

const diary: DiaryEntry[] = [];
vi.mock("../data/repository", () => ({
  getRepository: async () => ({
    addDiaryEntry: async (e: Omit<DiaryEntry, "id" | "loggedAt">) => {
      // Let the save take a moment, as the real store does.
      await new Promise((r) => setTimeout(r, 20));
      const row = { ...e, id: `d${diary.length}`, loggedAt: new Date().toISOString() } as DiaryEntry;
      diary.push(row);
      return row;
    },
  }),
}));
vi.mock("../features/recentFoods", () => ({ recentFoodsForMeal: async () => [] }));
vi.mock("../bridge/recipeBridge", () => ({
  listRecipes: async () => [],
  markCooked: async () => {},
  getResolvedRecipeProviderName: () => null,
}));

const { AddFoodScreen } = await import("./AddFoodScreen");

const food = (name: string): FoodItem => ({
  id: name,
  source: "custom",
  name,
  servingSize: "1 serving",
  perServing: { calories: 200, protein: 10, carbs: 20, fat: 5 },
});

const TWO = { items: [food("Eggs"), food("Toast")], groupName: "" };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  parseMealWithGroup.mockReset();
  parseMealWithGroup.mockResolvedValue({ ...TWO, outcome: "ok" });
  diary.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function settle() {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

function button(label: RegExp): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) => label.test(b.textContent ?? ""));
  if (!found) throw new Error(`no button matching ${label}`);
  return found;
}

/** Open Add food in AI mode, describe a meal and let the estimate land. */
async function reviewTwoItems() {
  await act(async () => {
    root.render(
      <AddFoodScreen
        date="2026-11-06"
        defaultMeal="lunch"
        defaultMode="ai"
        onLogged={() => {}}
        onCancel={() => {}}
      />,
    );
  });
  const ta = container.querySelector("textarea")!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(ta, "eggs on toast");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    button(/^Estimate$/).click();
  });
  await settle();
}

describe("AI review: Log items", () => {
  it("logs each item once when the button is pressed twice quickly", async () => {
    await reviewTwoItems();
    const log = button(/^Log 2 items/);
    await act(async () => {
      log.click();
      log.click();
    });
    await settle();
    expect(diary.map((d) => d.food.name)).toEqual(["Eggs", "Toast"]);
  });

  it("works again once the save has finished", async () => {
    await reviewTwoItems();
    await act(async () => {
      button(/^Log 2 items/).click();
    });
    await settle();
    expect(diary).toHaveLength(2);
    // The review is still on screen here (onLogged is a stub), so the button
    // must be live again for a later, deliberate press.
    expect(button(/^Log 2 items/).disabled).toBe(false);
  });
});
