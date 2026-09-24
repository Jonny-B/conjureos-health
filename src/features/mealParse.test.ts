import { describe, it, expect, vi, beforeEach } from "vitest";

const complete = vi.fn();
vi.mock("../bridge/ai", async (orig) => ({
  ...(await orig<typeof import("../bridge/ai")>()),
  complete: (...a: unknown[]) => complete(...a),
  isAiAvailable: () => true,
}));

beforeEach(() => complete.mockReset());

/**
 * The reported bug: "3 Beef hotdog plain no buns" came back as "No foods
 * recognized in that description." Every way the call can fail collapsed into
 * an empty item list, so an estimator that never answered was reported as the
 * user writing something unrecognisable.
 */
describe("a failed estimate is not 'no foods recognized'", () => {
  const cases: [string, unknown][] = [
    ["an empty body", ""],
    ["whitespace", "   "],
    ["a non-string body", undefined],
    ["a refusal", "I'm sorry, I can't help with that."],
    ["prose instead of JSON", "Here are the foods I found: three beef hotdogs."],
    ["JSON without an items array", '{"groupName":"Hotdogs"}'],
    ["a truncated body", '{"items":[{"name":"Beef hot'],
  ];

  for (const [label, body] of cases) {
    it(`reports ${label} as unreadable, not as empty`, async () => {
      const { parseMealWithGroup } = await import("./naturalLanguage");
      complete.mockResolvedValue(body);
      const res = await parseMealWithGroup({ text: "3 Beef hotdog plain no buns" });
      expect(res.outcome).toBe("unreadable");
      expect(res.items).toEqual([]);
    });
  }

  it("still reports a genuine empty answer as ok", async () => {
    const { parseMealWithGroup } = await import("./naturalLanguage");
    complete.mockResolvedValue('{"items":[],"groupName":""}');
    const res = await parseMealWithGroup({ text: "a glass of air" });
    expect(res.outcome).toBe("ok");
    expect(res.items).toEqual([]);
  });

  it("parses the hotdogs when the model answers properly", async () => {
    const { parseMealWithGroup } = await import("./naturalLanguage");
    complete.mockResolvedValue(JSON.stringify({
      groupName: "3 beef hotdogs",
      items: [{ name: "Beef hotdog", servingSize: "1 hotdog", calories: 150, protein: 6, carbs: 2, fat: 13 }],
    }));
    const res = await parseMealWithGroup({ text: "3 Beef hotdog plain no buns" });
    expect(res.outcome).toBe("ok");
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.name).toBe("Beef hotdog");
    expect(res.groupName).toBe("3 beef hotdogs");
  });

  it("handles a fenced response, which models still emit", async () => {
    const { parseMealWithGroup } = await import("./naturalLanguage");
    complete.mockResolvedValue('```json\n{"items":[{"name":"Beef hotdog","servingSize":"1","calories":150,"protein":6,"carbs":2,"fat":13}]}\n```');
    const res = await parseMealWithGroup({ text: "hotdog" });
    expect(res.outcome).toBe("ok");
    expect(res.items).toHaveLength(1);
  });

  it("doesn't call the model with nothing to parse", async () => {
    const { parseMealWithGroup } = await import("./naturalLanguage");
    const res = await parseMealWithGroup({ text: "  " });
    expect(res.outcome).toBe("ok");
    expect(complete).not.toHaveBeenCalled();
  });
});

/**
 * 2026-09-04: "Large DQ Twist cone" reported "The estimator didn't send back
 * an answer this time." The estimator HAD answered — Sonnet emitted an
 * object, noticed it had typed carbs as a string, and emitted a corrected one
 * after a sentence of prose. `extractJson`'s widest-span heuristic joined the
 * two through the prose in the middle, so nothing parsed. Verbatim reply,
 * captured from the proxy.
 */
describe("a model that answers twice", () => {
  const SONNET_REPLY =
    '{"groupName":"Large DQ Twist Cone","items":[{"name":"DQ Large Twist Soft Serve Cone",' +
    '"servingSize":"1 large cone","calories":500,"protein":10,"carbs":"72","fat":17}]}\n\n' +
    "Let me correct that — carbs must be a number:\n\n" +
    '{"groupName":"Large DQ Twist Cone","items":[{"name":"DQ Large Twist Soft Serve Cone",' +
    '"servingSize":"1 large cone","calories":500,"protein":10,"carbs":72,"fat":17}]}';

  it("reads the corrected answer instead of reporting it unreadable", async () => {
    complete.mockResolvedValue(SONNET_REPLY);
    const { parseMealWithGroup } = await import("./naturalLanguage");
    const res = await parseMealWithGroup({ text: "Large DQ Twist cone" });
    expect(res.outcome).toBe("ok");
    expect(res.items).toHaveLength(1);
    expect(res.groupName).toBe("Large DQ Twist Cone");
    const item = res.items[0];
    expect(item?.name).toBe("DQ Large Twist Soft Serve Cone");
    expect(item?.servingSize).toBe("1 large cone");
    expect(item?.perServing).toMatchObject({ calories: 500, protein: 10, carbs: 72, fat: 17 });
  });
});
