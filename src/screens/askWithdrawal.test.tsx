// @vitest-environment jsdom
/**
 * Withdrawing the AI agreement, driven through the real screens, the real
 * sheet and Settings (owner decision 2026-10-22, ConjureOS #1163):
 * "Withdrawn consent means they have withdrawn consent."
 *
 * An open Ask Health sheet lets go of its conversation the moment the
 * withdrawal lands and sends no follow-up; an answer still on its way is
 * thrown away, whether or not the sheet is open; Settings clears the stored
 * conversation and says when the withdrawal could not be saved; and agreeing
 * again opens a fresh conversation. `features/ask/withdrawal.test.ts` checks
 * the same rules on `askHealth` itself. Only the AI call, the files and the
 * stored profile and journal are stand-ins.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { Profile } from "../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const complete = vi.fn();
const files: Record<string, string> = {};
let writesFail = false;
let profileSaveFails = false;

vi.mock("../bridge/ai", async (orig) => ({
  ...(await orig<typeof import("../bridge/ai")>()),
  complete: (...a: unknown[]) => complete(...a),
  isAiAvailable: () => true,
}));
vi.mock("../bridge/vfs", () => ({
  readJson: async (p: string, d: unknown) => (files[p] ? JSON.parse(files[p]!) : d),
  writeJson: async (p: string, v: unknown) => {
    if (!writesFail) files[p] = JSON.stringify(v);
  },
  writeJsonOrThrow: async (p: string, v: unknown) => {
    if (writesFail) throw new Error("vfs offline");
    files[p] = JSON.stringify(v);
  },
  vfs: { rm: async (p: string) => void delete files[p] },
}));

const TODAY = "2026-10-20";
let profile: Profile;

vi.mock("../data/repository", () => ({
  getRepository: async () => ({
    getGoals: async () => ({ calories: 2200, protein: 150, carbs: 200, fat: 70 }),
    getPlan: async () => null,
    getProfile: async () => profile,
    saveProfile: async (p: Profile) => {
      if (profileSaveFails) throw new Error("backend down");
      profile = p;
    },
    listDiary: async (d: string) =>
      d === TODAY || d === "2026-09-03"
        ? [{
            id: d, date: d, meal: "lunch", quantity: 1, loggedAt: `${d}T12:00:00Z`,
            food: { id: "f", source: "usda", name: d === TODAY ? "Greek yogurt" : "Aged cheddar",
              servingSize: "1 serving", perServing: { calories: 300, protein: 10, carbs: 30, fat: 10 } },
          }]
        : [],
    listWater: async () => [],
    listSleep: async () => [],
    listSymptoms: async (d: string) =>
      d === "2026-09-03" ? [{ id: `s-${d}`, label: "Migraine", loggedAt: `${d}T14:00:00Z`, severity: 4 }] : [],
    listWeights: async () => [],
  }),
}));
vi.mock("../features/exercise", async (orig) => ({
  ...(await orig<typeof import("../features/exercise")>()),
  exerciseCaloriesForDate: async () => 0,
  listCompletedWorkouts: async () => [],
}));
vi.mock("../components/WeightCard", () => ({ WeightCard: () => null }));
vi.mock("../components/WellbeingCard", () => ({ WellbeingCard: () => null }));
vi.mock("../components/PlanCard", () => ({ PlanCard: () => null }));

type Req = { system: string; messages: { role: string; content: string }[] };
const req = (n: number) => complete.mock.calls[n]![0] as Req;
const contents = (r: Req) => r.messages.map((m) => m.content);
const stored = () => JSON.parse(files["ask-health.json"] ?? "[]") as { content: string }[];
const bubbles = () => [...container.querySelectorAll(".chat-bubble:not(.thinking)")].map((b) => b.textContent);

let container: HTMLDivElement;
let root: Root;
let consent: typeof import("../features/aiConsent");
let collection: typeof import("../features/healthConsent");

beforeEach(async () => {
  // A withdrawal holds for the session it happened in; each test is one.
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 20, 12, 0, 0));
  Element.prototype.scrollIntoView = () => {};
  complete.mockReset();
  complete.mockImplementation(async (r: Req) => `reply ${r.messages.length}`);
  for (const k of Object.keys(files)) delete files[k];
  writesFail = false;
  profileSaveFails = false;
  consent = await import("../features/aiConsent");
  // The app shows nothing that asks until the person agrees to it keeping
  // health data (components/HealthConsentGate), so every test starts agreed.
  files["health-consent.json"] = JSON.stringify({ acceptedAt: "2026-09-01T09:00:00.000Z", version: 1 });
  collection = await import("../features/healthConsent");
  expect(await collection.loadHealthConsent()).toBe(true);
  profile = {
    sex: "female", age: 34, heightCm: 168, weightKg: 70, activityLevel: "moderate",
    direction: "lose", units: "metric",
    aiJournalConsent: {
      version: consent.DISCLOSURE_VERSION,
      acceptedAt: new Date(2026, 9, 1, 9, 0, 0).toISOString(),
      includeNotes: false,
    },
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function settle() {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function render(el: ReactElement) {
  act(() => root.render(el));
  await settle();
}

/** Any button on the page: the consent sheet is drawn outside the screen on some lines. */
function button(text: string): HTMLButtonElement {
  const b = [...document.body.querySelectorAll("button")].find(
    (x) => x.textContent?.trim() === text || x.getAttribute("aria-label") === text,
  );
  if (!b) throw new Error(`no button "${text}"`);
  return b;
}

async function click(text: string) {
  act(() => button(text).click());
  await settle();
}

async function type(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`no input "${label}"`);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

async function pressEnter(label: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await settle();
}

async function home() {
  const { DiaryScreen } = await import("./DiaryScreen");
  await render(
    <DiaryScreen
      date={TODAY}
      goals={{ calories: 2200, protein: 150, carbs: 200, fat: 70 }}
      nonce={0}
      plan={null}
      profile={null}
      onChangeDate={() => {}}
      onOpenMeal={() => {}}
      onOpenPlan={() => {}}
      onOpenExercise={() => {}}
      onMutated={() => {}}
    />,
  );
}

async function withdraw() {
  await act(async () => {
    await consent.withdrawAiJournalConsent();
  });
  await settle();
}

describe("an open sheet, when the withdrawal lands", () => {
  it("lets go of the conversation and sends no follow-up from the home card", async () => {
    await home();
    await type("Ask Health a question", "what should I eat tonight?");
    await click("Ask");
    expect(bubbles()).toEqual(["what should I eat tonight?", "reply 1"]);

    await withdraw();
    expect(bubbles()).toEqual([]);
    expect(container.textContent).toContain("Ask Health sends nothing without your agreement");
    expect(button("Send").disabled).toBe(true);

    // Enter in the field is the other way to send.
    await type("Ask a follow-up", "and for dessert?");
    await pressEnter("Ask a follow-up");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(stored()).toEqual([]);
  });

  it("sends no follow-up from a Find patterns run, which would resend the month", async () => {
    const { JournalScreen } = await import("./JournalScreen");
    await render(<JournalScreen units="metric" nonce={0} />);
    await click("Previous month");
    await click("Find patterns");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(contents(req(0))[0]).toContain("Migraine");

    await withdraw();
    expect(bubbles()).toEqual([]);
    await type("Ask a follow-up", "what about the cheese?");
    await pressEnter("Ask a follow-up");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when the agreement went somewhere else, and keeps nothing on screen", async () => {
    await home();
    await type("Ask Health a question", "what should I eat tonight?");
    await click("Ask");
    // Withdrawn on another device: this session only sees the profile change.
    delete profile.aiJournalConsent;
    await type("Ask a follow-up", "and for dessert?");
    await click("Send");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(bubbles()).toEqual([]);
    expect(container.textContent).toContain("Ask Health sends nothing without your agreement");
  });
});

describe("an answer in flight when the withdrawal lands", () => {
  it("is thrown away with the sheet closed, and nothing is stored", async () => {
    let answer!: (s: string) => void;
    complete.mockImplementation(() => new Promise<string>((r) => (answer = r)));
    await home();
    await type("Ask Health a question", "what should I eat tonight?");
    await click("Ask");
    expect(complete).toHaveBeenCalledTimes(1);
    await click("Close");

    await withdraw();
    await act(async () => answer("the salmon"));
    await settle();
    expect(stored()).toEqual([]);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("is thrown away with the sheet open, and the sheet shows none of it", async () => {
    let answer!: (s: string) => void;
    complete.mockImplementation(() => new Promise<string>((r) => (answer = r)));
    await home();
    await type("Ask Health a question", "what should I eat tonight?");
    await click("Ask");

    await withdraw();
    await act(async () => answer("the salmon"));
    await settle();
    expect(bubbles()).toEqual([]);
    expect(container.textContent).not.toContain("the salmon");
    expect(stored()).toEqual([]);
  });
});

describe("withdrawing consent to keep health data, with an answer in flight", () => {
  // The app leaves for the agreement screen at once, which closes the sheet
  // (App.tsx). The question is already out: its answer is not kept.
  async function askThenClose() {
    let answer!: (s: string) => void;
    complete.mockImplementation(() => new Promise<string>((r) => (answer = r)));
    await home();
    await type("Ask Health a question", "what should I eat tonight?");
    await click("Ask");
    expect(complete).toHaveBeenCalledTimes(1);
    await click("Close");
    return (s: string) => answer(s);
  }

  it("keeps nothing of it: the conversation is health data", async () => {
    const answer = await askThenClose();
    await act(async () => {
      await collection.withdrawHealthConsent();
    });
    await act(async () => answer("the salmon"));
    await settle();
    expect(files["ask-health.json"] ?? "").not.toContain("salmon");
    expect(stored()).toEqual([]);
  });

  it("keeps nothing of it when the person agrees again before it lands", async () => {
    const answer = await askThenClose();
    await act(async () => {
      await collection.withdrawHealthConsent();
      await collection.recordHealthConsent();
    });
    await act(async () => answer("the salmon"));
    await settle();
    expect(stored()).toEqual([]);
  });

  it("keeps it when nothing changed (positive control)", async () => {
    const answer = await askThenClose();
    await act(async () => answer("the salmon"));
    await settle();
    expect(stored().map((m) => m.content)).toEqual(["what should I eat tonight?", "the salmon"]);
  });
});

describe("agreeing again", () => {
  it("opens a fresh conversation: nothing from before is shown or sent", async () => {
    await home();
    await type("Ask Health a question", "what should I eat tonight?");
    await click("Ask");
    await click("Close");
    expect(stored()).toHaveLength(2);

    await withdraw();
    vi.setSystemTime(new Date(2026, 9, 20, 12, 5, 0));
    await type("Ask Health a question", "and for dessert?");
    await click("Ask");
    // The consent sheet asks again first.
    await click("Send and ask");

    expect(complete).toHaveBeenCalledTimes(2);
    expect(contents(req(1))).toEqual(["and for dessert?"]);
    expect(bubbles()).toEqual(["and for dessert?", "reply 1"]);
  });
});

describe("Settings, under Privacy", () => {
  async function settings() {
    const { SettingsSheet } = await import("./SettingsSheet");
    await render(
      <SettingsSheet
        goals={{ calories: 2200, protein: 150, carbs: 200, fat: 70 }}
        profile={profile}
        onClose={() => {}}
        onSave={() => {}}
      />,
    );
  }

  it("clears the conversation when the agreement is withdrawn", async () => {
    files["ask-health.json"] = JSON.stringify([
      { role: "user", content: "what should I eat tonight?", at: new Date().toISOString() },
    ]);
    await settings();
    await click("Withdraw agreement");
    expect(stored()).toEqual([]);
    expect(profile.aiJournalConsent).toBeUndefined();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("says when the withdrawal was not saved, and Try again saves it", async () => {
    profileSaveFails = true;
    await settings();
    await click("Withdraw agreement");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(consent.AI_WITHDRAW_NOT_SAVED);
    // Nothing goes meanwhile.
    expect(await consent.hasAiJournalConsent()).toBe(false);

    profileSaveFails = false;
    await click("Try again");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(profile.aiJournalConsent).toBeUndefined();
  });
});
