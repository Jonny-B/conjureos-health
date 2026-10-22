import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The Consumer Health Data Privacy policy names Health's AI conversation by
 * the name a person sees in the app, Ask Health, and names no coach: coaching
 * is a Conjure Fitness feature, and Health has none.
 */

/** The whole policy, as a reader sees it. */
async function policyText(): Promise<{ html: string; text: string }> {
  const { HealthDataPolicy } = await import("./HealthDataPolicy");
  const html = renderToStaticMarkup(<HealthDataPolicy onClose={() => {}} />);
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return { html, text };
}

/** One section of the policy, from its heading to the next one. */
async function section(heading: RegExp): Promise<string> {
  const { html } = await policyText();
  const body = heading.exec(html)?.[1];
  expect(body, String(heading)).toBeDefined();
  return body!
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function expectCopyRules(text: string) {
  expect(text).not.toContain("—");
  expect(text).not.toMatch(/\b(now|no longer|yet)\b/i);
  expect(text).not.toMatch(/coach|ask about food/i);
}

describe("health data policy, Ask Health", () => {
  it("names a coach and the old name nowhere", async () => {
    const { html } = await policyText();
    expect(html).not.toMatch(/coach|trainer|ask about food|food questions/i);
  });

  it("names Ask Health as one of the two features that send part of the journal", async () => {
    const text = await section(/<h4>To an AI, when you ask it about your journal<\/h4>(.*?)<h4>/s);
    expect(text).toContain(
      "Two features send part of your journal to an AI: Find patterns on the Journal tab, " +
        "which looks for things that go together, and Ask Health on the home screen.",
    );
    expectCopyRules(text);
  });

  // One agreement covers Find patterns and Ask Health. "Analysis" describes
  // only Find patterns, so a withdraw line that says analysis stops leaves an
  // Ask Health user unsure whether their questions still send their journal.
  // The consent sheet says it of both; the policy says the same.
  it("says withdrawing stops both features sending, not only analysis", async () => {
    const text = await section(/<h3>Your choices and rights<\/h3>(.*?)<h3>/s);
    expect(text).not.toMatch(/future analysis/i);
    expect(text).toContain(
      "The first time you use Find patterns or Ask Health, you are shown exactly what would " +
        "be sent and can decline.",
    );
    expect(text).toContain(
      "You can withdraw your agreement at any time in Settings → Privacy. Find patterns and " +
        "Ask Health stop sending anything from your journal at once. Withdrawing cannot " +
        "recall something already sent.",
    );
    expectCopyRules(text);
  });

  // The rename is not a material revision: it names the same feature, which
  // sends what it sent, behind the same agreement. See the note on
  // POLICY_UPDATED before moving it.
  it("keeps the date of the last material revision", async () => {
    const { POLICY_UPDATED } = await import("./HealthDataPolicy");
    expect(POLICY_UPDATED).toBe("2026-10-01");
  });
});
