// @vitest-environment jsdom
/**
 * ConjureOS #1230: when Chat needs this app's AI agreement, the host asks the
 * app to show it. The app shows the collection gate first when that is what
 * is missing, otherwise the agreement sheet for Chat, and answers without a
 * sheet when the agreement is already in force. Don't allow is recorded as a
 * refusal and reported; the summary Chat reads goes when the agreement does.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const files: Record<string, string> = {};
let collectionConsent = true;
const writeNutritionSummary = vi.fn(async () => {});
const removeNutritionSummary = vi.fn(async () => {});

vi.mock("./bridge/vfs", () => ({
  readJson: async (p: string, d: unknown) => (files[p] !== undefined ? JSON.parse(files[p]!) : d),
  writeJson: async (p: string, v: unknown) => void (files[p] = JSON.stringify(v)),
  writeJsonOrThrow: async (p: string, v: unknown) => void (files[p] = JSON.stringify(v)),
  vfs: {
    exists: async (p: string) => files[p] !== undefined,
    read: async (p: string) => files[p]!,
    rm: async (p: string) => void delete files[p],
  },
}));
vi.mock("./bridge/actions", () => ({ registerActions: async () => {} }));
vi.mock("./features/healthConsent", () => ({
  loadHealthConsent: async () => collectionConsent,
  recordHealthConsent: async () => true,
  healthConsentGranted: () => collectionConsent,
  withdrawHealthConsent: async () => true,
}));
vi.mock("./features/ask/conversationFile", () => ({ clearAskConversation: async () => true }));
vi.mock("./bridge/intents", () => ({ readLaunchIntent: async () => null }));
vi.mock("./features/sharedSummary", () => ({
  writeNutritionSummary: () => writeNutritionSummary(),
  removeNutritionSummary: () => removeNutritionSummary(),
}));
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
import { AI_CONSENT_PATH, DISCLOSURE_VERSION, withdrawAiJournalConsent } from "./features/aiConsent";

type Req = { id?: string; purpose?: "chat" };
let ask: (r: Req) => Promise<{ shown: boolean }>;
const reports: string[] = [];
let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  for (const k of Object.keys(files)) delete files[k];
  collectionConsent = true;
  reports.length = 0;
  writeNutritionSummary.mockClear();
  removeNutritionSummary.mockClear();
  (window as unknown as { __conjureos: unknown }).__conjureos = {
    ai: {
      reportAgreement: (s: string) => void reports.push(s),
      onAgreementRequest: (fn: typeof ask) => {
        ask = fn;
        return () => {};
      },
    },
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<App />));
  await settle();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as { __conjureos?: unknown }).__conjureos;
});

const settle = (ms = 0) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
const show = () => act(async () => void (result = await ask({ id: "1", purpose: "chat" })));
let result: { shown: boolean } | undefined;
const agree = () =>
  void (files[AI_CONSENT_PATH] = JSON.stringify({
    acceptedAt: "2026-11-01T09:00:00.000Z",
    version: DISCLOSURE_VERSION,
    includeNotes: false,
  }));

describe("a request from the host to show the agreement for Chat", () => {
  it("opens the agreement sheet with the Chat purpose", async () => {
    await show();
    expect(result).toEqual({ shown: true });
    expect(host.textContent).toContain("ConjureOS Chat asked to use your health data to answer you.");
    expect(button("Agree")).toBeDefined();
    expect(button("Don't allow")).toBeDefined();
  });

  it("answers without a sheet when the agreement is already in force", async () => {
    agree();
    await show();
    expect(result).toEqual({ shown: false });
    expect(button("Don't allow")).toBeUndefined();
  });

  it("puts the collection gate first when that consent is what is missing", async () => {
    collectionConsent = false;
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(<App />));
    await settle();
    await show();
    expect(result).toEqual({ shown: true });
    expect(button("Agree and continue")).toBeDefined();
    expect(button("Don't allow")).toBeUndefined();
  });

  it("records a refusal and reports it when the person says Don't allow", async () => {
    await show();
    await act(async () => button("Don't allow")!.click());
    await settle();
    const file = JSON.parse(files[AI_CONSENT_PATH]!);
    expect(typeof file.refusedAt).toBe("string");
    expect(file.version).toBe(DISCLOSURE_VERSION);
    expect(reports).toContain("refused");
    expect(button("Don't allow")).toBeUndefined();
  });

  it("records the agreement and reports it when the person agrees", async () => {
    await show();
    await act(async () => button("Agree")!.click());
    await settle();
    expect(JSON.parse(files[AI_CONSENT_PATH]!).version).toBe(DISCLOSURE_VERSION);
    expect(reports).toEqual(["agreed"]);
    expect(button("Don't allow")).toBeUndefined();
  });

  it("closes without recording anything when the person taps outside", async () => {
    await show();
    await act(async () => host.querySelector<HTMLElement>(".sheet-backdrop")!.click());
    expect(files[AI_CONSENT_PATH]).toBeUndefined();
    expect(reports).toEqual([]);
  });
});

describe("the summary Chat reads follows the agreement", () => {
  it("is not written without the agreement, and is once the person agrees", async () => {
    await settle(1700);
    expect(writeNutritionSummary).not.toHaveBeenCalled();
    await show();
    await act(async () => button("Agree")!.click());
    await settle(1700);
    expect(writeNutritionSummary).toHaveBeenCalled();
  });

  it("is removed when the AI agreement is withdrawn", async () => {
    agree();
    await act(async () => void (await withdrawAiJournalConsent()));
    expect(removeNutritionSummary).toHaveBeenCalled();
  });
});
