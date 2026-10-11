/**
 * Coaching is a Conjure Fitness feature. Conjure Health has no coach: no
 * module, no screen, no tab, no card and no copy that offers one (owner
 * decision, 2026-10-10). Health's own AI conversation is Ask Health
 * (features/ask), which answers questions and changes nothing. It was called
 * "Ask about food" before it was renamed, so that name is held to the same
 * rule.
 *
 * What may still say "coach" in Health's shipped source, and why:
 *   - `coach.json` and `coach-chat.json`, the files older versions wrote. A
 *     user's stored data is never deleted for them, so the files stay on disk,
 *     unread, until Settings, Reset health data wipes them. Ask Health keeps
 *     its own conversation file and never reads `coach-chat.json`, which
 *     also holds the removed trainer's replies (features/ask/ask.ts).
 *   - The plan generator's model persona ("You are a wellness coach..."). That
 *     is prompt text the model reads, not a feature a person sees.
 *   - A line saying the coach was removed, or what was renamed from it, or
 *     that coaching belongs to Conjure Fitness. Those are the notes that stop
 *     someone rebuilding it.
 *
 * The removed coach also went by "trainer", so "trainer" is held to the same
 * rule. Anything else that names a coach or a trainer is a piece of the
 * removed feature left behind, which is what this file exists to catch.
 */

import { describe, expect, it } from "vitest";
import appSource from "./App.tsx?raw";

/** Every file under src, by path. Lazy: only the keys are used. */
const ALL_PATHS = Object.keys(import.meta.glob("./**/*"));

/** Shipped source (code and styles), tests excluded. */
const SHIPPED = import.meta.glob(["./**/*.{ts,tsx,css}", "!./**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** What the removed feature was called. */
const NAMES = /coach|trainer/i;

/** The mentions listed in the header, stripped out before looking for one. */
const ALLOWED: RegExp[] = [
  /\bcoach(-chat)?\.json\b/gi,
  /You are an? [\w ,]*?coach\b/g,
  /"wellness coach, not a doctor"/g,
];

/** Every line naming the removed feature, minus the allowed mentions. */
function leftoverLines(sources: Record<string, string>): string[] {
  const hits: string[] = [];
  for (const [path, text] of Object.entries(sources)) {
    text.split("\n").forEach((line, i) => {
      if (!NAMES.test(line) || /Conjure Fitness|\b(removed|renamed?)\b/i.test(line)) return;
      const rest = ALLOWED.reduce((s, re) => s.replace(re, ""), line);
      if (NAMES.test(rest)) hits.push(`${path}:${i + 1}: ${line.trim()}`);
    });
  }
  return hits;
}

describe("Conjure Health has no coach", () => {
  it("has no coach module, screen, component or test file", () => {
    expect(ALL_PATHS.filter((p) => /coach/i.test(p))).toEqual([]);
  });

  it("imports nothing from a coach module", () => {
    const imports = Object.entries(SHIPPED).flatMap(([path, text]) =>
      [...text.matchAll(/from\s+["']([^"']+)["']/g)]
        .map((m) => m[1]!)
        .filter((spec) => /coach/i.test(spec))
        .map((spec) => `${path} imports ${spec}`),
    );
    expect(imports).toEqual([]);
  });

  it("has no coach tab or route in the app shell", () => {
    const tabUnion = /type Tab\s*=([^;]+);/.exec(appSource)?.[1];
    expect(tabUnion).toBeDefined();
    expect(tabUnion).not.toMatch(/coach/i);
    expect(appSource).not.toMatch(/["']coach["']/);
    expect(appSource).not.toMatch(/CoachScreen|openCoach|onAskCoach/);
  });

  it("names a coach or a trainer nowhere else in shipped code, copy or styles", () => {
    expect(leftoverLines(SHIPPED)).toEqual([]);
  });

  it("calls its conversation Ask Health, never by its old name", () => {
    const old = Object.entries(SHIPPED).flatMap(([path, text]) =>
      text
        .split("\n")
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => /ask about food|food coach|food questions/i.test(line))
        .filter(({ line }) => !/\brenamed?\b/i.test(line))
        .map(({ line, i }) => `${path}:${i + 1}: ${line.trim()}`),
    );
    expect(old).toEqual([]);
  });

  it("catches a trainer as well as a coach, and lets the allowed mentions through", () => {
    // The check above passing means nothing unless it can fail.
    expect(
      leftoverLines({
        "a.ts": [
          " * History lives in a file the trainer's chat also wrote.",
          "/** The retired trainer's long-term memory of the user. */",
          "const label = 'Ask your coach';",
          "const SYSTEM_CORE = `You are a wellness coach, not a doctor.`;",
          "await rm(\"coach-chat.json\");",
          " * The coach was removed from Health (owner decision).",
        ].join("\n"),
      }),
    ).toEqual([
      "a.ts:1: * History lives in a file the trainer's chat also wrote.",
      "a.ts:2: /** The retired trainer's long-term memory of the user. */",
      "a.ts:3: const label = 'Ask your coach';",
    ]);
  });

  it("reads the older conversation file nowhere: only the reset row names it in code", () => {
    // Ask Health keeps its own file. `coach-chat.json` also holds the removed
    // trainer's replies, so the only code that may touch it is the reset row
    // that lets a user wipe it.
    const touching = Object.entries(SHIPPED)
      .filter(([, text]) => /["']coach-chat\.json["']/.test(text))
      .map(([path]) => path);
    expect(touching).toEqual(["./features/resetData.ts"]);
  });

  it("still sees the source it is guarding (positive control)", () => {
    // An empty glob would pass every test above for the wrong reason.
    expect(Object.keys(SHIPPED)).toContain("./App.tsx");
    expect(Object.keys(SHIPPED)).toContain("./styles.css");
    // Vitest blanks CSS unless vite.config.ts tells it otherwise: an empty
    // stylesheet here would mean the styles were never checked at all.
    expect(SHIPPED["./styles.css"]!.length).toBeGreaterThan(10_000);
    expect(Object.keys(SHIPPED).length).toBeGreaterThan(80);
  });
});
