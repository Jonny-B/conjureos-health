/**
 * Unified food lookup across providers.
 *
 *   - Text search fans out to Open Food Facts (branded) AND USDA (whole foods)
 *     in parallel, interleaving results so the list isn't dominated by one
 *     source. Either provider failing is non-fatal: we return what we got,
 *     and name the provider that did not answer so the screen can say so.
 *     Each provider's answer is remembered for ten minutes, and Add food asks
 *     only once the query has settled, because USDA's quota is one key shared
 *     across the platform (conjureos-fitness#70).
 *   - Barcode lookup tries Conjure Health DB FIRST (server-side, which itself
 *     falls through to OFF + backfills our DB on hit), then OFF directly as a
 *     fallback for the DEMO / offline / unconfigured cases. Caches positive
 *     hits to the app's VFS so the same pantry items don't re-roundtrip.
 */

import type { FoodItem } from "../../types";
import { readJson, writeJson } from "../../bridge/vfs";
import * as off from "./openFoodFacts";
import * as usda from "./usda";
import * as conjure from "./conjureHealthDb";
import { searchCustomFoods } from "./customFoods";
import type { SearchProvider } from "./http";

const CACHE_PATH = "food-cache.json";
const CACHE_VERSION = 2 as const;

interface BarcodeCache {
  v: typeof CACHE_VERSION;
  // barcode -> FoodItem, or null when a prior lookup found nothing.
  entries: Record<string, FoodItem | null>;
  /**
   * barcode -> the user's own corrected food, from the "Looks wrong" flow.
   *
   * Kept apart from `entries` and consulted ahead of it because these are the
   * only numbers in the cache the user vouched for personally. They must
   * outlive any provider refresh: today a correction we push to the community
   * DB stops being served (a user_manual row isn't public until promoted) and
   * the next lookup re-backfills the bad upstream figures straight over it. So
   * the local copy is what actually makes a fix stick for the person who made
   * it, whatever the server decides to do with it.
   */
  corrections?: Record<string, FoodItem>;
}

let cache: BarcodeCache | null = null;

async function loadCache(): Promise<BarcodeCache> {
  if (cache) return cache;
  const loaded = await readJson<BarcodeCache>(CACHE_PATH, { v: CACHE_VERSION, entries: {} });
  if (loaded.v !== CACHE_VERSION || typeof loaded.entries !== "object") {
    cache = { v: CACHE_VERSION, entries: {} };
  } else {
    cache = loaded;
  }
  return cache;
}

/**
 * Resolve a barcode to a food across every provider, newest cache first.
 *
 * Order: the VFS cache (including remembered misses, so a repeat scan of an
 * unknown item doesn't re-roundtrip), then the Conjure Health DB, then Open
 * Food Facts directly. Returns null when nobody knows it; never throws.
 *
 * `opts.log: false` skips the scan-attempt record (the barcode, platform and
 * time zone sent to tune provider hit rates). The app's own scanner logs; a
 * lookup another app asked for through `findFood` does not, since the user
 * didn't scan anything.
 */
export async function lookupBarcode(
  barcode: string,
  signal?: AbortSignal,
  opts: { log?: boolean } = {},
): Promise<FoodItem | null> {
  const code = barcode.replace(/\D/g, "");
  if (!code) return null;
  const logScanAttempt: typeof conjure.logScanAttempt =
    opts.log === false ? async () => {} : conjure.logScanAttempt;

  const c = await loadCache();
  const fixed = c.corrections?.[code];
  if (fixed) return fixed;
  if (Object.prototype.hasOwnProperty.call(c.entries, code)) {
    return c.entries[code] ?? null;
  }

  const t0 = performance.now();

  // Step 1: Conjure Health DB (the Edge Function itself checks OFF + backfills on hit).
  const ours = await conjure.lookupBarcode(code, signal);
  if (ours) {
    void logScanAttempt({
      barcode: code,
      resolvedFrom: "our_db",
      durationMs: performance.now() - t0,
    });
    c.entries[code] = ours;
    await writeJson(CACHE_PATH, c);
    return ours;
  }

  // Step 2: OFF direct fallback. Only useful when the Edge Function is unreachable
  // (DEMO mode, network outage); the server side already tried OFF in step 1 when live.
  const offItem = await off.lookupBarcode(code, signal);
  if (offItem) {
    void logScanAttempt({
      barcode: code,
      resolvedFrom: "off",
      durationMs: performance.now() - t0,
    });
    c.entries[code] = offItem;
    await writeJson(CACHE_PATH, c);
    return offItem;
  }

  void logScanAttempt({
    barcode: code,
    resolvedFrom: "miss",
    durationMs: performance.now() - t0,
  });
  c.entries[code] = null;
  await writeJson(CACHE_PATH, c);
  return null;
}

/**
 * Remember the user's correction for a barcode so their next scan of the same
 * item returns the fixed numbers instead of the provider's.
 *
 * This is local and unconditional — separate from `contribute()`, which offers
 * the same correction to everyone else and may be queued for moderation or
 * refused outright. One person fixing their own pantry must not depend on that.
 */
export async function rememberCorrection(barcode: string, food: FoodItem): Promise<void> {
  const code = barcode.replace(/\D/g, "");
  if (!code) return;
  const c = await loadCache();
  c.corrections = { ...(c.corrections ?? {}), [code]: food };
  // Drop any stale provider answer for the same code so there is one truth.
  delete c.entries[code];
  await writeJson(CACHE_PATH, c);
}

/**
 * Weighted merge that front-loads `primary`, taking `pw` from it for every `sw`
 * from `secondary`. Used to bias results toward USDA (a US database) over Open
 * Food Facts' noisy global catalog, while still surfacing OFF's branded items.
 * Leftovers from either list are appended once the other runs dry.
 */
function mergeUsFirst<T>(primary: T[], secondary: T[], pw = 2, sw = 1): T[] {
  const out: T[] = [];
  let i = 0;
  let j = 0;
  while (i < primary.length || j < secondary.length) {
    for (let p = 0; p < pw && i < primary.length; p++) out.push(primary[i++]!);
    for (let s = 0; s < sw && j < secondary.length; s++) out.push(secondary[j++]!);
  }
  return out;
}

/** A text search's answer. */
export interface FoodSearchResult {
  foods: FoodItem[];
  /**
   * Providers that did not answer: offline, timed out, rate-limited or down.
   * Their foods are missing from `foods`, so an empty `foods` is a real "no
   * match" only when this is empty too (conjureos-fitness#70). In a fixed
   * order, USDA first.
   */
  unanswered: SearchProvider[];
}

const PROVIDER_ORDER: SearchProvider[] = ["usda", "openfoodfacts"];

/** How the providers are named to the person. */
export const PROVIDER_NAMES: Record<SearchProvider, string> = {
  usda: "USDA",
  openfoodfacts: "Open Food Facts",
};

/**
 * How long a provider's answer to a text search is reused instead of asked
 * again. USDA is asked through ConjureOS's usda-proxy on one key shared by
 * every Health and Recipes user, at 1000 requests an hour
 * (conjureos-fitness#70), so a query typed again, backspaced to, or asked by
 * the assistant after the screen must not spend it twice.
 */
export const SEARCH_ANSWER_TTL_MS = 10 * 60_000;
const SEARCH_ANSWER_MAX = 100;

/** Answers that came back, by provider, size asked and query. Never a failure. */
const answers = new Map<string, { at: number; foods: FoodItem[] }>();

const answerKey = (provider: SearchProvider, want: number, q: string) =>
  `${provider}|${want}|${q.toLowerCase()}`;

function answerFor(key: string): FoodItem[] | undefined {
  const hit = answers.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > SEARCH_ANSWER_TTL_MS) {
    answers.delete(key);
    return undefined;
  }
  return hit.foods;
}

function rememberAnswer(key: string, foods: FoodItem[]): void {
  answers.delete(key);
  answers.set(key, { at: Date.now(), foods });
  while (answers.size > SEARCH_ANSWER_MAX) {
    const oldest = answers.keys().next().value;
    if (oldest === undefined) break;
    answers.delete(oldest);
  }
}

/** Forget every remembered answer. For tests. */
export function clearSearchAnswers(): void {
  answers.clear();
}

/** Resolves true after `ms`, or false as soon as `signal` aborts. */
function settle(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(ok);
    };
    const onAbort = () => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface SearchFoodsOptions {
  /**
   * Wait this long after the user's own foods are shown before asking the
   * providers, and ask nothing if `signal` aborts in that time. Add food passes
   * it so a query still being typed costs no USDA request; an answer already
   * remembered is shown without waiting.
   */
  settleMs?: number;
}

/**
 * Text search across Open Food Facts (branded) + USDA (whole foods), run in
 * parallel and merged USDA-first to bias toward US results (see mergeUsFirst).
 *
 * `onPartial`, when given, fires with the merged list as each provider lands so
 * the UI can paint the fast provider's hits (USDA is usually sub-second) without
 * waiting on the slow one (OFF's search endpoint often takes seconds). Both
 * requests are individually timed out, so a dead provider can't stall the other.
 *
 * A provider's answer is reused for `SEARCH_ANSWER_TTL_MS`; a provider that did
 * not answer, or a search that was cancelled, is asked again next time.
 *
 * Never throws. A provider that did not answer is named in `unanswered`, never
 * passed off as having found nothing; a search the caller cancelled names
 * nobody, since nobody is waiting for it.
 */
export async function searchFoods(
  query: string,
  limit = 20,
  signal?: AbortSignal,
  onPartial?: (foods: FoodItem[]) => void,
  opts: SearchFoodsOptions = {},
): Promise<FoodSearchResult> {
  const q = query.trim();
  if (q.length < 3) return { foods: [], unanswered: [] };
  // US bias: pull more from USDA (a US database) than OFF, and front-load it in
  // the merge. OFF still contributes branded items USDA lacks.
  const usdaWant = Math.ceil(limit * 0.7);
  const offWant = Math.ceil(limit * 0.5);

  let offResults: FoodItem[] = [];
  let usdaResults: FoodItem[] = [];
  const failed = new Set<SearchProvider>();
  // The user's own foods lead: they are the only numbers the user vouched for.
  let mine: FoodItem[] = [];
  try {
    mine = await searchCustomFoods(q);
  } catch {
    mine = [];
  }
  if (mine.length > 0 && !signal?.aborted) onPartial?.(mine);
  const merged = () => [...mine, ...mergeUsFirst(usdaResults, offResults, 2, 1)].slice(0, limit);

  // One wait shared by both providers, started only if one of them has to be
  // asked.
  let settled: Promise<boolean> | null = null;
  const ask = async (
    provider: SearchProvider,
    want: number,
    run: () => Promise<FoodItem[]>,
    land: (foods: FoodItem[]) => void,
  ): Promise<void> => {
    const key = answerKey(provider, want, q);
    let foods = answerFor(key);
    if (!foods) {
      settled ??= settle(opts.settleMs ?? 0, signal);
      if (!(await settled)) return;
      try {
        foods = await run();
      } catch {
        failed.add(provider);
        return;
      }
      // A cancelled search resolves [] without having asked; never keep that.
      if (signal?.aborted) return;
      rememberAnswer(key, foods);
    }
    land(foods);
    if (!signal?.aborted) onPartial?.(merged());
  };

  await Promise.all([
    ask("openfoodfacts", offWant, () => off.searchText(q, offWant, signal), (r) => (offResults = r)),
    ask("usda", usdaWant, () => usda.searchText(q, usdaWant, signal), (r) => (usdaResults = r)),
  ]);
  return {
    foods: merged(),
    unanswered: signal?.aborted ? [] : PROVIDER_ORDER.filter((p) => failed.has(p)),
  };
}

/**
 * The providers worth naming to the person after a search.
 *
 * With nothing found, every provider that did not answer, since "no matches"
 * would be untrue. Beside a list, only USDA: it supplies most of the list and
 * answers reliably, so its silence (the platform key's hourly quota,
 * conjureos-fitness#70) means foods really are missing. Open Food Facts'
 * search endpoint is often slow or 503s, about one search in three or more, so
 * beside a list its silence is routine and naming it every time would teach
 * people to ignore the note.
 */
export function providersToName(unanswered: SearchProvider[], foundAny: boolean): SearchProvider[] {
  return foundAny ? unanswered.filter((p) => p === "usda") : unanswered;
}

/**
 * What a search says about providers that did not answer, or null when there
 * is nothing worth saying (see `providersToName`). With nothing found it
 * stands in for "No matches", which would be untrue; with foods found it says
 * the list may be short.
 */
export function unansweredNote(unanswered: SearchProvider[], foundAny: boolean): string | null {
  const named = providersToName(unanswered, foundAny);
  if (named.length === 0) return null;
  const names = named.map((p) => PROVIDER_NAMES[p]).join(" and ");
  return foundAny
    ? `${names} did not answer, so some foods may be missing. Try again in a minute.`
    : `${names} did not answer. Try again in a minute, or add it yourself.`;
}
