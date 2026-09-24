import { useState } from "react";
import type { Exercise, ExerciseSet, PlanMode, Profile, ProgramWorkout, WorkoutKind, WorkoutProgram } from "../types";
import { newId } from "../data/id";
import { normalizeExerciseKey } from "../features/explainers/normalizeKey";
import { validateProgram } from "../features/plan/validate";
import { weightToDisplay, weightToKg, weightUnit } from "../features/units";
import { NumberField } from "./NumberField";
import { CloseIcon } from "./icons";

interface Props {
  program: WorkoutProgram;
  mode: PlanMode;
  injuries: string[];
  units: Profile["units"];
  onSave: (program: WorkoutProgram) => void;
  onCancel: () => void;
}

const KINDS: WorkoutKind[] = ["strength", "run", "bike"];

const clone = (p: WorkoutProgram): WorkoutProgram => structuredClone(p);
const emptySet = (): ExerciseSet => ({ reps: 10, durationSec: null, restSec: 45 });
const emptyExercise = (): Exercise => ({ id: newId(), name: "New exercise", sets: [emptySet()] });

/**
 * Structured editor for a plan's workout program (W6). Edits a working copy and
 * only commits via `onSave` when the result clears the SAME safety rails a
 * generated program does (injury exclusion, one benchmark, size) — a hand-edit
 * can never push an unsafe plan through. The parent persists (whole-doc
 * idempotent `savePlan`).
 */
export function ProgramEditor({ program, mode, injuries, units, onSave, onCancel }: Props) {
  const [draft, setDraft] = useState<WorkoutProgram>(() => clone(program));
  const [errors, setErrors] = useState<string[]>([]);

  const updateWorkout = (wi: number, fn: (pw: ProgramWorkout) => ProgramWorkout) =>
    setDraft((d) => ({ ...d, workouts: d.workouts.map((pw, i) => (i === wi ? fn(pw) : pw)) }));
  const updateExercise = (wi: number, ei: number, fn: (e: Exercise) => Exercise) =>
    updateWorkout(wi, (pw) => ({
      ...pw,
      workout: { ...pw.workout, exercises: pw.workout.exercises.map((e, i) => (i === ei ? fn(e) : e)) },
    }));
  const updateSet = (wi: number, ei: number, si: number, fn: (s: ExerciseSet) => ExerciseSet) =>
    updateExercise(wi, ei, (e) => ({ ...e, sets: e.sets.map((s, i) => (i === si ? fn(s) : s)) }));

  const addWorkout = () =>
    setDraft((d) => ({
      ...d,
      // Land the new workout in the group the user is currently on, so it shows
      // up on the Plan tab immediately (pre-groups drafts fall back to the
      // first training group, matching the legacy derivation).
      workouts: [
        ...d.workouts,
        {
          id: newId(),
          group: d.currentGroup ?? 2,
          workout: { id: newId(), name: "New workout", origin: "user", exercises: [emptyExercise()] },
        },
      ],
    }));
  const removeWorkout = (wi: number) =>
    setDraft((d) => ({ ...d, workouts: d.workouts.filter((_, i) => i !== wi) }));

  const save = () => {
    const reasons = validateProgram(draft, mode, injuries);
    if (reasons.length) {
      setErrors(reasons);
      return;
    }
    onSave(draft);
  };

  const bench = draft.benchmarks[0];

  return (
    <div className="sheet-backdrop" onClick={onCancel}>
      <div className="sheet program-editor" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2>Edit workouts</h2>
          <button className="icon-btn" aria-label="Close" onClick={onCancel}>
            <CloseIcon size={20} />
          </button>
        </header>

        <div className="sheet-body">
          {errors.length > 0 && (
            <div className="editor-errors" role="alert">
              <strong>Can't save yet:</strong>
              <ul>
                {errors.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}

          {bench && (
            <section className="editor-block">
              <div className="section-label">Benchmark</div>
              <label className="field">
                <span>Effort</span>
                <input
                  className="text-input"
                  value={bench.name}
                  aria-label="Benchmark name"
                  onChange={(e) => {
                    const name = e.target.value;
                    setDraft((d) => ({
                      ...d,
                      benchmarks: d.benchmarks.map((b, i) =>
                        i === 0 ? { ...b, name, exerciseKey: normalizeExerciseKey(name) } : b,
                      ),
                    }));
                  }}
                />
              </label>
              <label className="field">
                <span>Target ({bench.unit})</span>
                <NumberField
                  value={bench.target}
                  min={0}
                  max={100000}
                  aria-label="Benchmark target"
                  onChange={(n) =>
                    setDraft((d) => ({
                      ...d,
                      benchmarks: d.benchmarks.map((b, i) => (i === 0 ? { ...b, target: n ?? b.target } : b)),
                    }))
                  }
                />
              </label>
            </section>
          )}

          {draft.workouts.map((pw, wi) => (
            <section key={pw.id} className="editor-block">
              <div className="editor-workout-head">
                <input
                  className="text-input editor-title"
                  value={pw.workout.name}
                  aria-label={`Workout ${wi + 1} name`}
                  onChange={(e) =>
                    updateWorkout(wi, (p) => ({ ...p, workout: { ...p.workout, name: e.target.value } }))
                  }
                />
                <button className="link-btn danger" onClick={() => removeWorkout(wi)} aria-label="Remove workout">
                  Remove
                </button>
              </div>

              <label className="field inline">
                <span>Type</span>
                <select
                  className="select"
                  value={pw.workout.kind ?? "strength"}
                  onChange={(e) =>
                    updateWorkout(wi, (p) => ({
                      ...p,
                      workout: { ...p.workout, kind: e.target.value as WorkoutKind },
                    }))
                  }
                >
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
                {pw.isBenchmark && <span className="benchmark-badge">Benchmark</span>}
              </label>

              {pw.workout.exercises.map((ex, ei) => (
                <div key={ex.id} className="editor-exercise">
                  <div className="editor-exercise-head">
                    <input
                      className="text-input"
                      value={ex.name}
                      aria-label={`Exercise ${ei + 1} name`}
                      onChange={(e) => updateExercise(wi, ei, (x) => ({ ...x, name: e.target.value }))}
                    />
                    <button
                      className="link-btn danger"
                      onClick={() =>
                        updateWorkout(wi, (p) => ({
                          ...p,
                          workout: { ...p.workout, exercises: p.workout.exercises.filter((_, i) => i !== ei) },
                        }))
                      }
                      aria-label="Remove exercise"
                    >
                      ✕
                    </button>
                  </div>

                  {ex.sets.map((s, si) => (
                    <div key={si} className="editor-set">
                      <label className="set-field">
                        <span>Reps</span>
                        <NumberField
                          value={s.reps ?? undefined}
                          min={0}
                          max={100}
                          aria-label="Reps"
                          onChange={(n) => updateSet(wi, ei, si, (x) => ({ ...x, reps: n ?? null }))}
                        />
                      </label>
                      <label className="set-field">
                        <span>{weightUnit(units)}</span>
                        <NumberField
                          value={s.weightKg == null ? undefined : weightToDisplay(s.weightKg, units)}
                          min={0}
                          max={weightToDisplay(500, units)}
                          aria-label="Weight"
                          onChange={(n) =>
                            updateSet(wi, ei, si, (x) => ({
                              ...x,
                              weightKg: n == null ? undefined : Math.round(weightToKg(n, units) * 10) / 10,
                            }))
                          }
                        />
                      </label>
                      <label className="set-field">
                        <span>Sec</span>
                        <NumberField
                          value={s.durationSec ?? undefined}
                          min={0}
                          max={3600}
                          aria-label="Duration seconds"
                          onChange={(n) => updateSet(wi, ei, si, (x) => ({ ...x, durationSec: n ?? null }))}
                        />
                      </label>
                      <label className="set-field">
                        <span>Rest</span>
                        <NumberField
                          value={s.restSec}
                          min={0}
                          max={600}
                          aria-label="Rest seconds"
                          onChange={(n) => updateSet(wi, ei, si, (x) => ({ ...x, restSec: n ?? 0 }))}
                        />
                      </label>
                      <button
                        className="link-btn danger"
                        aria-label="Remove set"
                        onClick={() => updateExercise(wi, ei, (x) => ({ ...x, sets: x.sets.filter((_, i) => i !== si) }))}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <button
                    className="link-btn"
                    onClick={() => updateExercise(wi, ei, (x) => ({ ...x, sets: [...x.sets, emptySet()] }))}
                  >
                    + Add set
                  </button>
                </div>
              ))}

              <button
                className="link-btn"
                onClick={() =>
                  updateWorkout(wi, (p) => ({
                    ...p,
                    workout: { ...p.workout, exercises: [...p.workout.exercises, emptyExercise()] },
                  }))
                }
              >
                + Add exercise
              </button>
            </section>
          ))}

          <button className="btn block" onClick={addWorkout}>
            + Add workout
          </button>
        </div>

        <footer className="sheet-foot">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save plan
          </button>
        </footer>
      </div>
    </div>
  );
}
