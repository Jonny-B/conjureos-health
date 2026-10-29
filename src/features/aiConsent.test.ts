import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AiJournalConsent, Profile } from "../types";
import {
  AI_CONSENT_PATH,
  AI_FEATURES,
  DISCLOSURE_SENDS,
  DISCLOSURE_VERSION,
  DISCLOSURE_WITHHOLDS,
  consentIsCurrent,
  hasAiJournalConsent,
  readAiJournalConsent,
  recordAiJournalConsent,
  setAiJournalNotes,
  withdrawAiJournalConsent,
} from "./aiConsent";

const base: Profile = {
  sex: "male",
  age: 40,
  heightCm: 180,
  weightKg: 82,
  activityLevel: "moderate",
  direction: "lose",
  units: "metric",
};

let stored: Profile | null = base;
const files: Record<string, string> = {};
let throwOnRead = false;

const repo = {
  getProfile: async () => stored,
  saveProfile: async (p: Profile) => void (stored = p),
};
vi.mock("../data/repository", () => ({ getRepository: async () => repo }));
// The agreement is a file of its own (see the note at the top of aiConsent.ts).
vi.mock("../bridge/vfs", () => ({
  readJson: async (p: string, d: unknown) => {
    if (throwOnRead) throw new Error("vfs offline");
    return files[p] ? JSON.parse(files[p]!) : d;
  },
  writeJsonOrThrow: async (p: string, v: unknown) => void (files[p] = JSON.stringify(v)),
}));

const onFile = () => JSON.parse(files[AI_CONSENT_PATH] ?? "null") as AiJournalConsent | null;

beforeEach(() => {
  stored = { ...base };
  for (const k of Object.keys(files)) delete files[k];
  throwOnRead = false;
});

describe("consent is required before anything is disclosed", () => {
  it("is absent on a fresh profile", async () => {
    expect(await hasAiJournalConsent()).toBe(false);
  });

  it("fails closed when the agreement cannot be read", async () => {
    // Not knowing what was agreed is not the same as having agreed. A backend
    // hiccup must never open the disclosure.
    throwOnRead = true;
    expect(await hasAiJournalConsent()).toBe(false);
    expect(await readAiJournalConsent()).toBeUndefined();
  });

  it("holds once recorded, and remembers the date and the notes choice", async () => {
    expect(await recordAiJournalConsent(false)).toBe(true);
    expect(await hasAiJournalConsent()).toBe(true);
    const c = await readAiJournalConsent();
    expect(c?.version).toBe(DISCLOSURE_VERSION);
    expect(c?.includeNotes).toBe(false);
    expect(Number.isNaN(Date.parse(c?.acceptedAt ?? ""))).toBe(false);
  });

  it("can be given before there is a profile", async () => {
    // A new person has no profile until their first plan is saved, and the
    // plan builder is behind this agreement.
    stored = null;
    expect(await recordAiJournalConsent(true)).toBe(true);
    expect(await hasAiJournalConsent()).toBe(true);
  });
});

describe("re-wording the disclosure re-asks", () => {
  it("does not treat agreement to older wording as current", async () => {
    await recordAiJournalConsent(true);
    files[AI_CONSENT_PATH] = JSON.stringify({ ...onFile(), version: DISCLOSURE_VERSION - 1 });
    expect(await hasAiJournalConsent()).toBe(false);
    expect(consentIsCurrent(onFile() ?? undefined)).toBe(false);
  });

  it("does not read an agreement older versions kept on the profile", async () => {
    stored = {
      ...base,
      aiJournalConsent: { acceptedAt: new Date().toISOString(), version: DISCLOSURE_VERSION, includeNotes: false },
    };
    expect(await hasAiJournalConsent()).toBe(false);
  });
});

describe("the notes opt-in is separate from the accept", () => {
  it("can be changed without re-accepting", async () => {
    await recordAiJournalConsent(false);
    await setAiJournalNotes(true);
    expect((await readAiJournalConsent())?.includeNotes).toBe(true);
    expect(await hasAiJournalConsent()).toBe(true);
  });

  it("cannot become a back door to consenting", async () => {
    // No agreement on file: turning notes on must not manufacture one.
    await setAiJournalNotes(true);
    expect(await hasAiJournalConsent()).toBe(false);
    expect(await readAiJournalConsent()).toBeUndefined();
  });
});

describe("withdrawal", () => {
  it("removes the agreement so the gate asks again", async () => {
    await recordAiJournalConsent(true);
    await withdrawAiJournalConsent();
    expect(await hasAiJournalConsent()).toBe(false);
    expect(await readAiJournalConsent()).toBeUndefined();
  });

  it("clears the stored agreement, and the one older versions kept on the profile", async () => {
    stored = {
      ...base,
      aiJournalConsent: { acceptedAt: "2026-10-01T09:00:00.000Z", version: 2, includeNotes: false },
    };
    await recordAiJournalConsent(true);
    expect(await withdrawAiJournalConsent()).toBe(true);
    expect(onFile()).toBeNull();
    expect(stored?.aiJournalConsent).toBeUndefined();
  });

  it("leaves the rest of the profile alone", async () => {
    await recordAiJournalConsent(true);
    await withdrawAiJournalConsent();
    expect(stored).toMatchObject({ age: 40, heightCm: 180, units: "metric" });
  });
});

/**
 * The ask path's lines name it by the name a person sees: Ask Health. That
 * name replaced "asking the coach" on the same path, so the wording version
 * did not move and existing agreements still cover it. See the note on
 * DISCLOSURE_VERSION before changing either half of this.
 */
describe("the disclosure names Ask Health", () => {
  it("names Ask Health for the ask path, and names no coach", () => {
    const lines = [...DISCLOSURE_SENDS, ...DISCLOSURE_WITHHOLDS];
    expect(lines).toContain("Ask Health: today in full, plus daily totals from the 2 days before");
    expect(lines).toContain("Ask Health: anything from more than 2 days before today");
    expect(lines).toContain(
      "The names of foods you ate (up to 12 a day for Find patterns; up to 25 for today, with Ask Health)",
    );
    for (const line of lines) {
      expect(line).not.toMatch(/coach|ask about food/i);
      expect(line).not.toContain("\u2014");
    }
  });

});

/**
 * Version 3 (owner decision 2026-10-29, ConjureOS #1163): every feature that
 * sends to the AI is behind the agreement, and the wording names each one and
 * what it sends. The disclosure got wider, so the version went up and everyone
 * who agreed to v2 is asked once more. See the note on DISCLOSURE_VERSION
 * before changing either half of this.
 */
describe("the disclosure covers every feature that sends to the AI", () => {
  it("names each feature, and what each one sends", () => {
    expect([...AI_FEATURES]).toEqual([
      "Building a plan",
      "Adding food from a description",
      "Adding food from a photo",
      "Food estimates other apps ask for",
      "Find patterns",
      "Ask Health",
    ]);
    for (const name of AI_FEATURES) {
      expect(DISCLOSURE_SENDS.some((line) => line.startsWith(`${name}: `))).toBe(true);
    }
  });

  it("says the features that do not read the journal leave it alone", () => {
    expect(DISCLOSURE_WITHHOLDS).toContain(
      "Building a plan, adding food, and food estimates: your food diary, symptoms, sleep, water and past weigh-ins",
    );
  });

  it("keeps the copy rules", () => {
    for (const line of [...AI_FEATURES, ...DISCLOSURE_SENDS, ...DISCLOSURE_WITHHOLDS]) {
      expect(line).not.toContain("\u2014");
      expect(line).not.toMatch(/\b(now|no longer|yet)\b/i);
    }
  });

  it("is on the version that re-asks everyone who agreed to the narrower wording", () => {
    expect(DISCLOSURE_VERSION).toBe(3);
  });
});
