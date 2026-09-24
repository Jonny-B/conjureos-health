/**
 * Open Food Facts provider — barcodes + branded/packaged items.
 *
 * Free, open, CORS-enabled, no key. Two entry points: barcode lookup (the
 * scanner's target) and text search. Both normalize OFF's loose, locale-mixed
 * nutriment fields into our per-serving `FoodItem`.
 *
 * Docs: https://openfoodfacts.github.io/openfoodfacts-server/api/
 */

import type { FoodItem, Macros } from "../../types";
import { SEARCH_TIMEOUT_MS, withTimeout } from "./http";

const BASE = "https://world.openfoodfacts.org";
// Identify ourselves per OFF etiquette so we're not rate-limited as anon.
const UA = "ConjureOS-Fitness/0.1 (https://github.com/Jonny-B/conjureos-fitness)";

// OFF is a global database and returns products labeled in Arabic, CJK,
// Cyrillic, Thai, etc. We want English-region results, so drop any product
// whose name carries letters from a non-Latin script. Checked by code point so
// the source stays pure ASCII. (Greek is intentionally allowed — µ and friends
// show up in otherwise-English labels.)
function hasNonLatinScript(name: string): boolean {
  for (const ch of name) {
    const c = ch.codePointAt(0) ?? 0;
    if (
      (c >= 0x0590 && c <= 0x05ff) || // Hebrew
      (c >= 0x0600 && c <= 0x06ff) || // Arabic
      (c >= 0x0750 && c <= 0x077f) || // Arabic Supplement
      (c >= 0x0900 && c <= 0x097f) || // Devanagari
      (c >= 0x0e00 && c <= 0x0e7f) || // Thai
      (c >= 0x0400 && c <= 0x04ff) || // Cyrillic
      (c >= 0x3040 && c <= 0x30ff) || // Hiragana + Katakana
      (c >= 0x3400 && c <= 0x4dbf) || // CJK Extension A
      (c >= 0x4e00 && c <= 0x9fff) || // CJK Unified
      (c >= 0xac00 && c <= 0xd7af) //    Hangul
    ) {
      return true;
    }
  }
  return false;
}

/** True when a product name reads as English/Latin-script (and has letters). */
function isEnglishName(name: string): boolean {
  if (hasNonLatinScript(name)) return false;
  return /[A-Za-z]/.test(name);
}

interface OffNutriments {
  ["energy-kcal_serving"]?: number;
  ["proteins_serving"]?: number;
  ["carbohydrates_serving"]?: number;
  ["fat_serving"]?: number;
  ["fiber_serving"]?: number;
  ["sugars_serving"]?: number;
  ["sodium_serving"]?: number;
  ["energy-kcal_100g"]?: number;
  ["proteins_100g"]?: number;
  ["carbohydrates_100g"]?: number;
  ["fat_100g"]?: number;
  ["fiber_100g"]?: number;
  ["sugars_100g"]?: number;
  ["sodium_100g"]?: number;
}

interface OffProduct {
  code?: string;
  product_name?: string;
  brands?: string;
  serving_size?: string;
  serving_quantity?: number | string;
  countries_tags?: string[];
  nutriments?: OffNutriments;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Map one OFF product to a FoodItem, preferring per-serving over per-100g. */
function toFoodItem(p: OffProduct): FoodItem | null {
  const name = (p.product_name ?? "").trim();
  if (!name) return null;
  const n = p.nutriments ?? {};
  const hasServing = n["energy-kcal_serving"] !== undefined;

  const perServing: Macros = hasServing
    ? {
        calories: Math.round(num(n["energy-kcal_serving"])),
        protein: Math.round(num(n["proteins_serving"])),
        carbs: Math.round(num(n["carbohydrates_serving"])),
        fat: Math.round(num(n["fat_serving"])),
      }
    : {
        calories: Math.round(num(n["energy-kcal_100g"])),
        protein: Math.round(num(n["proteins_100g"])),
        carbs: Math.round(num(n["carbohydrates_100g"])),
        fat: Math.round(num(n["fat_100g"])),
      };

  const servingGrams =
    typeof p.serving_quantity === "number"
      ? p.serving_quantity
      : typeof p.serving_quantity === "string"
        ? Number(p.serving_quantity) || undefined
        : undefined;

  const servingSize = hasServing
    ? (p.serving_size?.trim() || (servingGrams ? `${servingGrams} g` : "1 serving"))
    : "100 g";

  return {
    id: p.code ?? name,
    source: "openfoodfacts",
    name,
    brand: p.brands?.split(",")[0]?.trim() || undefined,
    barcode: p.code,
    perServing,
    micros: {
      fiber: hasServing ? round1(n["fiber_serving"]) : round1(n["fiber_100g"]),
      sugar: hasServing ? round1(n["sugars_serving"]) : round1(n["sugars_100g"]),
      // OFF reports sodium in grams; we store milligrams.
      sodium: hasServing ? mg(n["sodium_serving"]) : mg(n["sodium_100g"]),
    },
    servingSize,
    servingGrams: hasServing ? servingGrams : 100,
  };
}

const round1 = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10) / 10 : undefined;
const mg = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1000) : undefined;

/** Look up a barcode directly in Open Food Facts. Returns null for a miss,
 *  a non-OK response, or a network failure — never throws. */
export async function lookupBarcode(
  barcode: string,
  signal?: AbortSignal,
): Promise<FoodItem | null> {
  const code = barcode.replace(/\D/g, "");
  if (!code) return null;
  const url = `${BASE}/api/v2/product/${encodeURIComponent(code)}.json`;
  let resp: Response;
  try {
    resp = await fetch(url, { signal, headers: { "User-Agent": UA } });
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  const json = (await resp.json()) as { status?: number; product?: OffProduct };
  if (json.status !== 1 || !json.product) return null;
  return toFoodItem({ ...json.product, code });
}

/** Search Open Food Facts by name. Strong on branded/packaged items, weak on
 *  whole foods (USDA covers those). Returns [] on any failure. */
export async function searchText(
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<FoodItem[]> {
  const q = query.trim();
  if (!q) return [];
  const url = new URL(`${BASE}/cgi/search.pl`);
  url.searchParams.set("search_terms", q);
  url.searchParams.set("search_simple", "1");
  url.searchParams.set("action", "process");
  url.searchParams.set("json", "1");
  // US bias: English labels + United-States country context/filter so we lean
  // toward products a US shopper actually sees. OFF's country data is noisy
  // (many items are tagged with several countries), so this is a soft nudge —
  // USDA carries the primary US signal; see foodSearch.mergeUsFirst.
  url.searchParams.set("lc", "en");
  url.searchParams.set("cc", "us");
  url.searchParams.set("tagtype_0", "countries");
  url.searchParams.set("tag_contains_0", "contains");
  url.searchParams.set("tag_0", "united-states");
  // Sort by scan popularity so common terms ("milk", "bread") surface real,
  // complete products first instead of the arbitrary newest-edited foreign
  // entries the default order returns — most of which we drop below for having
  // no energy or a non-Latin name, which is how "milk" could come back empty.
  url.searchParams.set("sort_by", "unique_scans_n");
  // Over-fetch: many OFF records are incomplete and get filtered out, so ask
  // for more than `limit` to still have enough survivors to fill the list.
  url.searchParams.set("page_size", String(Math.min(limit * 3, 40)));
  url.searchParams.set(
    "fields",
    "code,product_name,brands,serving_size,serving_quantity,countries_tags,nutriments",
  );
  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      signal: withTimeout(signal, SEARCH_TIMEOUT_MS),
      headers: { "User-Agent": UA },
    });
  } catch {
    // Aborted (new keystroke), timed out (OFF's search endpoint is often slow),
    // or offline — all non-fatal: the caller still shows USDA results.
    return [];
  }
  if (!resp.ok) return [];
  const json = (await resp.json()) as { products?: OffProduct[] };
  const out: FoodItem[] = [];
  for (const p of json.products ?? []) {
    const item = toFoodItem(p);
    if (!item) continue;
    // Drop entries with no usable energy (OFF has many incomplete records) and
    // anything not labeled in English/Latin script (no more Arabic, CJK, etc.).
    if (item.perServing.calories <= 0 || !isEnglishName(item.name)) continue;
    // US bias: when a product declares its countries, keep it only if the US is
    // one of them. Products with no country data are kept (US entries often
    // omit the tag) rather than thrown away.
    const countries = p.countries_tags;
    if (countries?.length && !countries.includes("en:united-states")) continue;
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}
