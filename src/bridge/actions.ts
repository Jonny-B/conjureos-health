/**
 * Cross-app actions Conjure Health exposes via ConjureOS's Phase 13a bridge, so the
 * home orchestrator, an assistant, or another app (Recipes, Pantry, a fitness
 * app) can write to / read from the diary. `package.json` → `conjureos.actions`
 * is the contract: the host validates params against it, the AI router reads
 * its descriptions, and the README's table is generated from it.
 *
 *   Food
 *     logFood({ name, calories?, protein?, carbs?, fat?, meal?, date? })   → write
 *     logMeal({ items[], meal?, date? })                                   → write
 *     copyMeal({ meal, fromDate?, toDate?, toMeal? })                      → write
 *     logRecipeMeal({ slug, servings?, meal?, date? })                     → write
 *     updateFoodEntry({ id, meal?, quantity?, name?, calories?, … })       → write
 *     setFoodQuantity({ id, quantity })                                    → write
 *     todayTotals()                                                        → read
 *     dayNutrition({ date? })                                              → read
 *     recentNutrition({ days? })                                           → read
 *     nutritionTargets()                                                   → read
 *     dayEntries({ date? })                                                → read
 *     estimateNutrition({ text | ingredients, servings? })                 → read (AI)
 *     findFood({ barcode | query, limit? })                                → read (network)
 *   Exercise
 *     logWorkout({ calories, type?, durationMin?, date?, externalId?, sourceApp? }) → write
 *     dayExercise({ date? })                                               → read
 *   Wellbeing
 *     logWater({ ml? | oz?, date? })                                       → write
 *     logSleep({ bedTime, wakeTime, wakeDate?, quality? })                 → write
 *     logSymptom({ label, severity?, note?, date? })                       → write
 *     logWeight({ kg? | lb?, date? })                                      → write
 *     dayWellbeing({ date? })                                              → read
 *     recentWellbeing({ days? })                                           → read
 *     weightTrend({ days? })                                               → read
 *   Corrections
 *     deleteEntry({ kind, id })                                            → write
 *
 * Every read returns `value`, one line that answers the question in the
 * user's units: Ask ConjureOS shows a result only through that field, so a
 * read without it answered "how many calories do I have left?" with nothing.
 *
 * Deliberately NOT exposed, and not an oversight:
 *
 *   - Granting AI-journal consent. An agent cannot agree to a health-data
 *     disclosure on the user's behalf; the record only means anything because
 *     a person read the disclosure and said yes (features/aiConsent.ts).
 *   - Running the journal pattern-finder or the coach. That call IS the
 *     disclosure, and it is defensible because a human pressed a button.
 *   - Bulk clears (clearDiary / clearAllHistories / …). Irreversible, and no
 *     caller need outweighs an agent wiping months of health data by mistake.
 *     `deleteEntry` removes exactly one record, by id.
 *   - Goals / profile / plan writes. Changing a calorie target silently
 *     re-bases every number in the app and the user may never notice.
 *   - Why a user has no calorie target. Reads say `tracksCalories: false` and
 *     carry no target; the plan mode behind it (the safety gate: under 18,
 *     pregnant, a heart condition) never leaves the app.
 *   - Symptom and sleep NOTES on read. Labels, severity and time go out; the
 *     free text stays on device, the same rule the AI summary follows.
 *
 * Who can call: ConjureOS asks the user before another app's call runs —
 * reads included — unless they chose "Always allow" for that app; its own
 * assistant runs them without asking. Params still come from other, untrusted
 * apps (and, until conjureos-bridge#1 is fixed, any open app can post straight
 * to these handlers without that prompt), so every field is type-checked,
 * length-capped and range-clamped here, and writes stay narrow: one record, or
 * one meal, per call. A write that finds nothing to change says so rather than
 * reporting success.
 */

import type { FoodItem, Macros, MealType, Profile, WorkoutSession } from "../types";
import { MEAL_LABELS, MEAL_TYPES } from "../types";
import { getRepository, type Repository } from "../data/repository";
import { parseMealDetailed } from "../features/naturalLanguage";
import { buildDayView, isAiEstimate, shiftDate, todayISO } from "../features/diary";
import {
  buildSleepEntry,
  formatSleep,
  isImplausible,
  parseClock,
  sleepMinutes,
} from "../features/sleep";
import { DEFAULT_WATER_TARGET_ML, flOzToMl, fmtWater } from "../features/water";
import { fmtWeight, lbToKg } from "../features/units";
import { getRecipe, markCooked, RecipesAppClosedError, type ListedRecipe } from "./recipeBridge";
import {
  exerciseCaloriesForDate,
  listCompletedWorkouts,
  originOfSession,
  weekExerciseProgress,
  type WorkoutOrigin,
} from "../features/exercise";
import { daySnapshot, effectiveTargets, recentSnapshots } from "../features/dataApi";
import { lookupBarcode, searchFoods } from "../features/foods/foodSearch";
import { notifyDataChanged } from "../features/dataEvents";
import { coerceFinite, toIntInRange } from "../features/num";
import { aiErrorMessage } from "./ai";
import { newId } from "../data/id";

type Units = Profile["units"];

// ── Param validation ──────────────────────────────────────────────────

function asObject(v: unknown, field = "params"): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${field} must be an object`);
  return v as Record<string, unknown>;
}
function asString(v: unknown, field: string, max: number): string {
  if (typeof v !== "string") throw new Error(`params.${field} must be a string`);
  // Control characters (a newline or tab in a multi-line note) become a space,
  // not nothing, or "2 eggs\n1 toast" reads "2 eggs1 toast". Clean first, so a
  // value of only control characters is refused as empty.
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\x00-\x1F\x7F]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (!t) throw new Error(`params.${field} cannot be empty`);
  if (t.length > max) throw new Error(`params.${field} exceeds ${max} chars`);
  return t;
}
function optString(v: unknown, field: string, max: number): string | undefined {
  return v === undefined || v === null ? undefined : asString(v, field, max);
}
/**
 * A whole, non-negative amount. `""`, `false` and `[]` are refused rather
 * than read as 0 (see features/num): a caller that sent an empty calorie field
 * said nothing, which is not the same as saying "zero".
 */
function asNonNegInt(v: unknown, field: string, max: number, dflt = 0): number {
  if (v === undefined || v === null) return dflt;
  const n = coerceFinite(v);
  if (n === null || n < 0) throw new Error(`params.${field} must be a non-negative number`);
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
  const n = coerceFinite(v);
  if (n === null || n <= 0) throw new Error(`params.${field} must be a positive number`);
  const clamped = Math.min(max, Math.max(min, n));
  return integer ? Math.round(clamped) : clamped;
}

/** A servings multiplier, stored to 2dp — see setFoodQuantity. */
function asQuantity(v: unknown, field = "quantity"): number {
  // Round-then-clamp, not clamp-then-round: rounding a sub-minimum quantity
  // like 0.004 to 2dp BEFORE re-checking the bound used to store a bare 0
  // (below the schema's 0.01 minimum) even though the raw value passed the
  // `> 0` check. asPositiveAmount clamps into [0.01, 50] first, so the value
  // that gets rounded is never smaller than the minimum in the first place.
  return Math.round(asPositiveAmount(v, field, 0.01, 50) * 100) / 100;
}

/** An optional meal, defaulting by time of day. */
function asMeal(v: unknown): MealType {
  if (typeof v === "string" && (MEAL_TYPES as string[]).includes(v)) return v as MealType;
  // Default by time of day if unspecified.
  const h = new Date().getHours();
  return h < 11 ? "breakfast" : h < 15 ? "lunch" : h < 21 ? "dinner" : "snacks";
}
/** A meal the caller must name — no time-of-day guess. */
function asMealStrict(v: unknown, field: string): MealType {
  if (typeof v === "string" && (MEAL_TYPES as string[]).includes(v)) return v as MealType;
  throw new Error(`params.${field} must be one of: ${MEAL_TYPES.join(", ")}`);
}
function asDate(v: unknown, field = "date"): string {
  if (v === undefined || v === null) return todayISO();
  const s = asString(v, field, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`params.${field} must be YYYY-MM-DD`);
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
    throw new Error(`params.${field} must be a real calendar date (YYYY-MM-DD)`);
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
  const n = coerceFinite(isMetric ? m : i);
  if (n === null || n <= 0) {
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

/** Per-serving calories + macros from a caller; calories required, macros 0
 *  when absent. `prefix` names the field in errors ("items[2].calories"). */
function asMacros(o: Record<string, unknown>, prefix = ""): Macros {
  if (o.calories === undefined || o.calories === null) {
    throw new Error(`params.${prefix}calories is required`);
  }
  return {
    calories: asNonNegInt(o.calories, `${prefix}calories`, 5000),
    protein: asNonNegInt(o.protein, `${prefix}protein`, 500),
    carbs: asNonNegInt(o.carbs, `${prefix}carbs`, 800),
    fat: asNonNegInt(o.fat, `${prefix}fat`, 500),
  };
}

/**
 * Per-serving macros from a recipe provider's `nutrition`, or null when there
 * is nothing usable: not an object, or no valid calories. Missing or invalid
 * macros become 0 and every field is clamped to asMacros's caps, so a sloppy
 * provider can't put NaN or a huge number into the diary.
 */
function recipeMacros(n: unknown): Macros | null {
  if (!n || typeof n !== "object") return null;
  const o = n as Record<string, unknown>;
  // A negative calorie count is nonsense, not "0": treat it as no nutrition.
  const cals = coerceFinite(o.calories);
  if (cals === null || cals < 0) return null;
  return {
    calories: toIntInRange(cals, 0, 5000)!,
    protein: toIntInRange(o.protein, 0, 500) ?? 0,
    carbs: toIntInRange(o.carbs, 0, 800) ?? 0,
    fat: toIntInRange(o.fat, 0, 500) ?? 0,
  };
}

// ── Answer lines ──────────────────────────────────────────────────────
// `value` is read by a person (Ask ConjureOS prints it after the summary),
// so it is words, rounded the way the app shows them, in the user's units.

const cal = (n: number): string => `${Math.round(n).toLocaleString()} cal`;

function listing(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "today", "yesterday", or the date itself. */
function dayWord(date: string): string {
  const today = todayISO();
  if (date === today) return "today";
  if (date === shiftDate(today, -1)) return "yesterday";
  return `on ${date}`;
}

/** The user's display units; metric when unknown. */
async function unitsPref(repo: Repository): Promise<Units> {
  try {
    return (await repo.getProfile())?.units === "imperial" ? "imperial" : "metric";
  } catch {
    return "metric";
  }
}

/** HH:MM local for an ISO timestamp, or undefined when it doesn't parse. */
function clockOf(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return undefined;
  return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
}

/** `{ time }` for a record with a readable timestamp, else nothing. */
function timed(iso: string | undefined): { time?: string } {
  const time = clockOf(iso);
  return time ? { time } : {};
}

/** Macros for an amount of a per-serving food, rounded the way the diary shows them. */
function scaled(per: Macros, quantity: number): Macros {
  return {
    calories: Math.round(per.calories * quantity),
    protein: Math.round(per.protein * quantity),
    carbs: Math.round(per.carbs * quantity),
    fat: Math.round(per.fat * quantity),
  };
}

// ── AI estimates ──────────────────────────────────────────────────────

/**
 * Why an estimate couldn't be made, in words a caller can pass on. The host
 * pauses AI for an app that isn't on screen — which is exactly the case when
 * another app calls while Conjure Health is closed and ConjureOS starts it
 * hidden — so that one gets a sentence naming this app instead of the in-app
 * "bring it to the front".
 */
function estimateFailure(err: unknown): string {
  const raw = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  if (raw.includes("background") || raw.includes("minimized")) {
    return "Conjure Health can only estimate while it's open on screen, because ConjureOS pauses AI for apps in the background. Open Conjure Health and try again.";
  }
  return aiErrorMessage(err, "The AI didn't answer.");
}

/**
 * Estimate the foods in a description, or throw a readable reason. Never
 * returns an empty list: logging "0 cal" for a meal the estimator couldn't
 * read used to look like a real entry in the diary and quietly understated
 * the day, and a caller was told it worked. Nor a partial one: if the
 * estimator dropped any item it was given, that throws too. `label` is how errors name what
 * was asked about; `retryHint` is appended to them.
 */
async function estimateFoods(text: string, label: string, retryHint = ""): Promise<FoodItem[]> {
  let items: FoodItem[];
  let dropped: number;
  try {
    ({ items, dropped } = await parseMealDetailed({ text }));
  } catch (err) {
    throw new Error(`Couldn't estimate ${label}. ${estimateFailure(err)}${retryHint}`);
  }
  if (items.length === 0) {
    throw new Error(`Couldn't estimate the calories in ${label}.${retryHint}`);
  }
  // A short list is not the meal that was described: the caller would log or
  // report only part of it, with nothing to say so.
  if (dropped > 0) {
    throw new Error(`Couldn't read part of ${label}. Try again.${retryHint}`);
  }
  return items;
}

// ── Food: writes ──────────────────────────────────────────────────────

interface LoggedFood extends Macros {
  id: string;
  name: string;
}

async function logFood(raw?: unknown): Promise<{
  id: string;
  ids: string[];
  foods: LoggedFood[];
  calories: number;
  estimated: boolean;
  value: string;
}> {
  const p = asObject(raw);
  const name = asString(p.name, "name", 80);
  const meal = asMeal(p.meal);
  const date = asDate(p.date);

  // Calories are optional. When a caller names food without numbers ("a
  // chicken sandwich and a beer"), estimate it with the same estimator the
  // AI tab uses, which splits a combo into one item per food — and every item
  // is logged, not just the first. An explicit 0 (black coffee) is respected;
  // only an absent value estimates.
  let foods: FoodItem[];
  const estimated = p.calories === undefined || p.calories === null;
  if (estimated) {
    foods = await estimateFoods(name, `"${name}"`, " Or pass calories to log it with your own numbers.");
    // One food: keep the words the user used for it rather than the model's
    // rewording of them.
    if (foods.length === 1 && foods[0]) foods = [{ ...foods[0], name }];
  } else {
    foods = [
      { id: newId(), source: "custom", name, perServing: asMacros(p), servingSize: "1 serving" },
    ];
  }

  const repo = await getRepository();
  const logged: LoggedFood[] = [];
  for (const food of foods) {
    // `provenance.sourceTag: "ai_estimate"` rides on every estimated item, so
    // the diary badges it as a guess the user may want to correct.
    const entry = await repo.addDiaryEntry({ date, meal, quantity: 1, food });
    logged.push({ id: entry.id, name: food.name, ...food.perServing });
  }
  notifyDataChanged();

  const total = logged.reduce((n, f) => n + f.calories, 0);
  const each = logged.map((f) => `${f.name} (${cal(f.calories)})`);
  return {
    id: logged[0]!.id,
    ids: logged.map((f) => f.id),
    foods: logged,
    calories: total,
    estimated,
    value:
      `${listing(each)} to ${MEAL_LABELS[meal].toLowerCase()}` +
      (logged.length > 1 ? `, ${cal(total)} in all` : "") +
      (estimated ? " (AI estimate)" : ""),
  };
}

const MAX_MEAL_ITEMS = 20;

/**
 * Log several foods to one meal in one call — a planned dinner from Pantry, a
 * meal an app composed. Every item carries its own numbers: this never calls
 * the AI (use logFood for a described meal), and it validates every item
 * before writing any, so a bad fifth item doesn't leave four logged.
 */
async function logMeal(raw?: unknown): Promise<{ ids: string[]; calories: number; value: string }> {
  const p = asObject(raw);
  if (!Array.isArray(p.items)) throw new Error("params.items must be an array of foods");
  if (p.items.length === 0) throw new Error("params.items is empty");
  if (p.items.length > MAX_MEAL_ITEMS) {
    throw new Error(`params.items holds at most ${MAX_MEAL_ITEMS} foods per call`);
  }
  const meal = asMeal(p.meal);
  const date = asDate(p.date);

  const planned = p.items.map((it, i) => {
    const o = asObject(it, `params.items[${i}]`);
    const quantity =
      o.servings === undefined || o.servings === null
        ? 1
        : Math.round(asPositiveAmount(o.servings, `items[${i}].servings`, 0.1, 20) * 100) / 100;
    const food: FoodItem = {
      id: newId(),
      source: "custom",
      name: asString(o.name, `items[${i}].name`, 80),
      perServing: asMacros(o, `items[${i}].`),
      servingSize: optString(o.servingSize, `items[${i}].servingSize`, 40) ?? "1 serving",
    };
    return { food, quantity };
  });

  const repo = await getRepository();
  const ids: string[] = [];
  let total = 0;
  for (const { food, quantity } of planned) {
    const entry = await repo.addDiaryEntry({ date, meal, quantity, food });
    ids.push(entry.id);
    total += Math.round(food.perServing.calories * quantity);
  }
  notifyDataChanged();
  return {
    ids,
    calories: total,
    value: `${plural(ids.length, "food")}, ${cal(total)}, to ${MEAL_LABELS[meal].toLowerCase()} ${dayWord(date)}`,
  };
}

/**
 * Copy one meal's foods from one day to another — "same breakfast as
 * yesterday". One call instead of a read and a write, because the home
 * orchestrator runs a single action per request.
 */
async function copyMeal(raw?: unknown): Promise<{
  ids: string[];
  count: number;
  calories: number;
  value: string;
}> {
  const p = asObject(raw);
  const meal = asMealStrict(p.meal, "meal");
  const fromDate =
    p.fromDate === undefined || p.fromDate === null
      ? shiftDate(todayISO(), -1)
      : asDate(p.fromDate, "fromDate");
  const toDate = asDate(p.toDate, "toDate");
  const toMeal = p.toMeal === undefined || p.toMeal === null ? meal : asMealStrict(p.toMeal, "toMeal");
  if (fromDate === toDate && meal === toMeal) {
    throw new Error("that would log the same meal twice on the same day; pass a different toDate or toMeal");
  }

  const repo = await getRepository();
  const source = (await repo.listDiary(fromDate)).filter((e) => e.meal === meal);
  if (source.length === 0) {
    throw new Error(`nothing was logged for ${MEAL_LABELS[meal].toLowerCase()} ${dayWord(fromDate)}`);
  }
  const ids: string[] = [];
  let total = 0;
  for (const e of source) {
    const entry = await repo.addDiaryEntry({
      date: toDate,
      meal: toMeal,
      quantity: e.quantity,
      food: e.food,
      ...(e.excludeFromQuickAdd ? { excludeFromQuickAdd: true } : {}),
    });
    ids.push(entry.id);
    total += Math.round(e.food.perServing.calories * e.quantity);
  }
  notifyDataChanged();
  return {
    ids,
    count: ids.length,
    calories: total,
    value: `Copied ${plural(ids.length, "food")} (${cal(total)}) from ${MEAL_LABELS[meal].toLowerCase()} ${dayWord(fromDate)} to ${MEAL_LABELS[toMeal].toLowerCase()} ${dayWord(toDate)}`,
  };
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
  // Another app's numbers: validate and clamp them like logFood's own, instead
  // of trusting a provider that may send partial, stringly or absurd values.
  const perServing = recipeMacros(recipe.nutrition);
  if (!perServing) throw new Error(`recipe not found or has no nutrition: ${slug}`);
  const repo = await getRepository();
  const entry = await repo.addDiaryEntry({
    date,
    meal,
    quantity: servings,
    food: {
      id: slug,
      source: "recipe",
      name: recipe.title,
      perServing,
      servingSize: "1 serving",
    },
  });
  notifyDataChanged();
  // Best-effort: confirm the recipe was cooked (non-fatal if the grant is denied).
  await markCooked(slug);
  return { id: entry.id, logged: true };
}

/** The error for an id that matches nothing, pointing at where ids come from. */
function notFound(kind: string, id: string): Error {
  return new Error(
    kind === "weight"
      ? `no weight is recorded on ${id}`
      : `there is no ${kind} entry with id ${id}; dayEntries lists a day's entries with their ids`,
  );
}

async function setFoodQuantity(raw?: unknown): Promise<{ id: string; quantity: number; calories: number }> {
  const p = asObject(raw);
  const id = asId(p.id);
  const quantity = asQuantity(p.quantity);
  const repo = await getRepository();
  const entry = await repo.getDiaryEntry(id);
  if (!entry) throw notFound("food", id);
  await repo.updateDiaryEntry(id, { quantity });
  notifyDataChanged();
  return { id, quantity, calories: Math.round(entry.food.perServing.calories * quantity) };
}

/**
 * Correct a logged food: move it to another meal, change the amount, rename
 * it, or fix its per-serving numbers. The numbers the caller gives replace an
 * AI estimate, so that entry stops being badged as a guess.
 */
async function updateFoodEntry(raw?: unknown): Promise<{
  id: string;
  meal: MealType;
  quantity: number;
  calories: number;
  value: string;
}> {
  const p = asObject(raw);
  const id = asId(p.id);
  const repo = await getRepository();
  const entry = await repo.getDiaryEntry(id);
  if (!entry) throw notFound("food", id);

  const patch: { meal?: MealType; quantity?: number; food?: FoodItem } = {};
  if (p.meal !== undefined && p.meal !== null) patch.meal = asMealStrict(p.meal, "meal");
  if (p.quantity !== undefined && p.quantity !== null) patch.quantity = asQuantity(p.quantity);
  const numberFields = (["calories", "protein", "carbs", "fat"] as const).filter(
    (k) => p[k] !== undefined && p[k] !== null,
  );
  const rename = optString(p.name, "name", 80);
  if (numberFields.length > 0 || rename) {
    const perServing = { ...entry.food.perServing };
    const caps = { calories: 5000, protein: 500, carbs: 800, fat: 500 };
    for (const k of numberFields) perServing[k] = asNonNegInt(p[k], k, caps[k]);
    const food: FoodItem = { ...entry.food, perServing, ...(rename ? { name: rename } : {}) };
    if (numberFields.length > 0 && isAiEstimate(entry)) delete food.provenance;
    patch.food = food;
  }
  if (Object.keys(patch).length === 0) {
    throw new Error("nothing to change: pass meal, quantity, name, calories, protein, carbs or fat");
  }
  await repo.updateDiaryEntry(id, patch);
  notifyDataChanged();

  const food = patch.food ?? entry.food;
  const meal = patch.meal ?? entry.meal;
  const quantity = patch.quantity ?? entry.quantity;
  const calories = Math.round(food.perServing.calories * quantity);
  return {
    id,
    meal,
    quantity,
    calories,
    value: `${food.name}: ${quantity !== 1 ? `${quantity}× ` : ""}${cal(calories)} at ${MEAL_LABELS[meal].toLowerCase()}`,
  };
}

// ── Food: reads ───────────────────────────────────────────────────────

async function todayTotals(): Promise<{
  date: string;
  tracksCalories: boolean;
  total: Macros;
  goals?: Macros;
  exerciseCalories: number;
  caloriesRemaining?: number;
  value: string;
}> {
  const repo = await getRepository();
  const date = todayISO();
  const [entries, target, exerciseCalories] = await Promise.all([
    repo.listDiary(date),
    effectiveTargets(),
    exerciseCaloriesForDate(date),
  ]);
  const { total } = buildDayView(date, entries);
  const goals = target.targets;
  if (!goals) {
    return {
      date,
      tracksCalories: false,
      total,
      exerciseCalories,
      value: `${cal(total.calories)} eaten today`,
    };
  }
  // Exercise calories add back to the day's allowance.
  const caloriesRemaining = goals.calories - total.calories + exerciseCalories;
  return {
    date,
    tracksCalories: true,
    total,
    goals,
    exerciseCalories,
    caloriesRemaining,
    value:
      `${cal(Math.abs(caloriesRemaining))} ${caloriesRemaining >= 0 ? "left" : "over"} today ` +
      `(${cal(total.calories)} eaten of ${cal(goals.calories)}` +
      (exerciseCalories > 0 ? `, plus ${cal(exerciseCalories)} from exercise` : "") +
      ")",
  };
}

/**
 * What the user has eaten on a date, with what's left of their targets.
 *
 * The read another app actually wants: a recipe app suggesting dinner needs
 * the gap, not just the totals. Nutrition only — sleep, symptoms and weight
 * have their own reads (dayWellbeing, weightTrend), so a caller and the
 * permission prompt the user sees name exactly the slice being asked for.
 */
async function dayNutrition(raw?: unknown): Promise<{
  date: string;
  tracksCalories: boolean;
  targets?: Macros;
  consumed: Macros;
  remaining?: Macros;
  exerciseCalories: number;
  foods: {
    id: string;
    name: string;
    meal: MealType;
    quantity: number;
    servingSize: string;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    estimated: boolean;
  }[];
  moreFoods: number;
  value: string;
}> {
  const p = asObject(raw ?? {});
  const date = asDate(p.date);
  const s = await daySnapshot(date);
  const foods = s.foods.map((f) => ({
    id: f.id,
    name: f.name,
    meal: f.meal,
    quantity: f.quantity,
    servingSize: f.servingSize,
    calories: f.calories,
    protein: f.protein,
    carbs: f.carbs,
    fat: f.fat,
    estimated: f.estimated,
  }));
  const base = {
    date: s.date,
    tracksCalories: s.tracksCalories,
    consumed: s.consumed,
    exerciseCalories: s.exerciseCalories,
    foods,
    moreFoods: s.moreFoods,
  };
  if (!s.targets || !s.remaining) {
    return { ...base, value: `${cal(s.consumed.calories)} eaten ${dayWord(date)}` };
  }
  const left = s.remaining.calories;
  return {
    ...base,
    targets: s.targets,
    remaining: s.remaining,
    value:
      `${cal(s.consumed.calories)} eaten ${dayWord(date)}, ` +
      `${cal(Math.abs(left))} ${left >= 0 ? "left" : "over"}; ` +
      `${s.consumed.protein} g of ${s.targets.protein} g protein`,
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
  value: string;
}> {
  const p = asObject(raw ?? {});
  // An explicit 0 is rejected, not silently turned into the 7-day default —
  // see asPositiveAmount.
  const days =
    p.days === undefined || p.days === null ? 7 : asPositiveAmount(p.days, "days", 1, 14, true);
  const snaps = await recentSnapshots(days);
  const out = snaps.map((s) => ({
    date: s.date,
    consumed: s.consumed,
    exerciseCalories: s.exerciseCalories,
  }));
  const logged = out.filter((d) => d.consumed.calories > 0);
  const avg = (k: keyof Macros) =>
    logged.length ? logged.reduce((n, d) => n + d.consumed[k], 0) / logged.length : 0;
  return {
    days: out,
    value: logged.length
      ? `${cal(avg("calories"))} and ${Math.round(avg("protein"))} g protein a day on average, ` +
        `over the ${plural(logged.length, "day")} with food logged in the last ${plural(days, "day")}`
      : `Nothing logged in the last ${plural(days, "day")}`,
  };
}

/**
 * The targets the user works to and how they read amounts: what an app needs
 * before it suggests a meal or shows a weight. `tracksCalories: false` means
 * no calorie target at all — suggest nothing against one.
 */
async function nutritionTargets(): Promise<{
  tracksCalories: boolean;
  targets?: Macros;
  units: Units;
  waterGoalMl: number;
  weeklyMovement?: { targetDays: number; daysThisWeek: number };
  value: string;
}> {
  const repo = await getRepository();
  const [target, units, plan] = await Promise.all([
    effectiveTargets(),
    unitsPref(repo),
    repo.getPlan().catch(() => null),
  ]);
  const movementDays = plan?.weeklyExerciseDays ?? 0;
  const weeklyMovement =
    movementDays > 0
      ? {
          targetDays: movementDays,
          daysThisWeek: (await weekExerciseProgress(movementDays).catch(() => ({ days: 0 }))).days,
        }
      : undefined;
  const t = target.targets;
  const parts = [
    t
      ? `${cal(t.calories)} a day: ${t.protein} g protein, ${t.carbs} g carbs, ${t.fat} g fat`
      : "No calorie target",
    `water ${fmtWater(DEFAULT_WATER_TARGET_ML, units)}`,
  ];
  if (weeklyMovement) {
    parts.push(`moving ${weeklyMovement.daysThisWeek} of ${weeklyMovement.targetDays} days this week`);
  }
  return {
    tracksCalories: target.tracksCalories,
    ...(t ? { targets: t } : {}),
    units,
    waterGoalMl: DEFAULT_WATER_TARGET_ML,
    ...(weeklyMovement ? { weeklyMovement } : {}),
    value: parts.join("; "),
  };
}

/** One record in `dayEntries`. `kind` + `id` are exactly what deleteEntry takes. */
interface DayEntry {
  kind: "food" | "water" | "sleep" | "symptom" | "weight" | "workout";
  id: string;
  label: string;
  /** HH:MM local, when the record has a time. */
  time?: string;
  meal?: MealType;
  quantity?: number;
  servingSize?: string;
  calories?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  estimated?: boolean;
  ml?: number;
  minutes?: number;
  quality?: number;
  severity?: number;
  weightKg?: number;
  durationMin?: number;
  origin?: WorkoutOrigin;
  deletable?: boolean;
}

/**
 * Every record the app holds for a day, with its id: the read that makes
 * setFoodQuantity, updateFoodEntry and deleteEntry usable by anyone who
 * didn't log the record themselves. Workouts here are the entries stored in
 * this app; ones read live from a wearable are in dayExercise. Symptom and
 * sleep notes are never included.
 */
async function dayEntries(raw?: unknown): Promise<{ date: string; entries: DayEntry[]; value: string }> {
  const p = asObject(raw ?? {});
  const date = asDate(p.date);
  const repo = await getRepository();
  const [food, water, sleep, symptoms, weights, sessions] = await Promise.all([
    repo.listDiary(date),
    repo.listWater(date),
    repo.listSleep(date),
    repo.listSymptoms(date),
    repo.listWeights(),
    repo.listWorkoutSessions(),
  ]);

  const entries: DayEntry[] = [];
  for (const e of food) {
    entries.push({
      kind: "food",
      id: e.id,
      label: e.food.name,
      ...timed(e.loggedAt),
      meal: e.meal,
      quantity: e.quantity,
      servingSize: e.food.servingSize,
      ...scaled(e.food.perServing, e.quantity),
      estimated: isAiEstimate(e),
    });
  }
  for (const w of water) {
    entries.push({ kind: "water", id: w.id, label: "Water", ...timed(w.loggedAt), ml: w.ml });
  }
  for (const n of sleep) {
    entries.push({
      kind: "sleep",
      id: n.id,
      label: "Sleep",
      ...timed(n.wakeAt),
      minutes: sleepMinutes(n),
      ...(n.quality !== undefined ? { quality: n.quality } : {}),
    });
  }
  for (const s of symptoms) {
    entries.push({
      kind: "symptom",
      id: s.id,
      label: s.label,
      ...timed(s.loggedAt),
      ...(s.severity !== undefined ? { severity: s.severity } : {}),
    });
  }
  const weight = weights.find((w) => w.date === date);
  if (weight) entries.push({ kind: "weight", id: date, label: "Weight", weightKg: weight.weightKg });
  for (const s of sessions.filter((x) => x.date === date)) {
    const origin = originOfSession(s);
    entries.push({
      kind: "workout",
      id: s.id,
      label: s.workoutName ?? "Workout",
      ...timed(s.completedAt),
      calories: s.caloriesBurned ?? 0,
      ...(s.durationSec ? { durationMin: Math.round(s.durationSec / 60) } : {}),
      origin,
      deletable: origin !== "legacy",
    });
  }
  // Untimed first (weight), then in the order they happened.
  entries.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));

  const count = (k: DayEntry["kind"]) => entries.filter((e) => e.kind === k).length;
  const parts: string[] = [];
  if (count("food")) parts.push(plural(count("food"), "food"));
  if (count("water")) parts.push(plural(count("water"), "drink"));
  if (count("sleep")) parts.push(plural(count("sleep"), "night"));
  if (count("symptom")) parts.push(plural(count("symptom"), "symptom"));
  if (count("weight")) parts.push("a weigh-in");
  if (count("workout")) parts.push(plural(count("workout"), "workout"));
  return {
    date,
    entries,
    value: parts.length ? `${listing(parts)} logged ${dayWord(date)}` : `Nothing logged ${dayWord(date)}`,
  };
}

// ── Food: lookups ─────────────────────────────────────────────────────

/**
 * An estimate of what a meal or a recipe contains, WITHOUT logging it — for a
 * recipe or meal-planning app that wants a number to show (ConjureOS #748
 * asks for one estimator the whole platform shares). Always labelled an
 * estimate, in whole numbers, because it is one. Spends an AI call.
 */
async function estimateNutrition(raw?: unknown): Promise<{
  version: 1;
  items: { name: string; amount: string; calories: number; protein: number; carbs: number; fat: number }[];
  total: Macros;
  servings?: number;
  perServing?: Macros;
  estimated: true;
  value: string;
}> {
  const p = asObject(raw);
  const hasText = p.text !== undefined && p.text !== null;
  const hasIngredients = p.ingredients !== undefined && p.ingredients !== null;
  if (hasText === hasIngredients) {
    throw new Error("pass text (a described meal) OR ingredients (a recipe's ingredient lines), not both");
  }
  let prompt: string;
  if (hasText) {
    prompt = asString(p.text, "text", 300);
  } else {
    if (!Array.isArray(p.ingredients) || p.ingredients.length === 0) {
      throw new Error("params.ingredients must be a non-empty array of ingredient lines");
    }
    // The estimator returns at most 20 items (naturalLanguage MAX_ITEMS), so
    // more lines than that could only ever be under-counted.
    if (p.ingredients.length > 20) throw new Error("params.ingredients holds at most 20 lines");
    const lines = p.ingredients.map((line, i) => asString(line, `ingredients[${i}]`, 120));
    prompt = `The ingredients of one recipe, each with its amount. One item per ingredient:\n${lines.join("\n")}`;
  }
  const servings =
    p.servings === undefined || p.servings === null
      ? undefined
      : Math.round(asPositiveAmount(p.servings, "servings", 0.5, 100) * 10) / 10;

  const foods = await estimateFoods(prompt, hasText ? `"${prompt}"` : "that ingredient list");
  const items = foods.map((f) => ({ name: f.name, amount: f.servingSize, ...f.perServing }));
  const total = items.reduce(
    (t, i) => ({
      calories: t.calories + i.calories,
      protein: t.protein + i.protein,
      carbs: t.carbs + i.carbs,
      fat: t.fat + i.fat,
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
  // "About 620 cal" rather than "617": the estimate isn't that good, and
  // saying so is part of the answer.
  const about = (n: number) => `About ${cal(Math.round(n / 10) * 10)}`;
  if (servings === undefined) {
    return { version: 1, items, total, estimated: true, value: `${about(total.calories)} (AI estimate)` };
  }
  const perServing = scaled(total, 1 / servings);
  return {
    version: 1,
    items,
    total,
    servings,
    perServing,
    estimated: true,
    value: `${about(perServing.calories)} per serving, ${cal(total.calories)} in all (AI estimate)`,
  };
}

/** A food as findFood returns it: per one `servingSize`. */
interface FoundFood extends Macros {
  name: string;
  brand?: string;
  servingSize: string;
  servingGrams?: number;
  source: FoodItem["source"];
  barcode?: string;
}

const SOURCE_NAMES: Record<FoodItem["source"], string> = {
  usda: "USDA",
  openfoodfacts: "Open Food Facts",
  conjure_health: "Conjure Health's food database",
  custom: "the user's own foods",
  recipe: "a recipe",
};

/**
 * Nutrition for a barcode or a search, from the user's own foods, USDA, Open
 * Food Facts and the community food database. Needs the network; searches
 * may be rate-limited when the app has no USDA key.
 */
async function findFood(raw?: unknown): Promise<{ foods: FoundFood[]; value: string }> {
  const p = asObject(raw);
  const hasBarcode = p.barcode !== undefined && p.barcode !== null;
  const hasQuery = p.query !== undefined && p.query !== null;
  if (hasBarcode === hasQuery) throw new Error("pass barcode OR query, not both");

  let found: FoodItem[];
  let asked: string;
  if (hasBarcode) {
    const code = asString(p.barcode, "barcode", 20).replace(/[\s-]/g, "");
    if (!/^\d{6,14}$/.test(code)) throw new Error("params.barcode must be 6 to 14 digits");
    asked = `barcode ${code}`;
    // No scan-attempt log: the user didn't scan anything here.
    const hit = await lookupBarcode(code, undefined, { log: false });
    found = hit ? [hit] : [];
  } else {
    const query = asString(p.query, "query", 80);
    if (query.length < 3) throw new Error("params.query needs at least 3 characters");
    asked = `"${query}"`;
    const limit = p.limit === undefined || p.limit === null ? 5 : asPositiveAmount(p.limit, "limit", 1, 10, true);
    found = await searchFoods(query, limit);
  }
  const foods: FoundFood[] = found.map((f) => ({
    name: f.name,
    ...(f.brand ? { brand: f.brand } : {}),
    servingSize: f.servingSize,
    ...(f.servingGrams ? { servingGrams: f.servingGrams } : {}),
    ...f.perServing,
    source: f.source,
    ...(f.barcode ? { barcode: f.barcode } : {}),
  }));
  const top = foods[0];
  return {
    foods,
    value: top
      ? `${top.brand ? `${top.brand} ` : ""}${top.name}: ${cal(top.calories)} per ${top.servingSize} (from ${SOURCE_NAMES[top.source]})`
      : `No food found for ${asked}`,
  };
}

// ── Exercise ──────────────────────────────────────────────────────────

/**
 * Log a completed workout (from a fitness app, an assistant, the home
 * orchestrator, or a wearable handoff). This is how exercise done elsewhere
 * reaches the calorie ring: `calories` feeds the diary's exercise add-back,
 * and `type` / `durationMin` name the entry and give its length on the
 * Exercise screen.
 *
 * `externalId` makes it idempotent: the same id from the same `sourceApp`
 * replaces the earlier entry instead of adding a second one, so a retry or a
 * re-sync never counts one run twice.
 */
async function logWorkout(raw?: unknown): Promise<{
  id: string;
  caloriesBurned: number;
  replaced: boolean;
  value: string;
}> {
  const p = asObject(raw);
  if (p.calories === undefined || p.calories === null) throw new Error("params.calories is required");
  const calories = asNonNegInt(p.calories, "calories", 10000);
  const type = optString(p.type, "type", 40);
  const minutes = asNonNegInt(p.durationMin, "durationMin", 1440);
  const date = asDate(p.date);
  const externalId = optString(p.externalId, "externalId", 100);
  const sourceApp = optString(p.sourceApp, "sourceApp", 60);

  const repo = await getRepository();
  const earlier = externalId
    ? (await repo.listWorkoutSessions()).find(
        (s) => s.source === "logWorkout" && s.externalId === externalId && (s.sourceApp ?? "") === (sourceApp ?? ""),
      )
    : undefined;
  const name = type ? type.charAt(0).toUpperCase() + type.slice(1) : undefined;
  const session: WorkoutSession = {
    id: earlier?.id ?? newId(),
    date,
    // "running" reads as "Running" in the list.
    ...(name ? { workoutName: name } : {}),
    ...(minutes > 0 ? { durationSec: minutes * 60 } : {}),
    // A back-dated workout sorts within its own day, not at this moment.
    completedAt: date === todayISO() ? new Date().toISOString() : new Date(`${date}T12:00:00`).toISOString(),
    caloriesBurned: calories,
    source: "logWorkout",
    ...(externalId ? { externalId } : {}),
    ...(sourceApp ? { sourceApp } : {}),
  };
  await repo.saveWorkoutSession(session);
  notifyDataChanged();
  return {
    id: session.id,
    caloriesBurned: calories,
    replaced: Boolean(earlier),
    value: `${name ?? "Workout"}, ${cal(calories)} burned ${dayWord(date)}${earlier ? " (updated)" : ""}`,
  };
}

/**
 * The exercise on a day's calorie ring, from every source: added by hand,
 * logged by an app, or read from Apple Health / Health Connect. A fitness app
 * reads this before logging, so a run that also synced from the watch isn't
 * counted twice. `counted: false` is a wearable workout the user took off the
 * ring; `deletable` says whether deleteEntry (kind "workout") can remove it.
 */
async function dayExercise(raw?: unknown): Promise<{
  date: string;
  totalCalories: number;
  workouts: {
    id: string;
    name: string;
    calories: number;
    durationMin?: number;
    origin: WorkoutOrigin;
    sourceLabel: string;
    counted: boolean;
    deletable: boolean;
    externalId?: string;
  }[];
  value: string;
}> {
  const p = asObject(raw ?? {});
  const date = asDate(p.date);
  const items = await listCompletedWorkouts(date);
  const workouts = items.map((w) => ({
    id: w.key,
    name: w.name,
    calories: w.kcal,
    ...(w.durationSec ? { durationMin: Math.round(w.durationSec / 60) } : {}),
    origin: w.origin,
    sourceLabel: w.sourceLabel,
    counted: !w.excluded,
    // Only entries stored here: a linked app's workout (source "linked") is
    // origin "app" too, but lives in that app, so it can only be un-counted.
    deletable: w.source === "app" && (w.origin === "manual" || w.origin === "app"),
    ...(w.externalId ? { externalId: w.externalId } : {}),
  }));
  const counted = workouts.filter((w) => w.counted);
  const totalCalories = counted.reduce((n, w) => n + w.calories, 0);
  return {
    date,
    totalCalories,
    workouts,
    value: counted.length
      ? `${cal(totalCalories)} from exercise ${dayWord(date)}: ${listing(counted.map((w) => w.name))}`
      : `No exercise ${dayWord(date)}`,
  };
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
  notifyDataChanged();
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
  const wakeDate = asDate(p.wakeDate, "wakeDate");
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
  // One night per wake date: the Diary card shows only the first, while the
  // journal and day totals sum every entry. A second call for the same night
  // (a retry, or a correction of the one logged in the app) replaces it, and
  // any extra rows already stored for that date go.
  const [existing, ...extra] = await repo.listSleep(entry.date);
  if (existing) {
    entry.id = existing.id;
    if (entry.quality === undefined && existing.quality !== undefined) entry.quality = existing.quality;
    if (existing.note) entry.note = existing.note;
  }
  await repo.saveSleep(entry);
  for (const e of extra) await repo.removeSleep(e.id);
  notifyDataChanged();
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
  const note = optString(p.note, "note", 200);
  const repo = await getRepository();
  const entry = await repo.addSymptom({
    date,
    loggedAt: new Date().toISOString(),
    label,
    ...(severity !== undefined ? { severity } : {}),
    ...(note !== undefined ? { note } : {}),
  });
  notifyDataChanged();
  return { id: entry.id };
}

async function logWeight(raw?: unknown): Promise<{ date: string; weightKg: number }> {
  const p = asObject(raw ?? {});
  // 2dp, like the weight card: at 1dp a pound entry doesn't survive the trip
  // (180.2 lb stored as 81.7 kg reads back as 180.1 lb).
  const weightKg = Math.round(asMetricAmount(p, "kg", "lb", lbToKg, 500) * 100) / 100;
  const date = asDate(p.date);
  // A weigh-in is a measurement of now. Stored under a future date it sorts
  // first and the weight card and plan wizard would read it as current.
  if (date > todayISO()) throw new Error("params.date cannot be in the future");
  const repo = await getRepository();
  // One canonical weight per day: this replaces the day's entry rather than
  // appending, matching what the weight card does.
  await repo.upsertWeight({ date, weightKg });
  notifyDataChanged();
  return { date, weightKg };
}

// ── Corrections ───────────────────────────────────────────────────────

/** What `deleteEntry` will remove. One record, by id, per call. */
const DELETABLE = ["food", "water", "sleep", "symptom", "weight", "workout"] as const;
type Deletable = (typeof DELETABLE)[number];

/** Every stored date, for the range reads that take one. */
const ALL_FROM = "0000-01-01";
const ALL_TO = "9999-12-31";

async function deleteEntry(raw?: unknown): Promise<{ deleted: true; kind: Deletable }> {
  const p = asObject(raw);
  const kind = asString(p.kind, "kind", 20);
  if (!(DELETABLE as readonly string[]).includes(kind)) {
    throw new Error(`params.kind must be one of: ${DELETABLE.join(", ")}`);
  }
  // Weight is keyed by date (one per day), everything else by row id.
  const id = kind === "weight" ? asDate(p.id, "id") : asId(p.id);
  const repo = await getRepository();
  // The stores' removes are idempotent no-ops for an unknown id, which made
  // this report "deleted" for records that never existed. Look first.
  let exists: boolean;
  switch (kind as Deletable) {
    case "food":
      exists = (await repo.getDiaryEntry(id)) !== null;
      break;
    case "water":
      exists = (await repo.listWaterRange(ALL_FROM, ALL_TO)).some((w) => w.id === id);
      break;
    case "sleep":
      exists = (await repo.listSleepRange(ALL_FROM, ALL_TO)).some((n) => n.id === id);
      break;
    case "symptom":
      exists = (await repo.listSymptomsRange(ALL_FROM, ALL_TO)).some((s) => s.id === id);
      break;
    case "weight":
      exists = (await repo.listWeights()).some((w) => w.date === id);
      break;
    case "workout": {
      const session = (await repo.listWorkoutSessions()).find((s) => s.id === id);
      exists = session !== undefined;
      // An entry from the old workout player may be the only record of that
      // workout (its sets, its route), so another app can't delete it; the
      // user still can, in the app.
      if (session && originOfSession(session) === "legacy") {
        throw new Error("that workout was recorded by an earlier version of Conjure Health and can only be removed in the app");
      }
      break;
    }
  }
  if (!exists) throw notFound(kind, id);

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
  notifyDataChanged();
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
      const out: WellbeingSymptom = { label: sym.label, at: clockOf(sym.loggedAt) ?? "00:00" };
      if (sym.severity !== undefined) out.severity = sym.severity;
      return out;
    }),
  };
  if (weight) day.weightKg = weight.weightKg;
  return day;
}

function wellbeingLine(d: WellbeingDay, units: Units): string {
  const parts: string[] = [];
  if (d.waterMl > 0) parts.push(`${fmtWater(d.waterMl, units)} of water`);
  if (d.sleepMinutes > 0) parts.push(`slept ${formatSleep(d.sleepMinutes)}`);
  if (d.weightKg !== undefined) parts.push(`weighed ${fmtWeight(d.weightKg, units)}`);
  if (d.symptoms.length) parts.push(listing(d.symptoms.map((s) => s.label.toLowerCase())));
  const when = dayWord(d.date);
  if (parts.length === 0) return `Nothing logged ${when}`;
  return `${when.charAt(0).toUpperCase()}${when.slice(1)}: ${parts.join(", ")}`;
}

async function dayWellbeing(raw?: unknown): Promise<WellbeingDay & { value: string }> {
  const p = asObject(raw ?? {});
  const repo = await getRepository();
  const [day, units] = await Promise.all([wellbeingFor(asDate(p.date)), unitsPref(repo)]);
  return { ...day, value: wellbeingLine(day, units) };
}

async function recentWellbeing(raw?: unknown): Promise<{ days: WellbeingDay[]; value: string }> {
  const p = asObject(raw ?? {});
  // Same rule as recentNutrition: an explicit 0 is rejected, not folded into
  // the 7-day default — see asPositiveAmount.
  const n =
    p.days === undefined || p.days === null ? 7 : asPositiveAmount(p.days, "days", 1, 14, true);
  const today = todayISO();
  const dates: string[] = [];
  for (let i = n - 1; i >= 0; i--) dates.push(shiftDate(today, -i));
  const repo = await getRepository();
  const [days, units] = await Promise.all([Promise.all(dates.map(wellbeingFor)), unitsPref(repo)]);
  const slept = days.filter((d) => d.sleepMinutes > 0);
  const drank = days.filter((d) => d.waterMl > 0);
  const parts: string[] = [];
  if (slept.length) {
    parts.push(`slept ${formatSleep(Math.round(slept.reduce((s, d) => s + d.sleepMinutes, 0) / slept.length))} a night`);
  }
  if (drank.length) {
    parts.push(`drank ${fmtWater(drank.reduce((s, d) => s + d.waterMl, 0) / drank.length, units)} a day`);
  }
  // A total, so it sits outside the "on average" clause.
  const symptomCount = days.reduce((s, d) => s + d.symptoms.length, 0);
  const symptoms = symptomCount ? `${plural(symptomCount, "symptom")} in total` : "";
  return {
    days,
    value:
      parts.length || symptoms
        ? `Over the last ${plural(n, "day")}` +
          (parts.length ? `, on average: ${parts.join(", ")}` : "") +
          (symptoms ? `${parts.length ? "; " : ": "}${symptoms}` : "")
        : `Nothing logged in the last ${plural(n, "day")}`,
  };
}

/**
 * The user's weight over a window: the latest weigh-in, every weigh-in in the
 * window, and the change across it. Reads the weigh-in history only, never the
 * profile's weight (an input to the calorie maths that can lag behind).
 */
async function weightTrend(raw?: unknown): Promise<{
  days: number;
  units: Units;
  latest?: { date: string; weightKg: number };
  entries: { date: string; weightKg: number }[];
  changeKg?: number;
  value: string;
}> {
  const p = asObject(raw ?? {});
  const days =
    p.days === undefined || p.days === null ? 30 : asPositiveAmount(p.days, "days", 1, 365, true);
  const today = todayISO();
  const from = shiftDate(today, -(days - 1));
  const repo = await getRepository();
  const [all, units] = await Promise.all([repo.listWeights(), unitsPref(repo)]);
  const upToToday = all.filter((w) => w.date <= today).sort((a, b) => a.date.localeCompare(b.date));
  const entries = upToToday
    .filter((w) => w.date >= from)
    .map((w) => ({ date: w.date, weightKg: w.weightKg }));
  const last = upToToday[upToToday.length - 1];
  const first = entries[0];
  const newest = entries[entries.length - 1];
  const changeKg =
    entries.length >= 2 && first && newest
      ? Math.round((newest.weightKg - first.weightKg) * 100) / 100
      : undefined;
  let value = "No weight recorded yet";
  if (last) {
    value = `${fmtWeight(last.weightKg, units)} ${dayWord(last.date)}`;
    if (changeKg !== undefined && first) {
      value +=
        changeKg === 0
          ? `, the same as on ${first.date}`
          : `, ${changeKg < 0 ? "down" : "up"} ${fmtWeight(Math.abs(changeKg), units)} since ${first.date}`;
    }
  }
  return {
    days,
    units,
    ...(last ? { latest: { date: last.date, weightKg: last.weightKg } } : {}),
    entries,
    ...(changeKg !== undefined ? { changeKg } : {}),
    value,
  };
}

/**
 * Publish this app's actions to ConjureOS so the assistant and other apps can
 * call them. Call once at startup; a no-op outside ConjureOS or on a host too
 * old to support registration. Keep the handler set in sync with the
 * `conjureos.actions` block in package.json — that's the schema the host
 * validates against, and a test fails when the two disagree.
 */
export async function registerActions(): Promise<void> {
  const bridge = window.__conjureos?.actions;
  if (!bridge?.register) return; // not inside ConjureOS, or host too old
  await bridge.register({
    logFood,
    logMeal,
    copyMeal,
    logRecipeMeal,
    updateFoodEntry,
    setFoodQuantity,
    todayTotals,
    dayNutrition,
    recentNutrition,
    nutritionTargets,
    dayEntries,
    estimateNutrition,
    findFood,
    logWorkout,
    dayExercise,
    logWater,
    logSleep,
    logSymptom,
    logWeight,
    dayWellbeing,
    recentWellbeing,
    weightTrend,
    deleteEntry,
  });
}
