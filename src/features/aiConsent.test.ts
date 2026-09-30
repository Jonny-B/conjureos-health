import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Profile } from "../types";
import {
  AI_CONSENT_VFS_PATH,
  DISCLOSURE_VERSION,
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

// In-memory VFS: the node test env has no window.__vfs for the real wrapper.
const files = new Map<string, string>();
let throwOnWrite = false;
vi.mock("../bridge/vfs", () => ({
  vfs: {
    read: async (p: string) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    exists: async (p: string) => files.has(p),
    rm: async (p: string) => void files.delete(p),
  },
  readJson: async <T,>(p: string, fallback: T): Promise<T> => {
    const v = files.get(p);
    return v === undefined ? fallback : (JSON.parse(v) as T);
  },
  writeJsonOrThrow: async (p: string, v: unknown) => {
    if (throwOnWrite) throw new Error("disk full");
    files.set(p, JSON.stringify(v));
  },
}));

beforeEach(() => {
  stored = { ...base };
  throwOnRead = false;
  throwOnWrite = false;
  files.clear();
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

  it("records to the VFS key when there is no profile, without fabricating one", async () => {
    // A plan-less user can use the Diary and the coach. Their accept must
    // stick, and must not invent a profile (commitNewPlan would overwrite it).
    stored = null;
    expect(await recordAiJournalConsent(true)).toBe(true);
    expect(stored).toBeNull();
    expect(files.has(AI_CONSENT_VFS_PATH)).toBe(true);
    expect(await hasAiJournalConsent()).toBe(true);
    expect((await readAiJournalConsent())?.includeNotes).toBe(true);
  });

  it("still honours the VFS consent once a profile exists without one", async () => {
    stored = null;
    await recordAiJournalConsent(false);
    stored = { ...base };
    expect(await hasAiJournalConsent()).toBe(true);
  });

  it("prefers the profile's consent over the VFS key", async () => {
    stored = null;
    await recordAiJournalConsent(false);
    stored = {
      ...base,
      aiJournalConsent: { acceptedAt: new Date().toISOString(), version: DISCLOSURE_VERSION, includeNotes: true },
    };
    expect((await readAiJournalConsent())?.includeNotes).toBe(true);
  });

  it("reports failure rather than silently agreeing when the write fails", async () => {
    // The agreement is the record. If it cannot be written there is no
    // record, and the caller must not proceed — and must not see a throw.
    stored = null;
    throwOnWrite = true;
    expect(await recordAiJournalConsent(true)).toBe(false);
    expect(await hasAiJournalConsent()).toBe(false);
  });

  it("reports failure when saving the profile throws", async () => {
    throwOnRead = true;
    expect(await recordAiJournalConsent(true)).toBe(false);
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

describe("the notes opt-in without a profile", () => {
  it("amends the VFS consent", async () => {
    stored = null;
    await recordAiJournalConsent(false);
    await setAiJournalNotes(true);
    expect((await readAiJournalConsent())?.includeNotes).toBe(true);
    expect(stored).toBeNull();
  });

  it("is still not a back door to consenting", async () => {
    stored = null;
    await setAiJournalNotes(true);
    expect(files.size).toBe(0);
    expect(await hasAiJournalConsent()).toBe(false);
  });
});

describe("withdrawal", () => {
  it("clears a consent held in the VFS key", async () => {
    stored = null;
    await recordAiJournalConsent(true);
    await withdrawAiJournalConsent();
    expect(files.has(AI_CONSENT_VFS_PATH)).toBe(false);
    expect(await hasAiJournalConsent()).toBe(false);
  });

  it("clears both locations when both hold one", async () => {
    stored = null;
    await recordAiJournalConsent(true);
    await repo.saveProfile({
      ...base,
      aiJournalConsent: { acceptedAt: new Date().toISOString(), version: DISCLOSURE_VERSION, includeNotes: true },
    });
    await withdrawAiJournalConsent();
    expect(await hasAiJournalConsent()).toBe(false);
    expect(await readAiJournalConsent()).toBeUndefined();
  });

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
