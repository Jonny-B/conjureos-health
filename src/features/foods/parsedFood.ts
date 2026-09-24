/**
 * The shared middle of the two photo parsers.
 *
 * A nutrition panel and a package front are read with different prompts — one
 * transcribes, the other estimates — but they return the same nutrition and
 * must turn it into the same FoodItem. Keeping two copies of that meant they
 * drifted, and the drift was invisible because each worked on its own: the
 * label path silently dropped alcohol and caffeine, never tagged its output as
 * AI-derived (so a panel read by a vision model was never badged), and until
 * recently did not ask for serving grams at all.
 *
 * So: one field list, one set of limits, one builder. The prompts stay
 * separate; everything downstream of the JSON lives here.
 */

import type { FoodItem, FoodSource } from "../../types";
import { newId } from "../../data/id";
import { parseServingGrams } from "./serving";

/**
 * The nutrition block both prompts ask for, verbatim. Sharing the text is the
 * point: a field added to one prompt and not the other is exactly how the two
 * came apart.
 */
export const NUTRIENT_SCHEMA = `  "name":         string,
  "brand":        string | null,
  "servingSize":  string,          // serving label, e.g. "1 doughnut (43 g)" or "1 cup (240 ml)"
  "servingGrams": number | null,   // grams in ONE serving, only when a weight is stated
  "calories":     number,          // kcal per serving
  "protein":      number,          // grams per serving
  "carbs":        number,          // grams per serving
  "fat":          number,          // grams per serving
  "fiber":        number | null,   // grams per serving
  "sugar":        number | null,   // grams per serving
  "sodium":       number | null,   // milligrams per serving
  "alcohol":      number | null,   // grams per serving
  "caffeine":     number | null,   // milligrams per serving
  "confidence":   number           // 0..1`;

/**
 * Ceilings for one serving. A value past these is not a big portion, it is a
 * misread — a decimal lost, a per-container figure, a column misaligned.
 */
const CORE_MAX = { calories: 5000, protein: 500, carbs: 800, fat: 500 } as const;
const MICRO_MAX = { fiber: 200, sugar: 500, sodium: 50_000, alcohol: 500, caffeine: 10_000 } as const;

/** Longest name we keep. Package names run long; past this it is label prose. */
const NAME_MAX = 120;

export function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function clamp01(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** A number in range, or null. Out of range is null, NOT the nearest bound:
 *  saturating an impossible reading is how a bad upstream figure became a
 *  confident 10,000 calories once already. */
function inRange(v: unknown, max: number): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) return null;
  return Math.round(n * 10) / 10;
}

/** Strip URLs and control characters, cap length. The note originates as text
 *  printed on a package, so it is attacker-controllable. */
export function sanitizeNote(s: string): string {
  if (!s) return "";
  const noUrls = s.replace(/https?:\/\/\S+/gi, "").replace(/www\.\S+/gi, "");
  // eslint-disable-next-line no-control-regex
  return noUrls.replace(/[\x00-\x1f]/g, " ").trim().slice(0, 200);
}

export interface BuildOptions {
  source: FoodSource;
  /** Provenance tag, so the diary can badge how these numbers were obtained. */
  sourceTag: "ai_label" | "ai_front";
  barcode?: string | undefined;
  warningNote?: string | undefined;
}

/**
 * Turn a validated JSON object into a FoodItem, or null when it cannot be
 * trusted. Rejects rather than repairs: a missing name or an impossible
 * calorie figure means the read failed, and the caller tells the user to
 * retake the photo instead of storing a number nobody measured.
 */
export function buildParsedFood(
  o: Record<string, unknown>,
  confidence: number,
  opts: BuildOptions,
): FoodItem | null {
  const name = str(o.name).slice(0, NAME_MAX);
  if (!name) return null;

  const calories = inRange(o.calories, CORE_MAX.calories);
  const protein = inRange(o.protein, CORE_MAX.protein);
  const carbs = inRange(o.carbs, CORE_MAX.carbs);
  const fat = inRange(o.fat, CORE_MAX.fat);
  if (calories === null || protein === null || carbs === null || fat === null) return null;

  const servingSize = str(o.servingSize).slice(0, 60) || "1 serving";

  const food: FoodItem = {
    id: opts.barcode ?? newId(),
    source: opts.source,
    name,
    perServing: { calories, protein, carbs, fat },
    micros: {
      fiber: inRange(o.fiber, MICRO_MAX.fiber) ?? undefined,
      sugar: inRange(o.sugar, MICRO_MAX.sugar) ?? undefined,
      sodium: inRange(o.sodium, MICRO_MAX.sodium) ?? undefined,
      alcoholG: inRange(o.alcohol, MICRO_MAX.alcohol) ?? undefined,
      caffeineMg: inRange(o.caffeine, MICRO_MAX.caffeine) ?? undefined,
    },
    servingSize,
    provenance: {
      sourceTag: opts.sourceTag,
      aiConfidence: confidence,
      ...(opts.warningNote ? { warningNote: opts.warningNote } : {}),
    },
  };

  const brand = str(o.brand).slice(0, NAME_MAX);
  if (brand) food.brand = brand;
  if (opts.barcode) food.barcode = opts.barcode.replace(/\D/g, "");

  // The model's figure first, then the serving label, which nearly always
  // carries the weight in words even when the field comes back empty.
  const grams = inRange(o.servingGrams, 5000) ?? parseServingGrams(servingSize);
  if (grams != null && grams > 0) food.servingGrams = grams;

  return food;
}
