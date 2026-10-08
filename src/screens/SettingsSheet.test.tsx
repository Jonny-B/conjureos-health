import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Profile } from "../types";
import { DISCLOSURE_VERSION } from "../features/aiConsent";
import { button, runtime } from "../testing/hooks";

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
