import { describe, it, expect, vi, beforeEach } from "vitest";
import { button, elements, runtime } from "../testing/hooks";

vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  const { runtime: rt } = await import("../testing/hooks");
  const api = { ...actual, ...rt.hooks };
  return { ...api, default: api };
});

let consented = false;
vi.mock("../features/aiConsent", () => ({
  hasAiJournalConsent: async () => consented,
  recordAiJournalConsent: async () => true,
}));

type Tree = Parameters<typeof elements>[0];

async function card(onAsk: (q: string) => void) {
  const { AskCoachCard } = await import("./AskCoachCard");
  return () => runtime.render(AskCoachCard, { onAsk });
}

const input = (tree: Tree) => {
  for (const el of elements(tree)) if (el.type === "input") return el;
  throw new Error("no input");
};

async function sheet(tree: Tree) {
  const { AiConsentSheet } = await import("./AiConsentSheet");
  for (const el of elements(tree)) if (el.type === AiConsentSheet) return el;
  return null;
}

const type = (tree: Tree, text: string) =>
  (input(tree).props.onChange as (e: unknown) => void)({ target: { value: text } });
const press = (tree: Tree, name: string) => (button(tree, name).props.onClick as () => void)();

// The suggestion carousel's timer; there is no DOM here.
vi.stubGlobal("window", { setInterval: () => 0, clearInterval: () => {} });

beforeEach(() => {
  runtime.reset();
  consented = false;
});

/**
 * Every question waits on the consent sheet until they agree. Saying no to
 * sharing what they log must not cost them the question they typed.
 */
describe("the ask card's consent sheet", () => {
  it("gives a typed question back when they say not now", async () => {
    const asked: string[] = [];
    const render = await card((q) => asked.push(q));
    let tree = await render();
    type(tree, "Are bananas high in fiber?");
    tree = await render();
    press(tree, "Ask");
    tree = await render();
    const open = await sheet(tree);
    expect(open).not.toBeNull();
    expect(input(tree).props.value).toBe("");
    (open!.props.onCancel as () => void)();
    tree = await render();
    expect(await sheet(tree)).toBeNull();
    expect(input(tree).props.value).toBe("Are bananas high in fiber?");
    expect(asked).toEqual([]);
  });

  it("leaves the field empty when the question was a suggestion", async () => {
    const render = await card(() => {});
    let tree = await render();
    press(tree, "Ask");
    tree = await render();
    ((await sheet(tree))!.props.onCancel as () => void)();
    tree = await render();
    expect(input(tree).props.value).toBe("");
  });

  it("asks the question once they agree, and leaves the field empty", async () => {
    const asked: string[] = [];
    const render = await card((q) => asked.push(q));
    let tree = await render();
    type(tree, "Are bananas high in fiber?");
    tree = await render();
    press(tree, "Ask");
    tree = await render();
    await ((await sheet(tree))!.props.onAccept as (n: boolean) => Promise<void>)(false);
    tree = await render();
    expect(asked).toEqual(["Are bananas high in fiber?"]);
    expect(input(tree).props.value).toBe("");
  });
});
