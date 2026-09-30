import { describe, expect, it, beforeEach } from "vitest";
import type { Plan, Profile } from "../types";
import { DEFAULT_GOALS, DEFAULT_PROFILE } from "../types";
import { vfs } from "../bridge/vfs";
import { planTracksCalories } from "../features/plan/model";
import { goalsToTargets, targetsToGoals } from "../features/plan/planService";
import { MockRepository, clearTrainerMemoryOnce } from "./mockRepository";

// node env has no window/localStorage — back it with a tiny Map-based Storage
// so the device-local persistence path is exercised.
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
  (globalThis as unknown as { window: { localStorage: unknown } }).window = {
    localStorage: storage,
  };
  return map;
}

const imperial = (): Profile => ({ ...DEFAULT_PROFILE, units: "imperial" });

describe("MockRepository device-local persistence", () => {
  let ls: Map<string, string>;

  beforeEach(async () => {
    ls = installLocalStorage();
    // Wipe the shared in-memory VFS mirror between tests.
    await vfs.write("store.json", JSON.stringify({ v: 2 }));
  });

  it("keeps a device-local write across a reopen even when the synced VFS blob is stale", async () => {
    // 1. Save imperial units and let it flush to both localStorage + VFS.
    const repo = new MockRepository();
    await repo.init();
    await repo.saveProfile(imperial());
    expect(ls.has(STORE_KEY)).toBe(true);

    // 2. Simulate a stale cloud pull: another surface's blind flush overwrites
    //    the synced VFS store.json with an OLD metric profile.
    await vfs.write(
      "store.json",
      JSON.stringify({ ...EMPTY_STORE, profile: { ...DEFAULT_PROFILE, units: "metric" } }),
    );

    // 3. Reopen the app (fresh repository instance) → must read the device-local
    //    authoritative copy, NOT the stale synced blob.
    const reopened = new MockRepository();
    await reopened.init();
    const p = await reopened.getProfile();
    expect(p?.units).toBe("imperial");
  });

  it("seeds from the VFS mirror on a fresh device (empty localStorage)", async () => {
    // A device with no local copy but a synced store.json should adopt it once.
    await vfs.write(
      "store.json",
      JSON.stringify({ ...EMPTY_STORE, profile: { ...DEFAULT_PROFILE, units: "imperial" } }),
    );
    ls.clear();

    const repo = new MockRepository();
    await repo.init();
    expect((await repo.getProfile())?.units).toBe("imperial");
    // …and pins it locally so the next load is device-authoritative.
    expect(ls.has(STORE_KEY)).toBe(true);
  });

  it("degrades to the VFS mirror when localStorage is disabled (private mode)", async () => {
    // window exists but touching localStorage throws — the real private-mode /
    // blocked-storage case. Persistence must fall back to the VFS mirror.
    (globalThis as unknown as { window: object }).window = {
      get localStorage(): unknown {
        throw new Error("storage disabled");
      },
    };
    const repo = new MockRepository();
    await repo.init();
    await repo.saveProfile(imperial());
    const reopened = new MockRepository();
    await reopened.init();
    expect((await reopened.getProfile())?.units).toBe("imperial");
  });

  // ── Bug 1: two-tab clobber ───────────────────────────────────────────

  it("a write from one tab does not erase a write another tab already persisted", async () => {
    // Two live instances against the SAME localStorage (two browser tabs).
    const tabA = new MockRepository();
    await tabA.init();
    const tabB = new MockRepository();
    await tabB.init();

    // Tab A logs a diary entry and flushes.
    await tabA.addDiaryEntry({
      date: "2026-01-01",
      meal: "breakfast",
      quantity: 1,
      food: aFood(),
    });

    // Tab B, still holding its OLDER in-memory snapshot (without A's entry),
    // now saves an unrelated profile change and flushes.
    await tabB.saveProfile(imperial());

    // Both writes must survive: B's flush must not have blind-overwritten the
    // whole document with its stale pre-A snapshot.
    const reopened = new MockRepository();
    await reopened.init();
    expect(await reopened.listDiary("2026-01-01")).toHaveLength(1);
    expect((await reopened.getProfile())?.units).toBe("imperial");
  });

  it("tab A's own diary entry survives even when read back through tab B", async () => {
    // Same setup as above, but assert on tabB directly (no reopen) — the
    // storage-event listener should also keep tabB's in-memory copy fresh.
    const tabA = new MockRepository();
    await tabA.init();
    const tabB = new MockRepository();
    await tabB.init();

    await tabA.addDiaryEntry({
      date: "2026-01-02",
      meal: "lunch",
      quantity: 1,
      food: aFood(),
    });
    await tabB.saveProfile(imperial());

    // tabB's own flush() re-reads localStorage immediately beforehand, so its
    // in-memory copy (and anything persisted) reflects A's entry too.
    expect(await tabB.listDiary("2026-01-02")).toHaveLength(1);
  });

  // ── Bug 2: a failed write must not resolve as success ───────────────

  it("rejects a mutation when both localStorage and the VFS mirror fail to persist", async () => {
    failNextLocalStorageWrites();
    const originalWrite = vfs.write;
    vfs.write = async () => {
      throw new Error("VFS mirror unavailable");
    };
    try {
      const repo = new MockRepository();
      await repo.init();
      await expect(repo.saveProfile(imperial())).rejects.toThrow();
    } finally {
      vfs.write = originalWrite;
    }
  });

  it("still resolves when localStorage fails but the VFS mirror succeeds", async () => {
    const repo = new MockRepository();
    await repo.init();
    failNextLocalStorageWrites();
    await expect(repo.saveProfile(imperial())).resolves.toBeUndefined();
  });
});

describe("MockRepository storage failures", () => {
  let ls: Map<string, string>;

  beforeEach(async () => {
    ls = installLocalStorage();
    await vfs.write("store.json", JSON.stringify({ v: 2 }));
  });

  const entry = (meal: "breakfast" | "lunch" | "dinner") => ({
    date: "2026-01-05",
    meal,
    quantity: 1,
    food: aFood(),
  });

  it("keeps every later change, and survives a reload, after a localStorage write fails", async () => {
    const repo = new MockRepository();
    await repo.init();
    await repo.saveProfile(imperial());

    // Quota fills up: from here the VFS mirror is the only copy that lands.
    failNextLocalStorageWrites();
    await repo.addDiaryEntry(entry("breakfast"));
    await repo.addDiaryEntry(entry("lunch"));

    // The second change must build on the first, not on the stale local copy.
    expect(await repo.listDiary("2026-01-05")).toHaveLength(2);
    expect(JSON.parse(await vfs.read("store.json")).diary).toHaveLength(2);

    const reopened = new MockRepository();
    await reopened.init();
    expect(await reopened.listDiary("2026-01-05")).toHaveLength(2);
    expect((await reopened.getProfile())?.units).toBe("imperial");
  });

  it("registers the cross-tab watcher when a local copy already exists", async () => {
    const listeners: Array<(e: { key: string; newValue: string | null }) => void> = [];
    const w = (globalThis as unknown as { window: Record<string, unknown> }).window;
    w.addEventListener = (_type: string, fn: (e: { key: string; newValue: string | null }) => void) => {
      listeners.push(fn);
    };

    const tabA = new MockRepository();
    await tabA.init(); // first run: no local copy yet
    await tabA.saveProfile(imperial());
    const tabB = new MockRepository();
    await tabB.init(); // local copy exists
    expect(listeners).toHaveLength(2);

    await tabA.addDiaryEntry(entry("dinner"));
    expect(await tabB.listDiary("2026-01-05")).toHaveLength(0);
    // The browser delivers the storage event to the other tab only.
    const key = STORE_KEY;
    listeners[1]!({ key, newValue: ls.get(key)! });
    expect(await tabB.listDiary("2026-01-05")).toHaveLength(1);
  });

  describe("when the VFS store cannot be read on a device with no local copy", () => {
    let writes: Array<[string, string]>;
    let removed: string[];
    let failReads: boolean;
    const synced = {
      v: 3,
      profile: null,
      goals: null,
      diary: [] as unknown[],
      weights: [],
      plan: null,
      dayLogs: {},
      workoutSessions: [],
      sleep: [],
      water: [],
      symptoms: [],
    };

    beforeEach(() => {
      writes = [];
      removed = [];
      failReads = true;
      (globalThis as unknown as { window: Record<string, unknown> }).window.__vfs = {
        exists: async () => true,
        read: async () => {
          if (failReads) throw new Error("vfs timeout");
          const row = { ...entry("lunch"), id: "synced", loggedAt: "2026-01-05T12:00:00Z" };
          return JSON.stringify({ ...synced, diary: [row] });
        },
        write: async (path: string, content: string) => void writes.push([path, content]),
        ls: async () => [],
        mkdir: async () => {},
        rm: async (path: string) => void removed.push(path),
      };
    });

    it("does not pin an empty store locally or write it to the mirror", async () => {
      const repo = new MockRepository();
      await repo.init();
      expect(ls.has(STORE_KEY)).toBe(false);
      expect(writes).toEqual([]);
    });

    it("fails the save loudly while the store is still unreadable, without writing anything", async () => {
      const repo = new MockRepository();
      await repo.init();
      await expect(repo.saveProfile(imperial())).rejects.toThrow();
      expect(ls.has(STORE_KEY)).toBe(false);
      expect(writes).toEqual([]);
    });

    it("retries the read before the first write and keeps the synced data", async () => {
      const repo = new MockRepository();
      await repo.init();
      failReads = false;
      await repo.saveProfile(imperial());
      expect(await repo.listDiary("2026-01-05")).toHaveLength(1);
      const mirror = JSON.parse(writes[writes.length - 1]![1]);
      expect(mirror.diary).toHaveLength(1);
      expect(mirror.profile.units).toBe("imperial");
    });

    it("removes the trainer's memory even while the store is unreadable, and keeps v3", async () => {
      const repo = new MockRepository();
      await repo.init();
      await settle();
      expect(removed).toEqual(["coach.json"]);
      failReads = false;
      await repo.saveProfile(imperial());
      expect(JSON.parse(writes[writes.length - 1]![1]).v).toBe(3);
    });
  });
});

// ── The split from Conjure Fitness: old plans and files are retired ──────────
//
// Stores saved before the split can hold fitness-era plan data, and the VFS the
// AI trainer's memory file. The plan is cleaned on every load (the store stays
// v3, so an older build still open elsewhere can read it), and each device
// removes the trainer's file once.

/** Let the un-awaited clean-up launch starts finish (the in-memory VFS
 *  resolves within a tick). */
const settle = () => new Promise((r) => setTimeout(r, 0));
const CLEARED_KEY = "conjure-health:trainer-memory-cleared";

/** The key keeps the app's old name, so every user's data still sits under it. */
const STORE_KEY = "conjure-fitness:store:v2";
const SAVED_GOALS = { calories: 2150, protein: 140, carbs: 230, fat: 70 };

/** A plan as a fitness-era build saved it: a workout goal, a program, injuries. */
function fitnessEraPlan(over: Record<string, unknown> = {}) {
  return {
    id: "plan-1",
    mode: "eat_better",
    durationWeeks: 4,
    startDate: "2026-07-27",
    endDate: "2026-08-23",
    goals: [
      { id: "g1", label: "Protein at every meal", kind: "nutrition" },
      { id: "g2", label: "Run 1.5-3 miles 2x per week", kind: "workout", detail: "w1" },
      { id: "g3", label: "Weigh in every morning", kind: "habit" },
    ],
    targets: { dailyCalories: 2000, protein: 130, carbs: 210, fat: 65 },
    safety: { ageBand: "18_39", pregnant: false, cardiacFlag: false, injuries: ["knee"], activityLevel: "moderate" },
    liability: { acknowledged: true, acceptedAt: "2026-07-27T00:00:00Z", appVersion: "1.30.0" },
    createdAt: "2026-07-27T00:00:00Z",
    goalText: "lose a few pounds",
    weeklyExerciseDays: 3,
    program: { workouts: [{ id: "pw1", isBenchmark: true }], benchmarks: [{ id: "b1", name: "Push-ups" }], currentGroup: 1 },
    ...over,
  };
}

/** A whole v3 document with every collection filled, so a migration that
 *  drops or rewrites any of them shows up. */
function v3Store(plan: unknown, over: Record<string, unknown> = {}) {
  return {
    v: 3,
    profile: { ...DEFAULT_PROFILE, units: "imperial", experienceLevel: "advanced" },
    goals: SAVED_GOALS,
    diary: [{ id: "d1", date: "2026-08-01", meal: "lunch", quantity: 1.5, loggedAt: "2026-08-01T12:00:00Z", food: aFood() }],
    weights: [{ date: "2026-08-01", weightKg: 81 }],
    plan,
    dayLogs: {
      "2026-08-01": {
        date: "2026-08-01",
        goalsCompleted: ["g1", "g2"],
        checkin: { at: "2026-08-01T21:00:00Z", answers: [{ question: "How was your day?", answer: "Fine" }] },
        excludedWearableKeys: ["k1"],
        wearableKcalOverrides: { k1: 120 },
      },
    },
    workoutSessions: [
      {
        id: "w1",
        date: "2026-08-01",
        workoutName: "Leg Day",
        completedAt: "2026-08-01T18:00:00Z",
        caloriesBurned: 300,
        planned: [{ reps: 10, durationSec: null, restSec: 60 }],
        actual: [],
        reprompts: [],
        benchmarkId: "b1",
      },
    ],
    sleep: [{ id: "s1", date: "2026-08-01", bedAt: "2026-07-31T23:00:00Z", wakeAt: "2026-08-01T07:00:00Z", quality: 4 }],
    water: [{ id: "h1", date: "2026-08-01", loggedAt: "2026-08-01T09:00:00Z", ml: 500 }],
    symptoms: [{ id: "y1", date: "2026-08-01", loggedAt: "2026-08-01T20:00:00Z", label: "Headache", severity: 2 }],
    updatedAt: "2026-08-01T12:00:00Z",
    ...over,
  };
}

describe("MockRepository store upgrade: fitness-era plans and files", () => {
  let ls: Map<string, string>;

  beforeEach(async () => {
    ls = installLocalStorage();
    // With no window, vfs is an in-memory map that outlives each repository.
    await vfs.write("store.json", JSON.stringify({ v: 2 }));
    for (const f of ["coach.json", "coach-chat.json", "plan-archive.json"]) await vfs.rm(f);
  });

  /** Open a repository over a device-local copy of `doc`. */
  async function openWith(doc: unknown): Promise<MockRepository> {
    ls.set(STORE_KEY, JSON.stringify(doc));
    const repo = new MockRepository();
    await repo.init();
    return repo;
  }

  it("turns a 'both' plan into eat_better and keeps its targets", async () => {
    const repo = await openWith(v3Store(fitnessEraPlan({ mode: "both" })));
    const plan = (await repo.getPlan())!;
    expect(plan.mode).toBe("eat_better");
    expect(plan.targets).toEqual({ dailyCalories: 2000, protein: 130, carbs: 210, fat: 65 });
    // The rest of the plan is exactly what was saved.
    expect(plan).toMatchObject({
      id: "plan-1",
      durationWeeks: 4,
      startDate: "2026-07-27",
      endDate: "2026-08-23",
      liability: { acknowledged: true, acceptedAt: "2026-07-27T00:00:00Z", appVersion: "1.30.0" },
      createdAt: "2026-07-27T00:00:00Z",
      goalText: "lose a few pounds",
      weeklyExerciseDays: 3,
    });
  });

  describe("a 'get_fit' plan tracked calories against the stored goals", () => {
    const noTarget: Array<[string, Record<string, unknown>]> = [
      ["a null calorie target", { targets: { dailyCalories: null } }],
      ["no targets at all", { targets: undefined }],
      ["macros but no calorie target", { targets: { dailyCalories: null, protein: 99 } }],
    ];

    it.each(noTarget)("takes the stored goals as its targets, so the diary budget is unchanged (%s)", async (_label, over) => {
      const saved = fitnessEraPlan({ mode: "get_fit", ...over });
      const repo = await openWith(v3Store(saved));
      const stored = await repo.getGoals();
      const plan = (await repo.getPlan())!;

      expect(plan.mode).toBe("eat_better");
      expect(plan.targets).toEqual(goalsToTargets(SAVED_GOALS));
      // What the diary shows, before (the plan as saved) and after.
      const before = { tracks: planTracksCalories(saved as unknown as Plan), goals: targetsToGoals(saved as unknown as Plan, stored) };
      const after = { tracks: planTracksCalories(plan), goals: targetsToGoals(plan, stored) };
      expect(after).toEqual(before);
      expect(after).toEqual({ tracks: true, goals: SAVED_GOALS });
    });

    it("keeps a calorie target the plan already has", async () => {
      const repo = await openWith(v3Store(fitnessEraPlan({ mode: "get_fit", targets: { dailyCalories: 1900, protein: 120 } })));
      expect((await repo.getPlan())?.targets).toEqual({ dailyCalories: 1900, protein: 120 });
    });

    it("leaves the targets as they are when the store has no goals", async () => {
      const repo = await openWith(v3Store(fitnessEraPlan({ mode: "get_fit", targets: { dailyCalories: null } }), { goals: null }));
      const plan = (await repo.getPlan())!;
      expect(plan.mode).toBe("eat_better");
      expect(plan.targets).toEqual({ dailyCalories: null });
      // The diary keeps showing the defaults, as it did.
      expect(targetsToGoals(plan, await repo.getGoals())).toEqual(DEFAULT_GOALS);
    });
  });

  it("drops workout goals and keeps the others in order", async () => {
    const plan = (await (await openWith(v3Store(fitnessEraPlan()))).getPlan())!;
    expect(plan.goals.map((g) => [g.id, g.kind])).toEqual([
      ["g1", "nutrition"],
      ["g3", "habit"],
    ]);
  });

  it("removes the program and the injuries list, and keeps the rest of the safety answers", async () => {
    const repo = await openWith(v3Store(fitnessEraPlan()));
    const plan = (await repo.getPlan())!;
    expect("program" in plan).toBe(false);
    expect(plan.safety).toEqual({ ageBand: "18_39", pregnant: false, cardiacFlag: false, activityLevel: "moderate" });
    // Gone from disk too, not just hidden on read.
    const saved = JSON.parse(ls.get(STORE_KEY)!);
    expect(saved.plan).not.toHaveProperty("program");
    expect(saved.plan.safety).not.toHaveProperty("injuries");
  });

  it("changes nothing but the plan, and keeps the store on v3", async () => {
    const doc = v3Store(fitnessEraPlan({ mode: "get_fit", targets: { dailyCalories: null } }));
    const repo = await openWith(doc);

    const { v: _v, plan: _plan, ...kept } = doc;
    const { v, plan: _saved, ...savedRest } = JSON.parse(ls.get(STORE_KEY)!);
    // Not bumped: an older build that doesn't know a version resets the store,
    // and one still open in another window would then save over everything.
    expect(v).toBe(3);
    // Diary, weights, day logs (check-in and all), exercise entries (sets and
    // all), sleep, water, symptoms, profile and goals: byte for byte.
    expect(savedRest).toEqual(kept);
    expect(await repo.listWorkoutSessions()).toEqual(doc.workoutSessions);
    expect(await repo.getDayLog("2026-08-01")).toEqual(doc.dayLogs["2026-08-01"]);
  });

  it("removes the AI trainer's memory once, and keeps the food coach's chat", async () => {
    const chat = JSON.stringify([{ role: "user", content: "Are bananas high in fiber?" }]);
    await vfs.write("coach.json", JSON.stringify({ memory: "prefers mornings" }));
    await vfs.write("coach-chat.json", chat);

    await openWith(v3Store(fitnessEraPlan()));
    await settle();
    expect(await vfs.exists("coach.json")).toBe(false);
    expect(await vfs.read("coach-chat.json")).toBe(chat);
    expect(ls.get(CLEARED_KEY)).toBe("1");

    // Done on this device, so a later launch does not go looking again.
    await vfs.write("coach.json", "written later");
    await new MockRepository().init();
    await settle();
    expect(await vfs.exists("coach.json")).toBe(true);
  });

  it("removes the trainer's memory whatever the plan looks like", async () => {
    await vfs.write("coach.json", "x");
    await openWith(v3Store(null));
    await settle();
    expect(await vfs.exists("coach.json")).toBe(false);
  });

  it("does both when it seeds from the synced mirror on a fresh device", async () => {
    await vfs.write("store.json", JSON.stringify(v3Store(fitnessEraPlan({ mode: "get_fit", targets: { dailyCalories: null } }))));
    await vfs.write("coach.json", "x");
    ls.clear();

    const repo = new MockRepository();
    await repo.init();
    await settle();
    expect((await repo.getPlan())?.mode).toBe("eat_better");
    expect(await vfs.exists("coach.json")).toBe(false);
    // Pinned locally and re-mirrored cleaned, still as v3.
    expect(JSON.parse(ls.get(STORE_KEY)!).v).toBe(3);
    const mirror = JSON.parse(await vfs.read("store.json"));
    expect(mirror.v).toBe(3);
    expect(mirror.plan).toMatchObject({ mode: "eat_better", targets: goalsToTargets(SAVED_GOALS) });
    expect(mirror.plan).not.toHaveProperty("program");
  });

  it("upgrades a v2 store the same way, and v2's new slices start empty", async () => {
    const { sleep: _s, water: _w, symptoms: _y, updatedAt: _u, ...v2Slices } = v3Store(
      fitnessEraPlan({ mode: "both" }),
    );
    await vfs.write("coach.json", "x");
    const repo = await openWith({ ...v2Slices, v: 2 });
    await settle();

    const plan = (await repo.getPlan())!;
    expect(plan.mode).toBe("eat_better");
    expect(plan.goals.map((g) => g.kind)).toEqual(["nutrition", "habit"]);
    expect(plan).not.toHaveProperty("program");
    expect(plan.safety).not.toHaveProperty("injuries");
    expect(await repo.listDiary("2026-08-01")).toHaveLength(1);
    expect(await repo.listSleep("2026-08-01")).toEqual([]);
    expect(await vfs.exists("coach.json")).toBe(false);
  });

  it("leaves the archive of past plans alone", async () => {
    const archive = JSON.stringify([fitnessEraPlan({ id: "old", mode: "both" })]);
    await vfs.write("plan-archive.json", archive);
    await openWith(v3Store(fitnessEraPlan()));
    expect(await vfs.read("plan-archive.json")).toBe(archive);
  });

  it("leaves a store with nothing to clean exactly as it is on disk", async () => {
    const clean = v3Store({ ...fitnessEraPlan(), goals: [], safety: { ageBand: "18_39", pregnant: false, cardiacFlag: false, activityLevel: "moderate" }, program: undefined });
    delete (clean.plan as Record<string, unknown>).program;
    const raw = JSON.stringify(clean);
    const repo = await openWith(clean);
    expect(ls.get(STORE_KEY)).toBe(raw);
    expect(await repo.getPlan()).toEqual(clean.plan);
  });

  it("does not rewrite a store it cannot read as any known version", async () => {
    const future = { v: 99, plan: fitnessEraPlan() };
    await openWith(future);
    expect(ls.get(STORE_KEY)).toBe(JSON.stringify(future));
  });

  it("still cleans the plan when the trainer's file cannot be deleted, and retries next launch", async () => {
    await vfs.write("coach.json", "x");
    const original = vfs.rm;
    vfs.rm = async () => {
      throw new Error("vfs unavailable");
    };
    try {
      const repo = await openWith(v3Store(fitnessEraPlan({ mode: "both" })));
      await settle();
      expect((await repo.getPlan())?.mode).toBe("eat_better");
      expect(ls.get(CLEARED_KEY)).toBeUndefined();
      // The same on the path that seeds from the mirror.
      ls.clear();
      await vfs.write("store.json", JSON.stringify(v3Store(fitnessEraPlan({ mode: "both" }))));
      const seeded = new MockRepository();
      await expect(seeded.init()).resolves.toBeUndefined();
      expect((await seeded.getPlan())?.mode).toBe("eat_better");
    } finally {
      vfs.rm = original;
    }
    await settle();
    await new MockRepository().init();
    await settle();
    expect(await vfs.exists("coach.json")).toBe(false);
    expect(ls.get(CLEARED_KEY)).toBe("1");
  });

  it("clearTrainerMemoryOnce records a device where the file never existed", async () => {
    await clearTrainerMemoryOnce();
    expect(ls.get(CLEARED_KEY)).toBe("1");
  });

  it("loads a store whose plan is not shaped like one, keeping everything else", async () => {
    const odd = { mode: "get_fit", goals: "none", safety: null, targets: "?" };
    const repo = await openWith(v3Store(odd));
    const plan = (await repo.getPlan()) as unknown as Record<string, unknown>;
    expect(plan.mode).toBe("eat_better");
    expect(plan.goals).toBe("none");
    expect(plan.safety).toBeNull();
    expect(await repo.listDiary("2026-08-01")).toHaveLength(1);
    expect(await repo.getGoals()).toEqual(SAVED_GOALS);
  });

  it("also upgrades a copy another tab left behind while the first read was failing", async () => {
    const removed: string[] = [];
    (globalThis as unknown as { window: Record<string, unknown> }).window.__vfs = {
      exists: async () => true,
      read: async () => {
        throw new Error("vfs timeout");
      },
      write: async () => {},
      ls: async () => [],
      mkdir: async () => {},
      rm: async (path: string) => void removed.push(path),
    };
    const repo = new MockRepository();
    await repo.init(); // no local copy and an unreadable mirror: nothing adopted yet
    ls.set(STORE_KEY, JSON.stringify(v3Store(fitnessEraPlan({ mode: "both" }))));

    await repo.saveProfile(imperial());
    expect((await repo.getPlan())?.mode).toBe("eat_better");
    expect(removed).toEqual(["coach.json"]);
    expect(JSON.parse(ls.get(STORE_KEY)!).v).toBe(3);
  });

  it("keeps a plan that is not an object exactly as it was", async () => {
    const repo = await openWith(v3Store("corrupt"));
    expect(await repo.getPlan()).toBe("corrupt");
    expect(await repo.listDiary("2026-08-01")).toHaveLength(1);
  });

  it("survives a reopen and further writes on the upgraded store", async () => {
    const repo = await openWith(v3Store(fitnessEraPlan({ mode: "get_fit", targets: { dailyCalories: null } })));
    await repo.saveProfile(imperial());
    const reopened = new MockRepository();
    await reopened.init();
    const plan = (await reopened.getPlan())!;
    expect(plan.mode).toBe("eat_better");
    expect(plan.goals).toHaveLength(2);
    expect(plan.targets).toEqual(goalsToTargets(SAVED_GOALS));
    expect(await reopened.listDiary("2026-08-01")).toHaveLength(1);
  });
});

/** Make every subsequent `localStorage.setItem` throw, simulating a full
 *  quota or a browser with storage disabled mid-session. */
function failNextLocalStorageWrites(): void {
  const w = (globalThis as unknown as { window: { localStorage: Storage } }).window;
  w.localStorage.setItem = () => {
    throw new Error("QuotaExceededError");
  };
}

function aFood() {
  return {
    id: "egg",
    source: "custom" as const,
    name: "Egg",
    perServing: { calories: 70, protein: 6, carbs: 1, fat: 5 },
    servingSize: "1 egg",
  };
}

const EMPTY_STORE = {
  v: 2 as const,
  profile: null,
  goals: null,
  diary: [],
  weights: [],
  plan: null,
  dayLogs: {},
  workoutSessions: [],
};
