import { useState } from "react";
import type { CardioActual, Profile, Workout } from "../types";
import { useGpsTracker } from "../features/cardio/tracker";
import { distanceUnit, fmtClock, fmtPace, kmToMi, paceUnit } from "../features/units";
import { ManualCardioEntry } from "../components/ManualCardioEntry";
import { ChevronLeft } from "../components/icons";

interface Props {
  workout: Workout;
  units: Profile["units"];
  onFinish: (cardio: CardioActual) => void;
  onCancel: () => void;
}

/** Cardio (run/bike) screen: live GPS distance/pace/time/splits, with a manual
 *  distance+duration path always reachable. */
export function CardioPlayer({ workout, units, onFinish, onCancel }: Props) {
  const { available, state, start, pause, resume, stop } = useGpsTracker();
  const [manual, setManual] = useState(!available);
  const [started, setStarted] = useState(false);
  const distDisplay = units === "imperial" ? kmToMi(state.distanceKm) : state.distanceKm;

  if (manual) {
    return (
      <div className="cardio-player">
        <div className="player-top">
          <button className="link-btn back-link" onClick={onCancel}>
            <ChevronLeft size={16} /> End
          </button>
          {available && (
            <button className="link-btn" onClick={() => setManual(false)}>Use GPS</button>
          )}
        </div>
        <h2 className="cardio-title">{workout.name}</h2>
        <ManualCardioEntry units={units} onSave={onFinish} onCancel={onCancel} />
      </div>
    );
  }

  return (
    <div className="cardio-player">
      <div className="player-top">
        <button className="link-btn back-link" onClick={onCancel}>
          <ChevronLeft size={16} /> End
        </button>
        <button className="link-btn" onClick={() => setManual(true)}>Enter manually</button>
      </div>

      <div className="cardio-stats">
        <div className="cardio-distance">
          {distDisplay.toFixed(2)}
          <span className="cardio-unit">{distanceUnit(units)}</span>
        </div>
        <div className="cardio-sub">
          <div className="cardio-metric">
            <span className="cardio-val">{fmtClock(state.elapsedSec)}</span>
            <span className="cardio-lbl">time</span>
          </div>
          <div className="cardio-metric">
            <span className="cardio-val">{fmtPace(state.paceSecPerKm, units)}</span>
            <span className="cardio-lbl">{paceUnit(units)}</span>
          </div>
        </div>
        {state.autoPaused && <div className="cardio-autopause">Auto-paused</div>}
        {started && !state.gps && <div className="muted small">Waiting for GPS…</div>}
      </div>

      {state.splits.length > 0 && (
        <div className="cardio-splits">
          {state.splits.map((s, i) => (
            <span key={i} className="split-chip">
              {distanceUnit(units)} {i + 1} · {fmtPace(s, units)}
            </span>
          ))}
        </div>
      )}

      <div className="player-controls">
        {!started ? (
          <button className="btn primary block" onClick={() => { setStarted(true); start(); }}>Start</button>
        ) : (
          <>
            <button className="btn" onClick={() => (state.running ? pause() : resume())}>
              {state.running ? "Pause" : "Resume"}
            </button>
            <button className="btn primary" onClick={() => onFinish(stop())}>Finish</button>
          </>
        )}
      </div>
    </div>
  );
}
