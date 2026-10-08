import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DayJournal } from "../features/journal";
import { button, elements, runtime } from "../testing/hooks";

vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  const { runtime: rt } = await import("../testing/hooks");
  const api = { ...actual, ...rt.hooks };
  return { ...api, default: api };
});

/** Each month read, held open until the test says how it lands. */
const loads: { from: string; to: string; resolve: (days: DayJournal[]) => void }[] = [];

vi.mock("../features/journal", async (orig) => ({
  ...(await orig<typeof import("../features/journal")>()),
  loadRangeJournal: (from: string, to: string) =>
    new Promise<DayJournal[]>((resolve) => loads.push({ from, to, resolve })),
  loadDayJournal: async (date: string) => day(date, "today"),
}));
vi.mock("../features/aiConsent", () => ({
  hasAiJournalConsent: async () => true,
  readAiJournalConsent: async () => ({ version: 3, acceptedAt: "2026-10-01T00:00:00Z", includeNotes: false }),
  recordAiJournalConsent: async () => true,
}));
vi.mock("../components/CoachChatModal", () => ({ CoachChatModal: () => null }));

/** A day with one symptom whose label says which read it came from. */
function day(date: string, label: string): DayJournal {
  return {
    date,
    events: [{ id: date, editable: true, at: Date.parse(`${date}T09:00:00`), timed: true, kind: "symptom", label }],
    totals: {
      calories: 0, protein: 0, carbs: 0, fat: 0, waterMl: 0, exerciseKcal: 0, sleepMinutes: 0, symptomCount: 1,
    },
  } as unknown as DayJournal;
}

const land = (n: number, label: string) => {
  const l = loads[n]!;
  l.resolve([day(l.from, label)]);
};

async function screen() {
  const { JournalScreen } = await import("./JournalScreen");
  return (props = { units: "metric" as const, nonce: 0 }) => runtime.render(JournalScreen, props);
}

/** What Find patterns handed the coach chat, once it has opened. */
async function openedWith(render: () => Promise<unknown>): Promise<string> {
  const { CoachChatModal } = await import("../components/CoachChatModal");
  for (let i = 0; i < 5; i++) {
    for (const el of elements((await render()) as never)) {
      if (el.type === CoachChatModal) return String(el.props.initialQuestion);
    }
  }
  throw new Error("the coach chat never opened");
}

const press = (tree: unknown, name: string) => (button(tree as never, name).props.onClick as () => unknown)();
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  runtime.reset();
  loads.length = 0;
});

/**
 * The journal sent is the one for the month on screen, and is labelled with
 * that month's dates. A read for a month the user has already left must not
 * land under the new month's label.
 */
describe("Find patterns sends the month on screen", () => {
  it("even when an earlier month's read lands after a later one", async () => {
    const render = await screen();
    await render();
    land(0, "this month");
    let tree = await render();
    // Two quick taps back. The read for the month on screen lands first.
    press(tree, "Previous month");
    tree = await render();
    press(tree, "Previous month");
    tree = await render();
    const [, oneBack, twoBack] = loads;
    expect(twoBack!.from < oneBack!.from).toBe(true);
    land(2, "two months back");
    land(1, "one month back");
    tree = await render();
    await press(tree, "Find patterns");
    const asked = await openedWith(render);
    expect(asked.startsWith(`Here is my journal for ${twoBack!.from} to ${twoBack!.to}.`)).toBe(true);
    expect(asked).toContain("two months back");
    expect(asked).not.toContain("one month back");
  });

  it("even when it is tapped before the month on screen has loaded", async () => {
    const render = await screen();
    await render();
    land(0, "this month");
    let tree = await render();
    press(tree, "Previous month");
    tree = await render();
    const shown = loads[1]!;
    const tapped = press(tree, "Find patterns");
    await tick();
    // Every read made for the month on screen lands only after the tap.
    for (const l of loads.slice(1)) l.resolve([day(l.from, "last month")]);
    await tapped;
    const asked = await openedWith(render);
    expect(asked.startsWith(`Here is my journal for ${shown.from} to ${shown.to}.`)).toBe(true);
    expect(asked).toContain("last month");
    expect(asked).not.toContain("this month");
  });
});
