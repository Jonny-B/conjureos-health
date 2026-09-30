import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FoodItem } from "../types";

// vitest here is plain node (no jsdom), so the component is driven through a
// tiny hook runtime: enough useState/useRef/useMemo/useEffect to call the
// function components and walk the element tree they return.
const rt = vi.hoisted(() => {
  interface Inst {
    slots: unknown[];
    i: number;
    effects: Array<() => void | (() => void)>;
    cleanups: Array<() => void>;
    ran: boolean;
  }
  const state: { cur: Inst | null } = { cur: null };
  const newInst = (): Inst => ({ slots: [], i: 0, effects: [], cleanups: [], ran: false });
  const useState = (init: unknown) => {
    const inst = state.cur!;
    const idx = inst.i++;
    if (!(idx in inst.slots)) {
      inst.slots[idx] = { v: typeof init === "function" ? (init as () => unknown)() : init };
    }
    const slot = inst.slots[idx] as { v: unknown };
    const set = (n: unknown) => {
      slot.v = typeof n === "function" ? (n as (p: unknown) => unknown)(slot.v) : n;
    };
    return [slot.v, set];
  };
  const useRef = (init: unknown) => {
    const inst = state.cur!;
    const idx = inst.i++;
    if (!(idx in inst.slots)) inst.slots[idx] = { current: init };
    return inst.slots[idx];
  };
  const useMemo = (fn: () => unknown) => {
    state.cur!.i++;
    return fn();
  };
  const useEffect = (fn: () => void | (() => void)) => {
    const inst = state.cur!;
    inst.i++;
    if (!inst.ran) inst.effects.push(fn);
  };
  return { state, newInst, hooks: { useState, useRef, useMemo, useEffect } };
});

vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), ...rt.hooks }));
vi.mock("../features/foods/conjureHealthDb", () => ({ contribute: vi.fn() }));

import { contribute } from "../features/foods/conjureHealthDb";
import { EditableNutritionPreview } from "./EditableNutritionPreview";
import { NumberField } from "./NumberField";

type El = { type: unknown; props: Record<string, any> };

function mount<P>(Comp: (p: P) => unknown, props: P) {
  const inst = rt.newInst();
  const m = {
    tree: null as unknown,
    render() {
      rt.state.cur = inst;
      inst.i = 0;
      m.tree = Comp(props);
      rt.state.cur = null;
      if (!inst.ran) {
        inst.ran = true;
        for (const e of inst.effects) {
          const c = e();
          if (typeof c === "function") inst.cleanups.push(c);
        }
      }
    },
    unmount() {
      inst.cleanups.forEach((c) => c());
    },
  };
  m.render();
  return m;
}

/** Flatten the tree, calling nested (hook-free) function components but
 *  leaving NumberField as a leaf so its props can be inspected. */
function walk(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => walk(n, out));
  else if (node && typeof node === "object" && "props" in node) {
    const el = node as El;
    out.push(el);
    if (typeof el.type === "function" && el.type !== NumberField) {
      walk((el.type as (p: unknown) => unknown)(el.props), out);
    } else {
      walk(el.props.children, out);
    }
  }
  return out;
}

const food = (over: Partial<FoodItem> = {}): FoodItem => ({
  id: "f1",
  name: "Test bar",
  servingSize: "1 bar",
  perServing: { calories: 200, protein: 5, carbs: 20, fat: 0 },
  source: "user",
  ...over,
} as FoodItem);

const fields = (m: { tree: unknown }) => walk(m.tree).filter((e) => e.type === NumberField);
const byLabel = (m: { tree: unknown }, label: string) =>
  fields(m).find((e) => e.props["aria-label"] === label)!;

describe("EditableNutritionPreview numeric fields keep what is typed (h-addfood#1)", () => {
  const mk = (over: Partial<FoodItem> = {}) =>
    mount(EditableNutritionPreview as (p: unknown) => unknown, {
      initial: food(over),
      source: "user_fix",
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    });

  it("uses raw-string NumberFields for calories, macros, grams and every micro, never a number-controlled input", () => {
    const m = mk();
    const open = walk(m.tree).find((e) => e.props["aria-controls"] === "more-nutrients")!;
    open.props.onClick();
    m.render();
    const labels = fields(m).map((e) => e.props["aria-label"]);
    for (const l of ["Calories per serving", "Protein (g)", "Carbs (g)", "Fat (g)", "Grams", "Fiber (g)", "Sodium (mg)", "Caffeine (mg)"]) {
      expect(labels).toContain(l);
    }
    // No leftover numeric <input> that re-renders from the parsed number.
    expect(walk(m.tree).filter((e) => e.type === "input" && e.props.inputMode)).toEqual([]);
  });

  it("routes a typed decimal into the food", () => {
    const m = mk();
    byLabel(m, "Fat (g)").props.onChange(0.5);
    byLabel(m, "Grams").props.onChange(28.4);
    m.render();
    expect(byLabel(m, "Fat (g)").props.value).toBe(0.5);
    expect(byLabel(m, "Grams").props.value).toBe(28.4);
    // A cleared or zero gram field means "unknown", not 0.
    byLabel(m, "Grams").props.onChange(0);
    m.render();
    expect(byLabel(m, "Grams").props.value).toBeUndefined();
    // A cleared macro is 0 (shown empty), as before.
    byLabel(m, "Fat (g)").props.onChange(undefined);
    m.render();
    expect(byLabel(m, "Fat (g)").props.value).toBeUndefined();
  });
});

describe("NumberField lets a decimal be typed one key at a time", () => {
  const typeKeys = (keys: string[]) => {
    const onChange = vi.fn();
    const m = mount(NumberField as (p: unknown) => unknown, { value: undefined, onChange, decimals: 1, min: 0 });
    let raw = "";
    for (const k of keys) {
      const input = (m.tree as El);
      input.props.onFocus?.();
      input.props.onChange({ target: { value: raw + k } });
      m.render();
      raw = (m.tree as El).props.value;
    }
    return { raw, emitted: onChange.mock.calls.map((c) => c[0]) };
  };

  it.each([
    [["0", ".", "5"], "0.5", 0.5],
    [["1", ".", "5"], "1.5", 1.5],
    [["2", "8", ".", "4"], "28.4", 28.4],
  ])("%j", (keys, raw, n) => {
    const r = typeKeys(keys);
    expect(r.raw).toBe(raw);
    expect(r.emitted.at(-1)).toBe(n);
  });

  it("a lone dot is held as text and never emits NaN", () => {
    const r = typeKeys(["."]);
    expect(r.raw).toBe(".");
    expect(r.emitted).toEqual([]);
  });
});

describe("Back while saving does not confirm (h-addfood#9)", () => {
  beforeEach(() => {
    vi.mocked(contribute).mockReset();
    vi.stubGlobal("window", { setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() });
  });

  const setup = (result: { ok: boolean }) => {
    let resolve!: (r: unknown) => void;
    vi.mocked(contribute).mockReturnValue(new Promise((r) => (resolve = r)) as never);
    const onConfirm = vi.fn();
    const m = mount(EditableNutritionPreview as (p: unknown) => unknown, {
      initial: food(),
      source: "user_fix",
      onConfirm,
      onCancel: vi.fn(),
    });
    const save = walk(m.tree).find((e) => e.type === "button" && /primary/.test(e.props.className ?? ""))!;
    const pending = save.props.onClick() as Promise<void>;
    return { m, onConfirm, pending, finish: () => resolve(result) };
  };

  it("success after unmount: onConfirm is not called", async () => {
    const { m, onConfirm, pending, finish } = setup({ ok: true });
    m.unmount();
    finish();
    await pending;
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("failure after unmount: no auto-advance timer is scheduled", async () => {
    const { m, onConfirm, pending, finish } = setup({ ok: false });
    m.unmount();
    finish();
    await pending;
    expect(window.setTimeout).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("success while still mounted still confirms", async () => {
    const { onConfirm, pending, finish } = setup({ ok: true });
    finish();
    await pending;
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
