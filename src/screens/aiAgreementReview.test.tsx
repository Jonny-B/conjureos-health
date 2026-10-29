// @vitest-environment jsdom
/**
 * Review of the AI agreement change (ConjureOS #1163, Health PR #20), driven
 * through the real screens and the real consent sheet:
 *
 *   - A package reading on screen (Scan's photo route, and "Looks wrong?") is
 *     let go when the agreement is withdrawn: nothing of it is logged, sent
 *     to the food database or stored as a correction afterwards. Ask Health
 *     and Add food's AI mode already let go of what they hold.
 *   - Package photos are off without the agreement, the same way Add food's
 *     AI mode is: no camera, a line saying they use the AI, one tap to agree.
 *   - Settings can give the agreement, since that is where the refusal other
 *     apps get (NEEDS_CONSENT) sends the person.
 *   - Wizard step 2 says which answers go to the AI, and that the safety
 *     check's do not.
 *
 * Only the AI call, the camera, the barcode scanner, the files, the food
 * lookups and the stored profile and diary are stand-ins.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { ChatImage } from "../bridge/ai";
import type { DiaryEntry, FoodItem, Profile } from "../types";

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
const PHOTO: ChatImage = { mediaType: "image/jpeg", data: "AAAA" };
vi.mock("../components/CameraCapture", () => ({
  CameraCapture: ({ onCapture }: { onCapture: (image: ChatImage, url: string) => void }) => (
    <button onClick={() => onCapture(PHOTO, "blob:photo")}>Shutter</button>
  ),
}));
// The scanner: its "snap a photo" shortcut, and a scan that reads a barcode.
const MISSED = "0123456789012";
vi.mock("../components/BarcodeScanner", () => ({
  BarcodeScanner: ({ onSnapPhoto, onDetected }: { onSnapPhoto?: () => void; onDetected: (code: string) => void }) => (
    <>
      <button onClick={onSnapPhoto}>Snap a photo</button>
      <button onClick={() => onDetected(MISSED)}>Read a barcode</button>
    </>
  ),
}));
const KNOWN: FoodItem = {
  id: "oat-bar",
  source: "openfoodfacts",
  name: "Oat bar",
  barcode: MISSED,
  perServing: { calories: 150, protein: 3, carbs: 25, fat: 5 },
  servingSize: "1 bar",
};
const lookupBarcode = vi.fn<(code: string) => Promise<FoodItem | null>>();
const rememberCorrection = vi.fn<(code: string, food: FoodItem) => Promise<void>>();
vi.mock("../features/foods/foodSearch", async (orig) => ({
  ...(await orig<typeof import("../features/foods/foodSearch")>()),
  lookupBarcode: (code: string) => lookupBarcode(code),
  rememberCorrection: (code: string, food: FoodItem) => rememberCorrection(code, food),
}));
// Sending a reviewed food in to the shared food database.
const contribute = vi.fn();
vi.mock("../features/foods/conjureHealthDb", async (orig) => ({
  ...(await orig<typeof import("../features/foods/conjureHealthDb")>()),
  contribute: (...a: unknown[]) => contribute(...a),
}));
vi.mock("../features/recentFoods", () => ({ recentFoodsForMeal: async () => [] }));
vi.mock("../bridge/recipeBridge", () => ({
  listRecipes: async () => [],
  markCooked: async () => {},
  getResolvedRecipeProviderName: () => null,
}));

const LABEL = JSON.stringify({
  name: "Granola square", servingSize: "1 bar", servingGrams: 40, calories: 190, protein: 4, carbs: 29, fat: 7,
  confidence: 0.9,
});

let container: HTMLDivElement;
let root: Root;
let consent: typeof import("../features/aiConsent");

beforeEach(async () => {
  // A withdrawal holds for the session it happened in; each test is one.
  vi.resetModules();
  URL.revokeObjectURL = () => {};
  complete.mockReset();
  complete.mockImplementation(async () => LABEL);
  lookupBarcode.mockReset();
  lookupBarcode.mockImplementation(async () => null);
  rememberCorrection.mockReset();
  rememberCorrection.mockImplementation(async () => {});
  contribute.mockReset();
  contribute.mockImplementation(async () => ({ ok: true }));
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

/** A button whose text is, or starts with, `text`, or whose label is `text`. */
function findButton(text: string): HTMLButtonElement | undefined {
  const all = [...document.body.querySelectorAll("button")];
  return (
    all.find((x) => x.textContent?.trim() === text || x.getAttribute("aria-label") === text) ??
    all.find((x) => x.textContent?.trim().startsWith(text))
  );
}

async function click(text: string) {
  const b = findButton(text);
  if (!b) throw new Error(`no button "${text}" in: ${document.body.textContent}`);
  act(() => b.click());
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
/** The review screen a package reading lands on. */
const preview = () => container.querySelector<HTMLInputElement>('input[aria-label="Product name"]');
const text = () => container.textContent ?? "";

function expectCopyRules(s: string) {
  expect(s).not.toContain("—");
  expect(s).not.toMatch(/\b(now|no longer|yet)\b/i);
}

async function addFood(props: { defaultMode?: "scan" | "search"; initialBarcode?: string } = {}) {
  const { AddFoodScreen } = await import("./AddFoodScreen");
  await render(
    <AddFoodScreen
      date="2026-10-29"
      defaultMeal="lunch"
      defaultMode={props.defaultMode ?? "scan"}
      initialBarcode={props.initialBarcode}
      onLogged={() => {}}
      onCancel={() => {}}
    />,
  );
}

/** Photograph a nutrition label and read it, under an agreement in force. */
async function readALabel() {
  await click("Add Nutrition label");
  await click("Shutter");
  await click("Read the label");
  expect(complete).toHaveBeenCalledTimes(1);
  expect(preview()?.value).toBe("Granola square");
}

describe("a package reading on screen is let go when the agreement is withdrawn", () => {
  it("Scan's photo route: the reading is dropped, and nothing is logged or sent in", async () => {
    await agree();
    await addFood();
    await click("Snap a photo");
    await readALabel();

    await withdraw();
    expect(preview()).toBeNull();
    expect(text()).not.toContain("Granola square");
    expect(findButton("Looks good, log it")).toBeUndefined();
    expect(contribute).not.toHaveBeenCalled();
    expect(diary).toEqual([]);
  });

  it("a barcode miss: the reading is dropped the same way", async () => {
    await agree();
    await addFood();
    await click("Read a barcode");
    expect(text()).toContain(MISSED);
    await readALabel();

    await withdraw();
    expect(preview()).toBeNull();
    expect(contribute).not.toHaveBeenCalled();
  });

  it("Looks wrong?: the reading is dropped, and no correction is stored", async () => {
    lookupBarcode.mockImplementation(async () => KNOWN);
    await agree();
    await addFood({ defaultMode: "search", initialBarcode: MISSED });
    await click("Looks wrong?");
    await click("Photograph the package");
    await readALabel();

    await withdraw();
    expect(preview()).toBeNull();
    expect(findButton("Looks good, log it")).toBeUndefined();
    expect(rememberCorrection).not.toHaveBeenCalled();
    expect(contribute).not.toHaveBeenCalled();
  });

  it("a save that is under way when the withdrawal lands hands nothing on to be logged", async () => {
    let answered!: (r: { ok: boolean }) => void;
    contribute.mockImplementation(() => new Promise((r) => (answered = r)));
    await agree();
    await addFood();
    await click("Snap a photo");
    await readALabel();
    await click("Looks good, log it");
    expect(contribute).toHaveBeenCalledTimes(1);

    await withdraw();
    await act(async () => answered({ ok: true }));
    await settle();
    expect(text()).not.toContain("Granola square");
    expect(findButton("Add to Lunch")).toBeUndefined();
    expect(diary).toEqual([]);
  });

  it("keeps the reading when nothing was withdrawn (positive control)", async () => {
    await agree();
    await addFood();
    await click("Snap a photo");
    await readALabel();
    await click("Looks good, log it");
    expect(findButton("Add to Lunch")).toBeDefined();
  });
});

describe("package photos are off without the agreement, as Add food's AI mode is", () => {
  async function capture(onParsed: (r: unknown) => void = () => {}) {
    const { PackageCapture } = await import("../components/PackageCapture");
    await render(<PackageCapture onParsed={onParsed} onCancel={() => {}} />);
  }

  it("before agreeing: no camera, a line saying they use the AI, and one tap to agree", async () => {
    await capture();
    expect(findButton("Add Nutrition label")).toBeUndefined();
    expect(findButton("Add Front of package")).toBeUndefined();
    expect(text()).toContain("Reading a package photo uses the AI, and needs your agreement first.");
    expectCopyRules(text());

    await click("Review and agree");
    expect(sheet()).not.toBeNull();
    // Agreeing here sends nothing at once: there is no photo to send.
    await click("Agree");
    expect(sheet()).toBeNull();
    expect(findButton("Add Nutrition label")).toBeDefined();
    expect(complete).not.toHaveBeenCalled();
  });

  it("after Not now they stay off, and still say why", async () => {
    await capture();
    await click("Review and agree");
    await click("Not now");
    expect(findButton("Add Nutrition label")).toBeUndefined();
    expect(text()).toContain("needs your agreement first");
    expect(complete).not.toHaveBeenCalled();
  });

  it("turn off when the agreement is withdrawn", async () => {
    await agree();
    await capture();
    expect(findButton("Add Nutrition label")).toBeDefined();
    await withdraw();
    expect(findButton("Add Nutrition label")).toBeUndefined();
    expect(findButton("Review and agree")).toBeDefined();
  });

  it("the routes to them say the AI reads the photos", async () => {
    // A barcode miss.
    await addFood();
    await click("Read a barcode");
    const miss = container.querySelector(".snap-miss-head")?.textContent ?? "";
    expect(miss).toMatch(/\bAI\b/);
    expect(miss).not.toContain("we'll do the rest");
    expectCopyRules(miss);
  });

  it("Looks wrong? says the AI reads the photos", async () => {
    lookupBarcode.mockImplementation(async () => KNOWN);
    await addFood({ defaultMode: "search", initialBarcode: MISSED });
    await click("Looks wrong?");
    const cta = findButton("Photograph the package")!.textContent ?? "";
    expect(cta).toMatch(/\bAI\b/);
    expectCopyRules(cta);
  });
});

describe("Settings can give the agreement", () => {
  async function settings() {
    const { SettingsSheet } = await import("./SettingsSheet");
    await render(
      <SettingsSheet
        goals={{ calories: 2000, protein: 120, carbs: 200, fat: 67 }}
        profile={profile}
        onClose={() => {}}
        onSave={() => {}}
      />,
    );
  }
  const privacy = () => container.querySelector(".privacy-block")?.textContent ?? "";

  it("offers it when there is none, shows what would be sent, and sends nothing on agreeing", async () => {
    await settings();
    await click("Review and agree");
    expect(sheet()).not.toBeNull();
    expect(document.body.querySelector(".consent-sample")).not.toBeNull();
    await click("Agree");
    expect(await consent.hasAiJournalConsent()).toBe(true);
    expect(privacy()).toContain("You agreed on");
    expect(findButton("Withdraw agreement")).toBeDefined();
    expect(complete).not.toHaveBeenCalled();
    expectCopyRules(privacy());
  });

  it("offers it again after a withdrawal there", async () => {
    await agree();
    await settings();
    await click("Withdraw agreement");
    expect(findButton("Review and agree")).toBeDefined();
    await click("Review and agree");
    await click("Not now");
    expect(await consent.hasAiJournalConsent()).toBe(false);
  });
});

describe("wizard step 2 says what goes to the AI", () => {
  async function stepTwo() {
    const { WizardScreen } = await import("./WizardScreen");
    await render(<WizardScreen onComplete={() => {}} profile={profile} />);
    await click("I understand");
    await click("Continue");
  }
  const intro = () => container.querySelector(".wizard-step > p.muted")?.textContent ?? "";

  it("names the answers a plan that counts calories sends", async () => {
    await stepTwo();
    expect(intro()).toContain("age, sex, height, weight and goal weight");
    expect(intro()).not.toMatch(/sends these/);
    expectCopyRules(intro());
  });

  it("says the safety check's answers stay in the app", async () => {
    await stepTwo();
    const line = [...container.querySelectorAll("p")].find((p) => p.textContent?.startsWith("These answers"));
    expect(line?.textContent).toBe(
      "These answers stay in this app. They decide the kind of plan, and only the kind of plan goes to the AI.",
    );
  });

  it("says nothing on the step is sent for a plan that does not count calories", async () => {
    await stepTwo();
    const pregnant = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')][0]!;
    act(() => pregnant.click());
    await settle();
    expect(intro()).not.toMatch(/age, sex|height|weight/);
    expect(intro()).toContain("None of these answers go to the AI");
  });
});
