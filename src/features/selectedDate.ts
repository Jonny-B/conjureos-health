/**
 * Which day the Diary shows. A user who is looking at "today" is *following*
 * today (stored as null) rather than holding a fixed date, so an app left open
 * past midnight moves on to the new day. A date they navigated to on purpose
 * stays pinned.
 */

/** The date to show: the pinned one, or today when following today. */
export function resolveSelectedDate(selected: string | null, today: string): string {
  return selected ?? today;
}

/** What to store for a chosen date: choosing today means "follow today". */
export function pinSelectedDate(chosen: string, today: string): string | null {
  return chosen === today ? null : chosen;
}

/** Milliseconds until just after the next local midnight (DST-safe). */
export function msUntilNextMidnight(now: Date = new Date()): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return next.getTime() - now.getTime() + 1000;
}

/** A day's exercise calories tagged with the date they were read for. */
export interface ExerciseDay {
  date: string;
  calories: number;
}

/** The burn for `date`: 0 (not the previous day's value) until it has loaded. */
export function exerciseFor(day: ExerciseDay | null, date: string): number {
  return day && day.date === date ? day.calories : 0;
}
