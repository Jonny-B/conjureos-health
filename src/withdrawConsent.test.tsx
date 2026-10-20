// @vitest-environment jsdom
/**
 * Withdrawing consent to collect health data, from Settings, when clearing
 * the stored agreement fails (found in the ConjureOS #1156 review).
 *
 * Collection stops for the session either way, but the next session reads
 * the file: a withdrawal that was not saved leaves the old agreement in force
 * after a reload. It used to pass in silence, Settings closing onto the
 * agreement screen as if it had worked. Settings says it was not saved and
 * offers a retry.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** What each withdrawal's write does, in order; the last one repeats. */
let saves: boolean[] = [];
let withdrawn = false;
const withdrawHealthConsent = vi.fn(async () => {
  withdrawn = true;
  return saves.length > 1 ? saves.shift()! : (saves[0] ?? true);
});

vi.mock("./bridge/actions", () => ({ registerActions: async () => {} }));
vi.mock("./features/healthConsent", () => ({
  loadHealthConsent: async () => true,
  recordHealthConsent: async () => true,
  healthConsentGranted: () => !withdrawn,
  withdrawHealthConsent: () => withdrawHealthConsent(),
}));
vi.mock("./features/aiConsent", async (orig) => ({
  ...(await orig<typeof import("./features/aiConsent")>()),
  readAiJournalConsent: async () => undefined,
}));
vi.mock("./bridge/intents", () => ({ readLaunchIntent: async () => null }));
vi.mock("./features/sharedSummary", () => ({ writeNutritionSummary: async () => {} }));
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
import { WITHDRAW_NOT_SAVED } from "./screens/SettingsSheet";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  saves = [];
  withdrawn = false;
  withdrawHealthConsent.mockClear();
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

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
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

const settingsOpen = () => !!host.querySelector(".sheet h2") && host.querySelector(".sheet h2")!.textContent === "Settings";
const onAgreementScreen = () => !!button("Agree and continue");

describe("withdrawing consent from Settings", () => {
  it("goes to the agreement screen when the withdrawal is saved", async () => {
    saves = [true];
    await openSettings();
    await click("Withdraw consent to collect health data");
    expect(withdrawHealthConsent).toHaveBeenCalledTimes(1);
    expect(onAgreementScreen()).toBe(true);
    expect(host.textContent).not.toContain(WITHDRAW_NOT_SAVED);
  });

  it("says it was not saved, stays in Settings, and offers a retry", async () => {
    saves = [false];
    await openSettings();
    await click("Withdraw consent to collect health data");
    expect(settingsOpen()).toBe(true);
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(WITHDRAW_NOT_SAVED);
    expect(button("Try again")).toBeDefined();
    expect(onAgreementScreen()).toBe(false);
  });

  it("goes to the agreement screen once a retry saves it", async () => {
    saves = [false, true];
    await openSettings();
    await click("Withdraw consent to collect health data");
    await click("Try again");
    expect(withdrawHealthConsent).toHaveBeenCalledTimes(2);
    // The person confirmed once; a retry does not ask again.
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(onAgreementScreen()).toBe(true);
  });

  it("keeps saying so while a retry fails too", async () => {
    saves = [false, false];
    await openSettings();
    await click("Withdraw consent to collect health data");
    await click("Try again");
    expect(withdrawHealthConsent).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(WITHDRAW_NOT_SAVED);
  });

  it("still stops collection: closing Settings after a failed save shows the agreement screen", async () => {
    saves = [false];
    await openSettings();
    await click("Withdraw consent to collect health data");
    await click("Done");
    expect(onAgreementScreen()).toBe(true);
  });

  it("keeps the not-saved copy to the copy rules", () => {
    expect(WITHDRAW_NOT_SAVED).not.toMatch(/—|\bnow\b|no longer|\byet\b/i);
  });
});
