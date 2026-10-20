// @vitest-environment jsdom
/**
 * ConjureOS #1156: the cross-app actions are registered at startup, before
 * the person has agreed to let Conjure Health keep their health data.
 *
 * Each action checks the agreement itself and refuses with ConjureOS's
 * needs-consent marker (bridge/actions.test.ts), so registering early reads
 * and keeps nothing. Registering only after the agreement left an app that
 * answered nothing at all: ConjureOS waited out its timeout and told the
 * person the app "did not register the action it advertises".
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const registerActions = vi.fn(async () => {});
let agreed = false;

vi.mock("./bridge/actions", () => ({ registerActions: () => registerActions() }));
vi.mock("./features/healthConsent", () => ({
  loadHealthConsent: async () => agreed,
  recordHealthConsent: async () => true,
  withdrawHealthConsent: async () => {},
}));
vi.mock("./bridge/intents", () => ({ readLaunchIntent: async () => null }));
vi.mock("./features/sharedSummary", () => ({ writeNutritionSummary: async () => {} }));
vi.mock("./features/plan/planService", async (orig) => ({
  ...(await orig<typeof import("./features/plan/planService")>()),
  loadPlan: async () => null,
}));
// Every screen reads something: lists come back empty, goals as set, the rest
// as nothing on file.
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

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  registerActions.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const mount = async () => {
  await act(async () => {
    root.render(<App />);
  });
  // Let the consent read and the startup effects settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

describe("registering the cross-app actions", () => {
  it("happens at startup even before the person has agreed, while only the consent screen shows", async () => {
    agreed = false;
    await mount();
    expect(registerActions).toHaveBeenCalledTimes(1);
    expect(host.textContent ?? "").toMatch(/agree/i);
  });

  it("happens once for a person who has agreed", async () => {
    agreed = true;
    await mount();
    expect(registerActions).toHaveBeenCalledTimes(1);
  });
});
