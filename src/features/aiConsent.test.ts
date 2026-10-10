import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Profile } from "../types";
import {
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
let throwOnRead = false;

const repo = {
  getProfile: async () => {
    if (throwOnRead) throw new Error("backend down");
    return stored;
  },
  saveProfile: async (p: Profile) => void (stored = p),
};
vi.mock("../data/repository", () => ({ getRepository: async () => repo }));

beforeEach(() => {
  stored = { ...base };
  throwOnRead = false;
});

describe("consent is required before anything is disclosed", () => {
  it("is absent on a fresh profile", async () => {
    expect(await hasAiJournalConsent()).toBe(false);
  });

  it("fails closed when the profile cannot be read", async () => {
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

  it("reports failure rather than silently agreeing when there is no profile", async () => {
    // The agreement is the record. If it cannot be written there is no
    // record, and the caller must not proceed.
    stored = null;
    expect(await recordAiJournalConsent(true)).toBe(false);
    expect(await hasAiJournalConsent()).toBe(false);
  });
});

describe("re-wording the disclosure re-asks", () => {
  it("does not treat agreement to older wording as current", async () => {
    await recordAiJournalConsent(true);
    stored = {
      ...(stored as Profile),
      aiJournalConsent: {
        acceptedAt: new Date().toISOString(),
        version: DISCLOSURE_VERSION - 1,
        includeNotes: true,
      },
    };
    expect(await hasAiJournalConsent()).toBe(false);
    expect(consentIsCurrent((stored as Profile).aiJournalConsent)).toBe(false);
  });
});

/**
 * The ask path's line names it by the name a person sees: Ask Health. That
 * name replaced "asking the coach" on the same path, so the wording version
 * did not move and existing agreements still cover it. See the note on
 * DISCLOSURE_VERSION before changing either half of this.
 *
 * This pins WORDING only. It is not evidence that the windows the lines
 * describe are what gets sent: Find patterns also carries Ask Health's
 * today-plus-2-days context, and later questions replay its range summary
 * (ConjureOS #1163).
 */
describe("the disclosure names Ask Health", () => {
  it("names Ask Health for the ask path, and names no coach", () => {
    const lines = [...DISCLOSURE_SENDS, ...DISCLOSURE_WITHHOLDS];
    expect(lines).toContain("Ask Health: today in full, plus daily totals from the 2 days before");
    expect(lines).toContain("Ask Health: anything from more than 2 days before today");
    for (const line of lines) expect(line).not.toMatch(/coach/i);
  });

  it("stays on the wording version agreements were given under", () => {
    expect(DISCLOSURE_VERSION).toBe(2);
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

  it("leaves the rest of the profile alone", async () => {
    await recordAiJournalConsent(true);
    await withdrawAiJournalConsent();
    expect(stored).toMatchObject({ age: 40, heightCm: 180, units: "metric" });
  });
});
