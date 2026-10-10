/**
 * Coaching is a Conjure Fitness feature. Conjure Health has no coach: no
 * module, no screen, no tab, no card and no copy that offers one (owner
 * decision, 2026-10-10). Health's own AI conversation is Ask Health
 * (features/ask), which answers questions and changes nothing.
 *
 * What may still say "coach" in Health's shipped source, and why:
 *   - `coach.json` and `coach-chat.json`, the files older versions wrote. A
 *     user's stored data is never deleted for them, so the files stay on disk.
 *     Ask Health keeps its history in `coach-chat.json` so that history still
 *     loads, and Settings, Reset health data wipes both.
 *   - The plan generator's model persona ("You are a wellness coach..."). That
 *     is prompt text the model reads, not a feature a person sees.
 *   - A line saying the coach was removed, or what was renamed from it, or
 *     that coaching belongs to Conjure Fitness. Those are the notes that stop
 *     someone rebuilding it.
 *
 * Anything else that names a coach is a piece of the removed feature left
 * behind, which is what this file exists to catch.
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

/** The mentions listed in the header, stripped out before looking for a coach. */
const ALLOWED: RegExp[] = [
  /\bcoach(-chat)?\.json\b/gi,
  /You are an? [\w ,]*?coach\b/g,
  /"wellness coach, not a doctor"/g,
];

function leftoverCoachLines(): string[] {
  const hits: string[] = [];
  for (const [path, text] of Object.entries(SHIPPED)) {
    text.split("\n").forEach((line, i) => {
      if (!/coach/i.test(line) || /Conjure Fitness|\b(removed|renamed?)\b/i.test(line)) return;
      const rest = ALLOWED.reduce((s, re) => s.replace(re, ""), line);
      if (/coach/i.test(rest)) hits.push(`${path}:${i + 1}: ${line.trim()}`);
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

  it("names a coach nowhere else in shipped code, copy or styles", () => {
    expect(leftoverCoachLines()).toEqual([]);
  });

  it("still sees the source it is guarding (positive control)", () => {
    // An empty glob would pass every test above for the wrong reason.
    expect(Object.keys(SHIPPED)).toContain("./App.tsx");
    expect(Object.keys(SHIPPED)).toContain("./styles.css");
    expect(Object.keys(SHIPPED).length).toBeGreaterThan(100);
  });
});
