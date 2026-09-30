import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FoodItem } from "../types";

// Plain node environment: the screens' function components are driven through
// a minimal hook runtime and the element tree they return is walked directly.
const rt = vi.hoisted(() => {
  interface Inst { slots: unknown[]; i: number }
  const state: { cur: Inst | null } = { cur: null };
  const useState = (init: unknown) => {
    const inst = state.cur!;
    const idx = inst.i++;
    if (!(idx in inst.slots)) {
      inst.slots[idx] = { v: typeof init === "function" ? (init as () => unknown)() : init };
    }
    const slot = inst.slots[idx] as { v: unknown };
    return [slot.v, (n: unknown) => void (slot.v = typeof n === "function" ? (n as (p: unknown) => unknown)(slot.v) : n)];
  };
  const useRef = (init: unknown) => {
    const inst = state.cur!;
    const idx = inst.i++;
    if (!(idx in inst.slots)) inst.slots[idx] = { current: init };
    return inst.slots[idx];
  };
  const useEffect = () => void state.cur!.i++;
  return { state, hooks: { useState, useRef, useEffect } };
});

vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), ...rt.hooks }));
vi.mock("../features/foods/foodSearch", () => ({
  searchFoods: vi.fn(),
  lookupBarcode: vi.fn(),
  rememberCorrection: vi.fn(),
}));
vi.mock("../features/naturalLanguage", () => ({ parseMealWithGroup: vi.fn() }));
vi.mock("../data/repository", () => ({ getRepository: vi.fn() }));

import { lookupBarcode } from "../features/foods/foodSearch";
import { parseMealWithGroup } from "../features/naturalLanguage";
import { getRepository } from "../data/repository";
import { AiMode, ScanMode, loggedQuantity } from "./AddFoodScreen";
import { BarcodeScanner } from "../components/BarcodeScanner";
import { toServings } from "../features/servingUnits";

type El = { type: unknown; key?: unknown; props: Record<string, any> };

function mount<P>(Comp: (p: P) => unknown, props: P) {
  const inst = { slots: [] as unknown[], i: 0 };
  const m = {
    tree: null as unknown,
    render() {
      rt.state.cur = inst;
      inst.i = 0;
      m.tree = Comp(props);
      rt.state.cur = null;
    },
  };
  m.render();
  return m;
}

function walk(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => walk(n, out));
  else if (node && typeof node === "object" && "props" in node) {
    out.push(node as El);
    walk((node as El).props.children, out);
  }
  return out;
}
const text = (node: unknown): string =>
  Array.isArray(node) ? node.map(text).join("") : typeof node === "string" || typeof node === "number" ? String(node) : node && typeof node === "object" && "props" in node ? text((node as El).props.children) : "";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("loggedQuantity (h-addfood#7)", () => {
  it("keeps a small re-logged quantity instead of snapping it up to 0.1 servings", () => {
    // 5 g of a 100 g serving was stored as 0.05; re-logging it from Recents
    // must store what the preview showed, not double it.
    expect(loggedQuantity(0.05)).toBe(0.05);
    expect(loggedQuantity(toServings(5, "g", { servingGrams: 100 } as never))).toBe(0.05);
  });

  it("keeps three decimals and still has a positive floor", () => {
    expect(loggedQuantity(0.333)).toBe(0.333);
    expect(loggedQuantity(1.5)).toBe(1.5);
    expect(loggedQuantity(0.0001)).toBe(0.001);
  });
});

describe("ScanMode when the barcode lookup throws (h-addfood#4)", () => {
  beforeEach(() => vi.mocked(lookupBarcode).mockReset());

  it("shows a retry message and remounts the scanner instead of freezing", async () => {
    vi.mocked(lookupBarcode).mockRejectedValueOnce(new Error("bad body")).mockResolvedValueOnce(null);
    const m = mount(ScanMode as (p: unknown) => unknown, { onPick: vi.fn() });
    const scanner = () => walk(m.tree).find((e) => e.type === BarcodeScanner)!;
    const keyBefore = scanner().key;

    await scanner().props.onDetected("5000112637922");
    m.render();
    expect(text(m.tree)).toContain("Couldn't look that up");
    expect(scanner().key).not.toBe(keyBefore);

    // The lookup lock was released, so the fresh scanner can try again.
    await scanner().props.onDetected("5000112637922");
    expect(lookupBarcode).toHaveBeenCalledTimes(2);
  });
});

describe("AiMode (h-addfood#5, h-addfood#11)", () => {
  const item = (n: string): FoodItem =>
    ({ id: n, name: n, servingSize: "1", perServing: { calories: 100, protein: 1, carbs: 1, fat: 1 }, source: "custom" }) as FoodItem;

  const withEstimate = async (names: string[], onLogged = vi.fn()) => {
    vi.mocked(parseMealWithGroup).mockResolvedValue({ outcome: "ok", items: names.map(item), groupName: "" } as never);
    const m = mount(AiMode as (p: unknown) => unknown, { date: "2026-09-30", meal: "lunch", onLogged });
    walk(m.tree).find((e) => e.type === "button" && text(e) === "Estimate")!.props.onClick();
    await flush();
    m.render();
    return { m, onLogged };
  };
  const logBtn = (m: { tree: unknown }) =>
    walk(m.tree).find((e) => e.type === "button" && /btn primary block/.test(e.props.className ?? ""))!;

  it("a double tap on Log logs each item once and disables the button meanwhile", async () => {
    const adds: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.mocked(getRepository).mockResolvedValue({
      addDiaryEntry: async (e: { food: FoodItem }) => {
        await gate;
        adds.push(e.food.name);
      },
    } as never);
    const { m, onLogged } = await withEstimate(["a", "b", "c"]);

    const first = logBtn(m).props.onClick();
    const second = logBtn(m).props.onClick();
    m.render();
    expect(logBtn(m).props.disabled).toBe(true);
    release();
    await Promise.all([first, second]);

    expect(adds).toEqual(["a", "b", "c"]);
    expect(onLogged).toHaveBeenCalledTimes(1);
  });

  it("after a mid-way failure only the unsaved items stay listed, so a retry cannot duplicate", async () => {
    const adds: string[] = [];
    vi.mocked(getRepository).mockResolvedValue({
      addDiaryEntry: async (e: { food: FoodItem }) => {
        if (e.food.name === "b") throw new Error("disk full");
        adds.push(e.food.name);
      },
    } as never);
    const { m, onLogged } = await withEstimate(["a", "b", "c"]);

    await logBtn(m).props.onClick();
    m.render();
    expect(onLogged).not.toHaveBeenCalled();
    expect(text(m.tree)).toContain("Couldn't save everything");
    expect(text(m.tree)).toContain("Log 2 items");
    expect(logBtn(m).props.disabled).toBe(false);
    expect(adds).toEqual(["a"]);
  });

  it("re-tapping the active tab keeps the estimate; switching tabs still clears it", async () => {
    const { m } = await withEstimate(["a", "b"]);
    const tab = (label: string) => walk(m.tree).find((e) => e.props.role === "tab" && text(e) === label)!;

    tab("Describe to AI").props.onClick();
    m.render();
    expect(text(m.tree)).toContain("Log 2 items");

    tab("Scan Food/Meal").props.onClick();
    m.render();
    expect(text(m.tree)).not.toContain("Log 2 items");
  });
});
