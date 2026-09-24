import { useEffect, useState } from "react";
import type { ExerciseActual, Workout, WorkoutSession } from "../types";
import { getRepository } from "../data/repository";
import { detectPRs, formatSet, summarize } from "../features/workoutHistory";
import { CheckIcon } from "../components/icons";

interface Props {
  workout: Workout;
  byExercise: ExerciseActual[];
  /** Advance to the calorie-burn estimate step (the terminal save happens there). */
  onContinue: () => void;
  onDiscard: () => void;
}

/**
 * End-of-workout stats: sets, reps, volume, time, PR callouts, and a per-
 * exercise breakdown. Loads prior sessions itself so PRs compare against
 * history that excludes this (not-yet-saved) session.
 */
export function WorkoutSummary({ workout, byExercise, onContinue, onDiscard }: Props) {
  const [prior, setPrior] = useState<WorkoutSession[] | null>(null);

  useEffect(() => {
    let alive = true;
    getRepository()
      .then((r) => r.listWorkoutSessions(200))
      .then((s) => alive && setPrior(s))
      .catch(() => alive && setPrior([]));
    return () => {
      alive = false;
    };
  }, []);

  const stats = summarize(byExercise);
  const prs = prior ? detectPRs(byExercise, prior) : [];
  const mins = Math.max(1, Math.round(stats.totalWorkSec / 60));

  return (
    <div className="mode-body workout-summary">
      <div className="summary-head">
        <h1>Nice work!</h1>
        <p className="muted">{workout.name}</p>
      </div>

      <div className="summary-stats">
        <Stat label="Sets" value={stats.totalSets} />
        <Stat label="Reps" value={stats.totalReps} />
        <Stat label="Volume" value={`${Math.round(stats.totalVolumeKg)} kg`} />
        <Stat label="Time" value={`${mins} min`} />
      </div>

      {prs.length > 0 && (
        <div className="summary-prs">
          {prs.map((pr) => (
            <div className="pr-badge" key={pr.exerciseKey}>
              🏆 New PR — {pr.name}:{" "}
              {pr.kind === "weight" ? `${pr.value} kg` : pr.kind === "hold" ? `${pr.value}s` : `${pr.value} reps`}
            </div>
          ))}
        </div>
      )}

      <ul className="summary-exercises">
        {byExercise.map((ex) => (
          <li key={ex.exerciseKey} className="summary-ex">
            <div className="summary-ex-name">{ex.name}</div>
            <div className="summary-ex-sets">
              {ex.sets.map((s, i) => (
                <span key={i} className="summary-set">{formatSet(s)}</span>
              ))}
            </div>
          </li>
        ))}
      </ul>

      <div className="wizard-nav">
        <button className="btn" onClick={onDiscard}>Discard</button>
        <button className="btn primary" onClick={onContinue}>
          <CheckIcon size={16} /> Continue
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="summary-stat">
      <span className="summary-stat-value">{value}</span>
      <span className="summary-stat-label">{label}</span>
    </div>
  );
}
