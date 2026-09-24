import { useState } from "react";
import type { SetActual } from "../types";
import { formatSet, overloadSuggestion } from "../features/workoutHistory";

/** What the user actually did on a set, as typed into the recorder — all
 *  fields optional because a set can be logged before every box is filled. */
export interface SetEntry {
  reps?: number;
  weightKg?: number;
  rpe?: number;
}

interface Props {
  /** The prescribed set (reps/weight/duration targets). */
  prescribed: { reps?: number | null; weightKg?: number | null; durationSec?: number | null };
  /** The same exercise's last recorded set, for "last time" + the suggestion. */
  last?: SetActual;
  value: SetEntry;
  onChange: (next: SetEntry) => void;
}

const RPE_OPTIONS = [6, 7, 8, 9, 10];

/**
 * Records reps + weight (+ optional RPE) for a rep/weighted work step. Shows
 * "last time" and a progressive-overload nudge, and a plate calculator for
 * weighted sets. Timed sets don't use this — their countdown IS the metric.
 */
export function SetRecorder({ prescribed, last, value, onChange }: Props) {
  const [platesOpen, setPlatesOpen] = useState(false);
  const weighted = prescribed.weightKg != null || last?.weightKg != null || value.weightKg != null;
  const suggestion = overloadSuggestion(last, prescribed);

  const num = (raw: string): number | undefined => {
    const n = Number(raw);
    return raw === "" || !Number.isFinite(n) || n < 0 ? undefined : n;
  };

  return (
    <div className="set-recorder">
      {last && <div className="set-lasttime muted small">Last time: {formatSet(last)}</div>}

      <div className="set-fields">
        <label className="set-field">
          <span>Reps</span>
          <input
            className="text-input"
            inputMode="numeric"
            value={value.reps ?? ""}
            onChange={(e) => onChange({ ...value, reps: num(e.target.value) })}
          />
        </label>
        {weighted && (
          <label className="set-field">
            <span>Weight (kg)</span>
            <input
              className="text-input"
              inputMode="decimal"
              value={value.weightKg ?? ""}
              onChange={(e) => onChange({ ...value, weightKg: num(e.target.value) })}
            />
          </label>
        )}
      </div>

      {suggestion && <div className="set-suggestion">💪 {suggestion}</div>}

      <div className="set-rpe">
        <span className="muted small">How hard? (RPE)</span>
        <div className="chip-row">
          {RPE_OPTIONS.map((r) => (
            <button
              key={r}
              type="button"
              className={`chip${value.rpe === r ? " active" : ""}`}
              onClick={() => onChange({ ...value, rpe: value.rpe === r ? undefined : r })}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {weighted && (
        <div className="plate-calc">
          <button type="button" className="link-btn" onClick={() => setPlatesOpen((o) => !o)}>
            {platesOpen ? "Hide" : "Plate calculator"}
          </button>
          {platesOpen && <PlateBreakdown totalKg={value.weightKg ?? prescribed.weightKg ?? 0} />}
        </div>
      )}
    </div>
  );
}

const PLATES = [25, 20, 15, 10, 5, 2.5, 1.25];
const BAR_KG = 20;

/** Plates per side for a standard 20 kg barbell. */
function PlateBreakdown({ totalKg }: { totalKg: number }) {
  if (totalKg <= BAR_KG) {
    return <div className="muted small">Just the {BAR_KG} kg bar.</div>;
  }
  let perSide = (totalKg - BAR_KG) / 2;
  const used: number[] = [];
  for (const p of PLATES) {
    while (perSide >= p - 1e-6) {
      used.push(p);
      perSide -= p;
    }
  }
  const leftover = perSide > 1e-6;
  return (
    <div className="plate-breakdown small">
      <span className="muted">Per side ({BAR_KG} kg bar):</span>{" "}
      {used.length ? used.map((p, i) => <span key={i} className="plate-chip">{p}</span>) : <span className="muted">—</span>}
      {leftover && <span className="muted"> (approx)</span>}
    </div>
  );
}
