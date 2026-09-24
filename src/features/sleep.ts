/**
 * Sleep: turning "went to bed at 11:10, up at 6:40" into a night on a date.
 *
 * The whole problem is the date boundary. People give a bedtime and a wake
 * time as clock faces, and those two clock faces do not say which day each one
 * belongs to: 23:10 → 06:40 is a normal night that starts yesterday, while
 * 00:40 → 08:15 is a normal night that starts today. Storing clock strings and
 * guessing later is where sleep trackers go wrong, so this module resolves the
 * ambiguity ONCE, at entry time, into two absolute timestamps.
 *
 * The rule: a night is filed under its WAKE date, and the bedtime is the most
 * recent instant with that clock face at or before the wake instant. That
 * single rule handles both cases above and needs no "did you go to bed after
 * midnight?" question — the answer is implied by the clock faces themselves.
 */

import type { SleepEntry } from "../types";

/** A night longer than this is almost certainly a mis-entered bedtime (am/pm,
 *  or a wake time typed as the bedtime). We still store it; callers can warn. */
export const IMPLAUSIBLE_SLEEP_HOURS = 16;

const MS_PER_MIN = 60_000;

/** Local YYYY-MM-DD for an instant. */
function localDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse "HH:MM" into minutes past midnight, or null if it isn't one. */
export function parseClock(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Render minutes-past-midnight back as "HH:MM" (24h, zero-padded). */
export function formatClock(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * Build the two absolute instants for a night, from a wake DATE plus the two
 * clock faces.
 *
 * `bedClock` is placed on the wake date if it is at or before `wakeClock`
 * (a night that began after midnight), otherwise on the day before (a night
 * that began the previous evening). Equal times are treated as the
 * after-midnight case and yield a zero-length night rather than 24 hours,
 * which is the more likely intent from a mis-tap.
 */
export function resolveNight(
  wakeDate: string,
  bedClock: string,
  wakeClock: string,
): { bedAt: Date; wakeAt: Date } | null {
  const bed = parseClock(bedClock);
  const wake = parseClock(wakeClock);
  if (bed === null || wake === null) return null;
  const [y, m, d] = wakeDate.split("-").map(Number);
  if (!y || !m || !d) return null;

  // Construct in LOCAL time so a DST shift is absorbed by the Date itself:
  // the difference between the two instants is then the real elapsed time,
  // which is what someone actually slept.
  const wakeAt = new Date(y, m - 1, d, Math.floor(wake / 60), wake % 60, 0, 0);
  const startsSameDay = bed <= wake;
  const bedAt = new Date(
    y,
    m - 1,
    startsSameDay ? d : d - 1,
    Math.floor(bed / 60),
    bed % 60,
    0,
    0,
  );
  return { bedAt, wakeAt };
}

/** Minutes actually slept. Uses the absolute instants, so a night spanning a
 *  DST change reports the hours that really elapsed, not the clock difference. */
export function sleepMinutes(entry: Pick<SleepEntry, "bedAt" | "wakeAt">): number {
  const bed = new Date(entry.bedAt).getTime();
  const wake = new Date(entry.wakeAt).getTime();
  if (!Number.isFinite(bed) || !Number.isFinite(wake)) return 0;
  return Math.max(0, Math.round((wake - bed) / MS_PER_MIN));
}

/** "7h 30m", or "45m" under an hour. Empty string for nothing. */
export function formatSleep(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Whether a night is long enough to look like a mis-entry rather than sleep. */
export function isImplausible(minutes: number): boolean {
  return minutes > IMPLAUSIBLE_SLEEP_HOURS * 60;
}

/**
 * Assemble a storable entry from the wake date and two clock faces.
 * Returns null when either clock is unparseable.
 */
export function buildSleepEntry(
  id: string,
  wakeDate: string,
  bedClock: string,
  wakeClock: string,
  extra?: { quality?: number; note?: string },
): SleepEntry | null {
  const night = resolveNight(wakeDate, bedClock, wakeClock);
  if (!night) return null;
  const entry: SleepEntry = {
    id,
    // Derived from the instant rather than trusting the caller's string, so a
    // bad wakeDate can't file a night under a day it didn't end on.
    date: localDate(night.wakeAt),
    bedAt: night.bedAt.toISOString(),
    wakeAt: night.wakeAt.toISOString(),
  };
  if (extra?.quality != null) entry.quality = extra.quality;
  if (extra?.note) entry.note = extra.note;
  return entry;
}

/** The clock faces to show when editing an existing night. */
export function clocksOf(entry: Pick<SleepEntry, "bedAt" | "wakeAt">): {
  bedClock: string;
  wakeClock: string;
} {
  const bed = new Date(entry.bedAt);
  const wake = new Date(entry.wakeAt);
  return {
    bedClock: formatClock(bed.getHours() * 60 + bed.getMinutes()),
    wakeClock: formatClock(wake.getHours() * 60 + wake.getMinutes()),
  };
}

/** Mean nightly minutes across the given entries, or 0 when there are none. */
export function averageSleepMinutes(entries: SleepEntry[]): number {
  if (entries.length === 0) return 0;
  const total = entries.reduce((sum, e) => sum + sleepMinutes(e), 0);
  return Math.round(total / entries.length);
}
