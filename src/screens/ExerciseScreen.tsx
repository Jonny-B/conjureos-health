import { useEffect, useState } from "react";
import { formatDay, todayISO } from "../features/diary";
import { fmtDuration } from "../features/units";
import {
  listCompletedWorkouts,
  removeSession,
  setSessionKcal,
  excludeWearable,
  restoreWearable,
  setWearableKcal,
  addManualExercise,
  manualExerciseProblem,
  type CompletedWorkout,
} from "../features/exercise";
import { NumberField } from "../components/NumberField";
import { CloseIcon, TrashIcon } from "../components/icons";

/**
 * The exercise behind the calorie ring's Exercise row: one day's exercise from
 * every source — added here by hand, synced from Apple Health or another
 * wearable, or logged by another app (a fitness app, say) through the
 * `logWorkout` action. Its calories are added back to the day's budget, so the
 * user must be able to see them, correct them, and remove what's wrong
 * (wearable removals are local + reversible; see features/exercise).
 *
 * Workouts themselves — a library, a player, a program — are not part of
 * Conjure Health; they live in a separate fitness app.
 */
export function ExerciseScreen({
  date = todayISO(),
  nonce = 0,
  onMutated,
}: {
  date?: string;
  nonce?: number;
  onMutated?: () => void;
}) {
  return (
    <div className="exercise-screen">
      <h1 className="screen-title">Exercise</h1>
      <p className="muted small">
        Exercise you add here, sync from Apple Health or another wearable, or log from another app.
        Calories burned are added back to your daily budget. Edit or remove anything that looks wrong.
      </p>
      <CompletedToday date={date} nonce={nonce} onMutated={onMutated} />
    </div>
  );
}

function CompletedToday({
  date,
  nonce,
  onMutated,
}: {
  date: string;
  nonce: number;
  onMutated?: () => void;
}) {
  const [items, setItems] = useState<CompletedWorkout[] | null>(null);
  const [editing, setEditing] = useState<CompletedWorkout | null>(null);
  const [adding, setAdding] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    listCompletedWorkouts(date)
      .then((r) => alive && setItems(r))
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, [date, nonce, tick]);

  const refresh = () => {
    setTick((t) => t + 1);
    onMutated?.();
  };

  const active = (items ?? []).filter((i) => !i.excluded);
  const removed = (items ?? []).filter((i) => i.excluded);
  const total = active.reduce((n, i) => n + (i.kcal || 0), 0);
  // Name the day when it isn't today: this screen adds to whichever day the
  // diary is showing, and a walk filed under yesterday never moves today's ring.
  const heading = date === todayISO() ? "Completed today" : `Completed on ${formatDay(date)}`;

  const addButton = (
    <button className="btn primary block add-exercise-btn" onClick={() => setAdding(true)}>
      Add exercise
    </button>
  );
  const addModal = adding && (
    <AddExerciseModal
      date={date}
      hasWearable={(items ?? []).some((i) => i.source === "wearable" && !i.excluded)}
      onClose={() => setAdding(false)}
      onDone={() => {
        setAdding(false);
        refresh();
      }}
    />
  );

  if (items && items.length === 0) {
    return (
      <section className="completed-today">
        <h2 className="screen-subtitle">{heading}</h2>
        <p className="muted small">No exercise logged for this day yet.</p>
        {addButton}
        {addModal}
      </section>
    );
  }

  return (
    <section className="completed-today">
      <div className="completed-head">
        <h2 className="screen-subtitle">{heading}</h2>
        {active.length > 0 && <span className="completed-total">{total} cal</span>}
      </div>

      {items == null ? (
        <div className="spinner" />
      ) : (
        <ul className="completed-list">
          {active.map((it) => (
            <li key={it.key} className="completed-row">
              <div className="completed-main">
                <div className="completed-name">
                  {it.name}
                  <span className={`source-pill source-${it.source}`}>{it.sourceLabel}</span>
                </div>
                <div className="completed-meta muted small">
                  {[fmtDuration(it.durationSec), `${it.kcal} cal`].filter(Boolean).join(" · ")}
                </div>
              </div>
              <div className="completed-actions">
                <button className="link-btn" onClick={() => setEditing(it)}>
                  Edit
                </button>
                <button
                  className="icon-btn danger-text"
                  aria-label={`${it.source === "app" ? "Delete" : "Remove"} ${it.name}`}
                  onClick={async () => {
                    if (it.source === "app") await removeSession(it.key);
                    else await excludeWearable(date, it.key);
                    refresh();
                  }}
                >
                  <TrashIcon size={18} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {removed.length > 0 && (
        <details className="removed-block">
          <summary className="muted small">Removed from total ({removed.length})</summary>
          <ul className="completed-list">
            {removed.map((it) => (
              <li key={it.key} className="completed-row removed">
                <div className="completed-main">
                  <div className="completed-name">
                    {it.name}
                    <span className={`source-pill source-${it.source}`}>{it.sourceLabel}</span>
                  </div>
                  <div className="completed-meta muted small">{it.kcal} cal · not counted</div>
                </div>
                <button
                  className="link-btn"
                  onClick={async () => {
                    await restoreWearable(date, it.key);
                    refresh();
                  }}
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {items != null && addButton}
      {addModal}

      {editing && (
        <CompletedEditModal
          date={date}
          item={editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </section>
  );
}

/**
 * Log an exercise by hand: name, optional minutes, calories burned. Calories
 * are typed in rather than estimated, so adding one never costs anything.
 */
function AddExerciseModal({
  date,
  hasWearable,
  onClose,
  onDone,
}: {
  date: string;
  hasWearable: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [minutes, setMinutes] = useState<number | undefined>(undefined);
  const [kcal, setKcal] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const input = { name, durationMin: minutes, calories: kcal ?? 0 };
    const problem = manualExerciseProblem({ ...input, calories: kcal });
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await addManualExercise(date, input);
      onDone();
    } catch {
      setError("Couldn't save this exercise. Nothing was added. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet compact" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2>Add exercise</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon size={20} />
          </button>
        </header>
        <div className="sheet-body">
          <label className="field">
            <span>What did you do?</span>
            <input
              className="text-input"
              type="text"
              value={name}
              maxLength={60}
              placeholder="e.g. Evening walk"
              onChange={(e) => setName(e.target.value)}
              aria-label="Exercise name"
            />
          </label>
          <label className="field">
            <span>Minutes (optional)</span>
            <NumberField value={minutes} min={0} max={1440} onChange={setMinutes} aria-label="Minutes" />
          </label>
          <label className="field">
            <span>Calories burned</span>
            <NumberField value={kcal} min={0} max={5000} onChange={setKcal} aria-label="Calories burned" />
          </label>
          {hasWearable && (
            <p className="muted small">
              If your watch already synced this workout, adding it here counts it twice. Edit the synced one
              instead.
            </p>
          )}
          {error && <div className="notice notice-error" role="alert">{error}</div>}
        </div>
        <footer className="sheet-foot">
          <button className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Add"}
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Edit a completed workout's burned calories, or remove it from the day. In-app
 * sessions are saved/deleted for real; wearable workouts get a local kcal
 * override / exclusion (we can't write back to Apple Health).
 */
function CompletedEditModal({
  date,
  item,
  onClose,
  onDone,
}: {
  date: string;
  item: CompletedWorkout;
  onClose: () => void;
  onDone: () => void;
}) {
  const [kcal, setKcal] = useState<number | undefined>(item.kcal);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const v = Math.max(0, Math.round(kcal ?? 0));
      if (item.source === "app") await setSessionKcal(item.key, v);
      else await setWearableKcal(date, item.key, v);
      onDone();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      if (item.source === "app") await removeSession(item.key);
      else await excludeWearable(date, item.key);
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet compact" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2>{item.name}</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon size={20} />
          </button>
        </header>
        <div className="sheet-body">
          <p className="muted small">
            {item.source === "app"
              ? "Your in-app workout."
              : `From ${item.sourceLabel}. Editing here only changes what ConjureOS counts — it won't change Apple Health.`}
          </p>
          <label className="field">
            <span>Calories burned</span>
            <NumberField value={kcal} min={0} max={5000} onChange={setKcal} aria-label="Calories burned" />
          </label>
        </div>
        <footer className="sheet-foot">
          <button className="btn danger" disabled={busy} onClick={() => void remove()}>
            <TrashIcon size={16} /> {item.source === "app" ? "Delete" : "Remove"}
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}
