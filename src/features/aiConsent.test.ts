import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Profile } from "../types";
import {
  DISCLOSURE_COACH_SAMPLE,
  DISCLOSURE_SAMPLE,
  DISCLOSURE_SENDS,
  DISCLOSURE_VERSION,
  DISCLOSURE_WITHHOLDS,
  consentIsCurrent,
  hasAiJournalConsent,
  readAiJournalConsent,
  recordAiJournalConsent,
  setAiJournalNotes,
  withStoredConsent,
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

/**
 * Every other profile write starts from a copy of the profile read earlier.
 * The agreement in that copy may be out of date either way, so the one on
 * file is what a write keeps.
 */
describe("a profile saved from an earlier copy", () => {
  const agreed = (version: number, includeNotes = false) => ({
    version,
    acceptedAt: "2026-10-01T00:00:00.000Z",
    includeNotes,
  });

  it("does not bring back an agreement withdrawn since the copy was read", async () => {
    const copy: Profile = { ...base, aiJournalConsent: agreed(DISCLOSURE_VERSION, true) };
    const next = await withStoredConsent({ ...copy, units: "imperial" });
    expect(next.aiJournalConsent).toBeUndefined();
    expect("aiJournalConsent" in next).toBe(false);
    expect(next.units).toBe("imperial");
  });

  it("keeps an agreement made since the copy was read, in place of the copy's", async () => {
    await recordAiJournalConsent(true);
    const copy: Profile = { ...base, aiJournalConsent: agreed(DISCLOSURE_VERSION - 1) };
    const next = await withStoredConsent(copy);
    expect(next.aiJournalConsent).toEqual(stored!.aiJournalConsent);
  });

  it("fails closed: an unreadable profile keeps no agreement", async () => {
    await recordAiJournalConsent(false);
    throwOnRead = true;
    const next = await withStoredConsent({ ...base, aiJournalConsent: agreed(DISCLOSURE_VERSION) });
    expect(next.aiJournalConsent).toBeUndefined();
  });

  it("is how every profile write outside this module saves", () => {
    const sources = import.meta.glob(["../**/*.ts", "../**/*.tsx", "!../**/*.test.*", "!../data/**", "!../testing/**"], {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    const unguarded = Object.entries(sources)
      .filter(([path]) => !path.endsWith("/aiConsent.ts"))
      .filter(([, src]) => (src.match(/\.saveProfile\(/g) ?? []).length > (src.match(/withStoredConsent\(/g) ?? []).length)
      .map(([path]) => path);
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    expect(unguarded).toEqual([]);
  });
});

describe("the disclosure wording", () => {
  const all = [...DISCLOSURE_SENDS, ...DISCLOSURE_WITHHOLDS, DISCLOSURE_SAMPLE, DISCLOSURE_COACH_SAMPLE];

  it("follows the copy rules: no em-dashes, and nothing comparing itself to an earlier version", () => {
    for (const line of all) {
      expect(line).not.toContain("\u2014");
      expect(line).not.toMatch(/\bnow\b|\byet\b|no longer/i);
    }
  });

  it("names everything the coach summary sends", () => {
    const sends = DISCLOSURE_SENDS.join("\n");
    for (const field of [
      "7 days before today",
      "how rested you felt",
      "targets",
      "goal weight",
      "since your first",
      "height, age, sex and activity level",
      "your goal in your own words",
      "weekly exercise target",
      "how often each came up",
    ]) {
      expect(sends).toContain(field);
    }
  });

  it("says plainly that only Find patterns sends a symptom note, and only once", () => {
    const withholds = DISCLOSURE_WITHHOLDS.join("\n");
    expect(withholds).toContain("Notes you type on a night's sleep");
    expect(withholds).toContain("then Find patterns sends it once, with the question that asked for it");
    // The coach's earlier replies go with each question (coach/ask.ts), so
    // nothing here may promise the coach never repeats something it was told.
    expect(withholds).not.toMatch(/coach never sends/);
  });

  it("names the conversation each question resends, and that a Find patterns range is not in it", () => {
    const sends = DISCLOSURE_SENDS.join("\n");
    expect(sends).toMatch(/last \d+ messages of your conversation with it, its replies included/);
    expect(sends).toContain("sent once with that question and not with later ones");
    expect(DISCLOSURE_WITHHOLDS.join("\n")).toContain("what its earlier replies mention");
  });
});
