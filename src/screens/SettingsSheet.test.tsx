import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Profile } from "../types";
import { DISCLOSURE_VERSION } from "../features/aiConsent";
import { button, runtime, textOf } from "../testing/hooks";

vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  const { runtime: rt } = await import("../testing/hooks");
  const api = { ...actual, ...rt.hooks };
  return { ...api, default: api };
});
vi.mock("../hooks/useScrollLock", () => ({ useScrollLock: () => {} }));

const base: Profile = {
  sex: "female",
  age: 41,
  heightCm: 165,
  weightKg: 70,
  activityLevel: "light",
  direction: "maintain",
  units: "metric",
};
let stored: Profile | null = null;
vi.mock("../data/repository", () => ({
  getRepository: async () => ({
    getProfile: async () => stored,
    saveProfile: async (p: Profile) => void (stored = p),
  }),
}));

beforeEach(() => {
  runtime.reset();
  stored = { ...base };
});

/**
 * App reads the profile once, at startup. Withdrawing AI consent in this sheet
 * writes the stored profile and leaves App's copy as it was, and the units
 * chips save from that copy.
 */
describe("choosing units in Settings", () => {
  it("never brings back an AI agreement withdrawn since the app opened", async () => {
    const { SettingsSheet } = await import("./SettingsSheet");
    const cached: Profile = {
      ...base,
      aiJournalConsent: { version: DISCLOSURE_VERSION, acceptedAt: "2026-10-01T00:00:00.000Z", includeNotes: true },
    };
    const saved: Profile[] = [];
    const tree = await runtime.render(SettingsSheet, {
      goals: { calories: 2000, protein: 120, carbs: 220, fat: 70 },
      profile: cached,
      plan: null,
      onClose: () => {},
      onSave: (_g, p) => void saved.push(p),
      onPlanChange: () => {},
    });
    await (button(tree, "Imperial").props.onClick as () => Promise<void>)();
    await new Promise((r) => setTimeout(r, 0));
    expect(stored?.units).toBe("imperial");
    expect(stored?.aiJournalConsent).toBeUndefined();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.aiJournalConsent).toBeUndefined();
  });
});

/**
 * A wording change (DISCLOSURE_VERSION) puts everyone who agreed before it
 * back on "nothing is sent", including people who have used both features.
 * What the sheet says happens next has to be true for them too.
 */
describe("the AI agreement in Privacy, when none is current", () => {
  const settings = async () => {
    const { SettingsSheet } = await import("./SettingsSheet");
    const tree = await runtime.render(SettingsSheet, {
      goals: { calories: 2000, protein: 120, carbs: 220, fat: 70 },
      profile: stored,
      plan: null,
      onClose: () => {},
      onSave: () => {},
      onPlanChange: () => {},
    });
    return textOf(tree).replace(/\s+/g, " ");
  };

  it("says they are asked before anything is sent, not that it is the first time", async () => {
    stored = {
      ...base,
      aiJournalConsent: { version: DISCLOSURE_VERSION - 1, acceptedAt: "2026-09-01T00:00:00.000Z", includeNotes: true },
    };
    const text = await settings();
    expect(text).toContain(
      "Nothing is sent. Before Find patterns or your health coach sends anything, you will be asked and shown exactly what would go.",
    );
    expect(text).not.toMatch(/first time/i);
    expect(text).not.toMatch(/\b(now|yet|no longer)\b|\u2014/i);
  });

  it("says the same to someone who never agreed", async () => {
    const text = await settings();
    expect(text).toContain("Before Find patterns or your health coach sends anything, you will be asked");
  });
});
