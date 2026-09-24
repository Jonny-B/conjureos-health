import { describe, expect, it } from "vitest";
import { aiErrorMessage, extractJson } from "./ai";

describe("aiErrorMessage", () => {
  it("names the real problem when the host says the user is out of credits", () => {
    expect(aiErrorMessage(new Error("out_of_credits"))).toMatch(/out of AI credits/i);
    expect(aiErrorMessage(new Error("out_of_credits"))).not.toMatch(/connection/i);
  });

  it("distinguishes the daily allowance from a hard credit stop", () => {
    expect(aiErrorMessage(new Error("free_tier_daily_cap_reached"))).toMatch(/today/i);
  });

  it("tells a rate-limited user to wait rather than to retry immediately", () => {
    expect(aiErrorMessage(new Error("ai.complete rate limit (per-minute): too many AI calls"))).toMatch(/wait/i);
  });

  it("explains the foreground gate in the user's terms", () => {
    const msg = aiErrorMessage(new Error("ai.complete blocked: this app's window is minimized"));
    expect(msg).toMatch(/on screen/i);
  });

  it("reports a timeout as slowness, not as an outage", () => {
    expect(aiErrorMessage(new Error("ai timeout"))).toMatch(/too long/i);
  });

  it("handles the real strings both hosts actually reject with", () => {
    // Desktop kernel (ConjureOS src/kernel/index.ts) and the mobile runner
    // (conjureos-mobile src/platform/ai.ts) word these differently; both must land.
    expect(aiErrorMessage(new Error("You're out of credits. Top up in ConjureOS Settings on the web."))).toMatch(/out of AI credits/i);
    expect(aiErrorMessage(new Error("Daily free-tier limit reached. Wait for the daily reset, or upgrade on the web."))).toMatch(/today's AI allowance/i);
    expect(aiErrorMessage(new Error("AI provider not configured"))).toMatch(/isn't available/i);
    expect(aiErrorMessage(new Error("Supabase isn't configured."))).toMatch(/isn't available/i);
    expect(aiErrorMessage(new Error("Sign in to use AI."))).toMatch(/sign in/i);
    expect(aiErrorMessage(new Error("app does not have ai.complete permission"))).toMatch(/AI permission/i);
    expect(aiErrorMessage(new Error("ai.complete blocked: ConjureOS is in the background"))).toMatch(/on screen/i);
    expect(aiErrorMessage(new Error('AI proxy request failed (402): {"error":"out_of_credits","tier":"free"}'))).toMatch(/out of AI credits/i);
  });

  it("reads Anthropic's own exhausted-account 400", () => {
    // The real string that broke prod on 2026-09-04. Anthropic returns it as a
    // 400 invalid_request_error, so nothing upstream of us calls it a credit
    // problem — the app has to recognise the sentence itself.
    const raw =
      'AI proxy request failed (400): {"type":"error","error":{"type":"invalid_request_error",' +
      '"message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';
    expect(aiErrorMessage(new Error(raw))).toMatch(/out of credit/i);
    expect(aiErrorMessage(new Error(raw))).not.toMatch(/connection/i);
  });

  it("reads the web kernel's rewrite of the same exhausted-account rejection", () => {
    // ConjureOS src/ai/providerErrors.ts replaces Anthropic's sentence before
    // the app sees it, so the raw-string match above never fires on the web.
    const hosted = new Error(
      "The AI provider turned the request down because the ConjureOS account with it is out of credit. This is on our side, not your credits. Please try again later.",
    );
    expect(aiErrorMessage(hosted, "The estimator didn’t answer. Try again.")).toMatch(/out of credit/i);
    expect(aiErrorMessage(hosted)).toMatch(/not your credits/i);
    expect(aiErrorMessage(hosted)).not.toMatch(/connection|couldn.t reach/i);
    const byk = new Error(
      "Your Anthropic account is out of credit. Add credit in the Anthropic Console, or remove your key in Settings to use your ConjureOS credits.",
    );
    expect(aiErrorMessage(byk)).toMatch(/your own AI key/i);
  });

  it("names a busy provider and a real network failure plainly", () => {
    expect(aiErrorMessage(new Error("The AI service is busy right now. Try again in a moment."))).toMatch(/busy/i);
    expect(aiErrorMessage(new Error("TypeError: Failed to fetch"))).toMatch(/connection/i);
  });

  it("keeps an unrecognised host reason visible instead of swallowing it", () => {
    const msg = aiErrorMessage(new Error("kaboom 517"), "The estimator didn't answer.");
    expect(msg).toContain("kaboom 517");
    expect(msg).toContain("The estimator didn't answer.");
  });

  it("falls back cleanly when the rejection carries no message", () => {
    expect(aiErrorMessage(new Error(""), "Nope.")).toBe("Nope.");
    expect(aiErrorMessage(undefined, "Nope.")).toBe("Nope.");
  });
});

describe("extractJson", () => {
  it("unwraps a fenced block", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("takes the corrected object when the model answers twice", () => {
    // The real Sonnet reply that broke prod on 2026-09-04: a first attempt
    // with carbs as a string, a sentence of self-correction, then a fixed
    // object. The widest-span heuristic swallowed the prose between them and
    // produced something unparseable.
    const raw =
      '{"groupName":"Large DQ Twist Cone","items":[{"name":"DQ Large Twist Soft Serve Cone",' +
      '"servingSize":"1 large cone","calories":500,"protein":10,"carbs":"72","fat":17}]}\n\n' +
      "Let me correct that — carbs must be a number:\n\n" +
      '{"groupName":"Large DQ Twist Cone","items":[{"name":"DQ Large Twist Soft Serve Cone",' +
      '"servingSize":"1 large cone","calories":500,"protein":10,"carbs":72,"fat":17}]}';
    const parsed = JSON.parse(extractJson(raw)) as { items: { carbs: number }[] };
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.carbs).toBe(72);
  });

  it("prefers the last parseable fence when the model fences twice", () => {
    const raw = '```json\n{"items":[],"n":1}\n```\nOops:\n```json\n{"items":[],"n":2}\n```';
    expect(JSON.parse(extractJson(raw))).toEqual({ items: [], n: 2 });
  });

  it("ignores braces inside string values", () => {
    const raw = 'Here: {"name":"Rice {special}","items":[]} done';
    expect(JSON.parse(extractJson(raw))).toEqual({ name: "Rice {special}", items: [] });
  });

  it("handles an escaped quote before a brace", () => {
    const raw = '{"name":"12\\" pizza {big}","items":[]}';
    const parsed = JSON.parse(extractJson(raw)) as { name: string };
    expect(parsed.name).toBe('12" pizza {big}');
  });

  it("still returns the widest span when nothing parses, so the caller reports it", () => {
    const raw = "{ not json at all }";
    expect(extractJson(raw)).toBe("{ not json at all }");
    expect(() => JSON.parse(extractJson(raw))).toThrow();
  });

  it("survives prose with no JSON in it", () => {
    expect(extractJson("  I could not identify any food.  ")).toBe("I could not identify any food.");
  });
});
