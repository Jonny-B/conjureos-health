import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../bridge/host", () => ({
  getAccessToken: async () => "fake-token",
  isHostAuthAvailable: () => true,
}));

import type { Plan } from "../types";
import { SupabaseRepository } from "./supabaseRepository";
import { vfs } from "../bridge/vfs";
import { SAVE_FAILED_EVENT, persist } from "./saveFailure";

function installWindow(): EventTarget {
  const map = new Map<string, string>();
  const events = new EventTarget();
  (globalThis as unknown as { window: unknown }).window = Object.assign(events, {
    localStorage: {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() {
        return map.size;
      },
    },
  });
  return events;
}

const plan: Plan = {
  id: "plan-1",
  mode: "eat_better",
  durationWeeks: 2,
  startDate: "2026-09-24",
  endDate: "2026-10-07",
  goals: [{ id: "g1", label: "Drink 2 litres of water", kind: "habit" }],
  safety: { ageBand: "18_39", pregnant: false, cardiacFlag: false, injuries: [], activityLevel: "moderate" },
  liability: { acknowledged: true, acceptedAt: "2026-09-24T00:00:00Z" },
  createdAt: "2026-09-24T00:00:00Z",
} as Plan;

async function mirror(): Promise<Record<string, unknown>> {
  return JSON.parse((await vfs.read("store.json")) ?? "{}");
}

describe("Supabase backend keeps on-device data (plans, check-offs, sleep, water, symptoms)", () => {
  const fetchMock = vi.fn(async () => {
    throw new Error("no server table for this data");
  });
  let repo: SupabaseRepository;

  beforeEach(async () => {
    installWindow();
    await vfs.write("store.json", "");
    vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-key");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
    repo = new SupabaseRepository();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("saves a plan, mirrors it to store.json, and reads it back from a fresh instance", async () => {
    await repo.savePlan(plan);
    expect((await mirror()).plan).toMatchObject({ id: "plan-1" });
    expect(await new SupabaseRepository().getPlan()).toMatchObject({ id: "plan-1" });
    await repo.clearPlan();
    expect(await repo.getPlan()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("saves daily check-offs", async () => {
    await repo.markCheckoff("g1", "2026-09-24", true);
    await repo.saveDayLog("2026-09-24", { weightKg: 80 });
    const log = await new SupabaseRepository().getDayLog("2026-09-24");
    expect(log?.goalsCompleted).toEqual(["g1"]);
    expect(log?.weightKg).toBe(80);
    expect((await mirror()).dayLogs).toHaveProperty("2026-09-24");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("saves sleep", async () => {
    await repo.saveSleep({
      id: "s1",
      date: "2026-09-24",
      bedAt: "2026-09-23T23:00:00Z",
      wakeAt: "2026-09-24T07:00:00Z",
    });
    expect((await new SupabaseRepository().listSleep("2026-09-24")).map((s) => s.id)).toEqual(["s1"]);
    expect(((await mirror()).sleep as { id: string }[]).map((s) => s.id)).toEqual(["s1"]);
    await repo.removeSleep("s1");
    expect(await repo.listSleep("2026-09-24")).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("saves water", async () => {
    const w = await repo.addWater({ date: "2026-09-24", ml: 250 });
    await repo.updateWater(w.id, { ml: 300 });
    const listed = await new SupabaseRepository().listWater("2026-09-24");
    expect(listed.map((e) => e.ml)).toEqual([300]);
    expect(((await mirror()).water as { id: string }[]).map((e) => e.id)).toEqual([w.id]);
    await repo.removeWater(w.id);
    expect(await repo.listWater("2026-09-24")).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("saves symptoms", async () => {
    const s = await repo.addSymptom({ date: "2026-09-24", label: "Headache", severity: 2 });
    await repo.updateSymptom(s.id, { label: "Headache", severity: 3 });
    const listed = await new SupabaseRepository().listSymptoms("2026-09-24");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: s.id, label: "Headache", severity: 3 });
    expect(((await mirror()).symptoms as { id: string }[]).map((e) => e.id)).toEqual([s.id]);
    await repo.removeSymptom(s.id);
    expect(await repo.listSymptoms("2026-09-24")).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("a save that fails is reported, not swallowed", () => {
  it("tells the user in plain words", async () => {
    const events = installWindow();
    const seen: string[] = [];
    events.addEventListener(SAVE_FAILED_EVENT, (e) => seen.push((e as CustomEvent<{ message: string }>).detail.message));
    const ok = await persist("your plan", Promise.reject(new Error("disk full")));
    expect(ok).toBe(false);
    expect(seen).toEqual(["We couldn't save your plan. Please try again."]);
  });
});
