import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Health's own AI conversation is called Ask Health, everywhere a person can
 * see or hear it: the home card, the sheet it opens, and the labels a screen
 * reader announces for both.
 *
 * A server render shows the sheet before its history has loaded. To read the
 * empty-history copy, `steer.emptyHistory` starts the sheet's history state as
 * an empty list instead; every other piece of state starts as it would.
 */
const steer = vi.hoisted(() => ({ emptyHistory: false }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const useState = ((initial: unknown) =>
    actual.useState(steer.emptyHistory && initial === null ? [] : initial)) as typeof actual.useState;
  return { ...actual, default: { ...actual, useState }, useState };
});

/** The copy rules every Ask Health surface is held to. */
function expectCopyRules(html: string) {
  const text = html.replace(/<[^>]+>/g, " ");
  expect(text).not.toContain("—");
  expect(text).not.toMatch(/\b(now|no longer|yet)\b/i);
  expect(html).not.toMatch(/coach|trainer/i);
  expect(html).not.toMatch(/ask about food|food questions/i);
}

describe("Ask Health card", () => {
  it("is titled Ask Health, for sighted and screen-reader users alike", async () => {
    const { AskHealthCard } = await import("./AskHealthCard");
    const html = renderToStaticMarkup(<AskHealthCard onAsk={() => {}} />);
    expect(html).toMatch(/<section[^>]*aria-label="Ask Health"/);
    expect(html).toMatch(/class="home-card-title"><svg[\s\S]*?<\/svg> Ask Health<\/span>/);
    expect(html).toContain('aria-label="Ask Health a question"');
    expectCopyRules(html);
  });

  it("keeps its scope line: nutrition questions, nothing changed", async () => {
    const { AskHealthCard } = await import("./AskHealthCard");
    const html = renderToStaticMarkup(<AskHealthCard onAsk={() => {}} />);
    expect(html).toContain("Nutrition questions, answered. Your plan and diary stay untouched.");
  });
});

describe("Ask Health sheet", () => {
  it("is titled Ask Health, for sighted and screen-reader users alike", async () => {
    const { AskHealthSheet } = await import("./AskHealthSheet");
    const html = renderToStaticMarkup(<AskHealthSheet initialQuestion={null} onClose={() => {}} />);
    expect(html).toMatch(/role="dialog"[^>]*aria-label="Ask Health"/);
    expect(html).toContain("<h2>Ask Health</h2>");
    expectCopyRules(html);
  });

  it("explains an empty history inside the copy rules", async () => {
    steer.emptyHistory = true;
    try {
      const { AskHealthSheet } = await import("./AskHealthSheet");
      const html = renderToStaticMarkup(<AskHealthSheet initialQuestion={null} onClose={() => {}} />);
      // Prove the steer landed: otherwise this would read the loading state.
      expect(html).toContain("chat-empty");
      expect(html).toContain("Your questions and answers show up here.");
      expectCopyRules(html);
    } finally {
      steer.emptyHistory = false;
    }
  });
});

/** Whether some rule in styles.css gives exactly `selector` a 44px+ height. */
async function tallRule(): Promise<(selector: string) => boolean> {
  const css = (await import("../styles.css?raw")).default.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1]!.split(",").map((s) => s.trim().replace(/\s+/g, " ")),
    body: m[2]!,
  }));
  return (selector: string) =>
    rules.some(
      (r) =>
        r.selectors.includes(selector) &&
        /(^|[;\s])(min-)?height:\s*(4[4-9]|[5-9]\d)px/.test(r.body),
    );
}

/**
 * Every control on the card and in its sheet is at least 44px tall. The
 * text fields sit at about 42px on padding and font alone, so each one has to
 * say so; the buttons get it from `.sheet-foot .btn` or their own rule.
 */
describe("Ask Health touch targets", () => {
  it("gives every input and button a 44px minimum", async () => {
    const tall = await tallRule();
    for (const selector of [
      ".ask-input", // the card's question field
      ".ask-send", // the card's Ask button
      ".chat-sheet .sheet-head .icon-btn", // the sheet's close button
      ".chat-foot .text-input", // the sheet's follow-up field
      ".sheet-foot .btn", // the sheet's Send button
      ".journal-actions .btn.small", // Find patterns, which opens the sheet
    ]) {
      expect(tall(selector), selector).toBe(true);
    }
  });
});

/**
 * Settings, under Privacy, is where a person withdraws the Ask Health and Find
 * patterns agreement, opens the policy, and withdraws consent to collection.
 * Those buttons are `btn small`, which is about 30px tall on padding and font
 * alone, so the block gives them a 44px minimum.
 */
describe("Settings privacy", () => {
  it("names Ask Health beside Find patterns, and no coach", async () => {
    const src = (await import("../screens/SettingsSheet.tsx?raw")).default;
    const block = /<div className="privacy-block">([\s\S]*?)\n {10}<\/div>/.exec(src)?.[1];
    expect(block).toBeDefined();
    expect(block).toContain("<strong>Find patterns</strong> and <strong>Ask Health</strong>");
    expect(block).toContain("time you use Find patterns or Ask Health.");
    expect(block).not.toMatch(/coach/i);
  });

  it("gives the privacy block's buttons a 44px minimum", async () => {
    const tall = await tallRule();
    expect(tall(".privacy-block .btn"), ".privacy-block .btn").toBe(true);
  });

  it("puts every button in the privacy block on that rule", async () => {
    const src = (await import("../screens/SettingsSheet.tsx?raw")).default;
    const block = /<div className="privacy-block">([\s\S]*?)\n {10}<\/div>/.exec(src)?.[1];
    expect(block).toBeDefined();
    const buttons = [...block!.matchAll(/<button\b[^>]*className="([^"]*)"/g)].map((m) => m[1]!);
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    for (const cls of buttons) expect(cls.split(" ")).toContain("btn");
  });

  // The symptom-notes checkbox is the block's other control: it is how a
  // person stops sending their notes to Find patterns and Ask Health. A
  // one-line label is about 19px tall, so the label itself carries the 44px.
  it("gives the symptom-notes checkbox a 44px minimum", async () => {
    const tall = await tallRule();
    expect(tall(".consent-toggle"), ".consent-toggle").toBe(true);
  });

  it("puts every checkbox label in the privacy block on that rule", async () => {
    const src = (await import("../screens/SettingsSheet.tsx?raw")).default;
    const block = /<div className="privacy-block">([\s\S]*?)\n {10}<\/div>/.exec(src)?.[1];
    expect(block).toBeDefined();
    const labels = [...block!.matchAll(/<label\b([^>]*)>/g)].map((m) => m[1]!);
    expect(labels.length).toBeGreaterThanOrEqual(1);
    for (const attrs of labels) expect(attrs).toMatch(/className="consent-toggle"/);
  });

  it("gives each Reset health data button, Ask Health's row among them, a 44px minimum", async () => {
    const tall = await tallRule();
    expect(tall(".reset-btn"), ".reset-btn").toBe(true);
  });
});

/**
 * The consent sheet stands in front of the first Ask Health question and the
 * first Find patterns run. Its only control besides the two footer buttons is
 * the symptom-notes checkbox, held to the same 44px as the Settings one.
 */
describe("Ask Health consent sheet touch targets", () => {
  it("puts the symptom-notes checkbox on the 44px rule", async () => {
    const tall = await tallRule();
    const src = (await import("./AiConsentSheet.tsx?raw")).default;
    const labels = [...src.matchAll(/<label\b([^>]*)>/g)].map((m) => m[1]!);
    expect(labels.length).toBeGreaterThanOrEqual(1);
    for (const attrs of labels) expect(attrs).toMatch(/className="consent-toggle"/);
    expect(tall(".consent-toggle"), ".consent-toggle").toBe(true);
  });
});
