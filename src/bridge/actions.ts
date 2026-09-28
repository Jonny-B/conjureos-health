/**
 * Cross-app actions Conjure Health exposes via ConjureOS's Phase 13a bridge, so the
 * home orchestrator, an assistant, or the Recipes app can write to / read from
 * the diary:
 *
 *   logFood({ name, calories, protein?, carbs?, fat?, meal?, date? })  → write
 *   todayTotals()                                                      → read
 *   dayNutrition({ date? })                                            → read
 *   recentNutrition({ days? })                                         → read
 *   logRecipeMeal({ slug, servings?, meal?, date? })                   → write
 *   logWorkout({ calories, type?, durationMin?, date? })               → write
 *   logWater({ ml? | oz?, date? })                                     → write
 *   logSleep({ bedTime, wakeTime, wakeDate?, quality? })                → write
 *   logSymptom({ label, severity?, note?, date? })                     → write
 *   logWeight({ kg? | lb?, date? })                                    → write
 *   setFoodQuantity({ id, quantity })                                  → write
 *   deleteEntry({ kind, id })                                          → write
 *   dayWellbeing({ date? })                                            → read
 *   recentWellbeing({ days? })                                         → read
 *
 * Deliberately NOT exposed, and not an oversight:
 *
 *   - Granting AI-journal consent. An agent cannot agree to a health-data
 *     disclosure on the user's behalf; the record only means anything because
 *     a person read the disclosure and said yes (features/aiConsent.ts).
 *   - Running the journal pattern-finder. That call IS the disclosure, and it
 *     is defensible because a human pressed a button, not a schedule.
 *   - Bulk clears (clearDiary / clearAllHistories / …). Irreversible, and no
 *     caller need outweighs an agent wiping months of health data by mistake.
 *     `deleteEntry` removes exactly one record, by id.
 *   - Goals / profile / plan writes. Changing a calorie target silently
 *     re-bases every number in the app and the user may never notice.
 *   - Symptom NOTES on read. Labels, severity and time go out; the free text
 *     stays on device, the same rule the AI summary follows.
 *
 * Params come from other (untrusted) apps, so every field is type-checked,
 * length-capped, and range-clamped before it reaches the repository. Reads are
 * side-effect-free; writes trigger ConjureOS's one-time per-caller grant.
 */

import type { Macros, MealType, WorkoutSession } from "../types";
import { MEAL_TYPES } from "../types";
import { getRepository } from "../data/repository";
import { parseMeal } from "../features/naturalLanguage";
import { buildDayView, shiftDate, todayISO } from "../features/diary";
import { buildSleepEntry, isImplausible, parseClock, sleepMinutes } from "../features/sleep";
import { flOzToMl } from "../features/water";
import { lbToKg } from "../features/units";
import { getRecipe, markCooked, RecipesAppClosedError, type ListedRecipe } from "./recipeBridge";
import { exerciseCaloriesForDate } from "../features/exercise";
import { daySnapshot, recentSnapshots } from "../features/dataApi";
import { newId } from "../data/id";

/** Exercise calories for a date: wearable (Apple Health, etc.) + in-app logged
 *  sessions, added, minus any the user removed. Shared with the diary ring via
 *  features/exercise so both stay consistent. */
async function exerciseCaloriesFor(date: string): Promise<number> {
  return exerciseCaloriesForDate(date);
}

function asObject(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("params must be an object");
  return v as Record<string, unknown>;
}
function asString(v: unknown, field: string, max: number): string {
  if (typeof v !== "string") throw new Error(`params.${field} must be a string`);
  const t = v.trim();
  if (!t) throw new Error(`params.${field} cannot be empty`);
  if (t.length > max) throw new Error(`params.${field} exceeds ${max} chars`);
  // eslint-disable-next-line no-control-regex
  return t.replace(/[\x00-\x1F\x7F]/g, "");
}
function asNonNegInt(v: unknown, field: string, max: number, dflt = 0): number {
  if (v === undefined || v === null) return dflt;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`params.${field} must be a non-negative number`);
  return Math.min(max, Math.round(n));
}
/**
 * A caller-stated amount, validated against a schema's [min, max].
 *
 * Zero or negative is always REJECTED, never clamped up: for a field that
 * counts or measures something (days of history, servings, a corrected
 * quantity), "none" is a different request than "a little" — the caller
 * should just not make the call, or use deleteEntry — so it must never be
 * silently reinterpreted as a default or a minimum. A positive value that
 * falls outside the bound, on the other hand, is safe to clamp to the nearer
 * edge: capping an excessive "days: 999" or rounding "servings: 0.02" up to
 * the smallest representable amount doesn't invent an amount the caller never
 * stated, it just refuses to honor an amount stated too precisely or too
 * generously. Applied consistently at every "explicit but out of range"
 * numeric field on this surface — see recentNutrition/recentWellbeing (days),
 * logRecipeMeal (servings), and setFoodQuantity (quantity).
 */
function asPositiveAmount(
  v: unknown,
  field: string,
  min: number,
  max: number,
  integer = false,
): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`params.${field} must be a positive number`);
  const clamped = Math.min(max, Math.max(min, n));
  return integer ? Math.round(clamped) : clamped;
}

function asMeal(v: unknown): MealType {
  if (typeof v === "string" && (MEAL_TYPES as string[]).includes(v)) return v as MealType;
  // Default by time of day if unspecified.
  const h = new Date().getHours();
  return h < 11 ? "breakfast" : h < 15 ? "lunch" : h < 21 ? "dinner" : "snacks";
}
function asDate(v: unknown): string {
  if (v === undefined || v === null) return todayISO();
  const s = asString(v, "date", 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error("params.date must be YYYY-MM-DD");
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // The regex only checks SHAPE. `new Date("2026-02-30")` rolls over to March
  // 2nd instead of failing, so the only reliable check is to construct the
  // date from its parts and read it back: a date that doesn't exist comes
  // back on a different day/month than the one asked for. This matters
  // because a written entry under a date the app's own UI can never navigate
  // to (recentNutrition/recentWellbeing walk real calendar days) is written
  // and then permanently invisible.
  const roundTrip = new Date(y, mo - 1, d);
  if (roundTrip.getFullYear() !== y || roundTrip.getMonth() !== mo - 1 || roundTrip.getDate() !== d) {
    throw new Error("params.date must be a real calendar date (YYYY-MM-DD)");
  }
  return s;
}

/** An id from a caller: non-empty, bounded, control characters stripped. */
function asId(v: unknown): string {
  return asString(v, "id", 64);
}

/**
 * A positive amount in one of two units, exactly one of which must be given.
 * Callers speak the user's units ("16 oz of water", "184 lb"), and storage is
 * always metric, so the conversion belongs here rather than in six call sites.
 */
function asMetricAmount(
  raw: Record<string, unknown>,
  metricField: string,
  imperialField: string,
  toMetric: (v: number) => number,
  max: number,
): number {
  const m = raw[metricField];
  const i = raw[imperialField];
  const given = [m, i].filter((v) => v !== undefined && v !== null);
  if (given.length === 0) throw new Error(`params.${metricField} or params.${imperialField} is required`);
  if (given.length > 1) throw new Error(`pass params.${metricField} OR params.${imperialField}, not both`);
  const isMetric = m !== undefined && m !== null;
  const n = Number(isMetric ? m : i);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`params.${isMetric ? metricField : imperialField} must be a positive number`);
  }
  const metric = isMetric ? n : toMetric(n);
  if (metric > max) throw new Error(`params.${isMetric ? metricField : imperialField} is implausibly large`);
  return metric;
}

/**
 * A clock face, "HH:MM" on a 24-hour clock.
 *
 * Deliberately capped generously rather than at 5, so "half nine" fails with
 * the format error a caller can act on instead of a length complaint about a
 * field whose length was never the point.
 */
function asClock(v: unknown, field: string): string {
  const s = asString(v, field, 40);
  if (parseClock(s) === null) throw new Error(`params.${field} must be HH:MM on a 24-hour clock`);
  return s;
}

async function logFood(raw?: unknown): Promise<{ id: string }> {
  const p = asObject(raw);
  const name = asString(p.name, "name", 80);
  const meal = asMeal(p.meal);
  const date = asDate(p.date);

  // Calories are optional. When a caller names a food without numbers ("a
  // McCrispy sandwich"), estimate the macros from the name — the same estimator
  // the Describe tab uses — instead of requiring the caller to know them. An
  // explicit 0 (e.g. black coffee) is respected; only an absent value estimates.
  let perServing: Macros;
  let servingSize = "1 serving";
  let estimated = false;
  if (p.calories === undefined || p.calories === null) {
    const estimate = await estimateMacros(name);
    perServing = estimate.perServing;
    servingSize = estimate.servingSize;
    estimated = true;
  } else {
    perServing = {
      calories: asNonNegInt(p.calories, "calories", 5000),
      protein: asNonNegInt(p.protein, "protein", 500),
      carbs: asNonNegInt(p.carbs, "carbs", 800),
      fat: asNonNegInt(p.fat, "fat", 500),
    };
  }

  const repo = await getRepository();
  const entry = await repo.addDiaryEntry({
    date,
    meal,
    quantity: 1,
    food: {
      id: newId(),
      source: "custom",
      name,
      perServing,
      servingSize,
      // Mark AI-estimated logs so the diary flags them as an inaccurate guess.
      ...(estimated ? { provenance: { sourceTag: "ai_estimate" } } : {}),
    },
  });
  return { id: entry.id };
}

/**
 * Estimate one food's per-serving macros from its name via the shared
 * natural-language estimator. Falls back to all-zeros if the estimator returns
 * nothing (offline / unparseable) so a log never hard-fails on a missing number.
 */
async function estimateMacros(
  name: string,
): Promise<{ perServing: Macros; servingSize: string }> {
  try {
    const [item] = await parseMeal({ text: name });
    if (item) return { perServing: item.perServing, servingSize: item.servingSize };
  } catch {
    // Non-fatal — fall through to the zero estimate below.
  }
  return { perServing: { calories: 0, protein: 0, carbs: 0, fat: 0 }, servingSize: "1 serving" };
}

async function todayTotals(): Promise<{
  date: string;
  total: { calories: number; protein: number; carbs: number; fat: number };
  goals: { calories: number; protein: number; carbs: number; fat: number };
  exerciseCalories: number;
  caloriesRemaining: number;
}> {
  const repo = await getRepository();
  const date = todayISO();
  const [entries, goals, exerciseCalories] = await Promise.all([
    repo.listDiary(date),
    repo.getGoals(),
    exerciseCaloriesFor(date),
  ]);
  const { total } = buildDayView(date, entries);
  // Exercise calories add back to the day's allowance.
  return {
    date,
    total,
    goals,
    exerciseCalories,
    caloriesRemaining: goals.calories - total.calories + exerciseCalories,
  };
}

/**
 * What the user has eaten on a date, with what's left of their targets.
 *
 * The read another app actually wants: a recipe app suggesting dinner needs
 * the gap, not just the totals. Deliberately NUTRITION ONLY — sleep, symptoms
 * and weight are in the same snapshot the in-app coach sees, and are withheld
 * here. The user's own assistant seeing their symptoms is one thing; handing
 * them to any installed app that asks is another, and nothing outside this app
 * has a nutrition reason to want them.
 */
async function dayNutrition(raw?: unknown): Promise<{
  date: string;
  targets: Macros;
  consumed: Macros;
  remaining: Macros;
  exerciseCalories: number;
  foods: { name: string; meal: MealType; quantity: number; calories: number }[];
  moreFoods: number;
}> {
  const p = asObject(raw);
  const date = asDate(p.date);
  const s = await daySnapshot(date);
  return {
    date: s.date,
    targets: s.targets,
    consumed: s.consumed,
    remaining: s.remaining,
    exerciseCalories: s.exerciseCalories,
    foods: s.foods.map((f) => ({
      name: f.name,
      meal: f.meal,
      quantity: f.quantity,
      calories: f.calories,
    })),
    moreFoods: s.moreFoods,
  };
}

/**
 * Daily nutrition totals over a recent window, oldest first — for anything
 * that wants a trend rather than a single day. Capped at two weeks: a caller
 * wanting more should ask the user for the journal export instead of pulling
 * an unbounded history through an action.
 */
async function recentNutrition(raw?: unknown): Promise<{
  days: { date: string; consumed: Macros; exerciseCalories: number }[];
}> {
  const p = asObject(raw);
  // An explicit 0 is rejected, not silently turned into the 7-day default —
  // see asPositiveAmount.
  const days =
    p.days === undefined || p.days === null ? 7 : asPositiveAmount(p.days, "days", 1, 14, true);
  const snaps = await recentSnapshots(days);
  return {
    days: snaps.map((s) => ({
      date: s.date,
      consumed: s.consumed,
      exerciseCalories: s.exerciseCalories,
    })),
  };
}

/**
 * Log a completed workout (from a fitness app, an assistant, the home
 * orchestrator, or a wearable handoff). This is how exercise done elsewhere
 * reaches the calorie ring: `calories` feeds the diary's exercise add-back,
 * and `type` / `durationMin` name the entry and give its length on the
 * Exercise screen. Untrusted input, so every field is checked + clamped.
 */
async function logWorkout(raw?: unknown): Promise<{ id: string; caloriesBurned: number }> {
  const p = asObject(raw);
  const calories = asNonNegInt(p.calories, "calories", 10000);
  const type = p.type === undefined ? undefined : asString(p.type, "type", 40);
  const minutes = asNonNegInt(p.durationMin, "durationMin", 1440);
  const date = asDate(p.date);

  const repo = await getRepository();
  const session: WorkoutSession = {
    id: newId(),
    date,
    // "running" reads as "Running" in the list.
    ...(type ? { workoutName: type.charAt(0).toUpperCase() + type.slice(1) } : {}),
    ...(minutes > 0 ? { durationSec: minutes * 60 } : {}),
    completedAt: new Date().toISOString(),
    caloriesBurned: calories,
    source: "logWorkout",
  };
  await repo.saveWorkoutSession(session);
  return { id: session.id, caloriesBurned: calories };
}

async function logRecipeMeal(raw?: unknown): Promise<{ id: string; logged: boolean }> {
  const p = asObject(raw);
  const slug = asString(p.slug, "slug", 80)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  if (!slug) throw new Error("params.slug invalid");
  // `|| 1` used to treat an explicit `servings: 0` as absent and silently log
  // a full serving. asPositiveAmount rejects 0/negative outright instead —
  // "I had none of it" isn't a smaller serving, it's not a call to make.
  const servings =
    p.servings === undefined || p.servings === null
      ? 1
      : asPositiveAmount(p.servings, "servings", 0.1, 20);
  const meal = asMeal(p.meal);
  const date = asDate(p.date);

  let recipe: ListedRecipe | null;
  try {
    recipe = await getRecipe(slug);
  } catch (err) {
    // Recipes app is closed: ask the orchestrator to open it and retry the
    // whole action, instead of failing as if the recipe didn't exist. The
    // shell catches this marker, opens Recipes, and re-invokes logRecipeMeal.
    if (err instanceof RecipesAppClosedError) {
      throw new Error(`NEEDS_APP_OPEN:${err.appPath}`);
    }
    throw err;
  }
  if (!recipe || !recipe.nutrition) {
    throw new Error(`recipe not found or has no nutrition: ${slug}`);
  }
  const n = recipe.nutrition;
  const repo = await getRepository();
  const entry = await repo.addDiaryEntry({
    date,
    meal,
    quantity: servings,
    food: {
      id: slug,
      source: "recipe",
      name: recipe.title,
      perServing: { calories: n.calories, protein: n.protein, carbs: n.carbs, fat: n.fat },
      servingSize: "1 serving",
    },
  });
  // Best-effort: confirm the recipe was cooked (non-fatal if the grant is denied).
  await markCooked(slug);
  return { id: entry.id, logged: true };
}

// ── Wellbeing writes ──────────────────────────────────────────────────
// Each adds exactly one record and is individually reversible via
// deleteEntry, which is what makes them safe for an agent to call.

async function logWater(raw?: unknown): Promise<{ id: string; ml: number }> {
  const p = asObject(raw ?? {});
  // 4 L in one go is already well past a real drink; anything above is a
  // caller bug, not a big glass.
  const ml = Math.round(asMetricAmount(p, "ml", "oz", flOzToMl, 4000));
  const date = asDate(p.date);
  const repo = await getRepository();
  const entry = await repo.addWater({ date, ml, loggedAt: new Date().toISOString() });
  return { id: entry.id, ml: entry.ml };
}

async function logSleep(raw?: unknown): Promise<{
  id: string;
  date: string;
  minutes: number;
}> {
  const p = asObject(raw);
  const bedTime = asClock(p.bedTime, "bedTime");
  const wakeTime = asClock(p.wakeTime, "wakeTime");
  // CORRECTION, 2026-09-09: this comment used to claim "buildSleepEntry
  // re-derives [the date] from the resolved instants anyway, so a caller
  // passing the bedtime's date cannot misfile the night." That was false.
  // resolveNight (features/sleep.ts) treats the date it is given as the WAKE
  // date and places bedTime on the day before it whenever bedTime > wakeTime —
  // it never looks at which clock face the caller actually meant the date to
  // go with. A caller who passes the BEDTIME's date (very plausible for an AI
  // translating "I went to bed at 11:30 on the 4th") files the night a full
  // day early, silently, with the duration still correct — nothing about the
  // result looks wrong.
  //
  // Fix: the param is named `wakeDate`, not `date`, so the field itself states
  // what it wants instead of relying on a caller reading the schema
  // description. We still don't guess: no bed-date param is accepted, so
  // there is nothing to reconcile or silently prefer.
  // 1.33.0 shipped this param as `date`, and a caller still passing that name
  // would now fall through to "defaults to today" — a silently WRONG night,
  // which is worse than the misfiling this rename set out to fix. Refuse
  // loudly instead, and name the replacement.
  if (p.date !== undefined && p.wakeDate === undefined) {
    throw new Error(
      "params.date is no longer accepted for logSleep — pass params.wakeDate, the date the user WOKE UP",
    );
  }
  const wakeDate = asDate(p.wakeDate);
  const quality =
    p.quality === undefined || p.quality === null
      ? undefined
      : Math.min(5, Math.max(1, asNonNegInt(p.quality, "quality", 5, 1)));
  const entry = buildSleepEntry(newId(), wakeDate, bedTime, wakeTime, {
    ...(quality !== undefined ? { quality } : {}),
  });
  if (!entry) throw new Error("could not resolve a night from those times");
  const minutes = sleepMinutes(entry);
  if (isImplausible(minutes)) {
    throw new Error(`that is ${Math.round(minutes / 60)}h of sleep — check bedTime and wakeTime`);
  }
  const repo = await getRepository();
  await repo.saveSleep(entry);
  return { id: entry.id, date: entry.date, minutes };
}

async function logSymptom(raw?: unknown): Promise<{ id: string }> {
  const p = asObject(raw);
  const label = asString(p.label, "label", 60);
  const date = asDate(p.date);
  const severity =
    p.severity === undefined || p.severity === null
      ? undefined
      : Math.min(5, Math.max(1, asNonNegInt(p.severity, "severity", 5, 1)));
  // A note may be WRITTEN through the API — the user dictating "log a headache,
  // it started after lunch" is the obvious case. It is never READ back out;
  // see dayWellbeing.
  const note =
    p.note === undefined || p.note === null ? undefined : asString(p.note, "note", 200);
  const repo = await getRepository();
  const entry = await repo.addSymptom({
    date,
    loggedAt: new Date().toISOString(),
    label,
    ...(severity !== undefined ? { severity } : {}),
    ...(note !== undefined ? { note } : {}),
  });
  return { id: entry.id };
}

async function logWeight(raw?: unknown): Promise<{ date: string; weightKg: number }> {
  const p = asObject(raw ?? {});
  const weightKg = Math.round(asMetricAmount(p, "kg", "lb", lbToKg, 500) * 10) / 10;
  const date = asDate(p.date);
  const repo = await getRepository();
  // One canonical weight per day: this replaces the day's entry rather than
  // appending, matching what the weight card does.
  await repo.upsertWeight({ date, weightKg });
  return { date, weightKg };
}

// ── Corrections ───────────────────────────────────────────────────────

async function setFoodQuantity(raw?: unknown): Promise<{ id: string; quantity: number }> {
  const p = asObject(raw);
  const id = asId(p.id);
  // Round-then-clamp, not clamp-then-round: rounding a sub-minimum quantity
  // like 0.004 to 2dp BEFORE re-checking the bound used to store a bare 0
  // (below the schema's 0.01 minimum) even though the raw value passed the
  // `> 0` check. asPositiveAmount clamps into [0.01, 50] first, so the value
  // that gets rounded is never smaller than the minimum in the first place.
  const quantity = Math.round(asPositiveAmount(p.quantity, "quantity", 0.01, 50) * 100) / 100;
  const repo = await getRepository();
  await repo.updateDiaryEntry(id, { quantity });
  return { id, quantity };
}

/** What `deleteEntry` will remove. One record, by id, per call. */
const DELETABLE = ["food", "water", "sleep", "symptom", "weight", "workout"] as const;
type Deletable = (typeof DELETABLE)[number];

async function deleteEntry(raw?: unknown): Promise<{ deleted: true; kind: Deletable }> {
  const p = asObject(raw);
  const kind = asString(p.kind, "kind", 20);
  if (!(DELETABLE as readonly string[]).includes(kind)) {
    throw new Error(`params.kind must be one of: ${DELETABLE.join(", ")}`);
  }
  // Weight is keyed by date (one per day), everything else by row id.
  const id = kind === "weight" ? asDate(p.id) : asId(p.id);
  const repo = await getRepository();
  switch (kind as Deletable) {
    case "food":
      await repo.removeDiaryEntry(id);
      break;
    case "water":
      await repo.removeWater(id);
      break;
    case "sleep":
      await repo.removeSleep(id);
      break;
    case "symptom":
      await repo.removeSymptom(id);
      break;
    case "weight":
      await repo.removeWeight(id);
      break;
    case "workout":
      await repo.removeWorkoutSession(id);
      break;
  }
  return { deleted: true, kind: kind as Deletable };
}

// ── Wellbeing reads ───────────────────────────────────────────────────

interface WellbeingSymptom {
  label: string;
  /** 1-5, when the user picked one. */
  severity?: number;
  /** HH:MM local, so "always in the evening" is answerable. */
  at: string;
}

interface WellbeingDay {
  date: string;
  waterMl: number;
  sleepMinutes: number;
  weightKg?: number;
  symptoms: WellbeingSymptom[];
}

/**
 * One day of everything the journal holds that is not food.
 *
 * Symptom NOTES are never included. The label, the severity and the time are
 * what a pattern question needs; the free text is where someone writes the
 * thing they would not want handed to another app, and it stays on device —
 * the same line features/journal.ts draws for the AI summary.
 */
async function wellbeingFor(date: string): Promise<WellbeingDay> {
  const repo = await getRepository();
  const [water, sleep, symptoms, weights] = await Promise.all([
    repo.listWater(date),
    repo.listSleep(date),
    repo.listSymptoms(date),
    repo.listWeights(),
  ]);
  const weight = weights.find((w) => w.date === date);
  const day: WellbeingDay = {
    date,
    waterMl: water.reduce((sum, w) => sum + w.ml, 0),
    sleepMinutes: sleep.reduce((sum, n) => sum + sleepMinutes(n), 0),
    symptoms: symptoms.slice(0, 20).map((sym) => {
      const at = new Date(sym.loggedAt);
      const out: WellbeingSymptom = {
        label: sym.label,
        at: `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`,
      };
      if (sym.severity !== undefined) out.severity = sym.severity;
      return out;
    }),
  };
  if (weight) day.weightKg = weight.weightKg;
  return day;
}

async function dayWellbeing(raw?: unknown): Promise<WellbeingDay> {
  const p = asObject(raw ?? {});
  return wellbeingFor(asDate(p.date));
}

async function recentWellbeing(raw?: unknown): Promise<{ days: WellbeingDay[] }> {
  const p = asObject(raw ?? {});
  // Same rule as recentNutrition: an explicit 0 is rejected, not folded into
  // the 7-day default — see asPositiveAmount.
  const n =
    p.days === undefined || p.days === null ? 7 : asPositiveAmount(p.days, "days", 1, 14, true);
  const today = todayISO();
  const dates: string[] = [];
  for (let i = n - 1; i >= 0; i--) dates.push(shiftDate(today, -i));
  return { days: await Promise.all(dates.map(wellbeingFor)) };
}

/**
 * Publish this app's actions (logFood, todayTotals, dayNutrition,
 * recentNutrition, logRecipeMeal, logWorkout) to ConjureOS so the assistant and other apps can call them.
 * Call once at startup; a no-op outside ConjureOS or on a host too old to
 * support registration. Keep the handler set in sync with the `conjureos.actions`
 * block in package.json — that's the schema the host validates against.
 */
export async function registerActions(): Promise<void> {
  const bridge = window.__conjureos?.actions;
  if (!bridge?.register) return; // not inside ConjureOS, or host too old
  await bridge.register({
    logFood,
    todayTotals,
    dayNutrition,
    recentNutrition,
    logRecipeMeal,
    logWorkout,
    logWater,
    logSleep,
    logSymptom,
    logWeight,
    setFoodQuantity,
    deleteEntry,
    dayWellbeing,
    recentWellbeing,
  });
}
