// @vitest-environment jsdom
/**
 * Withdrawing consent to collect health data, from Settings, including when
 * clearing the stored agreement fails (found in the ConjureOS #1156 review).
 *
 * Collection stops for the session either way, but the next session reads
 * the file: a withdrawal that was not saved leaves the old agreement in force
 * after a reload. It used to pass in silence. The agreement screen says so
 * and offers a retry.
 *
 * The app goes to that screen at once, whatever the save does. Holding it
 * open behind Settings while the notice showed left every screen mounted, so
 * whatever they run (the diary reading workouts, the shared summary being
 * rewritten) carried on after the person had withdrawn.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** What each withdrawal's write does, in order; the last one repeats. */
let saves: boolean[] = [];
/** When set, the next withdrawal's write waits for this to be called. */
let holdNext: ((finish: (saved: boolean) => void) => void) | null = null;
let withdrawn = false;
const withdrawHealthConsent = vi.fn(async () => {
  withdrawn = true;
  if (holdNext) {
    const hold = holdNext;
    holdNext = null;
    return new Promise<boolean>((resolve) => hold(resolve));
  }
  return saves.length > 1 ? saves.shift()! : (saves[0] ?? true);
});
const writeNutritionSummary = vi.fn(async () => {});

vi.mock("./bridge/actions", () => ({ registerActions: async () => {} }));
vi.mock("./features/healthConsent", () => ({
  loadHealthConsent: async () => true,
  recordHealthConsent: async () => {
    withdrawn = false;
    return true;
  },
  healthConsentGranted: () => !withdrawn,
  withdrawHealthConsent: () => withdrawHealthConsent(),
}));
vi.mock("./features/aiConsent", async (orig) => ({
  ...(await orig<typeof import("./features/aiConsent")>()),
  readAiJournalConsent: async () => undefined,
}));
vi.mock("./bridge/intents", () => ({ readLaunchIntent: async () => null }));
vi.mock("./features/sharedSummary", () => ({ writeNutritionSummary: () => writeNutritionSummary() }));
vi.mock("./features/plan/planService", async (orig) => ({
  ...(await orig<typeof import("./features/plan/planService")>()),
  loadPlan: async () => null,
}));
vi.mock("./data/repository", () => {
  const repo = new Proxy(
    {},
    {
      get: (_t, key) =>
        key === "then"
          ? undefined
          : async () =>
              key === "getGoals"
                ? { calories: 2000, protein: 120, carbs: 200, fat: 67 }
                : String(key).startsWith("list")
                  ? []
                  : null,
    },
  );
  return { getRepository: async () => repo };
});

import { App } from "./App";
import { notifyDataChanged } from "./features/dataEvents";
import { WITHDRAW_NOT_SAVED } from "./features/healthConsentCopy";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  saves = [];
  holdNext = null;
  withdrawn = false;
  withdrawHealthConsent.mockClear();
  writeNutritionSummary.mockClear();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const settle = (ms = 0) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

async function openSettings() {
  await act(async () => {
    root.render(<App />);
  });
  await settle();
  const cog = host.querySelector<HTMLButtonElement>('button[aria-label="Settings"]');
  expect(cog).not.toBeNull();
  await act(async () => cog!.click());
  await settle();
}

function button(label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
}

async function click(label: string) {
  const b = button(label);
  expect(b, `a "${label}" button`).toBeDefined();
  await act(async () => b!.click());
  await settle();
}

const withdraw = () => click("Withdraw consent to collect health data");
const onAgreementScreen = () => !!button("Agree and continue");
/** Anything of the app itself still mounted: its header carries the cog. */
const appMounted = () => !!host.querySelector('button[aria-label="Settings"]');
const notice = () => host.querySelector('[role="alert"]')?.textContent ?? "";

describe("withdrawing consent from Settings", () => {
  it("goes to the agreement screen when the withdrawal is saved", async () => {
    saves = [true];
    await openSettings();
    await withdraw();
    expect(withdrawHealthConsent).toHaveBeenCalledTimes(1);
    expect(onAgreementScreen()).toBe(true);
    expect(appMounted()).toBe(false);
    expect(notice()).not.toContain(WITHDRAW_NOT_SAVED);
  });

  it("leaves the app at once, before the save has finished", async () => {
    let finish: (saved: boolean) => void = () => {};
    holdNext = (f) => (finish = f);
    await openSettings();
    await withdraw();
    // The write is still in progress: the app is gone all the same.
    expect(onAgreementScreen()).toBe(true);
    expect(appMounted()).toBe(false);
    expect(notice()).toBe("");
    // It fails: the agreement screen says so.
    await act(async () => finish(false));
    await settle();
    expect(notice()).toContain(WITHDRAW_NOT_SAVED);
  });

  it("says on the agreement screen that it was not saved, and offers a retry", async () => {
    saves = [false];
    await openSettings();
    await withdraw();
    expect(onAgreementScreen()).toBe(true);
    expect(appMounted()).toBe(false);
    expect(notice()).toContain(WITHDRAW_NOT_SAVED);
    expect(button("Try again")).toBeDefined();
  });

  it("leaves nothing running behind it: a data change does not rewrite the shared summary", async () => {
    saves = [false];
    await openSettings();
    await withdraw();
    const before = writeNutritionSummary.mock.calls.length;
    // What Reset health data, or another app's write, sets off.
    act(() => notifyDataChanged());
    // The summary settles for 1.5s before it writes.
    await settle(1700);
    expect(writeNutritionSummary.mock.calls.length).toBe(before);
  });

  it("clears the notice once a retry saves it, without asking again", async () => {
    saves = [false, true];
    await openSettings();
    await withdraw();
    await click("Try again");
    expect(withdrawHealthConsent).toHaveBeenCalledTimes(2);
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(onAgreementScreen()).toBe(true);
    expect(notice()).not.toContain(WITHDRAW_NOT_SAVED);
  });

  it("keeps saying so while a retry fails too", async () => {
    saves = [false, false];
    await openSettings();
    await withdraw();
    await click("Try again");
    expect(withdrawHealthConsent).toHaveBeenCalledTimes(2);
    expect(notice()).toContain(WITHDRAW_NOT_SAVED);
  });

  it("does not let the person agree while a retry is clearing the file", async () => {
    saves = [false];
    await openSettings();
    await withdraw();
    const box = host.querySelector<HTMLInputElement>('.consent-toggle input[type="checkbox"]');
    await act(async () => box!.click());
    expect(button("Agree and continue")!.disabled).toBe(false);
    let finish: (saved: boolean) => void = () => {};
    holdNext = (f) => (finish = f);
    await click("Try again");
    expect(button("Withdrawing…")?.disabled).toBe(true);
    expect(button("Agree and continue")!.disabled).toBe(true);
    await act(async () => finish(true));
    await settle();
    expect(button("Agree and continue")!.disabled).toBe(false);
    expect(notice()).toBe("");
  });

  it("drops the notice when the person agrees again", async () => {
    saves = [false];
    await openSettings();
    await withdraw();
    const box = host.querySelector<HTMLInputElement>('.consent-toggle input[type="checkbox"]');
    await act(async () => box!.click());
    await click("Agree and continue");
    await settle();
    expect(appMounted()).toBe(true);
    expect(notice()).not.toContain(WITHDRAW_NOT_SAVED);
  });

  it("keeps the not-saved copy to the copy rules", () => {
    expect(WITHDRAW_NOT_SAVED).not.toMatch(/—|\bnow\b|no longer|\byet\b/i);
  });
});
