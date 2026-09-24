/**
 * Compact weight card for the home screen: latest weight, overall change, a
 * trend sparkline, and an inline quick-log. Reads/writes the same repository
 * methods as the full Weight screen; storage stays metric, display honors the
 * profile's units.
 */

import { useEffect, useState } from "react";
import type { Profile, WeightEntry } from "../types";
import { getRepository } from "../data/repository";
import { todayISO } from "../features/diary";
import { weightToDisplay, weightToKg, weightUnit } from "../features/units";
import { Sparkline } from "./Sparkline";

/**
 * The weight to show, in kg: the newest real weigh-in, or null when the user
 * hasn't logged one yet. We deliberately do NOT fall back to the profile's
 * stored weight here. The profile number is entered in a unit-typed field and,
 * for a value captured while the app was in metric, can be a pounds figure
 * sitting in the kilograms slot — rendering it ×2.2046 produced the phantom
 * "399 lb default" a user with zero weigh-ins would see. The trend cards are
 * for *tracked* weight, so with no weigh-in they show an empty prompt, never a
 * fabricated stat.
 */
export function pickWeightKg(weights: WeightEntry[]): number | null {
  return weights[0]?.weightKg ?? null;
}

/** Home-screen weigh-in card: latest weight, trend, and a quick-add field.
 *  Bump `nonce` to force a re-read after an external write (e.g. a reset). */
export function WeightCard({ profile, nonce = 0 }: { profile: Profile | null; nonce?: number }) {
  const [weights, setWeights] = useState<WeightEntry[]>([]);
  const [input, setInput] = useState("");
  const units = profile?.units ?? "metric";

  const reload = async () => {
    const repo = await getRepository();
    setWeights(await repo.listWeights());
  };
  // Re-read on any app-wide write nonce bump too — e.g. after "Reset health
  // data" clears the weight history while this card is mounted underneath.
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  const add = async () => {
    const shown = Number(input);
    if (!Number.isFinite(shown) || shown <= 0) return;
    const kg = weightToKg(shown, units);
    const repo = await getRepository();
    // Store kg to 2 decimals so a 1-decimal lb entry (0.1 lb ≈ 0.045 kg) round-trips.
    await repo.upsertWeight({ date: todayISO(), weightKg: Math.round(kg * 100) / 100 });
    setInput("");
    await reload();
  };

  const latest = weights[0];
  const oldest = weights[weights.length - 1];
  const changeKg = latest && oldest && weights.length > 1 ? latest.weightKg - oldest.weightKg : 0;
  const changeDisplay =
    units === "imperial"
      ? Math.round(changeKg * 2.2046226218 * 10) / 10
      : Math.round(changeKg * 10) / 10;

  // Show a stat only for a real weigh-in; otherwise the empty prompt below.
  const latestKg = pickWeightKg(weights);

  return (
    <section className="home-card weight-card">
      <div className="home-card-head">
        <span className="home-card-title">Weight</span>
        {weights.length > 1 && (
          <span className={`home-card-chip ${changeKg <= 0 ? "good" : "bad"}`}>
            {changeKg > 0 ? "+" : ""}
            {changeDisplay} {weightUnit(units)}
          </span>
        )}
      </div>
      {latestKg == null ? (
        <div className="weight-empty muted">Log your first weigh-in to start tracking.</div>
      ) : (
        <div className="weight-card-body">
          <div className="big-stat">
            <span className="big-number">{weightToDisplay(latestKg, units)}</span>
            <span className="big-unit">{weightUnit(units)}</span>
          </div>
          <Sparkline points={[...weights].reverse().map((w) => w.weightKg)} />
        </div>
      )}
      <div className="row gap weigh-in">
        <input
          className="text-input"
          type="number"
          inputMode="decimal"
          placeholder={`Today's weight (${weightUnit(units)})`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button className="btn primary" disabled={!input} onClick={add}>
          Log
        </button>
      </div>
    </section>
  );
}
