import { describe, expect, it, beforeEach } from "vitest";
import { vfs } from "../bridge/vfs";
import { MockRepository } from "./mockRepository";
import { buildSleepEntry } from "../features/sleep";

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

const KEY = "conjure-fitness:store:v2";

describe("v2 → v3 migration", () => {
  let ls: Map<string, string>;
  beforeEach(async () => {
    ls = installLocalStorage();
    await vfs.write("store.json", JSON.stringify({ v: 3 }));
  });

  it("KEEPS every existing slice — a version bump must never eat the diary", async () => {
    const v2 = {
      v: 2,
      profile: { units: "imperial" },
      goals: { calories: 2200, protein: 150, carbs: 200, fat: 70 },
      diary: [{ id: "d1", date: "2026-08-01", meal: "lunch", quantity: 1, loggedAt: "x",
                food: { id: "f", source: "usda", name: "Rice", servingSize: "1 cup",
                        perServing: { calories: 200, protein: 4, carbs: 45, fat: 0 } } }],
      weights: [{ date: "2026-08-01", weightKg: 81 }],
      plan: null,
      dayLogs: { "2026-08-01": { date: "2026-08-01", goalsCompleted: ["g1"] } },
      workoutSessions: [{ id: "w1" }],
    };
    ls.set(KEY, JSON.stringify(v2));

    const repo = new MockRepository();
    await repo.init();

    expect((await repo.getProfile())?.units).toBe("imperial");
    expect((await repo.getGoals()).calories).toBe(2200);
    expect(await repo.listDiary("2026-08-01")).toHaveLength(1);
    expect(await repo.listWeights()).toHaveLength(1);
    expect((await repo.getDayLog("2026-08-01"))?.goalsCompleted).toEqual(["g1"]);
    expect(await repo.listWorkoutSessions()).toHaveLength(1);
    // ...and the new slices exist, empty.
    expect(await repo.listSleep("2026-08-01")).toEqual([]);
    expect(await repo.listWater("2026-08-01")).toEqual([]);
    expect(await repo.listSymptoms("2026-08-01")).toEqual([]);
  });

  it("keeps a v1 document's data too", async () => {
    ls.set(KEY, JSON.stringify({ v: 1, profile: { units: "metric" }, goals: null,
      diary: [], weights: [{ date: "2026-07-01", weightKg: 80 }] }));
    const repo = new MockRepository();
    await repo.init();
    expect((await repo.getProfile())?.units).toBe("metric");
    expect(await repo.listWeights()).toHaveLength(1);
  });
});

describe("sleep / water / symptom storage", () => {
  let repo: MockRepository;
  beforeEach(async () => {
    installLocalStorage();
    await vfs.write("store.json", JSON.stringify({ v: 3 }));
    repo = new MockRepository();
    await repo.init();
  });

  it("files a night under its wake date and reads it back", async () => {
    const night = buildSleepEntry("n1", "2026-08-10", "23:15", "06:45")!;
    await repo.saveSleep(night);
    expect(await repo.listSleep("2026-08-10")).toHaveLength(1);
    // The bedtime was the 9th, but the night belongs to the 10th.
    expect(await repo.listSleep("2026-08-09")).toHaveLength(0);
  });

  it("replaces a night with the same id rather than duplicating it", async () => {
    const a = buildSleepEntry("n1", "2026-08-10", "23:15", "06:45")!;
    await repo.saveSleep(a);
    await repo.saveSleep({ ...a, quality: 5 });
    const all = await repo.listSleep("2026-08-10");
    expect(all).toHaveLength(1);
    expect(all[0]!.quality).toBe(5);
  });

  it("orders water and symptoms by when they were logged", async () => {
    await repo.addWater({ date: "2026-08-10", ml: 250, loggedAt: "2026-08-10T15:00:00Z" });
    await repo.addWater({ date: "2026-08-10", ml: 500, loggedAt: "2026-08-10T09:00:00Z" });
    expect((await repo.listWater("2026-08-10")).map((w) => w.ml)).toEqual([500, 250]);

    await repo.addSymptom({ date: "2026-08-10", label: "Headache", loggedAt: "2026-08-10T20:00:00Z" });
    await repo.addSymptom({ date: "2026-08-10", label: "Heartburn", loggedAt: "2026-08-10T13:00:00Z" });
    expect((await repo.listSymptoms("2026-08-10")).map((x) => x.label)).toEqual(["Heartburn", "Headache"]);
  });

  it("stamps an id and a time when none is given", async () => {
    const w = await repo.addWater({ date: "2026-08-10", ml: 300 });
    expect(w.id).toBeTruthy();
    expect(Number.isFinite(new Date(w.loggedAt).getTime())).toBe(true);
  });

  it("reads ranges inclusively on both ends", async () => {
    for (const d of ["2026-08-08", "2026-08-09", "2026-08-10", "2026-08-11"]) {
      await repo.addWater({ date: d, ml: 200, loggedAt: `${d}T10:00:00Z` });
    }
    const range = await repo.listWaterRange("2026-08-09", "2026-08-10");
    expect(range.map((w) => w.date)).toEqual(["2026-08-09", "2026-08-10"]);
  });

  it("deletes idempotently", async () => {
    const w = await repo.addWater({ date: "2026-08-10", ml: 300 });
    await repo.removeWater(w.id);
    await repo.removeWater(w.id);
    expect(await repo.listWater("2026-08-10")).toEqual([]);
  });

  it("each clear wipes only its own slice", async () => {
    await repo.addWater({ date: "2026-08-10", ml: 300 });
    await repo.addSymptom({ date: "2026-08-10", label: "Headache" });
    await repo.saveSleep(buildSleepEntry("n1", "2026-08-10", "23:00", "07:00")!);
    await repo.upsertWeight({ date: "2026-08-10", weightKg: 81 });

    await repo.clearWater();
    expect(await repo.listWater("2026-08-10")).toEqual([]);
    // The others are untouched — these are independent slices in Settings.
    expect(await repo.listSymptoms("2026-08-10")).toHaveLength(1);
    expect(await repo.listSleep("2026-08-10")).toHaveLength(1);

    await repo.clearSymptoms();
    expect(await repo.listSymptoms("2026-08-10")).toEqual([]);
    expect(await repo.listSleep("2026-08-10")).toHaveLength(1);

    await repo.clearSleep();
    expect(await repo.listSleep("2026-08-10")).toEqual([]);
    // Weight is a different slice entirely and survives all three.
    expect(await repo.listWeights()).toHaveLength(1);
  });

  it("survives a reopen", async () => {
    await repo.addSymptom({ date: "2026-08-10", label: "Heartburn", severity: 3 });
    const again = new MockRepository();
    await again.init();
    const back = await again.listSymptoms("2026-08-10");
    expect(back).toHaveLength(1);
    expect(back[0]!.severity).toBe(3);
  });
});
