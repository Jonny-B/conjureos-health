/**
 * The journal: one day, everything that happened, in the order it happened.
 *
 * The diary screen answers "how am I doing against today's targets". This
 * answers a different question — "what actually happened, and when" — which is
 * what you need to spot that the heartburn follows the late coffee, and what
 * you hand a doctor. So the unit here is a timestamped event, not a total.
 *
 * Everything is read-only and assembled from the existing stores. Nothing in
 * this module writes.
 */

import type {
  DiaryEntry,
  Profile,
  SleepEntry,
  SymptomEntry,
  WaterEntry,
  WeightEntry,
} from "../types";
import { getRepository } from "../data/repository";
import { listCompletedWorkouts, type CompletedWorkout } from "./exercise";
import { shiftDate } from "./diary";
import { sleepMinutes } from "./sleep";
import { fmtWater } from "./water";

type Units = Profile["units"];

/** One thing that happened, placed on the day's timeline. */
export interface JournalEvent {
  /**
   * Identity of the underlying record, so a row on the timeline can be edited
   * or deleted rather than merely read. Empty only for things the journal
   * shows but does not own — a wearable workout belongs to Apple Health, not
   * to us, and the exercise screen is where it gets excluded.
   */
  id: string;
  /** Whether this row can be opened for editing. */
  editable: boolean;
  /** Sort key: ms since epoch. */
  at: number;
  /** Whether `at` is a real recorded time or a placeholder (see `dayStart`). */
  timed: boolean;
  kind: "food" | "water" | "symptom" | "sleep" | "weight" | "exercise";
  /** Headline, e.g. "Greek yogurt" or "Headache". */
  label: string;
  /** Right-hand detail, e.g. "146 cal" or "7h 30m". */
  detail?: string;
  /** Extra line under the label, e.g. a note. */
  note?: string;
  /** Meal bucket, for food only. */
  meal?: string;
  /**
   * The entry's true stored value, for kinds whose `detail` is a ROUNDED
   * rendering of it — water is stored in ml but shown in oz, and reading the
   * amount back off the display string cost 13ml on a 250ml entry every time
   * it was edited. The editor reads this instead, so a save writes what the
   * user actually sees plus their change, not a re-derivation of it.
   */
  rawValue?: number;
}

/** Everything recorded for one calendar date. */
export interface DayJournal {
  date: string;
  events: JournalEvent[];
  totals: {
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    waterMl: number;
    exerciseKcal: number;
    sleepMinutes: number;
    symptomCount: number;
    foodCount: number;
  };
  weightKg?: number;
}

/** Midnight local on a YYYY-MM-DD, as ms. Used to place untimed events (a
 *  weigh-in has a date but no clock) at the top of the day rather than
 *  inventing a time that reads as real. */
function dayStart(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0).getTime();
}

const ms = (iso: string): number => {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
};

/**
 * Assemble one day. Every source failure degrades to "nothing recorded" for
 * that source rather than failing the whole day.
 *
 * `units` only affects how amounts READ — nothing is converted on disk. It is
 * threaded in here rather than formatted at render time so the screen and the
 * printed page can't drift apart.
 */
export async function loadDayJournal(date: string, units: Units = "metric"): Promise<DayJournal> {
  const repo = await getRepository();
  const [food, water, symptoms, sleep, weights, workouts] = await Promise.all([
    repo.listDiary(date).catch((): DiaryEntry[] => []),
    repo.listWater(date).catch((): WaterEntry[] => []),
    repo.listSymptoms(date).catch((): SymptomEntry[] => []),
    repo.listSleep(date).catch((): SleepEntry[] => []),
    repo.listWeights().catch((): WeightEntry[] => []),
    listCompletedWorkouts(date).catch((): CompletedWorkout[] => []),
  ]);

  const events: JournalEvent[] = [];
  const totals = {
    calories: 0,
    protein: 0,
    carbs: 0,
    fat: 0,
    waterMl: 0,
    exerciseKcal: 0,
    sleepMinutes: 0,
    symptomCount: symptoms.length,
    foodCount: food.length,
  };

  for (const e of food) {
    const cal = Math.round(e.food.perServing.calories * e.quantity);
    totals.calories += cal;
    totals.protein += e.food.perServing.protein * e.quantity;
    totals.carbs += e.food.perServing.carbs * e.quantity;
    totals.fat += e.food.perServing.fat * e.quantity;
    events.push({
      id: e.id,
      editable: true,
      at: ms(e.loggedAt),
      timed: true,
      kind: "food",
      label: e.food.name,
      detail: `${cal} cal`,
      meal: e.meal,
      ...(e.quantity !== 1 ? { note: `${e.quantity}× ${e.food.servingSize}` } : {}),
    });
  }

  for (const w of water) {
    totals.waterMl += w.ml;
    events.push({
      id: w.id,
      editable: true,
      at: ms(w.loggedAt),
      timed: true,
      kind: "water",
      rawValue: w.ml,
      label: "Water",
      detail: fmtWater(w.ml, units),
    });
  }

  for (const s of symptoms) {
    events.push({
      id: s.id,
      editable: true,
      at: ms(s.loggedAt),
      timed: true,
      kind: "symptom",
      label: s.label,
      ...(s.severity ? { detail: `${s.severity}/5` } : {}),
      ...(s.note ? { note: s.note } : {}),
    });
  }

  for (const n of sleep) {
    const mins = sleepMinutes(n);
    totals.sleepMinutes += mins;
    // Placed at the wake time: that is when the night ended and the day began,
    // so it sorts above everything else that happened after getting up.
    events.push({
      id: n.id,
      editable: true,
      at: ms(n.wakeAt),
      timed: true,
      kind: "sleep",
      label: "Slept",
      detail: `${Math.floor(mins / 60)}h ${mins % 60}m`,
      ...(n.note ? { note: n.note } : {}),
    });
  }

  for (const w of workouts) {
    if (w.excluded) continue;
    totals.exerciseKcal += w.kcal;
    events.push({
      // A wearable workout is Apple Health's record, not ours — we can hide it
      // from a day's total but never delete it, so it isn't offered as editable.
      id: w.source === "app" ? w.key : "",
      editable: w.source === "app",
      at: dayStart(date),
      timed: false,
      kind: "exercise",
      label: w.name,
      detail: `${w.kcal} cal`,
      note: w.sourceLabel,
    });
  }

  const weight = weights.find((w) => w.date === date);
  if (weight) {
    events.push({
      id: date,
      editable: true,
      at: dayStart(date),
      timed: false,
      kind: "weight",
      label: "Weighed in",
      detail: "",
    });
  }

  // Untimed events first (they describe the day, not a moment in it), then
  // everything else in the order it happened.
  events.sort((a, b) => (a.timed === b.timed ? a.at - b.at : a.timed ? 1 : -1));

  const day: DayJournal = {
    date,
    events,
    totals: {
      ...totals,
      protein: Math.round(totals.protein),
      carbs: Math.round(totals.carbs),
      fat: Math.round(totals.fat),
    },
  };
  if (weight) day.weightKg = weight.weightKg;
  return day;
}

/** Every date from `from` to `to` inclusive, oldest first. */
export function datesBetween(from: string, to: string): string[] {
  if (from > to) return [];
  const out: string[] = [];
  let d = from;
  // Bounded so a bad range can't spin: two years is far past any print job.
  for (let i = 0; i < 800 && d <= to; i++) {
    out.push(d);
    d = shiftDate(d, 1);
  }
  return out;
}

/** Assemble a range, oldest first. Days with nothing recorded are included so
 *  a printed week shows the gaps — an empty Tuesday is information. */
export async function loadRangeJournal(
  from: string,
  to: string,
  units: Units = "metric",
): Promise<DayJournal[]> {
  const dates = datesBetween(from, to);
  return Promise.all(dates.map((d) => loadDayJournal(d, units)));
}

/** Did anything at all get recorded? */
export function isEmptyDay(day: DayJournal): boolean {
  return day.events.length === 0;
}

/**
 * Compact the range into something an AI can read in a prompt.
 *
 * One line per day with the day's shape, plus the timed detail for symptoms —
 * the whole point of asking is usually "why do I keep getting X", so the
 * symptom times have to survive summarisation even though the food does not.
 */
export function summarizeRange(
  days: DayJournal[],
  opts: { includeNotes?: boolean } = {},
): string {
  // The free-text note on a symptom is held back unless the user opted in on
  // the consent sheet — that is the field where someone writes the sentence
  // they would not want sent anywhere. Severity and time always travel; they
  // are what pattern-finding actually needs. See features/aiConsent.ts.
  const includeNotes = opts.includeNotes === true;
  const lines: string[] = [];
  for (const d of days) {
    if (isEmptyDay(d)) continue;
    const bits: string[] = [];
    if (d.totals.foodCount) bits.push(`${d.totals.calories} cal from ${d.totals.foodCount} items`);
    if (d.totals.protein) bits.push(`${d.totals.protein}g protein`);
    if (d.totals.waterMl) bits.push(`${d.totals.waterMl}ml water`);
    if (d.totals.sleepMinutes) {
      bits.push(`slept ${Math.floor(d.totals.sleepMinutes / 60)}h${d.totals.sleepMinutes % 60}m`);
    }
    if (d.totals.exerciseKcal) bits.push(`${d.totals.exerciseKcal} cal exercise`);
    if (d.weightKg) bits.push(`${d.weightKg.toFixed(1)}kg`);

    const symptoms = d.events.filter((e) => e.kind === "symptom");
    if (symptoms.length) {
      const detail = symptoms
        .map((s) => {
          // Force 24-hour time: this string goes to the AI (and into
          // DISCLOSURE_SAMPLE, which the consent sheet shows verbatim), so it
          // must be unambiguous regardless of the user's locale. Left to the
          // default, en-US renders "09:40 PM" — a mismatch with the sample
          // that promised "21:40" and a needless ambiguity for the model.
          const t = new Date(s.at).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          });
          // `detail` is the severity ("3/5") — a number the user picked from a
          // scale, and the most useful half of a symptom for pattern-finding.
          // `note` is the free-text field, and is held back unless opted in.
          const severity = s.detail ? ` (${s.detail})` : "";
          const note = includeNotes && s.note ? ` — ${s.note}` : "";
          return `${s.label} at ${t}${severity}${note}`;
        })
        .join(", ");
      bits.push(`symptoms: ${detail}`);
    }
    // Foods are named but not timed — enough to spot "always after pizza"
    // without spending the whole prompt on the diary.
    const foods = d.events.filter((e) => e.kind === "food").map((e) => e.label);
    if (foods.length) bits.push(`ate: ${foods.slice(0, 12).join(", ")}`);

    lines.push(`${d.date}: ${bits.join("; ")}`);
  }
  return lines.join("\n");
}
