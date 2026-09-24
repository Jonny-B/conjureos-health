/**
 * Water, sleep and symptoms in one home-screen card.
 *
 * Three rows rather than three cards: these are quick, low-ceremony logs, and
 * giving each its own panel would push the diary itself off the screen. Water
 * logs inline (one tap, no sheet — the whole point is that it's frictionless);
 * sleep and symptoms open a sheet because they have more than one field.
 */

import { useCallback, useEffect, useState } from "react";
import type { Profile, SleepEntry, SymptomEntry, WaterEntry } from "../types";

type Units = Profile["units"];
import { getRepository } from "../data/repository";
import { reportSaveFailure } from "../data/saveFailure";
import { todayISO } from "../features/diary";
import { formatSleep, sleepMinutes } from "../features/sleep";
import { DEFAULT_WATER_TARGET_ML, fmtWater, totalMl, waterPresets } from "../features/water";
import { SleepSheet } from "./SleepSheet";
import { SymptomSheet } from "./SymptomSheet";
import { CloseIcon } from "./icons";

export function WellbeingCard({
  date,
  units,
  nonce,
  onMutated,
}: {
  date: string;
  units: Units;
  /** Bumped by the parent to force a re-read. */
  nonce: number;
  onMutated: () => void;
}) {
  const [water, setWater] = useState<WaterEntry[]>([]);
  const [sleep, setSleep] = useState<SleepEntry[]>([]);
  const [symptoms, setSymptoms] = useState<SymptomEntry[]>([]);
  const [sheet, setSheet] = useState<"sleep" | "symptom" | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const repo = await getRepository();
    const [w, s, y] = await Promise.all([
      repo.listWater(date).catch(() => []),
      repo.listSleep(date).catch(() => []),
      repo.listSymptoms(date).catch(() => []),
    ]);
    setWater(w);
    setSleep(s);
    setSymptoms(y);
  }, [date]);

  useEffect(() => {
    void load();
  }, [load, nonce]);

  const addWater = async (ml: number) => {
    if (busy) return;
    setBusy(true);
    try {
      const repo = await getRepository();
      await repo.addWater({ date, ml });
      await load();
      onMutated();
    } catch (err) {
      reportSaveFailure("that drink", err);
    } finally {
      setBusy(false);
    }
  };

  // Undo removes the most recent drink, which is what "I tapped that twice"
  // means — an itemised list of identical glasses would be noise.
  const undoWater = async () => {
    const last = water[water.length - 1];
    if (!last || busy) return;
    setBusy(true);
    try {
      const repo = await getRepository();
      await repo.removeWater(last.id);
      await load();
      onMutated();
    } catch (err) {
      reportSaveFailure("that change to your water", err);
    } finally {
      setBusy(false);
    }
  };

  const removeSymptom = async (id: string) => {
    try {
      const repo = await getRepository();
      await repo.removeSymptom(id);
      await load();
      onMutated();
    } catch (err) {
      reportSaveFailure("that change", err);
    }
  };

  const ml = totalMl(water);
  const pct = Math.min(100, Math.round((ml / DEFAULT_WATER_TARGET_ML) * 100));
  const night = sleep[0];
  const minutes = night ? sleepMinutes(night) : 0;
  const isToday = date === todayISO();

  return (
    <section className="home-card wellbeing-card">
      {/* ── Water ── */}
      <div className="wb-row">
        <div className="wb-row-head">
          <span className="wb-label">Water</span>
          <span className="wb-value">
            {fmtWater(ml, units)}
            {water.length > 0 && (
              <button className="wb-undo" aria-label="Undo last drink" onClick={undoWater}>
                <CloseIcon size={13} />
              </button>
            )}
          </span>
        </div>
        <div className="wb-bar" aria-hidden>
          <div className="wb-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="wb-chips">
          {waterPresets(units).map((p) => (
            <button key={p.label} className="chip-btn" disabled={busy} onClick={() => addWater(p.ml)}>
              +{p.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Sleep ── */}
      <button className="wb-row wb-row-tap" onClick={() => setSheet("sleep")}>
        <div className="wb-row-head">
          <span className="wb-label">Sleep</span>
          <span className="wb-value">{night ? formatSleep(minutes) : "Add"}</span>
        </div>
        <div className="muted small wb-sub">
          {night
            ? `${new Date(night.bedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} → ${new Date(night.wakeAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
            : isToday
              ? "How did last night go?"
              : "No sleep recorded for this day"}
        </div>
      </button>

      {/* ── Symptoms ── */}
      <div className="wb-row">
        <div className="wb-row-head">
          <span className="wb-label">How you felt</span>
          <button className="wb-add" onClick={() => setSheet("symptom")}>
            Add
          </button>
        </div>
        {symptoms.length === 0 ? (
          <div className="muted small wb-sub">Headache, heartburn, anything worth remembering.</div>
        ) : (
          <ul className="wb-symptoms">
            {symptoms.map((s) => (
              <li key={s.id}>
                <span className="wb-symptom-time">
                  {new Date(s.loggedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                </span>
                <span className="wb-symptom-label">{s.label}</span>
                {s.severity ? <span className="wb-sev">{s.severity}/5</span> : null}
                <button
                  className="wb-undo"
                  aria-label={`Remove ${s.label}`}
                  onClick={() => removeSymptom(s.id)}
                >
                  <CloseIcon size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {sheet === "sleep" && (
        <SleepSheet
          date={date}
          existing={night ?? null}
          onClose={() => setSheet(null)}
          onSaved={async () => {
            setSheet(null);
            await load();
            onMutated();
          }}
        />
      )}
      {sheet === "symptom" && (
        <SymptomSheet
          date={date}
          onClose={() => setSheet(null)}
          onSaved={async () => {
            setSheet(null);
            await load();
            onMutated();
          }}
        />
      )}
    </section>
  );
}
