import type { Workout } from "../types";
import { ExplainerDropdown } from "../components/ExplainerDropdown";
import { ChevronLeft, PlayIcon } from "../components/icons";
import { fmtSeconds } from "../features/units";

/**
 * Pre-workout splash — shown when a workout is tapped, before the guided
 * player starts. Gives an overview (description + the full exercise list with
 * how-to explainers) and an explicit Start / Back so you're never dropped
 * straight into a running session.
 *
 * Built as the seam for pre-start editing: the exercise list is its own
 * component and the footer already reserves room for an "Edit" action
 * (wired for plan workouts via `onEdit`). A future slice can turn the rows
 * into add/remove/reorder controls without touching the player or the list.
 */

const isCardio = (w: Workout) => w.kind === "run" || w.kind === "bike";

/** "3 × 10" / "4 × 30s" / "3 × 10 @ 12kg" for a set list. */
function setSummary(sets: Workout["exercises"][number]["sets"]): string {
  if (!sets.length) return "";
  const s = sets[0]!;
  const per = s.durationSec != null ? fmtSeconds(s.durationSec) : s.reps != null ? `${s.reps}` : "";
  const base = per ? `${sets.length} × ${per}` : `${sets.length} sets`;
  return s.weightKg ? `${base} @ ${s.weightKg}kg` : base;
}

/** Rough session-length estimate (work + rest) in whole minutes. */
function estimateMinutes(w: Workout): number {
  if (isCardio(w)) {
    const km = w.cardioTarget?.distanceKm;
    if (km) return Math.max(5, Math.round(km * (w.kind === "bike" ? 2.5 : 6)));
    const sec = w.cardioTarget?.durationSec;
    return sec ? Math.round(sec / 60) : 20;
  }
  let sec = 0;
  for (const e of w.exercises) {
    for (const set of e.sets) {
      sec += set.durationSec ?? (set.reps != null ? set.reps * 3 : 30);
      sec += set.restSec ?? 0;
    }
  }
  return Math.max(1, Math.round(sec / 60));
}

/** Pre-workout splash: what the session trains, its exercises, and an
 *  estimated duration, gating the actual start behind an explicit tap. */
export function WorkoutOverview({
  workout,
  isBenchmark,
  onStart,
  onBack,
  onEdit,
}: {
  workout: Workout;
  isBenchmark?: boolean;
  onStart: () => void;
  onBack: () => void;
  /** Present for plan workouts — opens the program editor. */
  onEdit?: () => void;
}) {
  const cardio = isCardio(workout);
  const setTotal = workout.exercises.reduce((n, e) => n + e.sets.length, 0);
  const description = workout.description ?? workout.summary ?? "A guided session — take it at your own pace.";

  return (
    <div className="mode-body workout-overview">
      <div className="player-top">
        <button className="link-btn back-link" onClick={onBack}>
          <ChevronLeft size={16} /> Back
        </button>
      </div>

      <div className="overview-head">
        <h1 className="overview-title">
          {workout.name}
          {isBenchmark && <span className="benchmark-badge">Evaluation</span>}
        </h1>
        <div className="overview-meta">
          {cardio ? (
            <span className="overview-chip">{workout.kind === "bike" ? "Bike" : "Run"}</span>
          ) : (
            <>
              <span className="overview-chip">{workout.exercises.length} exercises</span>
              <span className="overview-chip">{setTotal} sets</span>
            </>
          )}
          <span className="overview-chip">~{estimateMinutes(workout)} min</span>
        </div>
      </div>

      <p className="overview-description">{description}</p>

      {!cardio && workout.exercises.length > 0 && (
        <div className="overview-exercises">
          <div className="section-label">Exercises</div>
          <ul className="overview-ex-list">
            {workout.exercises.map((e) => (
              <li className="overview-ex" key={e.id}>
                <div className="overview-ex-row">
                  <span className="overview-ex-name">{e.name}</span>
                  <span className="overview-ex-sets">{setSummary(e.sets)}</span>
                </div>
                {e.notes && <div className="overview-ex-notes">{e.notes}</div>}
                <ExplainerDropdown name={e.name} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {cardio && workout.cardioTarget?.distanceKm != null && (
        <div className="overview-exercises">
          <div className="section-label">Target</div>
          <div className="muted">
            {workout.cardioTarget.distanceKm} km — tracked by GPS for distance and pace.
          </div>
        </div>
      )}

      <div className="overview-actions">
        {onEdit && (
          <button className="btn" onClick={onEdit}>
            Edit exercises
          </button>
        )}
        <button className="btn primary block overview-start" onClick={onStart}>
          <PlayIcon size={16} /> Start workout
        </button>
      </div>
    </div>
  );
}
