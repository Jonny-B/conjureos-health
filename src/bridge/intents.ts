/**
 * Deep links into Conjure Health (ConjureOS #520): the `intents` block in
 * package.json names what a link may ask for, and ConjureOS asks the user
 * before handing it over. Desktop only for now; feature-detected.
 *
 *   https://conjureos.com/launch/fitness?intent=addFood&query=greek%20yogurt
 *   https://conjureos.com/launch/fitness?intent=addFood&barcode=5200435000027&meal=breakfast
 *   https://conjureos.com/launch/fitness?intent=openDay&date=2026-09-27
 *   https://conjureos.com/launch/fitness?intent=exercise&date=2026-09-27
 *
 * Every intent only NAVIGATES. `addFood` opens the Add screen with the search
 * filled in (or the scanned food's details open), and the user still taps to
 * log — anyone can write a link, so a link must never change the diary by
 * itself. Params are untrusted strings; anything malformed is dropped rather
 * than guessed at.
 */

import type { MealType } from "../types";
import { MEAL_TYPES } from "../types";
import { todayISO } from "../features/diary";

/** What ConjureOS hands over after the user agrees to open the link. */
interface RawIntent {
  name: string;
  title?: string;
  params?: Record<string, unknown>;
  source?: string;
  receivedAt?: string;
}

declare global {
  interface ConjureosBridge {
    intent?: {
      /** Resolves once the user has answered ConjureOS's prompt; null when
       *  there is no intent or they dismissed it. Delivered once. */
      get?: () => Promise<RawIntent | null>;
    };
  }
}

/** A deep link, validated, as a place in the app to go. */
export type LaunchIntent =
  | { kind: "addFood"; query?: string; barcode?: string; meal?: MealType; date?: string }
  | { kind: "openDay"; date?: string }
  | { kind: "exercise"; date?: string };

/** A real calendar date no later than today — the diary can't show the future. */
function linkDate(v: unknown, today: string): string | undefined {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const [y, m, d] = v.split("-").map(Number) as [number, number, number];
  const t = new Date(y, m - 1, d);
  if (t.getFullYear() !== y || t.getMonth() !== m - 1 || t.getDate() !== d) return undefined;
  return v <= today ? v : undefined;
}

function linkQuery(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const q = v.replace(/[\x00-\x1F\x7F]/g, " ").trim().slice(0, 80);
  return q || undefined;
}

function linkBarcode(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const code = v.replace(/[\s-]/g, "");
  return /^\d{6,14}$/.test(code) ? code : undefined;
}

function linkMeal(v: unknown): MealType | undefined {
  return typeof v === "string" && (MEAL_TYPES as string[]).includes(v) ? (v as MealType) : undefined;
}

/** Turn what ConjureOS delivered into a LaunchIntent, or null for anything
 *  this app doesn't accept. Exported for tests. */
export function parseIntent(raw: unknown, today = todayISO()): LaunchIntent | null {
  if (!raw || typeof raw !== "object") return null;
  const { name, params } = raw as RawIntent;
  const p = params && typeof params === "object" ? params : {};
  const date = linkDate(p.date, today);
  const withDate = date ? { date } : {};
  switch (name) {
    case "addFood": {
      const query = linkQuery(p.query);
      const barcode = linkBarcode(p.barcode);
      const meal = linkMeal(p.meal);
      return {
        kind: "addFood",
        ...(query ? { query } : {}),
        ...(barcode ? { barcode } : {}),
        ...(meal ? { meal } : {}),
        ...withDate,
      };
    }
    case "openDay":
      return { kind: "openDay", ...withDate };
    case "exercise":
      return { kind: "exercise", ...withDate };
    default:
      return null;
  }
}

/**
 * The link this launch carries, if any. May stay pending while the user reads
 * ConjureOS's prompt, so callers must not hold up the first paint on it.
 */
export async function readLaunchIntent(): Promise<LaunchIntent | null> {
  const get = typeof window !== "undefined" ? window.__conjureos?.intent?.get : undefined;
  if (typeof get !== "function") return null;
  try {
    return parseIntent(await get());
  } catch {
    return null;
  }
}
