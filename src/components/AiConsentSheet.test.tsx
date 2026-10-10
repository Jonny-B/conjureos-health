import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DISCLOSURE_SENDS, DISCLOSURE_WITHHOLDS } from "../features/aiConsent";

/**
 * One consent sheet serves Find patterns and Ask Health, under one agreement.
 * Its framing names both, and the button a person agrees with names what they
 * asked for: a food question is not agreed to as "find patterns".
 *
 * The sheet portals to <body>. A server render has no document, so the portal
 * renders in place and `document.body` is a stand-in.
 */
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  createPortal: (node: unknown) => node,
}));

beforeAll(() => {
  vi.stubGlobal("document", { body: {} });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

async function render(purpose: "patterns" | "ask"): Promise<{ html: string; text: string }> {
  const { AiConsentSheet } = await import("./AiConsentSheet");
  const html = renderToStaticMarkup(
    <AiConsentSheet purpose={purpose} onAccept={() => {}} onCancel={() => {}} />,
  );
  const text = html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
  return { html, text };
}

/** The agree button's label: the primary button in the footer. */
function agreeLabel(html: string): string | undefined {
  return /<button class="btn primary"[^>]*>([^<]*)<\/button>/.exec(html)?.[1];
}

describe("the AI consent sheet", () => {
  it("agrees to Ask Health as asking, when Ask Health opened it", async () => {
    const { html } = await render("ask");
    expect(agreeLabel(html)).toBe("Send and ask");
  });

  it("agrees to Find patterns as finding patterns, when the journal opened it", async () => {
    const { html } = await render("patterns");
    expect(agreeLabel(html)).toBe("Send and find patterns");
  });

  it.each(["ask", "patterns"] as const)("introduces both features either way (%s)", async (purpose) => {
    const { text } = await render(purpose);
    expect(text).toContain(
      "Find patterns and Ask Health send part of your journal to an AI service outside this app.",
    );
    expect(text).toContain("One agreement covers both.");
    expect(text).not.toContain("Finding patterns means");
    expect(text).not.toMatch(/future analysis/);
  });

  it.each(["ask", "patterns"] as const)("shows the whole versioned disclosure (%s)", async (purpose) => {
    const { text } = await render(purpose);
    for (const line of [...DISCLOSURE_SENDS, ...DISCLOSURE_WITHHOLDS]) {
      expect(text).toContain(line.replace(/\s+/g, " "));
    }
  });

  it.each(["ask", "patterns"] as const)("keeps to the copy rules (%s)", async (purpose) => {
    const { html, text } = await render(purpose);
    expect(text).not.toContain("—");
    // "Not now" is the decline label every consent gate in the app shares (the
    // health-data gate, the plan disclaimer): a way to say no, not a line
    // comparing the app with an earlier version of itself. Everything else
    // on the sheet is held to the rule.
    expect(text).toContain(" Not now ");
    expect(text.replace(" Not now ", " ")).not.toMatch(/\b(now|no longer|yet)\b/i);
    expect(html).not.toMatch(/coach/i);
  });
});
