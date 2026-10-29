import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The words around the AI agreement (ConjureOS #1163, version 3), held to what
 * the code does:
 *
 *   - The food estimates are named as ConjureOS's assistant's too, since it
 *     is their most common caller, and nothing says they only send when the
 *     person uses a feature, since another app or the assistant asks for them.
 *   - The plan line names the kind of plan, which the safety check picks, and
 *     says the safety answers themselves are not sent.
 *   - The policy claims nothing for the AI agreement that it does not do: what
 *     ConjureOS's assistant reads is allowed in ConjureOS, not by it.
 */

function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function policy(): Promise<{ html: string; text: string }> {
  const { HealthDataPolicy } = await import("./HealthDataPolicy");
  const html = renderToStaticMarkup(<HealthDataPolicy onClose={() => {}} />);
  return { html, text: plain(html) };
}

async function consentSheet(): Promise<string> {
  const { AiConsentSheet } = await import("./AiConsentSheet");
  return plain(renderToStaticMarkup(<AiConsentSheet purpose="plan" onAccept={() => {}} onCancel={() => {}} />));
}

function expectCopyRules(s: string) {
  expect(s).not.toContain("—");
  expect(s).not.toMatch(/\b(now|no longer|yet)\b/i);
}

describe("the food estimates are named for who asks for them", () => {
  it("the feature list names ConjureOS's assistant", async () => {
    const { AI_FEATURES, DISCLOSURE_SENDS } = await import("../features/aiConsent");
    const estimates = AI_FEATURES.find((f) => /estimate/i.test(f));
    expect(estimates).toBe("Food estimates for ConjureOS's assistant and other apps");
    expect(DISCLOSURE_SENDS.some((l) => l.startsWith(`${estimates}: `))).toBe(true);
  });

  it("the consent sheet does not say they only send when the person uses them", async () => {
    const text = await consentSheet();
    expect(text).not.toContain("They only send when you use them");
    const intro =
      "They send only when you use one of them, or when ConjureOS's assistant or another app asks Conjure Health for a food estimate.";
    expect(text).toContain(intro);
    expectCopyRules(intro);
  });

  it("the policy says the same", async () => {
    const { text } = await policy();
    expect(text).not.toContain("They run only when you use them");
    expect(text).toContain("or when ConjureOS's assistant or another app asks Conjure Health for a food estimate");
  });

  it("the agreement to keep health data names them with the other AI features", async () => {
    const { CONSENT_BODY } = await import("../features/healthConsentCopy");
    const ai = CONSENT_BODY.find((p) => p.includes("to an AI"))!;
    expect(ai).toContain("food estimates for ConjureOS's assistant and other apps");
    expectCopyRules(ai);
  });
});

describe("the plan line says what the safety check does and does not send", () => {
  it("names the kind of plan, and what picks it", async () => {
    const { DISCLOSURE_SENDS } = await import("../features/aiConsent");
    const line = DISCLOSURE_SENDS.find((l) => l.startsWith("Building a plan:"))!;
    expect(line).toContain("the kind of plan");
    expect(line).toContain("pregnant or recently postpartum, or with a heart condition");
    expectCopyRules(line);
  });

  it("says the safety answers themselves are not sent", async () => {
    const { DISCLOSURE_WITHHOLDS } = await import("../features/aiConsent");
    expect(DISCLOSURE_WITHHOLDS).toContain("Building a plan: your safety check answers, beyond the kind of plan they pick");
  });
});

describe("the policy claims nothing for the AI agreement that it does not do", () => {
  it("scopes 'nothing goes to the AI' to Conjure Health's own features", async () => {
    const { text } = await policy();
    expect(text).not.toContain("Nothing goes to the AI until you agree to it.");
    expect(text).toContain("Conjure Health sends nothing to the AI until you agree to it.");
    expect(text).toContain("Every Conjure Health feature that uses the AI stops sending anything at once");
    expectCopyRules(text);
  });

  it("says ConjureOS's assistant is an AI, and that the agreement does not govern what it reads", async () => {
    const { html } = await policy();
    const others = plain(/<h4>To other apps on ConjureOS, when you allow them<\/h4>(.*?)<h3>/s.exec(html)![1]!);
    expect(others).toContain("ConjureOS's assistant is itself an AI");
    expect(others).toContain(
      "Withdrawing that agreement does not change what you allowed ConjureOS's assistant to read.",
    );
    expectCopyRules(others);
  });
});
