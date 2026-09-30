/**
 * Workouts from a fitness app, so they count on the calorie ring (Phase 45
 * self-describing apps, the `workoutSource` need in package.json).
 *
 * Nothing here names an app. ConjureOS matches the need's shape against every
 * installed app's action `returns` and `actions.discover("workoutSource")`
 * hands back the providers; Conjure Fitness's `listWorkouts` is one, and any
 * other app returning the same shape works the same way. The first call asks
 * the user once (Allow once / Always / Block; a Block degrades to no linked
 * workouts), and a closed provider is started off-screen by ConjureOS to answer.
 *
 * An empty answer is normal (no provider installed, or the user turned off
 * "Allow apps to connect to each other") and degrades to "no linked workouts".
 * So does any failure: the ring must never break because another app did.
 *
 * Costs are kept down two ways, because the ring and the weekly progress card
 * ask one date at a time: a fetch covers the whole Monday-to-Sunday week the
 * date falls in, and answers are cached briefly.
 */

import type { ProviderMatch } from "./recipeBridge";
import { shiftDate } from "../features/diary";

/** The need id declared in package.json's `conjureos.needs`. */
const NEED_ID = "workoutSource";
/** How long a fetched week is reused. */
const CACHE_MS = 60_000;
/** How long a failed fetch is remembered, so a dead provider isn't hammered. */
const FAILURE_CACHE_MS = 15_000;
/** How long "no provider" is remembered before discovering again. */
const NONE_RETRY_MS = 60_000;
/** Covers the one-time cross-app consent dialog and provider start-up. */
const INVOKE_TIMEOUT_MS = 30_000;

/** One workout from a linked app, validated and ready to list. */
export interface LinkedWorkout {
  /** Unique across providers: `linked:<appPath>:<id>`. Used for exclusions. */
  key: string;
  /** The provider's own id for the workout. */
  id: string;
  /** The provider's display name, e.g. "Conjure Fitness". */
  appName: string;
  /** YYYY-MM-DD. */
  date: string;
  name: string;
  caloriesBurned: number;
  durationSec?: number;
  /** Epoch ms, for ordering; 0 when the provider didn't say. */
  completedAtMs: number;
}

function actions() {
  // No window at all in unit tests and other non-browser contexts.
  return typeof window === "undefined" ? undefined : window.__conjureos?.actions;
}

type Resolved = { kind: "found"; match: ProviderMatch } | { kind: "none" };

let resolved: { at: number; value: Promise<Resolved> } | null = null;
const weeks = new Map<string, { at: number; ttl: number; value: Promise<LinkedWorkout[]> }>();

/** Test seam: forget providers and cached weeks. */
export function resetWorkoutSourceCache(): void {
  resolved = null;
  weeks.clear();
}

async function resolveProvider(): Promise<Resolved> {
  const now = Date.now();
  if (resolved && (resolved.at > now - NONE_RETRY_MS || (await resolved.value).kind === "found")) {
    return resolved.value;
  }
  const value = (async (): Promise<Resolved> => {
    const a = actions();
    if (typeof a?.discover !== "function" || typeof a.invoke !== "function") return { kind: "none" };
    try {
      const matches = (await a.discover(NEED_ID)) ?? [];
      const match = matches.find((m) => m.binding === "exact") ?? matches[0];
      return match ? { kind: "found", match } : { kind: "none" };
    } catch {
      return { kind: "none" };
    }
  })();
  resolved = { at: now, value };
  return value;
}

/** Monday-to-Sunday week containing `date`. */
function weekOf(date: string): { from: string; to: string } {
  const d = new Date(`${date}T00:00:00`);
  const back = Number.isNaN(d.getTime()) ? 0 : (d.getDay() + 6) % 7;
  const from = shiftDate(date, -back);
  return { from, to: shiftDate(from, 6) };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One provider item → a LinkedWorkout, or null when it isn't usable. The
 *  provider is another app, so nothing about its output is trusted. */
function toLinked(raw: unknown, match: ProviderMatch): LinkedWorkout | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim().slice(0, 64) : "";
  const date = typeof r.date === "string" ? r.date.trim() : "";
  const kcal = typeof r.caloriesBurned === "number" ? r.caloriesBurned : Number.NaN;
  if (!id || !DATE.test(date) || !Number.isFinite(kcal)) return null;
  // eslint-disable-next-line no-control-regex
  const name = typeof r.name === "string" ? r.name.replace(/[\x00-\x1F\x7F]/g, "").trim().slice(0, 60) : "";
  const minutes = typeof r.durationMin === "number" && Number.isFinite(r.durationMin) ? r.durationMin : 0;
  const at = typeof r.completedAt === "string" ? Date.parse(r.completedAt) : Number.NaN;
  return {
    key: `linked:${match.appPath}:${id}`,
    id,
    appName: match.displayName || "Another app",
    date,
    name: name || "Workout",
    caloriesBurned: Math.min(5000, Math.max(0, Math.round(kcal))),
    ...(minutes > 0 ? { durationSec: Math.round(Math.min(minutes, 1440) * 60) } : {}),
    completedAtMs: Number.isFinite(at) ? at : 0,
  };
}

async function fetchWeek(match: ProviderMatch, from: string, to: string): Promise<LinkedWorkout[]> {
  const a = actions();
  if (!a?.invoke) return [];
  const res = (await a.invoke(
    match.appPath,
    match.action,
    { from, to, limit: 100 },
    { timeoutMs: INVOKE_TIMEOUT_MS, normalize: NEED_ID },
  )) as { workouts?: unknown };
  const items = Array.isArray(res?.workouts) ? res.workouts : [];
  const seen = new Set<string>();
  const out: LinkedWorkout[] = [];
  for (const raw of items) {
    const w = toLinked(raw, match);
    if (!w || seen.has(w.key)) continue;
    seen.add(w.key);
    out.push(w);
  }
  return out;
}

/**
 * Linked-app workouts done on `date`. Never throws; [] when there is no
 * provider or it can't be reached.
 */
export async function linkedWorkoutsForDate(date: string): Promise<LinkedWorkout[]> {
  if (!DATE.test(date)) return [];
  const provider = await resolveProvider();
  if (provider.kind === "none") return [];
  const { from, to } = weekOf(date);
  const key = `${provider.match.appPath}|${from}`;
  const now = Date.now();
  let entry = weeks.get(key);
  if (!entry || entry.at + entry.ttl < now) {
    const value = fetchWeek(provider.match, from, to);
    entry = { at: now, ttl: CACHE_MS, value };
    weeks.set(key, entry);
    const mine = entry;
    // A failure is cached briefly as "nothing", then retried.
    // TIMEOUT errors are not cached, so the next read retries.
    value.catch((e) => {
      const isTimeout = e?.code === "TIMEOUT" || (typeof e?.message === "string" && /timed? ?out/i.test(e.message));
      if (isTimeout) {
        // Remove from cache so the next read retries (only our own entry)
        if (weeks.get(key) === mine) weeks.delete(key);
      } else {
        mine.ttl = FAILURE_CACHE_MS;
        mine.value = Promise.resolve([]);
        resolved = null; // the provider may be gone: discover again next time
      }
    });
  }
  const all = await entry.value.catch(() => [] as LinkedWorkout[]);
  return all.filter((w) => w.date === date);
}
