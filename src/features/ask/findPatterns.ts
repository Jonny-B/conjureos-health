/**
 * What a press of "Find patterns" in the journal opens Ask Health with.
 *
 * Kept out of the screen so the wiring is a function a test can call: the
 * press must ask as a Find patterns run (never from the home card, which
 * would add today, the 2 days before and the goal), and must send only the
 * month on screen (ConjureOS #1163).
 */

import { patternsQuestion, type DayJournal } from "../journal";
import { newPatternsRun, type AskFrom } from "./ask";

/** Days the journal has read, tagged with the range they were read for. */
export interface LoadedRange {
  from: string;
  to: string;
  days: DayJournal[];
}

/** The days on hand, when they are the range on screen; null otherwise. */
export function loadedFor(loaded: LoadedRange | null, from: string, to: string): LoadedRange | null {
  return loaded !== null && loaded.from === from && loaded.to === to ? loaded : null;
}

/**
 * The opening question and entry point for one press, or null when there is
 * nothing to send yet: right after the month changes, the days on hand are
 * still the month before, and sending them under this month's name would
 * send a range the person did not ask about.
 *
 * Each press is a new run, so its follow-ups carry this range and nothing
 * from another run or the home card (features/ask/ask.ts, `turnsToSend`).
 * Building this performs no disclosure; the sheet that sends it does, so only
 * call it once consent is on file.
 */
export function findPatternsAsk(
  loaded: LoadedRange | null,
  from: string,
  to: string,
  opts: { includeNotes: boolean },
): { question: string; from: AskFrom } | null {
  const range = loadedFor(loaded, from, to);
  if (range === null) return null;
  return {
    from: newPatternsRun(),
    question: patternsQuestion(range.days, from, to, { includeNotes: opts.includeNotes }),
  };
}
