// @vitest-environment jsdom
/**
 * What each Ask Health entry point sends, driven through the real screens and
 * the real sheet (ConjureOS #1163).
 *
 * `features/ask/ask.test.ts` checks `askHealth` given an entry point. These
 * check that the screens hand the right one over and that the sheet keeps it
 * for every follow-up: the home card asks from the home card, a "Find
 * patterns" press asks as a run of its own with the month on screen and
 * nothing else, and a month still being read is never sent under the name of
 * the month shown. Only the AI call, the files and the stored journal are
 * stand-ins.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { DISCLOSURE_VERSION } from "../features/aiConsent";

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
  writeJson: async (p: string, v: unknown) => {
    files[p] = JSON.stringify(v);
  },
}));

const TODAY = "2026-10-20";

/** A food or symptom on one date, each found nowhere else in the data. */
const DIARY: Record<string, string> = {
  [TODAY]: "Greek yogurt",
  "2026-10-05": "Pumpkin soup",
  "2026-09-03": "Aged cheddar",
  "2026-08-12": "Shellfish platter",
};
const SYMPTOMS: Record<string, string> = {
  [TODAY]: "Heartburn",
  "2026-09-03": "Migraine",
};

/**
 * Reads for a month wait on its gate when one is set ("2026-09"), so a test
 * can hold a month mid-read the way a slow bridge does.
 */
const gates = new Map<string, Promise<void>>();
function gate(month: string): () => void {
  let open!: () => void;
  gates.set(month, new Promise<void>((r) => (open = r)));
  return open;
}
const waitFor = async (date: string) => {
  await gates.get(date.slice(0, 7));
};

vi.mock("../data/repository", () => ({
  getRepository: async () => ({
    getGoals: async () => ({ calories: 2200, protein: 150, carbs: 200, fat: 70 }),
    getPlan: async () => null,
    getProfile: async () => ({
      units: "metric",
      weightKg: 81,
      direction: "lose",
      aiJournalConsent: { version: DISCLOSURE_VERSION, acceptedAt: "2026-01-01T00:00:00.000Z", includeNotes: false },
    }),
    listDiary: async (d: string) => {
      await waitFor(d);
      const name = DIARY[d];
      return name
        ? [{
            id: d, date: d, meal: "lunch", quantity: 1, loggedAt: `${d}T12:00:00Z`,
            food: { id: name, source: "usda", name, servingSize: "1 serving",
              perServing: { calories: 300, protein: 10, carbs: 30, fat: 10 } },
          }]
        : [];
    },
    listWater: async () => [],
    listSleep: async () => [],
    listSymptoms: async (d: string) => {
      await waitFor(d);
      const label = SYMPTOMS[d];
      return label ? [{ id: `s-${d}`, label, loggedAt: `${d}T14:00:00Z`, severity: 4 }] : [];
    },
    listWeights: async () => [],
  }),
}));
vi.mock("../features/exercise", async (orig) => ({
  ...(await orig<typeof import("../features/exercise")>()),
  exerciseCaloriesForDate: async () => 0,
  listCompletedWorkouts: async () => [],
}));
// The home screen's other cards read stores of their own and play no part in
// asking.
vi.mock("../components/WeightCard", () => ({ WeightCard: () => null }));
vi.mock("../components/WellbeingCard", () => ({ WellbeingCard: () => null }));
vi.mock("../components/PlanCard", () => ({ PlanCard: () => null }));

type Req = { system: string; messages: { role: string; content: string }[] };
const req = (n: number) => complete.mock.calls[n]![0] as Req;
const everything = (r: Req) => [r.system, ...r.messages.map((m) => m.content)].join("\n");
const contents = (r: Req) => r.messages.map((m) => m.content);
const stored = () =>
  JSON.parse(files["ask-health.json"] ?? "[]") as { role: string; content: string; at?: string; patternsRun?: string }[];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 20, 12, 0, 0));
  // jsdom lays nothing out, so it has no scrollIntoView for the sheet to call.
  Element.prototype.scrollIntoView = () => {};
  complete.mockReset();
  complete.mockImplementation(async (r: Req) => `reply ${r.messages.length}`);
  for (const k of Object.keys(files)) delete files[k];
  gates.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

/** Let every pending read, render and effect run. */
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

function button(text: string): HTMLButtonElement {
  const b = [...container.querySelectorAll("button")].find(
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

async function journal() {
  const { JournalScreen } = await import("./JournalScreen");
  await render(<JournalScreen units="metric" nonce={0} />);
}

describe("Find patterns, from the journal", () => {
  it("asks as a run of its own with the month on screen, and a follow-up in its sheet stays in that run", async () => {
    await journal();
    await click("Previous month");
    await click("Find patterns");

    expect(complete).toHaveBeenCalledTimes(1);
    const first = req(0);
    expect(contents(first)).toHaveLength(1);
    expect(contents(first)[0]).toContain("Here is my journal for 2026-09-01 to 2026-09-30.");
    expect(everything(first)).toContain("Aged cheddar"); // positive control: the range goes
    expect(everything(first)).toContain("Migraine");
    // Nothing from today, the 2 days before, the goal or the targets.
    expect(first.system).toMatch(/not given today's diary/);
    for (const absent of ["ABOUT THIS USER", "Greek yogurt", "Heartburn", "Pumpkin soup", "losing weight", "2200"]) {
      expect(everything(first)).not.toContain(absent);
    }

    // Stored as one run, so a later question can tell it apart.
    const run = stored()[0]!.patternsRun;
    expect(run).toEqual(expect.any(String));
    expect(stored().map((m) => m.patternsRun)).toEqual([run, run]);

    await type("Ask a follow-up", "what about the cheese?");
    await click("Send");

    expect(complete).toHaveBeenCalledTimes(2);
    const second = req(1);
    expect(contents(second)).toEqual([contents(first)[0], "reply 1", "what about the cheese?"]);
    for (const absent of ["ABOUT THIS USER", "Greek yogurt", "Heartburn", "losing weight"]) {
      expect(everything(second)).not.toContain(absent);
    }
    expect(stored().map((m) => m.patternsRun)).toEqual([run, run, run, run]);
  });

  it("each press is a new run, which carries nothing from the run before", async () => {
    await journal();
    await click("Find patterns");
    await click("Close");
    await click("Previous month");
    await click("Find patterns");

    expect(complete).toHaveBeenCalledTimes(2);
    expect(contents(req(1))).toHaveLength(1);
    expect(contents(req(1))[0]).toContain("2026-09-01 to 2026-09-30");
    expect(everything(req(1))).not.toContain("Pumpkin soup"); // October's run
    const runs = new Set(stored().map((m) => m.patternsRun));
    expect(runs.size).toBe(2);
  });

  it("sends nothing while the month it moved to is still being read", async () => {
    await journal();
    const openSeptember = gate("2026-09");
    await click("Previous month");

    // October's days are still on hand; none of them may go out as September.
    await click("Find patterns");
    expect(complete.mock.calls.map((c) => everything(c[0] as Req))).toEqual([]);
    expect(button("Find patterns").disabled).toBe(true);
    // Nor drawn on September's calendar.
    expect(container.querySelectorAll(".cal-dots i")).toHaveLength(0);

    openSeptember();
    await settle();
    expect(button("Find patterns").disabled).toBe(false);
    await click("Find patterns");

    expect(complete).toHaveBeenCalledTimes(1);
    const all = everything(req(0));
    expect(all).toContain("2026-09-01 to 2026-09-30");
    expect(all).toContain("Aged cheddar");
    expect(all).not.toContain("Pumpkin soup");
    expect(all).not.toContain("Greek yogurt");
  });

  it("a slow read of an earlier month never replaces the month on screen", async () => {
    await journal();
    const openSeptember = gate("2026-09");
    const openAugust = gate("2026-08");
    await click("Previous month");
    await click("Previous month");
    expect(container.querySelector(".month-label")?.textContent).toBe("August 2026");

    // August lands first, then September's read, started earlier, lands late.
    openAugust();
    await settle();
    openSeptember();
    await settle();

    await click("Find patterns");
    expect(complete).toHaveBeenCalledTimes(1);
    const all = everything(req(0));
    expect(all).toContain("Here is my journal for 2026-08-01 to 2026-08-31.");
    expect(all).not.toContain("Aged cheddar");
    expect(all).not.toContain("Migraine");
    expect(all).toContain("Shellfish platter");

    // The calendar shows August's day too, not September's.
    const aug12 = container.querySelector(`button[aria-label="${new Date(2026, 7, 12).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}"]`);
    expect(aug12?.querySelectorAll(".cal-dots i").length).toBeGreaterThan(0);
  });
});

describe("Ask Health, from the home card", () => {
  it("asks with today's context, and a follow-up in its sheet replays only today's home card turns", async () => {
    // Already on file: a Find patterns run from this morning, and a home card
    // question from 3 days ago.
    const morning = new Date(2026, 9, 20, 8, 0, 0).toISOString();
    const old = new Date(2026, 9, 17, 9, 0, 0).toISOString();
    files["ask-health.json"] = JSON.stringify([
      { role: "user", content: "I had heartburn all week, what should I avoid?", at: old },
      { role: "assistant", content: "skip the late coffee", at: old },
      { role: "user", content: "Here is my journal for 2026-09-01 to 2026-09-30.\n\n2026-09-03: Migraine", at: morning, patternsRun: "r0" },
      { role: "assistant", content: "Migraines follow aged cheddar.", at: morning, patternsRun: "r0" },
    ]);

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
    await type("Ask Health a question", "what should I eat tonight?");
    await click("Ask");

    expect(complete).toHaveBeenCalledTimes(1);
    const first = req(0);
    expect(contents(first)).toEqual(["what should I eat tonight?"]);
    expect(first.system).toContain("ABOUT THIS USER"); // the home card does get today
    expect(first.system).toContain("Greek yogurt");
    expect(everything(first)).not.toContain("Migraine");
    expect(everything(first)).not.toContain("heartburn all week");
    expect(stored().at(-1)).toMatchObject({ role: "assistant", at: expect.any(String) });
    expect(stored().at(-1)!.patternsRun).toBeUndefined();

    await type("Ask a follow-up", "and for dessert?");
    await click("Send");

    expect(complete).toHaveBeenCalledTimes(2);
    const second = req(1);
    expect(contents(second)).toEqual(["what should I eat tonight?", "reply 1", "and for dessert?"]);
    expect(second.system).toContain("ABOUT THIS USER");
    expect(everything(second)).not.toContain("Migraine");
    expect(stored().slice(-4).every((m) => m.patternsRun === undefined)).toBe(true);
  });
});
