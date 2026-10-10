/**
 * Apps never get a place in the ConjureOS shell's Chat (ConjureOS #513).
 * Health's conversation, Ask Health, lives inside the app; the shell's Chat
 * reaches Health only through the declared actions, and none of those is a
 * conversation or a coach.
 */

import { describe, expect, it } from "vitest";
import pkg from "../package.json";

const manifest = pkg.conjureos as Record<string, unknown> & {
  permissions: string[];
  actions: Record<string, unknown>;
  promptSuggestions: string[];
};

const SHIPPED = import.meta.glob(["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

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
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name).not.toMatch(/coach|chat|ask/i);
      expect(JSON.stringify(manifest.actions[name])).not.toMatch(/coach|chat|ask health/i);
    }
  });

  it("describes no coach to the shell or the store", () => {
    expect(pkg.description).not.toMatch(/coach/i);
    for (const s of manifest.promptSuggestions) expect(s).not.toMatch(/coach/i);
  });

  it("never reaches for the shell's chat bridge from code", () => {
    const users = Object.entries(SHIPPED)
      .filter(([, text]) => /__conjureos\s*\??\.\s*chat\b/.test(text))
      .map(([path]) => path);
    expect(users).toEqual([]);
    expect(Object.keys(SHIPPED)).toContain("./App.tsx");
  });
});
