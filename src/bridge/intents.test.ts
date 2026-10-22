import { describe, it, expect } from "vitest";
import { parseIntent } from "./intents";

const today = "2026-09-28";

describe("deep links", () => {
  it("opens Add food with the search filled in", () => {
    expect(
      parseIntent({ name: "addFood", params: { query: "greek yogurt", meal: "breakfast", date: "2026-09-27" } }, today),
    ).toEqual({ kind: "addFood", query: "greek yogurt", meal: "breakfast", date: "2026-09-27" });
  });

  it("keeps a well-formed barcode and drops a malformed one", () => {
    expect(parseIntent({ name: "addFood", params: { barcode: "5200 4350-00027" } }, today)).toEqual({
      kind: "addFood",
      barcode: "5200435000027",
    });
    expect(parseIntent({ name: "addFood", params: { barcode: "12ab" } }, today)).toEqual({ kind: "addFood" });
  });

  it("drops dates that don't exist or haven't happened yet", () => {
    expect(parseIntent({ name: "openDay", params: { date: "2026-02-30" } }, today)).toEqual({ kind: "openDay" });
    expect(parseIntent({ name: "exercise", params: { date: "2026-09-29" } }, today)).toEqual({ kind: "exercise" });
    expect(parseIntent({ name: "exercise", params: { date: today } }, today)).toEqual({ kind: "exercise", date: today });
  });

  it("strips control characters and caps a query", () => {
    const res = parseIntent({ name: "addFood", params: { query: `oat\u0000meal ${"x".repeat(200)}` } }, today) as {
      query: string;
    };
    expect(res.query.startsWith("oat meal")).toBe(true);
    expect(res.query.length).toBe(80);
  });

  it("ignores an intent this app doesn't declare, and a meal it doesn't know", () => {
    expect(parseIntent({ name: "deleteEverything", params: {} }, today)).toBeNull();
    expect(parseIntent(null, today)).toBeNull();
    expect(parseIntent({ name: "addFood", params: { meal: "brunch" } }, today)).toEqual({ kind: "addFood" });
  });
});
