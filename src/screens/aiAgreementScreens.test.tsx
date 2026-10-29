// @vitest-environment jsdom
/**
 * Every feature that sends anything to an AI asks for the AI agreement in
 * place, before it sends, and sends nothing after a withdrawal (owner decision
 * 2026-10-29, ConjureOS #1163): "If you remove consent, we should stop the plan
 * builder and photo, and you would have to re-agree."
 *
 * Driven through the real screens and the real consent sheet: Add food's AI
 * mode (a description or a photo of the meal), the package photos (a
 * nutrition label or the front), and the plan builder. Settings and the
 * consent sheet name every covered feature. `features/aiAgreement.test.ts`
 * checks the same rules on the features themselves. Only the AI call, the
 * camera, the files and the stored profile and diary are stand-ins.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { ChatImage } from "../bridge/ai";
import type { DiaryEntry, Profile } from "../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const complete = vi.fn();
const files: Record<string, string> = {};

vi.mock("../bridge/ai", async (orig) => ({
  ...(await orig<typeof import("../bridge/ai")>()),
  complete: (...a: unknown[]) => complete(...a),
  isAiAvailable: () => true,
}));
vi.mock("../bridge/vfs", () => ({
  readJson: async (p: string, d: unknown) => (files[p] ? JSON.parse(files[p]!) : d),
  writeJson: async (p: string, v: unknown) => void (files[p] = JSON.stringify(v)),
  writeJsonOrThrow: async (p: string, v: unknown) => void (files[p] = JSON.stringify(v)),
  vfs: { rm: async (p: string) => void delete files[p] },
}));

let profile: Profile | null;
let diary: DiaryEntry[];
vi.mock("../data/repository", () => ({
  getRepository: async () => ({
    getProfile: async () => profile,
    saveProfile: async (p: Profile) => void (profile = p),
    listWeights: async () => [],
    addDiaryEntry: async (e: Omit<DiaryEntry, "id" | "loggedAt">) => {
      const row = { ...e, id: `d${diary.length}`, loggedAt: new Date().toISOString() } as DiaryEntry;
      diary.push(row);
      return row;
    },
  }),
}));
// The camera: one button that hands back a photo, as the shutter does.
const PHOTO: ChatImage = { mediaType: "image/jpeg", data: "AAAA" };
vi.mock("../components/CameraCapture", () => ({
  CameraCapture: ({ onCapture }: { onCapture: (image: ChatImage, url: string) => void }) => (
    <button onClick={() => onCapture(PHOTO, "blob:photo")}>Shutter</button>
  ),
}));
vi.mock("../features/recentFoods", () => ({ recentFoodsForMeal: async () => [] }));
vi.mock("../bridge/recipeBridge", () => ({
  listRecipes: async () => [],
  markCooked: async () => {},
  getResolvedRecipeProviderName: () => null,
}));

const MEAL = JSON.stringify({
  items: [{ name: "Grilled chicken", servingSize: "6 oz", calories: 280, protein: 52, carbs: 0, fat: 6 }],
  groupName: "Grilled chicken",
});
const LABEL = JSON.stringify({
  name: "Oat bar", servingSize: "1 bar", servingGrams: 40, calories: 190, protein: 4, carbs: 29, fat: 7,
  confidence: 0.9,
});
const PLAN = JSON.stringify({
  summary: "A steady plan for you.",
  dailyCalorieTarget: 1800,
  goals: [
    { label: "Stay around 1800 kcal", kind: "nutrition" },
    { label: "Protein at every meal", kind: "nutrition" },
    { label: "Water before each meal", kind: "habit" },
  ],
});

let container: HTMLDivElement;
let root: Root;
let consent: typeof import("../features/aiConsent");

beforeEach(async () => {
  // A withdrawal holds for the session it happened in; each test is one.
  vi.resetModules();
  // The photo previews are object URLs, which jsdom does not have.
  URL.revokeObjectURL = () => {};
  complete.mockReset();
  for (const k of Object.keys(files)) delete files[k];
  profile = {
    sex: "female", age: 34, heightCm: 168, weightKg: 70, activityLevel: "moderate",
    direction: "lose", units: "metric",
  };
  diary = [];
  consent = await import("../features/aiConsent");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function settle(ms = 0) {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  if (ms) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
    await settle();
  }
}

async function render(el: ReactElement) {
  act(() => root.render(el));
  await settle();
}

function findButton(text: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll("button")].find(
    (x) => x.textContent?.trim() === text || x.getAttribute("aria-label") === text,
  );
}

function button(text: string): HTMLButtonElement {
  const b = findButton(text);
  if (!b) throw new Error(`no button "${text}"`);
  return b;
}

async function click(text: string, ms = 0) {
  act(() => button(text).click());
  await settle(ms);
}

async function typeInto(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

async function agree() {
  expect(await consent.recordAiJournalConsent(false)).toBe(true);
}

async function withdraw() {
  await act(async () => {
    await consent.withdrawAiJournalConsent();
  });
  await settle();
}

/** The consent sheet, while it is up. */
const sheet = () => document.body.querySelector(".consent-foot");

async function addFood() {
  const { AddFoodScreen } = await import("./AddFoodScreen");
  await render(
    <AddFoodScreen date="2026-10-29" defaultMeal="lunch" defaultMode="ai" onLogged={() => {}} onCancel={() => {}} />,
  );
}

const describeBox = () => container.querySelector<HTMLTextAreaElement>("textarea");

describe("Add food from a description or a photo", () => {
  it("is off before the person agrees, with one tap to the agreement, and sends nothing", async () => {
    await addFood();
    // Nothing to type a meal into, and no camera.
    expect(describeBox()).toBeNull();
    await click("Scan Food/Meal").catch(() => {});
    expect(findButton("Shutter")).toBeUndefined();
    expect(container.textContent).toContain("needs your agreement");

    await click("Review and agree");
    expect(sheet()).not.toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  it("works once the person agrees on the sheet", async () => {
    complete.mockImplementation(async () => MEAL);
    await addFood();
    await click("Review and agree");
    await click("Agree");
    expect(sheet()).toBeNull();
    await typeInto(describeBox()!, "grilled chicken");
    await click("Estimate");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Grilled chicken");
  });

  it("stays off after Not now, and sends nothing", async () => {
    await addFood();
    await click("Review and agree");
    await click("Not now");
    expect(sheet()).toBeNull();
    expect(describeBox()).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  it("is off after a withdrawal", async () => {
    await agree();
    await consent.withdrawAiJournalConsent();
    await addFood();
    expect(describeBox()).toBeNull();
    expect(button("Review and agree")).toBeDefined();
  });

  it("turns off when the withdrawal lands, and throws away an estimate still on its way", async () => {
    let answer!: (s: string) => void;
    complete.mockImplementation(() => new Promise<string>((r) => (answer = r)));
    await agree();
    await addFood();
    await typeInto(describeBox()!, "grilled chicken");
    await click("Estimate");
    expect(complete).toHaveBeenCalledTimes(1);

    await withdraw();
    await act(async () => answer(MEAL));
    await settle();
    expect(container.textContent).not.toContain("Grilled chicken");
    expect(describeBox()).toBeNull();
    expect(findButton("Review and agree")).toBeDefined();
    expect(diary).toEqual([]);
  });

  it("drops a photo estimate that lands after a withdrawal", async () => {
    let answer!: (s: string) => void;
    complete.mockImplementation(() => new Promise<string>((r) => (answer = r)));
    await agree();
    await addFood();
    await click("Scan Food/Meal");
    await click("Shutter");
    expect(complete).toHaveBeenCalledTimes(1);

    await withdraw();
    await act(async () => answer(MEAL));
    await settle();
    expect(container.textContent).not.toContain("Grilled chicken");
    expect(findButton("Shutter")).toBeUndefined();
  });
});

describe("package photos", () => {
  async function capture(onParsed: (r: unknown) => void) {
    const { PackageCapture } = await import("../components/PackageCapture");
    await render(<PackageCapture onParsed={onParsed} onCancel={() => {}} />);
    await click("Add Nutrition label");
    await click("Shutter");
  }

  // Off without the agreement, as Add food's AI mode is: the camera opens
  // only once the person has agreed (screens/aiAgreementReview.test.tsx).
  it("ask for the agreement in place before the camera, and send nothing first", async () => {
    complete.mockImplementation(async () => LABEL);
    const { PackageCapture } = await import("../components/PackageCapture");
    const parsed = vi.fn();
    await render(<PackageCapture onParsed={parsed} onCancel={() => {}} />);
    expect(findButton("Add Nutrition label")).toBeUndefined();
    await click("Review and agree");
    expect(sheet()).not.toBeNull();
    expect(complete).not.toHaveBeenCalled();

    await click("Agree");
    await click("Add Nutrition label");
    await click("Shutter");
    await click("Read the label");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(parsed).toHaveBeenCalledTimes(1);
  });

  it("send nothing after Not now, or after a withdrawal", async () => {
    complete.mockImplementation(async () => LABEL);
    const { PackageCapture } = await import("../components/PackageCapture");
    const parsed = vi.fn();
    await agree();
    await consent.withdrawAiJournalConsent();
    await render(<PackageCapture onParsed={parsed} onCancel={() => {}} />);
    expect(findButton("Add Nutrition label")).toBeUndefined();
    await click("Review and agree");
    expect(sheet()).not.toBeNull();
    await click("Not now");
    expect(complete).not.toHaveBeenCalled();
    expect(parsed).not.toHaveBeenCalled();
  });

  it("ask again in place when the agreement went on another device, and send only once agreed", async () => {
    complete.mockImplementation(async () => LABEL);
    const parsed = vi.fn();
    await agree();
    await capture(parsed);
    // Another device withdrew: the file is cleared, and this session is not told.
    files["ai-consent.json"] = "null";
    await click("Read the label");
    expect(sheet()).not.toBeNull();
    expect(complete).not.toHaveBeenCalled();
    await click("Send and read");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(parsed).toHaveBeenCalledTimes(1);
  });

  it("hand back nothing from a read that lands after a withdrawal", async () => {
    let answer!: (s: string) => void;
    complete.mockImplementation(() => new Promise<string>((r) => (answer = r)));
    const parsed = vi.fn();
    await agree();
    await capture(parsed);
    await click("Read the label");
    expect(complete).toHaveBeenCalledTimes(1);

    await withdraw();
    await act(async () => answer(LABEL));
    await settle();
    expect(parsed).not.toHaveBeenCalled();
  });
});

describe("the plan builder", () => {
  async function toBuild() {
    const { WizardScreen } = await import("./WizardScreen");
    await render(<WizardScreen onComplete={() => {}} profile={profile} />);
    await click("I understand");
    await click("Continue");
    await click("Continue");
  }
  // The builder dwells on its first stage so the spinner can be read.
  const BUILD_MS = 1200;

  it("asks for the agreement in place before building, and sends nothing first", async () => {
    complete.mockImplementation(async () => PLAN);
    await toBuild();
    await click("Build my plan", BUILD_MS);
    expect(sheet()).not.toBeNull();
    expect(complete).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Here's your plan");

    await click("Send and build my plan", BUILD_MS);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("A steady plan for you.");
  });

  it("sends nothing after Not now, or after a withdrawal", async () => {
    complete.mockImplementation(async () => PLAN);
    await agree();
    await consent.withdrawAiJournalConsent();
    await toBuild();
    await click("Build my plan", BUILD_MS);
    await click("Not now", BUILD_MS);
    expect(complete).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Here's your plan");
  });

  it("keeps nothing from a plan that lands after a withdrawal", async () => {
    let answer!: (s: string) => void;
    complete.mockImplementation(() => new Promise<string>((r) => (answer = r)));
    await agree();
    await toBuild();
    await click("Build my plan", BUILD_MS);
    expect(complete).toHaveBeenCalledTimes(1);

    await withdraw();
    await act(async () => answer(PLAN));
    await settle(BUILD_MS);
    expect(container.textContent).not.toContain("A steady plan for you.");
    expect(findButton("Start plan")).toBeUndefined();
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

/** The names a person knows the covered features by. */
const COVERED = [
  "Building a plan",
  "Adding food from a description",
  "Adding food from a photo",
  "Food estimates for ConjureOS's assistant and other apps",
  "Find patterns",
  "Ask Health",
];

const listItems = (html: string) =>
  [...html.matchAll(/<li[^>]*>(.*?)<\/li>/gs)].map((m) =>
    m[1]!.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").trim(),
  );

describe("the consent sheet and Settings name every covered feature", () => {
  it("on the consent sheet", async () => {
    const { AiConsentSheet } = await import("../components/AiConsentSheet");
    const html = renderToStaticMarkup(<AiConsentSheet purpose="plan" onAccept={() => {}} onCancel={() => {}} />);
    const items = listItems(html);
    for (const name of COVERED) expect(items).toContain(name);
  });

  it("in Settings, as the features the agreement covers", async () => {
    const { SettingsSheet } = await import("./SettingsSheet");
    await render(
      <SettingsSheet
        goals={{ calories: 2000, protein: 120, carbs: 200, fat: 67 }}
        profile={profile}
        onClose={() => {}}
        onSave={() => {}}
      />,
    );
    const block = container.querySelector(".privacy-block")!;
    const items = [...block.querySelectorAll("li")].map((li) => li.textContent?.trim());
    for (const name of COVERED) expect(items).toContain(name);
  });

  it("in Settings, saying withdrawing stops them all and agreeing again turns them back on", async () => {
    await agree();
    const { SettingsSheet } = await import("./SettingsSheet");
    await render(
      <SettingsSheet
        goals={{ calories: 2000, protein: 120, carbs: 200, fat: 67 }}
        profile={profile}
        onClose={() => {}}
        onSave={() => {}}
      />,
    );
    const text = container.querySelector(".privacy-block")!.textContent ?? "";
    expect(text).toContain("Withdrawing stops all of them at once");
    expect(text).toContain("To use them again, you agree again.");
    expect(text).not.toContain("—");
    expect(text).not.toMatch(/\b(now|no longer|yet)\b/i);
  });
});
