/**
 * Every `capable` or `epic` AI call leaves room to think (conjureos-health#10,
 * ConjureOS #1159).
 *
 * Those tiers run models that think before they answer, and thinking counts
 * toward `maxTokens`. A call sized for its answer alone can spend the whole
 * cap thinking; ConjureOS then rejects it as "ran out of room", and the call
 * is still charged. This reads every `complete({ ... })` in the app's source,
 * so a new call cannot ship sized for a model that does not think.
 */
import { describe, expect, it } from "vitest";
import { CAPABLE_MIN_MAX_TOKENS } from "./ai";

/** Shipped source, tests excluded, by path relative to this folder. */
const SHIPPED = import.meta.glob(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * The object literal passed to each `complete(` call in `text`, braces
 * balanced, and to each `completeUnderAgreement(`, the gate every feature
 * sends through (features/aiGate.ts).
 */
function completeRequests(text: string): string[] {
  const out: string[] = [];
  const call = /\b(?:complete|completeUnderAgreement)\(\s*\{/g;
  for (let m = call.exec(text); m; m = call.exec(text)) {
    const start = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) {
        out.push(text.slice(start, i + 1));
        break;
      }
    }
  }
  return out;
}

/** A `maxTokens` value: a number literal, or a `const` of one in the same file. */
function capValue(request: string, file: string): number | null {
  const raw = /\bmaxTokens:\s*([\w.]+)/.exec(request)?.[1];
  if (!raw) return null;
  if (/^[\d_]+$/.test(raw)) return Number(raw.replace(/_/g, ""));
  const named = new RegExp(`\\bconst\\s+${raw}\\s*(?::\\s*number\\s*)?=\\s*([\\d_]+)\\b`).exec(file)?.[1];
  return named ? Number(named.replace(/_/g, "")) : null;
}

interface ThinkingCall {
  where: string;
  cap: number | null;
}

function thinkingCalls(): ThinkingCall[] {
  const calls: ThinkingCall[] = [];
  for (const [path, text] of Object.entries(SHIPPED)) {
    for (const request of completeRequests(text)) {
      if (!/\btier:\s*["'](capable|epic)["']/.test(request)) continue;
      calls.push({ where: path.replace(/^\.\.\//, ""), cap: capValue(request, text) });
    }
  }
  return calls;
}

describe("capable and epic calls leave room to think", () => {
  it("finds the calls it is guarding", () => {
    const files = new Set(thinkingCalls().map((c) => c.where));
    for (const f of [
      "features/ask/ask.ts",
      "features/plan/generate.ts",
      "features/naturalLanguage.ts",
      "features/foods/labelParse.ts",
      "features/foods/frontParse.ts",
    ]) {
      expect(files).toContain(f);
    }
  });

  it(`asks for at least ${CAPABLE_MIN_MAX_TOKENS} tokens on every one`, () => {
    const short = thinkingCalls().filter((c) => c.cap === null || c.cap < CAPABLE_MIN_MAX_TOKENS);
    expect(short).toEqual([]);
  });
});
