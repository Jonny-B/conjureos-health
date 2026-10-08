/**
 * Just enough of React's hooks to call a function component as a plain
 * function, run its effects, and press its buttons, with no DOM. The repo has
 * no DOM test environment, and a server render runs no effects, so a screen
 * whose bug lives in an effect (a load racing another load) cannot be tested
 * any other way.
 *
 * Tests only. A test file swaps it in for React's own hooks:
 *
 *   vi.mock("react", async (orig) => {
 *     const actual = await orig<typeof import("react")>();
 *     const { runtime } = await import("../testing/hooks");
 *     const api = { ...actual, ...runtime.hooks };
 *     return { ...api, default: api };
 *   });
 *
 * Child components are not rendered: they stay elements in the returned tree,
 * which is what lets a test read the props a screen hands them.
 */

import type { ReactElement, ReactNode } from "react";

type Slot = { v?: unknown; deps?: readonly unknown[]; cleanup?: void | (() => void); current?: unknown };

const changed = (a?: readonly unknown[], b?: readonly unknown[]) =>
  !a || !b || a.length !== b.length || a.some((d, k) => !Object.is(d, b[k]));

function createRuntime() {
  let slots: Slot[] = [];
  let i = 0;
  let pending: (() => void)[] = [];
  let dirty = false;

  const hooks = {
    useState<T>(init: T | (() => T)): [T, (v: T | ((p: T) => T)) => void] {
      const k = i++;
      const slot = (slots[k] ??= { v: typeof init === "function" ? (init as () => T)() : init });
      const set = (v: T | ((p: T) => T)) => {
        const next = typeof v === "function" ? (v as (p: T) => T)(slot.v as T) : v;
        if (!Object.is(next, slot.v)) {
          slot.v = next;
          dirty = true;
        }
      };
      return [slot.v as T, set];
    },
    useMemo<T>(fn: () => T, deps: readonly unknown[]): T {
      const k = i++;
      const slot = slots[k];
      if (!slot || changed(slot.deps, deps)) slots[k] = { v: fn(), deps };
      return slots[k]!.v as T;
    },
    useCallback<T>(fn: T, deps: readonly unknown[]): T {
      return hooks.useMemo(() => fn, deps);
    },
    useRef<T>(init: T): { current: T } {
      const k = i++;
      return (slots[k] ??= { current: init }) as { current: T };
    },
    useEffect(fn: () => void | (() => void), deps?: readonly unknown[]): void {
      const k = i++;
      const slot = slots[k];
      if (slot && !changed(slot.deps, deps)) return;
      const s: Slot = (slots[k] = { deps, cleanup: slot?.cleanup });
      pending.push(() => {
        if (typeof s.cleanup === "function") s.cleanup();
        s.cleanup = fn();
      });
    },
  };

  /** Forget every component's state, between tests. */
  function reset(): void {
    slots = [];
    pending = [];
    dirty = false;
  }

  /**
   * Render, run the effects that render scheduled, let promises settle, and
   * render again for as long as state keeps changing. Returns the last tree.
   */
  async function render<P>(component: (props: P) => ReactNode, props: P): Promise<ReactNode> {
    for (let pass = 0; pass < 100; pass++) {
      i = 0;
      dirty = false;
      const tree = component(props);
      const run = pending;
      pending = [];
      for (const effect of run) effect();
      await new Promise((r) => setTimeout(r, 0));
      if (!dirty && pending.length === 0) return tree;
    }
    throw new Error("the component never settled");
  }

  return { hooks, reset, render };
}

/** The one runtime a test file's React mock and its tests share. */
export const runtime = createRuntime();

type Element = ReactElement<Record<string, unknown>>;

/** Every element in a tree, depth first. */
export function* elements(node: ReactNode): Generator<Element> {
  if (Array.isArray(node)) {
    for (const n of node) yield* elements(n as ReactNode);
    return;
  }
  if (node && typeof node === "object" && "props" in node) {
    const el = node as Element;
    yield el;
    yield* elements(el.props.children as ReactNode);
  }
}

/** The text directly inside an element and its DOM children. */
export function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((n) => textOf(n as ReactNode)).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textOf((node as Element).props.children as ReactNode);
  }
  return "";
}

/** The button whose label or text matches. Throws when there is none. */
export function button(tree: ReactNode, name: string | RegExp): Element {
  for (const el of elements(tree)) {
    if (el.type !== "button") continue;
    const label = `${String(el.props["aria-label"] ?? "")} ${textOf(el)}`;
    if (typeof name === "string" ? label.includes(name) : name.test(label)) return el;
  }
  throw new Error(`no button ${String(name)}`);
}
