import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DiaryEntry, Plan, SymptomEntry } from "../types";

const d = new Date();
const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const state = {
  plan: null as Plan | null,
  diary: [] as DiaryEntry[],
  symptoms: [] as SymptomEntry[],
};

vi.mock("../data/repository", () => ({
  getRepository: async () => ({
    getGoals: async () => ({ calories: 2000, protein: 120, carbs: 200, fat: 67 }),
    getProfile: async () => ({ units: "imperial" }),
    getPlan: async () => state.plan,
    listDiary: async (date: string) => state.diary.filter((e) => e.date === date),
    listWater: async (date: string) =>
      date === today ? [{ id: "w", date, ml: 500, loggedAt: new Date().toISOString() }] : [],
    listSleep: async () => [],
    listSymptoms: async (date: string) => state.symptoms.filter((s) => s.date === date),
    listWeights: async () => [{ date: today, weightKg: 80 }],
    listWorkoutSessions: async () => [],
    getDayLog: async () => null,
  }),
}));

// The files are an in-memory map (ConjureOS #1230 tests below). The AI agreement
// is the real module reading it.
const files: Record<string, string> = {};
vi.mock("../bridge/vfs", () => ({
  readJson: async (p: string, d: unknown) => (files[p] !== undefined ? JSON.parse(files[p]!) : d),
  writeJson: async (p: string, v: unknown) => void (files[p] = JSON.stringify(v)),
  writeJsonOrThrow: async (p: string, v: unknown) => void (files[p] = JSON.stringify(v)),
  vfs: {
    exists: async (p: string) => files[p] !== undefined,
    read: async (p: string) => files[p]!,
    rm: async (p: string) => void delete files[p],
  },
}));

import { buildNutritionSummary, removeNutritionSummary, writeNutritionSummary, SUMMARY_DAYS, SUMMARY_PATH } from "./sharedSummary";
import { AI_CONSENT_PATH, DISCLOSURE_VERSION } from "./aiConsent";

beforeEach(() => {
  for (const k of Object.keys(files)) delete files[k];
  state.plan = null;
  state.diary = [
    {
      id: "a",
      date: today,
      meal: "breakfast",
      quantity: 1,
      loggedAt: new Date().toISOString(),
      food: {
        id: "f",
        source: "usda",
        name: "Oatmeal",
        servingSize: "1 cup",
        perServing: { calories: 300, protein: 10, carbs: 50, fat: 6 },
      },
    },
  ];
  state.symptoms = [
    { id: "s", date: today, label: "Heartburn", note: "private note", loggedAt: new Date().toISOString() },
  ];
});

describe("the summary ConjureOS may read", () => {
  it("is the file the manifest declares readable, and only that", async () => {
    const pkg = (await import("../../package.json")) as unknown as {
      default: { conjureos: { dataReadable: string[] } };
    };
    expect(pkg.default.conjureos.dataReadable).toEqual([SUMMARY_PATH]);
  });

  it("covers food, water and exercise for two weeks, with today's foods and what's left", async () => {
    const s = await buildNutritionSummary();
    expect(s.days).toHaveLength(SUMMARY_DAYS);
    expect(s.days[SUMMARY_DAYS - 1]).toMatchObject({ date: today, calories: 300, waterMl: 500 });
    expect(s.today.foods).toEqual([{ meal: "breakfast", name: "Oatmeal", quantity: 1, calories: 300, protein: 10 }]);
    expect(s.today.remainingCalories).toBe(1700);
    expect(s.units).toBe("imperial");
  });

  it("holds no symptoms, sleep, weight or plan", async () => {
    // `about` names what's left out, so it's excluded from the search.
    const data = JSON.stringify({ ...(await buildNutritionSummary()), about: "" });
    for (const leak of ["Heartburn", "private note", "weightKg", "sleepMinutes", "safety", "goalText"]) {
      expect(data).not.toContain(leak);
    }
  });

  it("stays small enough for ConjureOS to read whole", async () => {
    expect(JSON.stringify(await buildNutritionSummary()).length).toBeLessThan(20_000);
  });

  it("gives a user with no calorie target no target and no 'remaining'", async () => {
    state.plan = {
      id: "p",
      mode: "logging_only",
      durationWeeks: 4,
      startDate: today,
      endDate: today,
      goals: [],
      targets: { dailyCalories: null },
      safety: { ageBand: "under_18", pregnant: false, cardiacFlag: false, activityLevel: "light" },
      liability: { acknowledged: true, acceptedAt: "2026-09-01T00:00:00Z" },
      createdAt: "2026-09-01T00:00:00Z",
    };
    const s = await buildNutritionSummary();
    expect(s.tracksCalories).toBe(false);
    expect(s.dailyTargets).toBeNull();
    expect(s.today).not.toHaveProperty("remainingCalories");
    expect(s.about).toMatch(/without a calorie target/);
    expect(JSON.stringify(s)).not.toMatch(/under_18|logging_only/);
  });
});

/**
 * ConjureOS Chat reads this file to answer a question about health, and sends
 * it to an AI, so it exists only while the AI agreement does (ConjureOS #1230).
 */
describe("the summary exists only under the AI agreement", () => {
  const agree = () =>
    void (files[AI_CONSENT_PATH] = JSON.stringify({
      acceptedAt: "2026-11-01T09:00:00.000Z",
      version: DISCLOSURE_VERSION,
      includeNotes: false,
    }));

  it("writes nothing without a current agreement", async () => {
    await writeNutritionSummary();
    expect(files[SUMMARY_PATH]).toBeUndefined();
    files[AI_CONSENT_PATH] = JSON.stringify({ acceptedAt: "2026-10-30T09:00:00.000Z", version: DISCLOSURE_VERSION - 1, includeNotes: false });
    await writeNutritionSummary();
    expect(files[SUMMARY_PATH]).toBeUndefined();
  });

  it("takes away a summary an earlier version left, when there is no agreement", async () => {
    files[SUMMARY_PATH] = JSON.stringify({ stale: true });
    await writeNutritionSummary();
    expect(files[SUMMARY_PATH]).toBeUndefined();
  });

  it("writes it under a current agreement", async () => {
    agree();
    await writeNutritionSummary();
    expect(JSON.parse(files[SUMMARY_PATH]!).today.date).toBe(today);
  });

  it("removes it", async () => {
    files[SUMMARY_PATH] = "{}";
    await removeNutritionSummary();
    expect(files[SUMMARY_PATH]).toBeUndefined();
  });

  it("a removal that lands while the summary is built leaves no file behind", async () => {
    agree();
    const w = writeNutritionSummary();
    const r = removeNutritionSummary();
    await Promise.all([w, r]);
    expect(files[SUMMARY_PATH]).toBeUndefined();
  });

  it("a removal that follows a write already posted still removes it", async () => {
    agree();
    await writeNutritionSummary();
    expect(files[SUMMARY_PATH]).toBeDefined();
    await removeNutritionSummary();
    expect(files[SUMMARY_PATH]).toBeUndefined();
  });
});
