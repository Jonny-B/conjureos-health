import { useState } from "react";
import type { CardioActual, Profile } from "../types";
import { distanceUnit, miToKm } from "../features/units";
import { NumberField } from "./NumberField";

interface Props {
  units: Profile["units"];
  onSave: (cardio: CardioActual) => void;
  onCancel: () => void;
}

/** Distance + duration entry — the universal cardio fallback (no GPS, denied
 *  permission, tunnels, or the mobile WebView until native GPS lands). */
export function ManualCardioEntry({ units, onSave, onCancel }: Props) {
  const [dist, setDist] = useState<number | undefined>(undefined);
  const [minutes, setMinutes] = useState<number | undefined>(undefined);
  const valid = (dist ?? 0) > 0 && (minutes ?? 0) > 0;

  const save = () => {
    const distanceKm = units === "imperial" ? miToKm(dist!) : dist!;
    const durationSec = Math.round(minutes! * 60);
    onSave({
      distanceKm,
      durationSec,
      avgPaceSecPerKm: distanceKm > 0.05 ? Math.round(durationSec / distanceKm) : undefined,
      source: "manual",
    });
  };

  return (
    <div className="mode-body manual-cardio">
      <label className="field">
        <span className="field-label">Distance ({distanceUnit(units)})</span>
        <NumberField value={dist} min={0} max={500} onChange={setDist} aria-label="Distance" />
      </label>
      <label className="field">
        <span className="field-label">Duration (minutes)</span>
        <NumberField value={minutes} min={0} max={1000} onChange={setMinutes} aria-label="Duration in minutes" />
      </label>
      <div className="wizard-nav">
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn primary" disabled={!valid} onClick={save}>Save</button>
      </div>
    </div>
  );
}
