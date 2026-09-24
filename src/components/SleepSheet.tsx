/**
 * Record a night: bed time, wake time, and how it felt.
 *
 * Two clock fields and nothing else — deliberately no "did you go to bed after
 * midnight?" checkbox, because the two clock faces already imply the answer
 * (see features/sleep). The sheet shows the resolved duration live, which is
 * both the useful feedback and the honest way to surface that resolution: if
 * it says 14h you mistyped, and you can see that before saving.
 */

import { useMemo, useState } from "react";
import type { SleepEntry } from "../types";
import { getRepository } from "../data/repository";
import { reportSaveFailure } from "../data/saveFailure";
import { newId } from "../data/id";
import {
  buildSleepEntry,
  clocksOf,
  formatSleep,
  isImplausible,
  resolveNight,
  sleepMinutes,
} from "../features/sleep";
import { useScrollLock } from "../hooks/useScrollLock";
import { AlertTriangle, CloseIcon } from "./icons";

const QUALITY = [1, 2, 3, 4, 5];

export function SleepSheet({
  date,
  existing,
  onClose,
  onSaved,
}: {
  date: string;
  existing: SleepEntry | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  useScrollLock();
  const start = existing ? clocksOf(existing) : { bedClock: "23:00", wakeClock: "07:00" };
  const [bedClock, setBedClock] = useState(start.bedClock);
  const [wakeClock, setWakeClock] = useState(start.wakeClock);
  const [quality, setQuality] = useState<number | undefined>(existing?.quality);
  const [note, setNote] = useState(existing?.note ?? "");
  const [busy, setBusy] = useState(false);

  // Live resolution, so the date-boundary rule is visible rather than implied.
  const preview = useMemo(() => {
    const night = resolveNight(date, bedClock, wakeClock);
    if (!night) return null;
    const mins = sleepMinutes({ bedAt: night.bedAt.toISOString(), wakeAt: night.wakeAt.toISOString() });
    return { mins, crossesMidnight: night.bedAt.getDate() !== night.wakeAt.getDate() };
  }, [date, bedClock, wakeClock]);

  const save = async () => {
    if (busy || !preview) return;
    setBusy(true);
    try {
      const entry = buildSleepEntry(existing?.id ?? newId(), date, bedClock, wakeClock, {
        ...(quality != null ? { quality } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      if (!entry) return;
      const repo = await getRepository();
      await repo.saveSleep(entry);
      onSaved();
    } catch (err) {
      reportSaveFailure("your sleep", err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!existing || busy) return;
    setBusy(true);
    try {
      const repo = await getRepository();
      await repo.removeSleep(existing.id);
      onSaved();
    } catch (err) {
      reportSaveFailure("that change to your sleep", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label="Record sleep" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>Sleep</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon size={18} />
          </button>
        </div>

        <div className="sheet-body">
          <div className="field-row">
            <label className="field">
              <span>Went to bed</span>
              <input
                className="text-input"
                type="time"
                aria-label="Bed time"
                value={bedClock}
                onChange={(e) => setBedClock(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Woke up</span>
              <input
                className="text-input"
                type="time"
                aria-label="Wake time"
                value={wakeClock}
                onChange={(e) => setWakeClock(e.target.value)}
              />
            </label>
          </div>

          <div className="sleep-preview">
            {preview ? (
              <>
                <span className="sleep-preview-dur">{formatSleep(preview.mins) || "0m"}</span>
                <span className="muted small">
                  {preview.crossesMidnight ? "across midnight" : "same night"}
                </span>
              </>
            ) : (
              <span className="muted small">Enter both times.</span>
            )}
          </div>

          {preview && isImplausible(preview.mins) && (
            <div className="notice notice-soft" role="note">
              <AlertTriangle size={14} /> That's over 16 hours — check the times before saving.
            </div>
          )}

          <div className="field">
            <span>How rested? (optional)</span>
            <div className="wb-chips">
              {QUALITY.map((q) => (
                <button
                  key={q}
                  className={`chip-btn${quality === q ? " active" : ""}`}
                  onClick={() => setQuality(quality === q ? undefined : q)}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>

          <label className="field">
            <span>Note (optional)</span>
            <input
              className="text-input"
              placeholder="e.g. woke twice, hot room"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
        </div>

        <div className="sheet-foot">
          {existing && (
            <button className="btn danger-subtle" disabled={busy} onClick={remove}>
              Delete
            </button>
          )}
          <button className="btn primary" disabled={busy || !preview} onClick={save}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
