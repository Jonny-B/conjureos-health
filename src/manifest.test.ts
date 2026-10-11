/**
 * Apps never get a place in the ConjureOS shell's Chat (ConjureOS #513).
 * Health's conversation, Ask Health, lives inside the app; the shell reaches
 * Health only through the declared actions and intents, and none of those is
 * a conversation or a coach. Coaching is a Conjure Fitness feature.
 */

import { describe, expect, it } from "vitest";
import pkg from "../package.json";

const manifest = pkg.conjureos as Record<string, unknown> & {
  permissions: string[];
  actions: Record<string, unknown>;
  intents: Record<string, unknown>;
  promptSuggestions: string[];
};

const SHIPPED = import.meta.glob(["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Names the removed coach and the renamed Q&A went by. */
const OLD_NAMES = /coach|trainer|ask about food|food questions/i;

describe("Health's ConjureOS manifest", () => {
  it("declares no chat block", () => {
    expect(Object.keys(manifest).filter((k) => /chat/i.test(k))).toEqual([]);
  });

  it("asks for no chat permission", () => {
    expect(manifest.permissions.length).toBeGreaterThan(0);
    expect(manifest.permissions.filter((p) => /chat/i.test(p))).toEqual([]);
  });

  it("exposes no action that is a conversation, Ask Health or a coach", () => {
    const names = Object.keys(manifest.actions);
    // The 23 cross-app actions stay as they are; this only reads them.
    expect(names.length).toBe(23);
    for (const name of names) {
      expect(name).not.toMatch(/coach|chat|ask/i);
      const body = JSON.stringify(manifest.actions[name]);
      expect(body, name).not.toMatch(/chat|ask health/i);
      expect(body, name).not.toMatch(OLD_NAMES);
    }
  });

  it("opens no conversation or coach through an intent", () => {
    for (const [name, intent] of Object.entries(manifest.intents)) {
      expect(name).not.toMatch(/coach|chat|ask/i);
      expect(JSON.stringify(intent), name).not.toMatch(OLD_NAMES);
      expect(JSON.stringify(intent), name).not.toMatch(/chat|ask health/i);
    }
  });

  it("describes no coach to the shell or the store", () => {
    expect(pkg.description).not.toMatch(OLD_NAMES);
    expect(manifest.promptSuggestions.length).toBeGreaterThan(0);
    for (const s of manifest.promptSuggestions) expect(s).not.toMatch(OLD_NAMES);
    expect(JSON.stringify(manifest)).not.toMatch(OLD_NAMES);
  });

  it("never reaches for the shell's chat bridge from code", () => {
    const users = Object.entries(SHIPPED)
      .filter(([, text]) => /__conjureos\s*\??\.\s*chat\b/.test(text))
      .map(([path]) => path);
    expect(users).toEqual([]);
    expect(Object.keys(SHIPPED)).toContain("./App.tsx");
  });
});
