/**
 * The cross-app action surface, exercised through `registerActions` — the same
 * way ConjureOS reaches it — rather than through test-only exports.
 *
 * Params here arrive from other, untrusted apps, so the assertions are as much
 * about what these handlers REFUSE as what they do.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  DiaryEntry,
  FoodItem,
  Plan,
  Profile,
  SleepEntry,
  SymptomEntry,
  WaterEntry,
  WeightEntry,
  WorkoutSession,
} from "../types";

type Handler = (params?: unknown) => Promise<unknown>;

const db = {
  diary: [] as DiaryEntry[],
  water: [] as WaterEntry[],
  sleep: [] as SleepEntry[],
  symptoms: [] as SymptomEntry[],
  weights: [] as WeightEntry[],
  workouts: [] as WorkoutSession[],
  plan: null as Plan | null,
  profile: null as Profile | null,
  removed: [] as string[],
};
let nextId = 0;

const inRange = (d: string, from: string, to: string) => d >= from && d <= to;

const repo = {
  getGoals: async () => ({ calories: 2000, protein: 120, carbs: 200, fat: 67 }),
  getProfile: async () => db.profile,
  getPlan: async () => db.plan,
  listDiary: async (date: string) => db.diary.filter((e) => e.date === date),
  getDiaryEntry: async (id: string) => db.diary.find((e) => e.id === id) ?? null,
  addDiaryEntry: async (e: Omit<DiaryEntry, "id" | "loggedAt">) => {
    const row = { ...e, id: `d${nextId++}`, loggedAt: new Date().toISOString() };
    db.diary.push(row);
    return row;
  },
  updateDiaryEntry: async (id: string, patch: Partial<Pick<DiaryEntry, "quantity" | "meal" | "food">>) => {
    const e = db.diary.find((x) => x.id === id);
    if (e) Object.assign(e, patch);
  },
  addWater: async (e: Omit<WaterEntry, "id">) => {
    const row = { ...e, id: `w${db.water.length}` };
    db.water.push(row);
    return row;
  },
  saveSleep: async (e: SleepEntry) => void db.sleep.push(e),
  addSymptom: async (e: Omit<SymptomEntry, "id">) => {
    const row = { ...e, id: `s${db.symptoms.length}` };
    db.symptoms.push(row);
    return row;
  },
  upsertWeight: async (e: WeightEntry) => {
    db.weights = db.weights.filter((w) => w.date !== e.date).concat(e);
  },
  listWater: async (date: string) => db.water.filter((w) => w.date === date),
  listWaterRange: async (from: string, to: string) => db.water.filter((w) => inRange(w.date, from, to)),
  listSleep: async (date: string) => db.sleep.filter((n) => n.date === date),
  listSleepRange: async (from: string, to: string) => db.sleep.filter((n) => inRange(n.date, from, to)),
  listSymptoms: async (date: string) => db.symptoms.filter((s) => s.date === date),
  listSymptomsRange: async (from: string, to: string) => db.symptoms.filter((s) => inRange(s.date, from, to)),
  listWeights: async () => [...db.weights].sort((a, b) => b.date.localeCompare(a.date)),
  removeDiaryEntry: async (id: string) => void db.removed.push(`food:${id}`),
  removeWater: async (id: string) => void db.removed.push(`water:${id}`),
  removeSleep: async (id: string) => void db.removed.push(`sleep:${id}`),
  removeSymptom: async (id: string) => void db.removed.push(`symptom:${id}`),
  removeWeight: async (d: string) => void db.removed.push(`weight:${d}`),
  removeWorkoutSession: async (id: string) => void db.removed.push(`workout:${id}`),
  listWorkoutSessions: async () => db.workouts,
  saveWorkoutSession: async (s: WorkoutSession) => {
    db.workouts = db.workouts.filter((w) => w.id !== s.id).concat(s);
  },
  getDayLog: async () => null,
};

vi.mock("../data/repository", () => ({ getRepository: async () => repo }));
// The real module, minus the wearable: exercise calories come from stored
// entries only.
vi.mock("../features/exercise", async (orig) => ({
  ...(await orig<typeof import("../features/exercise")>()),
  exerciseCaloriesForDate: async (date: string) =>
    db.workouts.filter((w) => w.date === date).reduce((n, w) => n + (w.caloriesBurned ?? 0), 0),
}));

const { parseMeal, lookupBarcode, searchFoods } = vi.hoisted(() => ({
  parseMeal: vi.fn(),
  lookupBarcode: vi.fn(),
  searchFoods: vi.fn(),
}));
vi.mock("../features/naturalLanguage", () => ({ parseMeal }));
vi.mock("../features/foods/foodSearch", () => ({ lookupBarcode, searchFoods }));

let actions: Record<string, Handler> = {};

beforeEach(async () => {
  db.diary = [];
  db.water = [];
  db.sleep = [];
  db.symptoms = [];
  db.weights = [];
  db.workouts = [];
  db.plan = null;
  db.profile = null;
  db.removed = [];
  parseMeal.mockReset();
  lookupBarcode.mockReset();
  searchFoods.mockReset();
  (globalThis as { window?: unknown }).window = {
    __conjureos: {
      actions: {
        register: async (map: Record<string, Handler>) => void (actions = map),
      },
    },
  };
  const { registerActions } = await import("./actions");
  await registerActions();
});

const call = (name: string, params?: unknown) => {
  const fn = actions[name];
  if (!fn) throw new Error(`action ${name} is not registered`);
  return fn(params);
};

/** Local calendar date, the way the app's own `todayISO` computes it. */
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = () => iso(new Date());
const yesterday = () => iso(new Date(Date.now() - 86_400_000));

const food = (name: string, calories: number, extra: Partial<FoodItem> = {}): FoodItem => ({
  id: name,
  source: "usda",
  name,
  servingSize: "1 serving",
  perServing: { calories, protein: 10, carbs: 20, fat: 5 },
  ...extra,
});
const seedFood = (id: string, name: string, calories: number, extra: Partial<DiaryEntry> = {}) => {
  const e: DiaryEntry = {
    id,
    date: today(),
    meal: "breakfast",
    food: food(name, calories),
    quantity: 1,
    loggedAt: new Date().toISOString(),
    ...extra,
  };
  db.diary.push(e);
  return e;
};
const loggingOnlyPlan = (): Plan => ({
  id: "p1",
  mode: "logging_only",
  durationWeeks: 4,
  startDate: today(),
  endDate: today(),
  goals: [],
  targets: { dailyCalories: null },
  safety: { ageBand: "18_39", pregnant: true, cardiacFlag: false, activityLevel: "light" },
  liability: { acknowledged: true, acceptedAt: "2026-09-01T00:00:00Z" },
  createdAt: "2026-09-01T00:00:00Z",
});

describe("what the orchestrator can reach", () => {
  it("registers every action the manifest declares, and nothing more", async () => {
    // The manifest is what the host validates against, so a handler without a
    // schema is unreachable and a schema without a handler is a broken promise.
    const pkg = (await import("../../package.json")) as unknown as {
      default: { conjureos: { actions: Record<string, unknown> } };
    };
    const declared = Object.keys(pkg.default.conjureos.actions).sort();
    expect(Object.keys(actions).sort()).toEqual(declared);
  });

  it("does not expose consent, the pattern-finder, the coach, bulk clears, or goal writes", () => {
    // These are refusals, not omissions. See the header of actions.ts.
    for (const forbidden of [
      "grantAiConsent",
      "setAiConsent",
      "findPatterns",
      "askPatterns",
      "askCoach",
      "clearHistory",
      "clearAllHistories",
      "clearDiary",
      "saveGoals",
      "setGoals",
      "saveProfile",
      "savePlan",
      "clearPlan",
    ]) {
      expect(actions[forbidden]).toBeUndefined();
    }
  });

  it("gives every read a one-line answer, which is all Ask ConjureOS shows", async () => {
    const pkg = (await import("../../package.json")) as unknown as {
      default: {
        conjureos: {
          actions: Record<string, { permission: string; returns: { required?: string[] } }>;
        };
      };
    };
    const reads = Object.entries(pkg.default.conjureos.actions).filter(
      ([, a]) => a.permission === "actions.read",
    );
    expect(reads.length).toBeGreaterThan(5);
    for (const [name, a] of reads) expect(a.returns.required, name).toContain("value");
  });

  it("tells the app its data changed after a write, and not after a read", async () => {
    const { onDataChanged } = await import("../features/dataEvents");
    let changes = 0;
    const off = onDataChanged(() => changes++);
    await call("todayTotals");
    expect(changes).toBe(0);
    await call("logWater", { ml: 250 });
    expect(changes).toBe(1);
    off();
  });
});

describe("logFood", () => {
  it("logs the caller's own numbers as they are", async () => {
    const res = (await call("logFood", { name: "Oatmeal", calories: 150, protein: 5, meal: "breakfast" })) as {
      id: string;
      estimated: boolean;
      value: string;
    };
    expect(res.estimated).toBe(false);
    expect(db.diary).toEqual([
      expect.objectContaining({
        id: res.id,
        meal: "breakfast",
        food: expect.objectContaining({ name: "Oatmeal", perServing: { calories: 150, protein: 5, carbs: 0, fat: 0 } }),
      }),
    ]);
    expect(res.value).toBe("Oatmeal (150 cal) to breakfast");
  });

  it("logs every food in a described combo, not just the first", async () => {
    parseMeal.mockResolvedValueOnce([
      food("Chicken sandwich", 350, { provenance: { sourceTag: "ai_estimate" } }),
      food("Beer", 153, { provenance: { sourceTag: "ai_estimate" } }),
    ]);
    const res = (await call("logFood", { name: "a chicken sandwich and a beer", meal: "lunch" })) as {
      ids: string[];
      calories: number;
      estimated: boolean;
      value: string;
    };
    expect(res.ids).toHaveLength(2);
    expect(res.calories).toBe(503);
    expect(res.estimated).toBe(true);
    expect(db.diary.map((e) => e.food.name)).toEqual(["Chicken sandwich", "Beer"]);
    expect(db.diary.every((e) => e.food.provenance?.sourceTag === "ai_estimate")).toBe(true);
    expect(res.value).toBe("Chicken sandwich (350 cal) and Beer (153 cal) to lunch, 503 cal in all (AI estimate)");
  });

  it("keeps the user's own words for a single estimated food", async () => {
    parseMeal.mockResolvedValueOnce([food("McDonald's McCrispy chicken sandwich", 470)]);
    await call("logFood", { name: "a McCrispy" });
    expect(db.diary[0]?.food.name).toBe("a McCrispy");
  });

  it("fails with the reason instead of logging 0 when the AI is paused in the background", async () => {
    parseMeal.mockRejectedValueOnce(new Error("ai.complete blocked: this app's window is minimized"));
    await expect(call("logFood", { name: "a burrito" })).rejects.toThrow(/open on screen/);
    expect(db.diary).toEqual([]);
  });

  it("fails instead of logging 0 when the estimate comes back empty", async () => {
    parseMeal.mockResolvedValueOnce([]);
    await expect(call("logFood", { name: "zxqv" })).rejects.toThrow(/Couldn't estimate.*pass calories/);
    expect(db.diary).toEqual([]);
  });

  it("refuses an empty calorie field rather than reading it as zero", async () => {
    await expect(call("logFood", { name: "Toast", calories: "" })).rejects.toThrow(/non-negative/);
  });
});

describe("logMeal", () => {
  it("logs every item with its servings", async () => {
    const res = (await call("logMeal", {
      meal: "dinner",
      items: [
        { name: "Lasagna", calories: 400, protein: 20, servings: 1.5 },
        { name: "Salad", calories: 120, servingSize: "1 bowl" },
      ],
    })) as { ids: string[]; calories: number };
    expect(res.ids).toHaveLength(2);
    expect(res.calories).toBe(720);
    expect(db.diary.map((e) => [e.food.name, e.quantity, e.meal])).toEqual([
      ["Lasagna", 1.5, "dinner"],
      ["Salad", 1, "dinner"],
    ]);
  });

  it("writes nothing when any item is bad", async () => {
    await expect(
      call("logMeal", { items: [{ name: "Lasagna", calories: 400 }, { name: "Mystery" }] }),
    ).rejects.toThrow(/items\[1\]\.calories is required/);
    expect(db.diary).toEqual([]);
  });

  it("refuses more than twenty foods", async () => {
    const items = Array.from({ length: 21 }, (_, i) => ({ name: `F${i}`, calories: 10 }));
    await expect(call("logMeal", { items })).rejects.toThrow(/at most 20/);
  });
});

describe("copyMeal", () => {
  it("copies yesterday's breakfast to today", async () => {
    seedFood("a", "Eggs", 180, { date: yesterday() });
    seedFood("b", "Coffee", 5, { date: yesterday() });
    seedFood("c", "Pasta", 600, { date: yesterday(), meal: "dinner" });
    const res = (await call("copyMeal", { meal: "breakfast" })) as { count: number; calories: number };
    expect(res).toMatchObject({ count: 2, calories: 185 });
    const copied = db.diary.filter((e) => e.date === today());
    expect(copied.map((e) => [e.food.name, e.meal])).toEqual([
      ["Eggs", "breakfast"],
      ["Coffee", "breakfast"],
    ]);
  });

  it("says when there is nothing to copy", async () => {
    await expect(call("copyMeal", { meal: "lunch" })).rejects.toThrow(/nothing was logged for lunch yesterday/);
  });

  it("refuses to log a meal onto itself", async () => {
    await expect(call("copyMeal", { meal: "lunch", fromDate: today() })).rejects.toThrow(/twice/);
  });
});

describe("correcting a logged food", () => {
  it("changes a logged food's quantity", async () => {
    seedFood("d1", "Toast", 100);
    const res = (await call("setFoodQuantity", { id: "d1", quantity: 2 })) as { calories: number };
    expect(db.diary[0]?.quantity).toBe(2);
    expect(res.calories).toBe(200);
  });

  it("says so when no food has that id, instead of reporting success", async () => {
    await expect(call("setFoodQuantity", { id: "nope", quantity: 2 })).rejects.toThrow(/no food entry with id nope/);
  });

  it("refuses a non-positive quantity", async () => {
    seedFood("d1", "Toast", 100);
    await expect(call("setFoodQuantity", { id: "d1", quantity: 0 })).rejects.toThrow(/positive/);
  });

  // Bug 4: positivity was checked on the RAW input, then the value was
  // rounded to 2dp without re-checking, so a positive-but-sub-minimum
  // quantity like 0.004 rounded down to a bare 0 in storage. It now clamps
  // into the schema's stated minimum (0.01) before rounding, so it is never
  // rounded back out of range.
  it("clamps a positive quantity finer than the schema minimum, rather than storing zero", async () => {
    seedFood("d1", "Toast", 100);
    const res = (await call("setFoodQuantity", { id: "d1", quantity: 0.004 })) as { quantity: number };
    expect(res.quantity).toBe(0.01);
    expect(db.diary[0]?.quantity).toBe(0.01);
  });

  it("moves a food to another meal and replaces an AI estimate with real numbers", async () => {
    seedFood("d1", "Burrito", 700, { food: food("Burrito", 700, { provenance: { sourceTag: "ai_estimate" } }) });
    const res = (await call("updateFoodEntry", { id: "d1", meal: "dinner", calories: 540, protein: 30 })) as {
      calories: number;
      meal: string;
    };
    expect(res).toMatchObject({ meal: "dinner", calories: 540 });
    expect(db.diary[0]?.food.perServing).toEqual({ calories: 540, protein: 30, carbs: 20, fat: 5 });
    expect(db.diary[0]?.food.provenance).toBeUndefined();
  });

  it("refuses an update that changes nothing", async () => {
    seedFood("d1", "Toast", 100);
    await expect(call("updateFoodEntry", { id: "d1" })).rejects.toThrow(/nothing to change/);
  });
});

describe("deleteEntry", () => {
  it("deletes one record of each kind", async () => {
    const d = today();
    seedFood("x1", "Toast", 100);
    db.water.push({ id: "x1", date: d, ml: 250, loggedAt: new Date().toISOString() });
    db.sleep.push({ id: "x1", date: d, bedAt: `${d}T00:00:00Z`, wakeAt: `${d}T07:00:00Z` });
    db.symptoms.push({ id: "x1", date: d, label: "Headache", loggedAt: new Date().toISOString() });
    db.workouts.push({ id: "x1", date: d, completedAt: new Date().toISOString(), source: "manual" });
    db.weights.push({ date: "2026-09-05", weightKg: 80 });
    for (const kind of ["food", "water", "sleep", "symptom", "workout"]) {
      await call("deleteEntry", { kind, id: "x1" });
    }
    await call("deleteEntry", { kind: "weight", id: "2026-09-05" });
    expect(db.removed).toEqual([
      "food:x1",
      "water:x1",
      "sleep:x1",
      "symptom:x1",
      "workout:x1",
      "weight:2026-09-05",
    ]);
  });

  it("says so when there is nothing with that id, instead of reporting success", async () => {
    await expect(call("deleteEntry", { kind: "water", id: "ghost" })).rejects.toThrow(/no water entry/);
    await expect(call("deleteEntry", { kind: "weight", id: "2026-09-05" })).rejects.toThrow(
      /no weight is recorded on 2026-09-05/,
    );
    expect(db.removed).toEqual([]);
  });

  it("will not delete a workout an earlier version of the app recorded", async () => {
    // The old workout player's sessions can be the only copy of that data.
    db.workouts.push({ id: "old", date: today(), completedAt: new Date().toISOString() });
    await expect(call("deleteEntry", { kind: "workout", id: "old" })).rejects.toThrow(/earlier version/);
    expect(db.removed).toEqual([]);
  });

  it("refuses a kind it does not know rather than silently doing nothing", async () => {
    await expect(call("deleteEntry", { kind: "everything", id: "x" })).rejects.toThrow(/must be one of/);
    expect(db.removed).toEqual([]);
  });

  it("requires a date for a weight delete, since weight is keyed by day", async () => {
    await expect(call("deleteEntry", { kind: "weight", id: "w1" })).rejects.toThrow(/YYYY-MM-DD/);
  });
});

describe("nutrition reads", () => {
  it("answers 'how many calories do I have left?' in one line", async () => {
    seedFood("a", "Toast", 400);
    db.workouts.push({ id: "r", date: today(), completedAt: new Date().toISOString(), caloriesBurned: 200, source: "manual" });
    const res = (await call("todayTotals")) as {
      tracksCalories: boolean;
      caloriesRemaining: number;
      value: string;
    };
    expect(res.tracksCalories).toBe(true);
    expect(res.caloriesRemaining).toBe(1800);
    expect(res.value).toBe("1,800 cal left today (400 cal eaten of 2,000 cal, plus 200 cal from exercise)");
  });

  it("lists each food with its id, macros and estimate flag", async () => {
    seedFood("a", "Toast", 100, { quantity: 2 });
    const day = (await call("dayNutrition")) as {
      foods: { id: string; calories: number; protein: number; estimated: boolean }[];
      value: string;
    };
    expect(day.foods[0]).toMatchObject({ id: "a", calories: 200, protein: 20, estimated: false });
    expect(day.value).toMatch(/^200 cal eaten today, 1,800 cal left/);
  });

  it("returns the user's targets, units and water goal", async () => {
    db.profile = { units: "imperial" } as Profile;
    const t = (await call("nutritionTargets")) as {
      tracksCalories: boolean;
      targets: { calories: number };
      units: string;
      waterGoalMl: number;
      value: string;
    };
    expect(t).toMatchObject({ tracksCalories: true, units: "imperial", waterGoalMl: 2000 });
    expect(t.targets.calories).toBe(2000);
    expect(t.value).toMatch(/^2,000 cal a day: 120 g protein/);
  });

  it("averages the logged days of a recent window", async () => {
    seedFood("a", "Toast", 1000);
    seedFood("b", "Soup", 1500, { date: yesterday() });
    const res = (await call("recentNutrition", { days: 3 })) as { days: unknown[]; value: string };
    expect(res.days).toHaveLength(3);
    expect(res.value).toMatch(/^1,250 cal and 10 g protein a day on average, over the 2 days/);
  });

  it("refuses an explicit days: 0 rather than defaulting to 7", async () => {
    await expect(call("recentNutrition", { days: 0 })).rejects.toThrow(/positive/);
  });
});

// The safety gate (under 18, pregnant, a heart condition) puts a user on a
// logging-only plan: they log food with no calorie target, and nothing may
// hand them — or another app on their behalf — a budget, a "left" or an "over".
describe("a user with no calorie target", () => {
  beforeEach(() => {
    db.plan = loggingOnlyPlan();
    seedFood("a", "Toast", 400);
  });

  it("gets no goals or remaining from todayTotals", async () => {
    const res = (await call("todayTotals")) as Record<string, unknown>;
    expect(res.tracksCalories).toBe(false);
    expect(res).not.toHaveProperty("goals");
    expect(res).not.toHaveProperty("caloriesRemaining");
    expect(res.value).toBe("400 cal eaten today");
  });

  it("gets no targets or remaining from dayNutrition", async () => {
    const res = (await call("dayNutrition")) as Record<string, unknown>;
    expect(res.tracksCalories).toBe(false);
    expect(res).not.toHaveProperty("targets");
    expect(res).not.toHaveProperty("remaining");
    expect(JSON.stringify(res)).not.toMatch(/left|over/);
  });

  it("gets no targets from nutritionTargets, and never the reason", async () => {
    const res = (await call("nutritionTargets")) as Record<string, unknown>;
    expect(res.tracksCalories).toBe(false);
    expect(res).not.toHaveProperty("targets");
    expect(res.value).toMatch(/^No calorie target/);
    expect(JSON.stringify(res)).not.toMatch(/logging_only|pregnan|cardiac|under_18/);
  });
});

describe("dayEntries", () => {
  it("lists every kind of record with the kind and id deleteEntry takes, and no notes", async () => {
    const d = today();
    seedFood("f1", "Toast", 100);
    db.water.push({ id: "w1", date: d, ml: 300, loggedAt: new Date().toISOString() });
    db.symptoms.push({ id: "s1", date: d, label: "Heartburn", severity: 3, note: "secret", loggedAt: new Date().toISOString() });
    db.weights.push({ date: d, weightKg: 80.5 });
    db.workouts.push({ id: "k1", date: d, completedAt: new Date().toISOString(), caloriesBurned: 250, source: "logWorkout", workoutName: "Run" });
    const res = (await call("dayEntries")) as {
      entries: { kind: string; id: string; origin?: string; deletable?: boolean }[];
      value: string;
    };
    expect(res.entries.map((e) => [e.kind, e.id])).toEqual(
      expect.arrayContaining([
        ["food", "f1"],
        ["water", "w1"],
        ["symptom", "s1"],
        ["weight", d],
        ["workout", "k1"],
      ]),
    );
    expect(res.entries.find((e) => e.kind === "workout")).toMatchObject({ origin: "app", deletable: true });
    expect(JSON.stringify(res)).not.toContain("secret");
    expect(res.value).toBe("1 food, 1 drink, 1 symptom, a weigh-in and 1 workout logged today");
  });
});

describe("estimateNutrition", () => {
  it("estimates a recipe's ingredients per serving, without logging anything", async () => {
    parseMeal.mockResolvedValueOnce([food("Flour", 910), food("Butter", 810)]);
    const res = (await call("estimateNutrition", {
      ingredients: ["2 cups flour", "1 stick butter"],
      servings: 4,
    })) as { total: { calories: number }; perServing: { calories: number }; estimated: boolean; value: string };
    expect(parseMeal.mock.calls[0]?.[0]?.text).toContain("2 cups flour\n1 stick butter");
    expect(res.total.calories).toBe(1720);
    expect(res.perServing.calories).toBe(430);
    expect(res.estimated).toBe(true);
    expect(res.value).toBe("About 430 cal per serving, 1,720 cal in all (AI estimate)");
    expect(db.diary).toEqual([]);
  });

  it("wants text or ingredients, not both", async () => {
    await expect(call("estimateNutrition", { text: "soup", ingredients: ["water"] })).rejects.toThrow(/not both/);
  });

  it("says what went wrong when the AI is out of credit", async () => {
    parseMeal.mockRejectedValueOnce(new Error("out_of_credits"));
    await expect(call("estimateNutrition", { text: "a bowl of chili" })).rejects.toThrow(/out of AI credits/);
  });
});

describe("findFood", () => {
  it("looks a barcode up without logging a scan the user never made", async () => {
    lookupBarcode.mockResolvedValueOnce(food("Greek yogurt", 146, { source: "openfoodfacts", brand: "Fage", barcode: "5200435000027" }));
    const res = (await call("findFood", { barcode: "5200435000027" })) as { foods: { name: string }[]; value: string };
    expect(lookupBarcode).toHaveBeenCalledWith("5200435000027", undefined, { log: false });
    expect(res.foods[0]).toMatchObject({ name: "Greek yogurt", brand: "Fage", calories: 146, source: "openfoodfacts" });
    expect(res.value).toBe("Fage Greek yogurt: 146 cal per 1 serving (from Open Food Facts)");
  });

  it("searches by name with a capped limit", async () => {
    searchFoods.mockResolvedValueOnce([]);
    const res = (await call("findFood", { query: "oatmeal", limit: 50 })) as { value: string };
    expect(searchFoods).toHaveBeenCalledWith("oatmeal", 10);
    expect(res.value).toBe('No food found for "oatmeal"');
  });

  it("refuses a malformed barcode, or both inputs at once", async () => {
    await expect(call("findFood", { barcode: "abc" })).rejects.toThrow(/6 to 14 digits/);
    await expect(call("findFood", { barcode: "12345678", query: "oats" })).rejects.toThrow(/not both/);
  });
});

describe("logWorkout", () => {
  // How a fitness app puts its workouts on the calorie ring.
  it("names the entry from its type and keeps its length", async () => {
    const res = (await call("logWorkout", { calories: 300, type: "running", durationMin: 30 })) as {
      caloriesBurned: number;
      replaced: boolean;
    };
    expect(res).toMatchObject({ caloriesBurned: 300, replaced: false });
    expect(db.workouts).toEqual([
      expect.objectContaining({
        date: today(),
        workoutName: "Running",
        durationSec: 1800,
        caloriesBurned: 300,
        source: "logWorkout",
      }),
    ]);
  });

  it("still logs a bare burn", async () => {
    await call("logWorkout", { calories: 150 });
    expect(db.workouts[0]?.caloriesBurned).toBe(150);
    expect(db.workouts[0]?.workoutName).toBeUndefined();
    expect(db.workouts[0]?.durationSec).toBeUndefined();
  });

  it("requires calories rather than logging a zero burn", async () => {
    await expect(call("logWorkout", { type: "yoga" })).rejects.toThrow(/calories is required/);
  });

  it("refuses a blank or overlong type rather than storing it", async () => {
    await expect(call("logWorkout", { calories: 100, type: " " })).rejects.toThrow(/type/);
    await expect(call("logWorkout", { calories: 100, type: "x".repeat(41) })).rejects.toThrow(/type/);
    expect(db.workouts).toEqual([]);
  });

  it("replaces a re-sent workout with the same externalId instead of counting it twice", async () => {
    const first = (await call("logWorkout", { calories: 300, externalId: "run-1", sourceApp: "Conjure Fitness" })) as {
      id: string;
    };
    const again = (await call("logWorkout", { calories: 320, externalId: "run-1", sourceApp: "Conjure Fitness" })) as {
      id: string;
      replaced: boolean;
    };
    expect(again).toMatchObject({ id: first.id, replaced: true });
    expect(db.workouts).toHaveLength(1);
    expect(db.workouts[0]).toMatchObject({ caloriesBurned: 320, externalId: "run-1", sourceApp: "Conjure Fitness" });
    // The same id from a different app is a different workout.
    await call("logWorkout", { calories: 100, externalId: "run-1", sourceApp: "Other Tracker" });
    expect(db.workouts).toHaveLength(2);
  });

  it("files a back-dated workout inside its own day", async () => {
    await call("logWorkout", { calories: 200, date: "2026-09-05" });
    expect(iso(new Date(db.workouts[0]!.completedAt))).toBe("2026-09-05");
  });
});

describe("dayExercise", () => {
  it("lists the day's workouts with where each came from", async () => {
    const d = today();
    db.workouts.push(
      { id: "m", date: d, completedAt: new Date().toISOString(), caloriesBurned: 120, source: "manual", workoutName: "Walk" },
      {
        id: "a",
        date: d,
        completedAt: new Date().toISOString(),
        caloriesBurned: 300,
        source: "logWorkout",
        workoutName: "Run",
        externalId: "run-1",
        sourceApp: "Conjure Fitness",
      },
    );
    const res = (await call("dayExercise")) as {
      totalCalories: number;
      workouts: { id: string; origin: string; sourceLabel: string; deletable: boolean; externalId?: string }[];
      value: string;
    };
    expect(res.totalCalories).toBe(420);
    expect(res.workouts.find((w) => w.id === "a")).toMatchObject({
      origin: "app",
      sourceLabel: "From Conjure Fitness",
      deletable: true,
      externalId: "run-1",
    });
    expect(res.value).toMatch(/^420 cal from exercise today: /);
  });

  it("lists a linked fitness app's workout as counted but not deletable here", async () => {
    const d = today();
    const { resetWorkoutSourceCache } = await import("./workoutSource");
    resetWorkoutSourceCache();
    const bridge = (globalThis as { window: { __conjureos: { actions: Record<string, unknown> } } }).window
      .__conjureos.actions;
    bridge.discover = async () => [
      { appPath: "/apps/conjure-fitness", displayName: "Conjure Fitness", action: "listWorkouts", binding: "exact" },
    ];
    bridge.invoke = async () => ({
      workouts: [{ id: "fw9", date: d, name: "Leg Day", durationMin: 40, caloriesBurned: 200, completedAt: new Date().toISOString() }],
    });
    const res = (await call("dayExercise")) as {
      workouts: { id: string; origin: string; sourceLabel: string; counted: boolean; deletable: boolean; externalId?: string }[];
    };
    expect(res.workouts).toHaveLength(1);
    expect(res.workouts[0]).toMatchObject({
      id: "linked:/apps/conjure-fitness:fw9",
      origin: "app",
      sourceLabel: "Conjure Fitness",
      counted: true,
      deletable: false,
      externalId: "fw9",
    });
    resetWorkoutSourceCache();
  });
});

describe("logWater", () => {
  it("stores millilitres when given ounces", async () => {
    const res = (await call("logWater", { oz: 16 })) as { ml: number };
    expect(res.ml).toBe(473); // 16 fl oz
    expect(db.water[0]?.ml).toBe(473);
  });

  it("takes ml unchanged", async () => {
    expect((await call("logWater", { ml: 500 })) as { ml: number }).toMatchObject({ ml: 500 });
  });

  it("refuses both units at once rather than guessing", async () => {
    await expect(call("logWater", { ml: 500, oz: 16 })).rejects.toThrow(/not both/);
  });

  it("refuses neither", async () => {
    await expect(call("logWater", {})).rejects.toThrow(/required/);
  });

  it("refuses an implausible amount", async () => {
    await expect(call("logWater", { ml: 9000 })).rejects.toThrow(/implausibly large/);
  });
});

// Bug 1: the shape check `/^\d{4}-\d{2}-\d{2}$/` let calendar dates that don't
// exist (Feb 30, month 13) through, so an orchestrator-computed date could
// write an entry that recentNutrition/recentWellbeing — which only ever walk
// real calendar days — can never surface again. `date` is shared by every
// write handler via `asDate`, so exercising it through one (logWater) covers
// all of them.
describe("date validation (asDate)", () => {
  it("rejects a day that does not exist in that month", async () => {
    await expect(call("logWater", { ml: 500, date: "2026-02-30" })).rejects.toThrow(/real calendar date/);
  });

  it("rejects a month that does not exist", async () => {
    await expect(call("logWater", { ml: 500, date: "2026-13-01" })).rejects.toThrow(/real calendar date/);
  });

  it("still accepts a real date, including a leap day", async () => {
    const res = (await call("logWater", { ml: 500, date: "2028-02-29" })) as { ml: number };
    expect(res.ml).toBe(500);
  });
});

describe("logSleep", () => {
  it("reads a bedtime after the wake time as the night before", async () => {
    const res = (await call("logSleep", {
      bedTime: "23:30",
      wakeTime: "07:00",
      wakeDate: "2026-09-05",
    })) as { minutes: number; date: string };
    expect(res.minutes).toBe(450); // 7h30m
    expect(res.date).toBe("2026-09-05");
  });

  it("handles a bedtime after midnight", async () => {
    const res = (await call("logSleep", {
      bedTime: "01:15",
      wakeTime: "08:00",
      wakeDate: "2026-09-05",
    })) as { minutes: number };
    expect(res.minutes).toBe(405);
  });

  it("rejects a clock face it cannot read", async () => {
    await expect(call("logSleep", { bedTime: "half nine", wakeTime: "07:00" })).rejects.toThrow(/HH:MM/);
  });

  it("rejects an implausibly long night instead of storing it", async () => {
    await expect(
      call("logSleep", { bedTime: "08:00", wakeTime: "07:00", wakeDate: "2026-09-05" }),
    ).rejects.toThrow(/check bedTime and wakeTime/);
  });

  // Bug 2: the param is `wakeDate`, not `date` — the old name let a caller
  // pass the BEDTIME's date (very plausible for "I went to bed at 11:30 on
  // the 4th") and file the night a day early with the duration still correct.
  // Passing the old `date` name now does nothing but fall through to
  // "defaults to today," rather than being silently accepted as the wake day.
  it("refuses the pre-1.34 `date` field loudly instead of silently using today", async () => {
    // A caller left on the 1.33.0 contract must fail visibly, not quietly log
    // the night under the wrong day — that would be worse than the bug the
    // rename fixed.
    await expect(
      call("logSleep", { bedTime: "23:30", wakeTime: "07:00", date: "2026-09-05" }),
    ).rejects.toThrow(/wakeDate/);
  });

  it("files the night under wakeDate, not the bedtime's date", async () => {
    // Going to bed at 23:30 on the 4th and waking at 07:00 on the 5th is filed
    // under the 5th — the caller must state the wake day explicitly.
    const res = (await call("logSleep", {
      bedTime: "23:30",
      wakeTime: "07:00",
      wakeDate: "2026-09-05",
    })) as { date: string };
    expect(res.date).toBe("2026-09-05");
  });
});

describe("logSymptom", () => {
  it("records the label, severity and note", async () => {
    await call("logSymptom", { label: "Heartburn", severity: 3, note: "after pizza" });
    expect(db.symptoms[0]).toMatchObject({ label: "Heartburn", severity: 3, note: "after pizza" });
  });

  it("clamps severity into the 1-5 scale", async () => {
    await call("logSymptom", { label: "Headache", severity: 99 });
    expect(db.symptoms[0]?.severity).toBe(5);
  });

  it("requires a label", async () => {
    await expect(call("logSymptom", {})).rejects.toThrow(/label/);
  });
});

describe("logWeight", () => {
  it("converts pounds to kilograms at the weight card's precision", async () => {
    const res = (await call("logWeight", { lb: 180 })) as { weightKg: number };
    expect(res.weightKg).toBe(81.65);
  });

  it("stores a pound entry so it reads back as the same pounds", async () => {
    // At one decimal, 180.2 lb was stored as 81.7 kg and read back as 180.1 lb.
    const { weightKg } = (await call("logWeight", { lb: 180.2 })) as { weightKg: number };
    expect(Math.round((weightKg / 0.45359237) * 10) / 10).toBe(180.2);
  });

  it("keeps one weight per day", async () => {
    await call("logWeight", { kg: 82, date: "2026-09-05" });
    await call("logWeight", { kg: 81, date: "2026-09-05" });
    expect(db.weights).toHaveLength(1);
    expect(db.weights[0]?.weightKg).toBe(81);
  });
});

describe("weightTrend", () => {
  it("gives the latest weigh-in and the change over the window, in the user's units", async () => {
    db.profile = { units: "imperial" } as Profile;
    db.weights.push(
      { date: iso(new Date(Date.now() - 20 * 86_400_000)), weightKg: 82 },
      { date: yesterday(), weightKg: 81 },
      { date: iso(new Date(Date.now() - 400 * 86_400_000)), weightKg: 90 },
    );
    const res = (await call("weightTrend", { days: 30 })) as {
      entries: unknown[];
      latest: { weightKg: number };
      changeKg: number;
      value: string;
    };
    expect(res.entries).toHaveLength(2);
    expect(res.latest.weightKg).toBe(81);
    expect(res.changeKg).toBe(-1);
    expect(res.value).toMatch(/^178\.6 lb yesterday, down 2\.2 lb since /);
  });

  it("says when nothing has been recorded", async () => {
    expect(((await call("weightTrend")) as { value: string }).value).toBe("No weight recorded yet");
  });
});

// Bug 3: logRecipeMeal's `Number(p.servings) || 1` treated an explicit
// `servings: 0` as absent and silently logged a full serving's calories for a
// user who said they had none. Validation runs before the recipe lookup, so
// this doesn't need recipeBridge mocked.
describe("logRecipeMeal", () => {
  it("refuses an explicit zero servings rather than logging a full one", async () => {
    await expect(call("logRecipeMeal", { slug: "any-recipe", servings: 0 })).rejects.toThrow(/positive/);
  });
});

describe("wellbeing reads never carry the symptom note", () => {
  it("returns label, severity and time but not the free text", async () => {
    const date = today();
    db.symptoms.push({
      id: "s1",
      date,
      loggedAt: new Date(`${date}T21:40:00`).toISOString(),
      label: "Heartburn",
      severity: 3,
      note: "after the antibiotics",
    });
    const day = (await call("dayWellbeing")) as {
      symptoms: { label: string; severity?: number; at: string }[];
      value: string;
    };
    expect(day.symptoms[0]).toEqual({ label: "Heartburn", severity: 3, at: "21:40" });
    expect(JSON.stringify(day)).not.toContain("antibiotics");
    expect(day.value).toBe("Today: heartburn");
  });

  it("holds the note back across a range too", async () => {
    const date = today();
    db.symptoms.push({
      id: "s1",
      date,
      loggedAt: new Date(`${date}T09:00:00`).toISOString(),
      label: "Headache",
      note: "secret",
    });
    const res = (await call("recentWellbeing", { days: 3 })) as { days: unknown[]; value: string };
    expect(res.days).toHaveLength(3);
    expect(JSON.stringify(res)).not.toContain("secret");
    expect(JSON.stringify(res)).toContain("Headache");
    expect(res.value).toBe("Over the last 3 days, on average: 1 symptom");
  });

  it("totals water and sleep for the day", async () => {
    const date = today();
    db.water.push({ id: "w1", date, ml: 300, loggedAt: new Date().toISOString() });
    db.water.push({ id: "w2", date, ml: 500, loggedAt: new Date().toISOString() });
    db.sleep.push({
      id: "n1",
      date,
      bedAt: new Date(`${date}T00:00:00`).toISOString(),
      wakeAt: new Date(`${date}T07:00:00`).toISOString(),
    });
    db.weights.push({ date, weightKg: 82.4 });
    const day = (await call("dayWellbeing", { date })) as {
      waterMl: number;
      sleepMinutes: number;
      weightKg?: number;
      value: string;
    };
    expect(day.waterMl).toBe(800);
    expect(day.sleepMinutes).toBe(420);
    expect(day.weightKg).toBe(82.4);
    expect(day.value).toMatch(/^Today: 800 ml of water, slept 7h/);
  });

  it("caps the range rather than trusting the caller", async () => {
    const res = (await call("recentWellbeing", { days: 999 })) as { days: unknown[] };
    expect(res.days).toHaveLength(14);
  });

  // Bug 4: `asNonNegInt(p.days, "days", 14) || 7` treated an explicit `days: 0`
  // as absent and silently returned the 7-day default. It's the mirror image
  // of the "caps the range" case above: excessive is clamped down, but zero
  // (a different request, not a smaller one) is rejected outright rather than
  // guessing what the caller meant.
  it("refuses an explicit days: 0 rather than defaulting to 7", async () => {
    await expect(call("recentWellbeing", { days: 0 })).rejects.toThrow(/positive/);
  });
});
