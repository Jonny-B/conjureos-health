/**
 * Unit conversion + formatting (WU). Storage is ALWAYS metric (kg, cm, km) — as
 * the Profile.units comment dictates. These convert only at the input/display
 * edges. Calories (kcal) + macros (grams) are unit-agnostic and not touched.
 */

import type { Profile } from "../types";

/** The user's display preference. Storage is metric regardless. */
type Units = Profile["units"];

const LB_PER_KG = 2.2046226218;
const IN_PER_CM = 1 / 2.54;
const MI_PER_KM = 0.621371;

/** Kilograms → pounds. */
export const kgToLb = (kg: number) => kg * LB_PER_KG;
/** Pounds → kilograms (the storage unit). */
export const lbToKg = (lb: number) => lb / LB_PER_KG;
/** Centimetres → inches. */
export const cmToIn = (cm: number) => cm * IN_PER_CM;
/** Inches → centimetres (the storage unit). */
export const inToCm = (inch: number) => inch / IN_PER_CM;
/** Kilometres → miles. */
export const kmToMi = (km: number) => km * MI_PER_KM;
/** Miles → kilometres (the storage unit). */
export const miToKm = (mi: number) => mi / MI_PER_KM;

/** Weight suffix for the user's units: "lb" or "kg". */
export const weightUnit = (u: Units) => (u === "imperial" ? "lb" : "kg");
/** Height suffix for the user's units: "in" or "cm". */
export const heightUnit = (u: Units) => (u === "imperial" ? "in" : "cm");
/** Distance suffix for the user's units: "mi" or "km". */
export const distanceUnit = (u: Units) => (u === "imperial" ? "mi" : "km");
/** Pace suffix for the user's units: "/mi" or "/km". */
export const paceUnit = (u: Units) => (u === "imperial" ? "/mi" : "/km");

/** kg → the display number in the user's units (one decimal, matching entry). */
export const weightToDisplay = (kg: number, u: Units) =>
  u === "imperial" ? Math.round(kgToLb(kg) * 10) / 10 : Math.round(kg * 10) / 10;
/** A display weight (in the user's units) → kg for storage. */
export const weightToKg = (v: number, u: Units) => (u === "imperial" ? lbToKg(v) : v);

/** cm → the display number in the user's units, rounded to a whole in/cm. */
export const heightToDisplay = (cm: number, u: Units) =>
  u === "imperial" ? Math.round(cmToIn(cm)) : Math.round(cm);
/** A display height (in the user's units) → cm for storage. */
export const heightToCm = (v: number, u: Units) => (u === "imperial" ? inToCm(v) : v);

/** A stored weight rendered with its unit: "182.5 lb" / "82.8 kg". */
export function fmtWeight(kg: number, u: Units): string {
  return u === "imperial" ? `${Math.round(kgToLb(kg) * 10) / 10} lb` : `${Math.round(kg * 10) / 10} kg`;
}

/** A stored height rendered per units: `5'11"` imperial, "180 cm" metric. */
export function fmtHeight(cm: number, u: Units): string {
  if (u === "imperial") {
    const totalIn = Math.round(cmToIn(cm));
    return `${Math.floor(totalIn / 12)}'${totalIn % 12}"`;
  }
  return `${Math.round(cm)} cm`;
}

/**
 * Seconds → a clock reading: `m:ss`, widening to `h:mm:ss` past an hour.
 * Always shows a minutes field ("0:45"), so a running timer doesn't jump
 * formats as it ticks past a minute. Use this for live timers and elapsed
 * times; use {@link fmtSeconds} for prescribed set lengths.
 */
export function fmtClock(sec: number): string {
  const total = Number.isFinite(sec) ? Math.max(0, Math.round(sec)) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Seconds → a human duration: short efforts stay "45s", anything from 90s up
 *  reads m:ss ("8:00", "50:00") — a 3000-second run should never print "3000s". */
export function fmtSeconds(sec: number): string {
  if (!Number.isFinite(sec) || sec < 90) return `${Math.round(sec)}s`;
  return fmtClock(sec);
}

/**
 * Seconds → a coarse "how long did that take" label for completed work:
 * "45s" under a minute, "12 min" above it. Empty string for a missing or
 * zero duration so a caller can drop the field entirely.
 */
export function fmtDuration(sec: number | undefined): string {
  if (!sec || !Number.isFinite(sec) || sec <= 0) return "";
  const m = Math.round(sec / 60);
  return m >= 1 ? `${m} min` : `${Math.round(sec)}s`;
}

/** A stored distance rendered with its unit, two decimals: "3.11 mi". */
export function fmtDistance(km: number, u: Units): string {
  return u === "imperial" ? `${kmToMi(km).toFixed(2)} mi` : `${km.toFixed(2)} km`;
}

/** Pace (stored as sec/km) formatted per the user's distance unit. */
export function fmtPace(secPerKm: number | null | undefined, u: Units): string {
  if (secPerKm == null || !Number.isFinite(secPerKm)) return "—:—";
  const per = u === "imperial" ? secPerKm / MI_PER_KM : secPerKm;
  const m = Math.floor(per / 60);
  const s = Math.round(per % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
