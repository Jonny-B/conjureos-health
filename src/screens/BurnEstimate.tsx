import { useEffect, useState } from "react";
import type { Profile, Workout, WorkoutSession } from "../types";
import { getRepository } from "../data/repository";
import { estimateWorkoutBurn, sessionMinutes, type BurnEstimateResult } from "../features/calories";
import { NumberField } from "../components/NumberField";
import { AiEstimateBadge } from "../components/AiEstimateBadge";
import { HoldButton } from "../components/HoldButton";

/**
 * Post-workout step: estimate calories burned (local formula → AI fallback),
 * let the user confirm or adjust, then add it to today's calorie ring. Shown
 * after the workout finishes, before the coach reflection. `onConfirm` runs the
 * (slow) session save, so the commit is a hold-to-finish with a busy state.
 */
export function BurnEstimate({
  session,
  workout,
  onConfirm,
  onSkip,
}: {
  session: WorkoutSession;
  workout: Workout;
  onConfirm: (kcal: number) => Promise<void>;
  onSkip: () => Promise<void>;
}) {
  const [est, setEst] = useState<BurnEstimateResult | null>(null);
  const [kcal, setKcal] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const minutes = Math.round(sessionMinutes(session));

  useEffect(() => {
    let alive = true;
    (async () => {
      const repo = await getRepository();
      const profile: Profile | null = await repo.getProfile().catch(() => null);
      const result = await estimateWorkoutBurn(session, workout, profile);
      if (alive) {
        setEst(result);
        setKcal(result.kcal);
      }
    })();
    return () => {
      alive = false;
    };
  }, [session, workout]);

  const commit = async () => {
    setBusy(true);
    try {
      await onConfirm(Math.max(0, Math.round(kcal ?? est?.kcal ?? 0)));
    } catch {
      setBusy(false); // parent unmounts on success; re-enable if it failed
    }
  };
  const skip = async () => {
    setBusy(true);
    try {
      await onSkip();
    } catch {
      setBusy(false);
    }
  };

  const loading = est == null;

  return (
    <div className="mode-body burn-estimate">
      <div className="summary-head">
        <h1>Calories burned</h1>
        <p className="muted">{workout.name}</p>
      </div>

      {loading ? (
        <div className="center-fill">
          <div className="spinner" />
          <p className="muted small">Estimating…</p>
        </div>
      ) : (
        <>
          <div className="burn-figure">
            <div className="big-stat">
              <span className="big-number">{kcal ?? est.kcal}</span>
              <span className="big-unit">kcal</span>
            </div>
            {est.method === "ai" ? (
              <AiEstimateBadge />
            ) : (
              <span className="muted small">Estimated{minutes > 0 ? ` · ${minutes} min` : ""}</span>
            )}
          </div>

          <label className="field burn-adjust">
            <span>Adjust if this looks off</span>
            <NumberField value={kcal} min={0} max={5000} onChange={setKcal} aria-label="Calories burned" />
          </label>

          <p className="muted small">
            This is an estimate from your workout and stats — it gets added back into today's
            calorie budget.
          </p>

          <div className="wizard-nav burn-actions">
            <button className="btn" onClick={() => void skip()} disabled={busy}>
              Skip
            </button>
            <HoldButton
              label="Hold to add & finish"
              holdingLabel="Keep holding…"
              busyLabel="Saving…"
              busy={busy}
              onComplete={() => void commit()}
              className="btn primary"
            />
          </div>
        </>
      )}
    </div>
  );
}
