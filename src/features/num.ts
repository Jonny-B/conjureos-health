/**
 * Numeric coercion + range clamping.
 *
 * Two jobs live here, and the distinction matters at every call site:
 *
 *   - `clamp` narrows a number you already trust (a slider position, a computed
 *     target) into a legal range.
 *   - `toNumInRange` / `toIntInRange` coerce something UNTRUSTED — a JSON field
 *     from a model reply or a third-party food API — and return `null` when it
 *     isn't a finite number, so a garbage field fails loudly instead of
 *     silently becoming 0.
 *
 * Reach for the coercing pair whenever the input crossed a network or model
 * boundary; use `?? fallback` at the call site to pick the substitute value.
 */

/** Constrain an already-finite number to `[min, max]`. */
export const clamp = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, v));

/**
 * The one spot that decides whether an untrusted value is "a number" at all.
 * `Number(v)` on its own says yes to far too much: `Number(null) === 0`,
 * `Number("") === 0`, `Number([]) === 0`, `Number(false) === 0` — every one of
 * those is a JS coercion quirk, not a number anyone wrote down, and letting
 * them through here is how they used to end up clamped to `min` instead of
 * rejected (a `null` reps field silently becoming "1 rep").
 *
 * Only an actual `number` or a non-blank numeric `string` counts. Everything
 * else — null, undefined, booleans, arrays, objects — returns null before it
 * ever reaches `Number(...)`.
 *
 * Exported (not just used by the two range helpers below) for callers that
 * need "is this a real number" without also wanting `toNumInRange`'s
 * clamp-to-bound behaviour on an out-of-range value — e.g. an AI-macro
 * field where out-of-range must be rejected outright, not capped.
 */
export function coerceFinite(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null; // "" and whitespace-only both mean "nothing was said"
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Coerce an untrusted value to a number inside `[min, max]`.
 * Returns null for anything non-numeric (strings that don't parse, null,
 * objects, NaN, Infinity) rather than substituting a default — the caller
 * decides what a missing value means.
 */
export function toNumInRange(v: unknown, min: number, max: number): number | null {
  const n = coerceFinite(v);
  if (n == null) return null;
  return clamp(n, min, max);
}

/**
 * Like {@link toNumInRange}, but rounds to a whole number. For fields that are
 * counts by nature — reps, seconds, kcal, grams.
 */
export function toIntInRange(v: unknown, min: number, max: number): number | null {
  const n = coerceFinite(v);
  if (n == null) return null;
  // Round BEFORE clamping so a fractional bound still yields an in-range int.
  return clamp(Math.round(n), min, max);
}
