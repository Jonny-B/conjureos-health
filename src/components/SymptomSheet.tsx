/**
 * Record how you felt: a headache, heartburn, anything.
 *
 * The chips are a shortcut, not a menu — the field stays free text so the
 * thing someone actually noticed is never rounded to the nearest option we
 * happened to think of. Severity is optional; a symptom worth recording is
 * worth recording even when you can't rate it.
 */

import { useState } from "react";
import { COMMON_SYMPTOMS } from "../types";
import { getRepository } from "../data/repository";
import { reportSaveFailure } from "../data/saveFailure";
import { useScrollLock } from "../hooks/useScrollLock";
import { CloseIcon } from "./icons";

const SEVERITY = [1, 2, 3, 4, 5];

export function SymptomSheet({
  date,
  onClose,
  onSaved,
}: {
  date: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  useScrollLock();
  const [label, setLabel] = useState("");
  const [severity, setSeverity] = useState<number | undefined>(undefined);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const text = label.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const repo = await getRepository();
      await repo.addSymptom({
        date,
        label: text,
        ...(severity != null ? { severity } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onSaved();
    } catch (err) {
      reportSaveFailure("how you felt", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label="Record how you felt" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>How you felt</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon size={18} />
          </button>
        </div>

        <div className="sheet-body">
          <div className="wb-chips symptom-bank">
            {COMMON_SYMPTOMS.map((s) => (
              <button
                key={s}
                className={`chip-btn${label === s ? " active" : ""}`}
                onClick={() => setLabel(s)}
              >
                {s}
              </button>
            ))}
          </div>

          <label className="field">
            <span>What was it?</span>
            <input
              className="text-input"
              autoFocus
              placeholder="Type anything"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
              }}
            />
          </label>

          <div className="field">
            <span>How bad? (optional)</span>
            <div className="wb-chips">
              {SEVERITY.map((n) => (
                <button
                  key={n}
                  className={`chip-btn${severity === n ? " active" : ""}`}
                  onClick={() => setSeverity(severity === n ? undefined : n)}
                >
                  {n}
                </button>
              ))}
            </div>
            <span className="muted small field-hint">1 barely noticed · 5 severe</span>
          </div>

          <label className="field">
            <span>Note (optional)</span>
            <input
              className="text-input"
              placeholder="e.g. started after lunch"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>

          <div className="muted small">
            Recorded at the current time, so it lands on your journal where it happened.
            Notes stay on your device — the AI pattern-finder only sees them if you turn
            that on in Settings.
          </div>
        </div>

        <div className="sheet-foot">
          <button className="btn primary" disabled={busy || !label.trim()} onClick={save}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
