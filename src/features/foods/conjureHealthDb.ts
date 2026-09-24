/**
 * Client SDK for the Conjure Health community food database (health-foods-db
 * Edge Function on the platform Supabase project). Fails OPEN: every call
 * returns null on transport error so the lookup chain in foodSearch.ts can
 * advance to OFF instead of blocking the user.
 *
 * The Edge Function URL is built from VITE_SUPABASE_URL baked at build time
 * (publish-store.yml sets it per dev/prod trigger). In a published build
 * without those vars, FN_URL is empty and every call short-circuits to null,
 * preserving the v0.2.8 standalone behavior.
 */

import type { FoodItem } from "../../types";
import { getAccessToken, getIdentityToken } from "../../bridge/host";

const FN_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)
  ? `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/health-foods-db`
  : "";
const ANON = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? "";
const APP_VERSION =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

interface HealthFoodApi {
  id: string;
  name: string;
  brand: string | null;
  barcode: string | null;
  servingSize: string | null;
  servingGrams: number | null;
  calories: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  fiberG: number | null;
  totalSugarG: number | null;
  addedSugarG: number | null;
  saturatedFatG: number | null;
  transFatG: number | null;
  cholesterolMg: number | null;
  sodiumMg: number | null;
  potassiumMg: number | null;
  calciumMg: number | null;
  ironMg: number | null;
  vitaminAIu: number | null;
  vitaminCMg: number | null;
  vitaminDIu: number | null;
  alcoholG: number | null;
  caffeineMg: number | null;
  ingredientsText: string | null;
  source: string;
  aiConfidence: number | null;
  needsReview: boolean;
  isCanonical: boolean;
  isFlagged: boolean;
  flagCount: number;
  license: string | null;
  attributionText: string | null;
}

/** Actions that WRITE to the community DB — these need a verified identity. On
 *  mobile the raw session token isn't in the WebView, so we mint a first-party
 *  ConjureOS token (which prompts a one-time consent) rather than falling back
 *  to the anon key (which the server rejects). Reads stay anon. */
const WRITE_ACTIONS = new Set(["submit"]);

async function call<T>(
  action: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T | null> {
  if (!FN_URL || !ANON) return null;
  // Prefer the raw session token when the app can read it (desktop). For writes,
  // fall back to a minted identity token (mobile) so a signed-in user can still
  // contribute even though the JWT never enters the WebView there.
  let token = await getAccessToken().catch(() => null);
  if (!token && WRITE_ACTIONS.has(action)) {
    token = await getIdentityToken().catch(() => null);
  }
  try {
    const resp = await fetch(FN_URL, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        apikey: ANON,
        authorization: `Bearer ${token ?? ANON}`,
      },
      body: JSON.stringify({ action, ...payload }),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

function toFoodItem(row: HealthFoodApi): FoodItem {
  const item: FoodItem = {
    id: row.id,
    source: "conjure_health",
    name: row.name,
    perServing: {
      calories: row.calories ?? 0,
      protein: row.proteinG ?? 0,
      carbs: row.carbsG ?? 0,
      fat: row.fatG ?? 0,
    },
    micros: {
      fiber: row.fiberG ?? undefined,
      sugar: row.totalSugarG ?? undefined,
      addedSugar: row.addedSugarG ?? undefined,
      saturatedFat: row.saturatedFatG ?? undefined,
      transFat: row.transFatG ?? undefined,
      cholesterolMg: row.cholesterolMg ?? undefined,
      sodium: row.sodiumMg ?? undefined,
      potassiumMg: row.potassiumMg ?? undefined,
      calciumMg: row.calciumMg ?? undefined,
      ironMg: row.ironMg ?? undefined,
      vitaminAIu: row.vitaminAIu ?? undefined,
      vitaminCMg: row.vitaminCMg ?? undefined,
      vitaminDIu: row.vitaminDIu ?? undefined,
      alcoholG: row.alcoholG ?? undefined,
      caffeineMg: row.caffeineMg ?? undefined,
    },
    servingSize: row.servingSize ?? "1 serving",
    provenance: {
      sourceTag: row.source,
      aiConfidence: row.aiConfidence ?? undefined,
      isCanonical: row.isCanonical,
      license: row.license ?? undefined,
      attributionText: row.attributionText ?? undefined,
    },
  };
  if (row.brand) item.brand = row.brand;
  if (row.barcode) item.barcode = row.barcode;
  if (row.servingGrams != null) item.servingGrams = row.servingGrams;
  return item;
}

/**
 * Look up a barcode in the community food DB. The Edge Function itself falls
 * through to Open Food Facts and backfills our DB on a hit, so a miss here
 * means neither source knew it. Returns null on any failure — callers treat an
 * unreachable DB the same as a miss and continue to the next provider.
 */
export async function lookupBarcode(
  barcode: string,
  signal?: AbortSignal,
): Promise<FoodItem | null> {
  const code = barcode.replace(/\D/g, "");
  if (!code) return null;
  const res = await call<{ source: string; food: HealthFoodApi | null }>(
    "lookup",
    { barcode: code },
    signal,
  );
  if (!res?.food) return null;
  return toFoodItem(res.food);
}

/** Free-text search of the community food DB. Returns [] on any failure. */
export async function searchText(
  query: string,
  limit = 20,
  signal?: AbortSignal,
): Promise<FoodItem[]> {
  const res = await call<{ foods: HealthFoodApi[] }>(
    "search",
    { query, limit },
    signal,
  );
  return (res?.foods ?? []).map(toFoodItem);
}

/** A food being submitted back to the community DB, tagged with how it was
 *  derived and whether the user corrected it before saving. */
export interface ContributePayload {
  food: FoodItem;
  source: "ai_label" | "ai_front" | "user_manual";
  aiConfidence?: number;
  userEdited?: boolean;
}

/** Outcome of a contribution. `acceptedAs` distinguishes a canonical row
 *  from a queued suggestion; `ok: false` means the submit never landed. */
export interface ContributeResult {
  ok: boolean;
  acceptedAs: "row" | "suggestion" | null;
  food: FoodItem | null;
}

function foodItemToPayload(f: FoodItem): Record<string, unknown> {
  const m = f.micros ?? {};
  return {
    name: f.name,
    brand: f.brand ?? null,
    barcode: f.barcode ?? null,
    serving_size: f.servingSize,
    serving_grams: f.servingGrams ?? null,
    calories: f.perServing.calories,
    protein_g: f.perServing.protein,
    carbs_g: f.perServing.carbs,
    fat_g: f.perServing.fat,
    fiber_g: m.fiber ?? null,
    total_sugar_g: m.sugar ?? null,
    added_sugar_g: m.addedSugar ?? null,
    saturated_fat_g: m.saturatedFat ?? null,
    trans_fat_g: m.transFat ?? null,
    cholesterol_mg: m.cholesterolMg ?? null,
    sodium_mg: m.sodium ?? null,
    potassium_mg: m.potassiumMg ?? null,
    calcium_mg: m.calciumMg ?? null,
    iron_mg: m.ironMg ?? null,
    vitamin_a_iu: m.vitaminAIu ?? null,
    vitamin_c_mg: m.vitaminCMg ?? null,
    vitamin_d_iu: m.vitaminDIu ?? null,
    alcohol_g: m.alcoholG ?? null,
    caffeine_mg: m.caffeineMg ?? null,
  };
}

/**
 * Submit a food (usually an AI parse the user reviewed) to the community DB.
 * Best-effort and never throws: contributing is a side benefit, so a failure
 * must not block the user's own diary entry.
 */
export async function contribute(p: ContributePayload): Promise<ContributeResult> {
  const body = {
    food: foodItemToPayload(p.food),
    source: p.source,
    ai_confidence: p.aiConfidence,
    user_edited: p.userEdited ?? false,
  };
  const res = await call<{
    food: HealthFoodApi | null;
    accepted_as: "row" | "suggestion" | null;
  }>("submit", body);
  if (res === null) return { ok: false, acceptedAs: null, food: null };
  return {
    ok: true,
    acceptedAs: res.accepted_as,
    food: res.food ? toFoodItem(res.food) : null,
  };
}

/** Telemetry for one lookup: what was scanned or searched, which provider
 *  ultimately answered, and how long it took. */
export interface ScanAttempt {
  barcode?: string;
  query?: string;
  resolvedFrom: "our_db" | "off" | "usda" | "ai_label" | "ai_front" | "user_manual" | "miss";
  durationMs?: number;
}

/** Record a lookup outcome so provider hit-rates can be tuned. Fire-and-
 *  forget: never throws and is not awaited on the user's critical path. */
export async function logScanAttempt(a: ScanAttempt): Promise<void> {
  await call("logScanAttempt", {
    barcode: a.barcode,
    query_text: a.query,
    resolved_from: a.resolvedFrom,
    duration_ms: a.durationMs,
    app_version: APP_VERSION,
    platform: navigator.platform,
    client_tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
}
