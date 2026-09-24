/**
 * The cross-app action surface, exercised through `registerActions` — the same
 * way ConjureOS reaches it — rather than through test-only exports.
 *
 * Params here arrive from other, untrusted apps, so the assertions are as much
 * about what these handlers REFUSE as what they do.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SleepEntry, SymptomEntry, WaterEntry, WeightEntry } from "../types";

type Handler = (params?: unknown) => Promise<unknown>;

const db = {
  water: [] as WaterEntry[],
  sleep: [] as SleepEntry[],
  symptoms: [] as SymptomEntry[],
  weights: [] as WeightEntry[],
  removed: [] as string[],
  quantities: {} as Record<string, number>,
};

const repo = {
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
  listSleep: async (date: string) => db.sleep.filter((n) => n.date === date),
  listSymptoms: async (date: string) => db.symptoms.filter((s) => s.date === date),
  listWeights: async () => db.weights,
  updateDiaryEntry: async (id: string, patch: { quantity?: number }) => {
    if (patch.quantity !== undefined) db.quantities[id] = patch.quantity;
  },
  removeDiaryEntry: async (id: string) => void db.removed.push(`food:${id}`),
  removeWater: async (id: string) => void db.removed.push(`water:${id}`),
  removeSleep: async (id: string) => void db.removed.push(`sleep:${id}`),
  removeSymptom: async (id: string) => void db.removed.push(`symptom:${id}`),
  removeWeight: async (d: string) => void db.removed.push(`weight:${d}`),
  removeWorkoutSession: async (id: string) => void db.removed.push(`workout:${id}`),
};

vi.mock("../data/repository", () => ({ getRepository: async () => repo }));
vi.mock("../features/exercise", () => ({ exerciseCaloriesForDate: async () => 0 }));

let actions: Record<string, Handler> = {};

beforeEach(async () => {
  db.water = [];
  db.sleep = [];
  db.symptoms = [];
  db.weights = [];
  db.removed = [];
  db.quantities = {};
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

const today = () => new Date().toISOString().slice(0, 10);

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

  it("does not expose consent, the pattern-finder, bulk clears, or goal writes", () => {
    // These are refusals, not omissions. See the header of actions.ts.
    for (const forbidden of [
      "grantAiConsent",
      "setAiConsent",
      "findPatterns",
      "askPatterns",
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
    await expect(call("logWater", { ml: 500, date: "2026-02-30" })).rejects.toThrow(
      /real calendar date/,
    );
  });

  it("rejects a month that does not exist", async () => {
    await expect(call("logWater", { ml: 500, date: "2026-13-01" })).rejects.toThrow(
      /real calendar date/,
    );
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
    await expect(call("logSleep", { bedTime: "half nine", wakeTime: "07:00" })).rejects.toThrow(
      /HH:MM/,
    );
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
  it("converts pounds to kilograms", async () => {
    const res = (await call("logWeight", { lb: 180 })) as { weightKg: number };
    expect(res.weightKg).toBeCloseTo(81.6, 1);
  });

  it("keeps one weight per day", async () => {
    await call("logWeight", { kg: 82, date: "2026-09-05" });
    await call("logWeight", { kg: 81, date: "2026-09-05" });
    expect(db.weights).toHaveLength(1);
    expect(db.weights[0]?.weightKg).toBe(81);
  });
});

// Bug 3: logRecipeMeal's `Number(p.servings) || 1` treated an explicit
// `servings: 0` as absent and silently logged a full serving's calories for a
// user who said they had none. Validation runs before the recipe lookup, so
// this doesn't need recipeBridge mocked.
describe("logRecipeMeal", () => {
  it("refuses an explicit zero servings rather than logging a full one", async () => {
    await expect(call("logRecipeMeal", { slug: "any-recipe", servings: 0 })).rejects.toThrow(
      /positive/,
    );
  });
});

describe("corrections", () => {
  it("changes a logged food's quantity", async () => {
    await call("setFoodQuantity", { id: "d1", quantity: 2 });
    expect(db.quantities.d1).toBe(2);
  });

  it("refuses a non-positive quantity", async () => {
    await expect(call("setFoodQuantity", { id: "d1", quantity: 0 })).rejects.toThrow(/positive/);
  });

  // Bug 4: positivity was checked on the RAW input, then the value was
  // rounded to 2dp without re-checking, so a positive-but-sub-minimum
  // quantity like 0.004 rounded down to a bare 0 in storage. It now clamps
  // into the schema's stated minimum (0.01) before rounding, so it is never
  // rounded back out of range.
  it("clamps a positive quantity finer than the schema minimum, rather than storing zero", async () => {
    const res = (await call("setFoodQuantity", { id: "d1", quantity: 0.004 })) as {
      quantity: number;
    };
    expect(res.quantity).toBe(0.01);
    expect(db.quantities.d1).toBe(0.01);
  });

  it("deletes one record of each kind", async () => {
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

  it("refuses a kind it does not know rather than silently doing nothing", async () => {
    await expect(call("deleteEntry", { kind: "everything", id: "x" })).rejects.toThrow(
      /must be one of/,
    );
    expect(db.removed).toEqual([]);
  });

  it("requires a date for a weight delete, since weight is keyed by day", async () => {
    await expect(call("deleteEntry", { kind: "weight", id: "w1" })).rejects.toThrow(/YYYY-MM-DD/);
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
    };
    expect(day.symptoms[0]).toEqual({ label: "Heartburn", severity: 3, at: "21:40" });
    expect(JSON.stringify(day)).not.toContain("antibiotics");
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
    const res = (await call("recentWellbeing", { days: 3 })) as { days: unknown[] };
    expect(res.days).toHaveLength(3);
    expect(JSON.stringify(res)).not.toContain("secret");
    expect(JSON.stringify(res)).toContain("Headache");
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
    };
    expect(day.waterMl).toBe(800);
    expect(day.sleepMinutes).toBe(420);
    expect(day.weightKg).toBe(82.4);
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

describe("recentNutrition", () => {
  it("refuses an explicit days: 0 rather than defaulting to 7", async () => {
    await expect(call("recentNutrition", { days: 0 })).rejects.toThrow(/positive/);
  });
});
