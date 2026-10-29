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

  it("names every feature that sends to the AI, behind one agreement", async () => {
    const text = await section(/<h4>To an AI, only with your agreement<\/h4>(.*?)<h4>/s);
    expect(text).toContain(
      "These features of Conjure Health send what they need to an AI. They send only when you use " +
        "one of them, or when ConjureOS's assistant or another app asks Conjure Health for a food " +
        "estimate, and only after you have agreed to what they send. One agreement covers all of them.",
    );
    const { AI_FEATURES } = await import("../features/aiConsent");
    for (const name of AI_FEATURES) expect(text).toContain(name);
    expectCopyRules(text);
  });

  // One agreement covers every feature that sends to the AI (ConjureOS #1163,
  // 2026-10-29). "Analysis" describes only Find patterns, and a line naming
  // only Find patterns and Ask Health leaves a person unsure whether building
  // a plan or a food photo still sends. The consent sheet says it of all of
  // them; the policy says the same.
  it("says withdrawing stops every feature that sends to the AI", async () => {
    const text = await section(/<h3>Your choices and rights<\/h3>(.*?)<h3>/s);
    expect(text).not.toMatch(/future analysis/i);
    expect(text).toContain(
      "Conjure Health sends nothing to the AI until you agree to it. The first time you use one " +
        "of its features that needs the AI, you are shown exactly what would be sent and can decline.",
    );
    expect(text).toContain(
      "You can withdraw your agreement at any time in Settings → Privacy. Every Conjure Health " +
        "feature that uses the AI stops sending anything at once, and to use them again you agree " +
        "again. Withdrawing cannot recall something already sent.",
    );
    expectCopyRules(text);
  });

  // Putting the plan builder and food photos behind the agreement is a
  // material revision: see the note on POLICY_UPDATED.
  it("dates the last material revision", async () => {
    const { POLICY_UPDATED } = await import("./HealthDataPolicy");
    expect(POLICY_UPDATED).toBe("2026-10-29");
  });
});
