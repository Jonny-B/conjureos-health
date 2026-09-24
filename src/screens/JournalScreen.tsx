/**
 * The journal: a month at a glance, a day in detail, and a printable range.
 *
 * Three jobs in one screen because they're the same question at three zoom
 * levels — "when did that happen?" A month grid to find the day, a timeline to
 * read it, and a print view for handing a stretch of it to a doctor.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Profile } from "../types";
import {
  datesBetween,
  isEmptyDay,
  loadDayJournal,
  loadRangeJournal,
  summarizeRange,
  type DayJournal,
  type JournalEvent,
} from "../features/journal";
import { shiftDate, todayISO } from "../features/diary";
import { fmtWater } from "../features/water";
import { formatSleep } from "../features/sleep";
import { CoachChatModal } from "../components/CoachChatModal";
import { AiConsentSheet } from "../components/AiConsentSheet";
import {
  hasAiJournalConsent,
  readAiJournalConsent,
  recordAiJournalConsent,
} from "../features/aiConsent";
import { JournalEntrySheet } from "../components/JournalEntrySheet";
import { ChevronLeft, ChevronRight, CoachIcon } from "../components/icons";

type Units = Profile["units"];

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** First of the month containing `date`. */
const monthStart = (date: string): string => `${date.slice(0, 7)}-01`;

/** Last day of the month containing `date`. */
function monthEnd(date: string): string {
  const [y, m] = date.split("-").map(Number);
  const d = new Date(y ?? 1970, m ?? 1, 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Monday-based weekday index (0 = Monday), matching the header row. */
function weekdayIndex(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return (new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).getDay() + 6) % 7;
}

function monthLabel(date: string): string {
  const [y, m] = date.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, 1).toLocaleDateString([], { month: "long", year: "numeric" });
}

function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

const eventTime = (e: JournalEvent): string =>
  e.timed ? new Date(e.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";

export function JournalScreen({ units, nonce }: { units: Units; nonce: number }) {
  const today = todayISO();
  const [cursor, setCursor] = useState(today); // any date in the shown month
  const [selected, setSelected] = useState<string>(today);
  const [month, setMonth] = useState<DayJournal[] | null>(null);
  const [day, setDay] = useState<DayJournal | null>(null);
  const [printOpen, setPrintOpen] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  // Open when "Find patterns" was pressed without a current agreement on file.
  const [consenting, setConsenting] = useState(false);
  const [editing, setEditing] = useState<JournalEvent | null>(null);
  // Bumped after an edit so both the day and the month grid re-read.
  const [localNonce, setLocalNonce] = useState(0);

  const from = monthStart(cursor);
  const to = monthEnd(cursor);

  const loadMonth = useCallback(async () => {
    setMonth(await loadRangeJournal(from, to, units));
  }, [from, to, units]);

  useEffect(() => {
    void loadMonth();
  }, [loadMonth, nonce, localNonce]);

  useEffect(() => {
    let alive = true;
    void loadDayJournal(selected, units).then((d) => {
      if (alive) setDay(d);
    });
    return () => {
      alive = false;
    };
  }, [selected, nonce, units, localNonce]);

  const byDate = useMemo(() => {
    const map = new Map<string, DayJournal>();
    for (const d of month ?? []) map.set(d.date, d);
    return map;
  }, [month]);

  // Leading blanks so the 1st lands under its weekday.
  const lead = weekdayIndex(from);
  const cells: (string | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...datesBetween(from, to),
  ];

  /**
   * Build the prompt and open the chat. Split out from the button so the
   * consent sheet can call it on accept without duplicating the wording.
   * Never call this without checking consent first — it is the step that
   * performs the disclosure.
   */
  const runPatterns = (includeNotes: boolean) => {
    const days = month ?? [];
    const summary = summarizeRange(days, { includeNotes });
    const range = `${from} to ${to}`;
    setAsking(
      summary
        ? `Here is my journal for ${range}. What patterns do you notice — anything that seems to go together?\n\n${summary}`
        : `I have nothing recorded for ${range} yet. What would be worth tracking to spot patterns?`,
    );
  };

  const askPatterns = async () => {
    if (!(await hasAiJournalConsent())) {
      setConsenting(true);
      return;
    }
    const consent = await readAiJournalConsent();
    runPatterns(consent?.includeNotes === true);
  };

  return (
    // `printing` lets the print stylesheet hide the live screen. The overlay is
    // position:fixed on screen (so it covers), but must go static to print
    // across pages — at which point the calendar behind it would otherwise
    // flow onto page one of the report.
    <div className={`journal${printOpen ? " printing" : ""}`}>
      <div className="journal-toolbar">
        <div className="month-nav">
          <button className="icon-btn" aria-label="Previous month" onClick={() => setCursor(shiftDate(from, -1))}>
            <ChevronLeft size={20} />
          </button>
          <span className="month-label">{monthLabel(cursor)}</span>
          <button
            className="icon-btn"
            aria-label="Next month"
            disabled={to >= today}
            onClick={() => setCursor(shiftDate(to, 1))}
          >
            <ChevronRight size={20} />
          </button>
        </div>
        <div className="journal-actions">
          <button className="btn small" onClick={askPatterns}>
            <CoachIcon size={15} /> Find patterns
          </button>
          <button className="btn small" onClick={() => setPrintOpen(true)}>
            Print
          </button>
        </div>
      </div>

      <div className="cal-grid" role="grid" aria-label={`${monthLabel(cursor)} journal`}>
        {WEEKDAYS.map((w) => (
          <div key={w} className="cal-weekday">
            {w}
          </div>
        ))}
        {cells.map((date, i) =>
          date === null ? (
            <div key={`b${i}`} className="cal-cell blank" />
          ) : (
            <button
              key={date}
              className={`cal-cell${date === selected ? " selected" : ""}${date === today ? " today" : ""}`}
              aria-label={dayLabel(date)}
              aria-current={date === today ? "date" : undefined}
              disabled={date > today}
              onClick={() => setSelected(date)}
            >
              <span className="cal-num">{Number(date.slice(8))}</span>
              <span className="cal-dots" aria-hidden>
                {(() => {
                  const d = byDate.get(date);
                  if (!d) return null;
                  const kinds = new Set(d.events.map((e) => e.kind));
                  return [...kinds].slice(0, 4).map((k) => <i key={k} className={`dot dot-${k}`} />);
                })()}
              </span>
            </button>
          ),
        )}
      </div>

      <DayDetail day={day} units={units} onPick={setEditing} />

      {printOpen && <PrintSheet defaultFrom={from} defaultTo={to} units={units} onClose={() => setPrintOpen(false)} />}
      {consenting && (
        <AiConsentSheet
          onCancel={() => setConsenting(false)}
          onAccept={async (includeNotes) => {
            // Persist BEFORE disclosing. If the profile can't be written we
            // have no record of the agreement, so nothing is sent — an
            // agreement that survives only in memory is not a record.
            const stored = await recordAiJournalConsent(includeNotes);
            setConsenting(false);
            if (stored) runPatterns(includeNotes);
          }}
        />
      )}
      {asking !== null && <CoachChatModal initialQuestion={asking} onClose={() => setAsking(null)} />}
      {editing && (
        <JournalEntrySheet
          event={editing}
          units={units}
          onClose={() => setEditing(null)}
          onChanged={() => {
            setEditing(null);
            setLocalNonce((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

/** One day, read top to bottom. */
function DayDetail({
  day,
  units,
  onPick,
}: {
  day: DayJournal | null;
  units: Units;
  onPick: (e: JournalEvent) => void;
}) {
  if (!day) return <div className="muted small">Loading…</div>;
  const t = day.totals;
  return (
    <section className="day-detail">
      <h2 className="day-detail-title">{dayLabel(day.date)}</h2>

      {isEmptyDay(day) ? (
        <p className="muted small">Nothing recorded on this day.</p>
      ) : (
        <>
          <div className="day-chips">
            {t.calories > 0 && <span className="day-chip">{t.calories} cal</span>}
            {t.protein > 0 && <span className="day-chip">{t.protein}g protein</span>}
            {t.waterMl > 0 && <span className="day-chip">{fmtWater(t.waterMl, units)}</span>}
            {t.sleepMinutes > 0 && <span className="day-chip">{formatSleep(t.sleepMinutes)} sleep</span>}
            {t.exerciseKcal > 0 && <span className="day-chip">{t.exerciseKcal} cal burned</span>}
            {t.symptomCount > 0 && (
              <span className="day-chip warn">
                {t.symptomCount} symptom{t.symptomCount > 1 ? "s" : ""}
              </span>
            )}
          </div>

          <ol className="timeline">
            {day.events.map((e, i) => (
              <li key={`${e.kind}-${e.id}-${i}`} className={`tl-item tl-${e.kind}`}>
                {/* A row is a button only when there is something to do with
                    it — a wearable workout is read-only here, and a disabled
                    button would just look broken. */}
                <button
                  className="tl-row"
                  disabled={!e.editable}
                  aria-label={e.editable ? `Edit ${e.label}` : e.label}
                  onClick={() => e.editable && onPick(e)}
                >
                  <span className="tl-time">{eventTime(e)}</span>
                  <span className="tl-dot" aria-hidden />
                  <span className="tl-body">
                    <span className="tl-label">
                      {e.label}
                      {e.meal ? <span className="tl-meal">{e.meal}</span> : null}
                    </span>
                    {e.note ? <span className="tl-note muted small">{e.note}</span> : null}
                  </span>
                  {e.detail ? <span className="tl-detail">{e.detail}</span> : null}
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

/**
 * Pick a range and print it. The printed page is rendered here rather than
 * opened in a new window so it inherits the app's data layer; the print
 * stylesheet hides everything else on the page.
 */
function PrintSheet({
  defaultFrom,
  defaultTo,
  units,
  onClose,
}: {
  defaultFrom: string;
  defaultTo: string;
  units: Units;
  onClose: () => void;
}) {
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [days, setDays] = useState<DayJournal[] | null>(null);
  const [busy, setBusy] = useState(false);

  const build = async () => {
    setBusy(true);
    try {
      setDays(await loadRangeJournal(from, to, units));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void build();
    // Rebuild whenever the range changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, units]);

  const filled = (days ?? []).filter((d) => !isEmptyDay(d));

  return (
    <div className="print-overlay">
      <div className="print-controls no-print">
        <label className="field">
          <span>From</span>
          <input className="text-input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          <span>To</span>
          <input className="text-input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button className="btn primary" disabled={busy || filled.length === 0} onClick={() => window.print()}>
          Print
        </button>
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="print-doc">
        <header className="print-head">
          <h1>Health journal</h1>
          <p className="muted small">
            {from} to {to} · {filled.length} day{filled.length === 1 ? "" : "s"} with entries
          </p>
        </header>

        {busy && <p className="muted small no-print">Building…</p>}
        {!busy && filled.length === 0 && <p className="muted small">Nothing recorded in this range.</p>}

        {filled.map((d) => (
          <section key={d.date} className="print-day">
            <h2>{dayLabel(d.date)}</h2>
            <p className="print-totals">
              {[
                d.totals.calories > 0 ? `${d.totals.calories} cal` : null,
                d.totals.protein > 0 ? `${d.totals.protein}g protein` : null,
                d.totals.waterMl > 0 ? fmtWater(d.totals.waterMl, units) : null,
                d.totals.sleepMinutes > 0 ? `${formatSleep(d.totals.sleepMinutes)} sleep` : null,
                d.totals.exerciseKcal > 0 ? `${d.totals.exerciseKcal} cal burned` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <table className="print-table">
              <tbody>
                {d.events.map((e, i) => (
                  <tr key={i}>
                    <td className="print-time">{eventTime(e)}</td>
                    <td className="print-kind">{e.kind}</td>
                    <td>
                      {e.label}
                      {e.note ? ` — ${e.note}` : ""}
                    </td>
                    <td className="print-detail">{e.detail ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </div>
  );
}
