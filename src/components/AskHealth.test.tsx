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
  expect(html).not.toMatch(/coach/i);
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
