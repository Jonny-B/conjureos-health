import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AI_FEATURES, DISCLOSURE_SENDS, DISCLOSURE_WITHHOLDS } from "../features/aiConsent";
import type { AiConsentPurpose } from "./AiConsentSheet";

const PURPOSES = ["ask", "patterns", "plan", "package", "food"] as const;

/**
 * One consent sheet serves every feature that sends to the AI, under one
 * agreement (ConjureOS #1163, 2026-10-29). Its framing names them all, and the
 * button a person agrees with names what they asked for: a food question is
 * not agreed to as "find patterns".
 */
async function render(purpose: AiConsentPurpose): Promise<{ html: string; text: string }> {
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

  it("agrees to building a plan, reading package photos, and Add food's AI mode by name", async () => {
    expect(agreeLabel((await render("plan")).html)).toBe("Send and build my plan");
    expect(agreeLabel((await render("package")).html)).toBe("Send and read");
    // Agreeing there turns the mode on; nothing is sent until they use it.
    expect(agreeLabel((await render("food")).html)).toBe("Agree");
  });

  it.each(PURPOSES)("introduces every feature the agreement covers, whichever opened it (%s)", async (purpose) => {
    const { text } = await render(purpose);
    expect(text).toContain("These features send what they need to an AI service outside this app.");
    expect(text).toContain("One agreement covers all of them.");
    for (const name of AI_FEATURES) expect(text).toContain(name);
    expect(text).toContain("Withdrawing stops all of them sending anything more, and to use them again you agree again.");
    expect(text).not.toContain("Finding patterns means");
    expect(text).not.toMatch(/future analysis/);
  });

  it.each(PURPOSES)("shows the whole versioned disclosure (%s)", async (purpose) => {
    const { text } = await render(purpose);
    for (const line of [...DISCLOSURE_SENDS, ...DISCLOSURE_WITHHOLDS]) {
      expect(text).toContain(line.replace(/\s+/g, " "));
    }
  });

  it.each(PURPOSES)("keeps to the copy rules (%s)", async (purpose) => {
    const { html, text } = await render(purpose);
    expect(text).not.toContain("—");
    // "Not now" is the decline label every consent gate in the app shares: a
    // way to say no, not a line comparing the app with an earlier version of
    // itself. Everything else on the sheet is held to the rule.
    expect(text).toContain(" Not now ");
    expect(text.replace(" Not now ", " ")).not.toMatch(/\b(now|no longer|yet)\b/i);
    expect(html).not.toMatch(/coach|ask about food/i);
  });
});
