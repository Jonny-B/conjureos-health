import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiJournalConsent } from "../types";
import { DEFAULT_PROFILE } from "../types";

/**
 * Versions 1 and 2 of the AI agreement were kept on the profile, and an older
 * version of the app still reads it there (from the device's own store, or
 * from the synced copy when it starts on a device for the first time). A
 * withdrawal drops it (features/aiConsent.ts, `dropProfileAgreement`).
 *
 * Settings' units write and the plan builder save the profile App read at
 * startup, which still carries that agreement after a withdrawal. A save must
 * not put it back, or the older version reads an agreement the person
 * withdrew and sends again.
 */

// node env has no window/localStorage: back it with a Map, so the device's
// own store is the one written.
function installLocalStorage(): Map<string, string> {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
  (globalThis as unknown as { window: { localStorage: unknown } }).window = { localStorage: storage };
  return map;
}

const V2: AiJournalConsent = { version: 2, acceptedAt: "2026-10-01T09:00:00.000Z", includeNotes: false };

const STORE_WITH_V2 = {
  v: 3,
  profile: { ...DEFAULT_PROFILE, aiJournalConsent: V2 },
  goals: null,
  diary: [],
  weights: [],
  plan: null,
  dayLogs: {},
  workoutSessions: [],
  sleep: [],
  water: [],
  symptoms: [],
};

let ls: Map<string, string>;
// The in-memory VFS the repository writes to: one per module load, so it is
// taken after the reset.
let vfs: typeof import("../bridge/vfs").vfs;

beforeEach(async () => {
  vi.resetModules();
  ls = installLocalStorage();
  ({ vfs } = await import("../bridge/vfs"));
  // What an older version left: the agreement on the profile.
  await vfs.write("store.json", JSON.stringify(STORE_WITH_V2));
});

describe("the agreement older versions kept on the profile", () => {
  it("stays dropped after a withdrawal when a profile read before it is saved", async () => {
    const { getRepository } = await import("./repository");
    const repo = await getRepository();
    const readAtStartup = await repo.getProfile();
    expect(readAtStartup?.aiJournalConsent).toEqual(V2);

    const { withdrawAiJournalConsent } = await import("../features/aiConsent");
    expect(await withdrawAiJournalConsent()).toBe(true);
    expect((await repo.getProfile())?.aiJournalConsent).toBeUndefined();

    // Settings' units write, over the copy App read at startup.
    await repo.saveProfile({ ...readAtStartup!, units: "imperial" });

    expect((await repo.getProfile())?.units).toBe("imperial");
    expect((await repo.getProfile())?.aiJournalConsent).toBeUndefined();
    // Neither the device's own store nor the synced copy an older version reads.
    expect([...ls.values()].join("")).not.toContain("aiJournalConsent");
    expect(await vfs.read("store.json")).not.toContain("aiJournalConsent");
  });

  it("is never written by this version's profile saves", async () => {
    const { getRepository } = await import("./repository");
    const repo = await getRepository();
    await repo.saveProfile({ ...DEFAULT_PROFILE, units: "imperial", aiJournalConsent: V2 });
    expect((await repo.getProfile())?.aiJournalConsent).toBeUndefined();
  });
});
