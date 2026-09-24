/**
 * Reading the gram weight out of a serving label.
 *
 * Serving labels almost always carry the weight already — "1 doughnut (43 g)",
 * "16 chips (28 g)", "30g" — but it's written for a human, not stored as a
 * number. When a parser gives us the label and omits the figure, this recovers
 * it rather than leaving the field blank, which is what happened to a
 * front-and-back scan that read "1 doughnut 43 grams" and stored no grams at
 * all.
 *
 * Deliberately conservative: it only returns a number when the text actually
 * says grams. "1 cup (240 ml)" is a volume and gets nothing — inventing a mass
 * from millilitres would be a guess dressed as a measurement.
 */

/** Above this a "serving" is a catering pack, and the number is more likely a
 *  misparse than a portion. */
const MAX_SERVING_G = 5000;

// A number followed by a gram unit. `mg` and `kg` don't match: the character
// after the digits has to be the `g` itself, so the `m`/`k` blocks them.
const GRAMS = /(\d+(?:\.\d+)?)\s*(?:g|gm|gms|gram|grams)\b/gi;

/**
 * Grams in one serving, read from its label, or null when the label doesn't
 * say. Takes the last IN-RANGE gram figure in the string: a label that
 * carries two ("1.4 oz / 40 g") puts the metric weight last by convention,
 * but a trailing figure past `MAX_SERVING_G` is more likely a misparse (a
 * catering-pack total, a stray digit) than the real portion, so it's skipped
 * in favour of an earlier one that actually looks like a serving. Docstring
 * previously claimed "the last gram figure, full stop" — that undersold the
 * guard this function has always had; the code was right, the words weren't.
 */
export function parseServingGrams(label: string | undefined): number | null {
  if (!label) return null;
  GRAMS.lastIndex = 0;
  let match: RegExpExecArray | null;
  let found: number | null = null;
  while ((match = GRAMS.exec(label)) !== null) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > 0 && n <= MAX_SERVING_G) found = n;
  }
  // One decimal is as much precision as a serving label ever means.
  return found === null ? null : Math.round(found * 10) / 10;
}
