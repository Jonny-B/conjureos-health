/**
 * Water: millilitres on disk, whatever the user reads.
 *
 * Storage is always ml so switching units never rewrites history — the same
 * reason weight is stored in kg. Everything user-facing goes through here.
 */

import type { Profile, WaterEntry } from "../types";

type Units = Profile["units"];

const ML_PER_FL_OZ = 29.5735;

/** A US fluid ounce in ml. */
export const flOzToMl = (oz: number): number => oz * ML_PER_FL_OZ;
/** ml as US fluid ounces. */
export const mlToFlOz = (ml: number): number => ml / ML_PER_FL_OZ;

/** The unit label for the user's setting. */
export const waterUnit = (u: Units): string => (u === "imperial" ? "oz" : "ml");

/**
 * The quick-add buttons, in the user's own units.
 *
 * Deliberately real-world containers rather than round numbers of ml: nobody
 * drinks "200 ml", they drink a glass or a bottle. Values are the ml actually
 * stored.
 */
export function waterPresets(u: Units): { label: string; ml: number }[] {
  if (u === "imperial") {
    return [
      { label: "8 oz", ml: Math.round(flOzToMl(8)) },
      { label: "12 oz", ml: Math.round(flOzToMl(12)) },
      { label: "16 oz", ml: Math.round(flOzToMl(16)) },
      { label: "24 oz", ml: Math.round(flOzToMl(24)) },
    ];
  }
  return [
    { label: "250 ml", ml: 250 },
    { label: "330 ml", ml: 330 },
    { label: "500 ml", ml: 500 },
    { label: "750 ml", ml: 750 },
  ];
}

/** Render an ml amount in the user's units, e.g. "16 oz" or "500 ml". */
export function fmtWater(ml: number, u: Units): string {
  if (!Number.isFinite(ml) || ml <= 0) return u === "imperial" ? "0 oz" : "0 ml";
  return u === "imperial"
    ? `${Math.round(mlToFlOz(ml))} oz`
    : `${Math.round(ml)} ml`;
}

/** Total ml across entries. */
export function totalMl(entries: WaterEntry[]): number {
  return entries.reduce((sum, e) => sum + (Number.isFinite(e.ml) ? e.ml : 0), 0);
}

/**
 * A default daily target, used only to draw a progress bar — never enforced
 * and never a nag. ~2 litres / ~64 oz is the common rule of thumb; the point
 * is a sense of scale, not a medical prescription.
 */
export const DEFAULT_WATER_TARGET_ML = 2000;
