import { useCallback, useEffect, useRef, useState } from "react";
import type { ExerciseActual, Plan, Profile, Workout, WorkoutSession } from "../types";
import { buildSteps, newCardioSession, newSessionFrom, type PlayerStep } from "../features/workouts";
import { normalizeExerciseKey } from "../features/explainers/normalizeKey";
import { recordSessionAndAdapt } from "../features/plan/planService";
import { lastSetFor } from "../features/workoutHistory";
import { getRepository } from "../data/repository";
import { ProgressRing } from "../components/rings";
import { SetRecorder, type SetEntry } from "../components/SetRecorder";
import { ExplainerDropdown } from "../components/ExplainerDropdown";
import { CardioPlayer } from "./CardioPlayer";
import { WorkoutSummary } from "./WorkoutSummary";
import { WorkoutOverview } from "./WorkoutOverview";
import { CoachReflect } from "./CoachReflect";
import { BurnEstimate } from "./BurnEstimate";
import { HoldButton } from "../components/HoldButton";
import { ChevronLeft } from "../components/icons";
import { fmtClock } from "../features/units";

// Shared workout helpers — used by both the Workouts library and the Plan tab's
// program section, so they live with the runner that all workouts flow through.

/** Whether a workout routes to the GPS distance tracker rather than the
 *  guided step player. */
export const isCardio = (w: Workout) => w.kind === "run" || w.kind === "bike";
/** Total prescribed sets across every exercise in a workout. */
export const setCount = (w: Workout) => w.exercises.reduce((s, e) => s + e.sets.length, 0);
/** One-line workout subtitle for cards and lists: modality for cardio,
 *  exercise + set counts for strength. */
export function metaLine(w: Workout): string {
  if (isCardio(w)) return w.kind === "run" ? "Run · track distance" : "Bike · track distance";
  return `${w.exercises.length} exercises · ${setCount(w)} sets`;
}

type RunnerView =
  | { screen: "overview" }
  | { screen: "player" }
  | { screen: "cardio" }
  | { screen: "summary"; byExercise: ExerciseActual[]; elapsedSec: number }
  | { screen: "burn"; session: WorkoutSession }
  | { screen: "reflect"; session: WorkoutSession };

/**
 * Runs a single workout end-to-end: overview splash → guided player (strength or
 * cardio) → summary → coach reflection, persisting the session and running the
 * adaptive loop on the way out. Both the Workouts library and the Plan tab's
 * program section mount this to actually run a workout; when the flow ends (or
 * the user backs out of the splash) it calls `onExit` to return to the list.
 */
export function WorkoutRunner({
  workout,
  programWorkoutId,
  benchmarkId,
  benchmarkIds,
  isBenchmark,
  fromPlan,
  plan,
  units,
  onPlanChange,
  onExit,
  onEditWorkouts,
}: {
  workout: Workout;
  /** The plan ProgramWorkout being run — finishing checks it off in its group. */
  programWorkoutId?: string;
  benchmarkId?: string;
  /** All benchmarks this run measures (a multi-part assessment). */
  benchmarkIds?: string[];
  isBenchmark?: boolean;
  fromPlan?: boolean;
  plan: Plan | null;
  units: Profile["units"];
  onPlanChange: (plan: Plan | null) => void;
  onExit: () => void;
  onEditWorkouts?: () => void;
}) {
  const [view, setView] = useState<RunnerView>({ screen: "overview" });

  // Persist a finished session and run the adaptive loop via the plan service
  // (benchmark fold-in + group check-off + periodic AI adaptation), then hand
  // the new plan back up.
  const saveSession = useCallback(
    async (session: WorkoutSession) => {
      const next = await recordSessionAndAdapt(plan, session, { programWorkoutId });
      onPlanChange(next);
    },
    [plan, onPlanChange, programWorkoutId],
  );

  const begin = () => setView({ screen: isCardio(workout) ? "cardio" : "player" });

  if (view.screen === "cardio") {
    return (
      <CardioPlayer
        workout={workout}
        units={units}
        onFinish={(cardio) => {
          const session = newCardioSession(workout, cardio, benchmarkId, benchmarkIds);
          setView({ screen: "burn", session });
        }}
        onCancel={onExit}
      />
    );
  }

  if (view.screen === "player") {
    return (
      <StrengthPlayer
        workout={workout}
        onFinish={(byExercise, elapsedSec) => setView({ screen: "summary", byExercise, elapsedSec })}
        onCancel={onExit}
      />
    );
  }

  if (view.screen === "summary") {
    const { byExercise, elapsedSec } = view;
    return (
      <WorkoutSummary
        workout={workout}
        byExercise={byExercise}
        onContinue={() => {
          const session = newSessionFrom(workout, byExercise, benchmarkId, benchmarkIds, elapsedSec);
          setView({ screen: "burn", session });
        }}
        onDiscard={onExit}
      />
    );
  }

  // Estimate + confirm calories burned, THEN persist (the slow adaptive save
  // runs here, behind the hold-to-finish's busy state) and go to reflection.
  if (view.screen === "burn") {
    const commit = async (session: WorkoutSession) => {
      await saveSession(session);
      setView({ screen: "reflect", session });
    };
    return (
      <BurnEstimate
        session={view.session}
        workout={workout}
        onConfirm={(kcal) => commit({ ...view.session, caloriesBurned: kcal })}
        onSkip={() => commit(view.session)}
      />
    );
  }

  if (view.screen === "reflect") {
    return <CoachReflect session={view.session} onDone={onExit} onPlanChange={onPlanChange} />;
  }

  return (
    <WorkoutOverview
      workout={workout}
      isBenchmark={isBenchmark}
      onBack={onExit}
      onStart={begin}
      onEdit={fromPlan ? onEditWorkouts : undefined}
    />
  );
}

// ── Guided strength player: timers, rest, per-set recording ──────────────

interface ActualBucket extends ExerciseActual {
  order: number;
}

function StrengthPlayer({
  workout,
  onFinish,
  onCancel,
}: {
  workout: Workout;
  onFinish: (byExercise: ExerciseActual[], elapsedSec: number) => void;
  onCancel: () => void;
}) {
  const stepsRef = useRef<PlayerStep[]>(buildSteps(workout));
  const steps = stepsRef.current;
  // Wall-clock workout start, for the calorie estimate (per-set times exclude
  // rest/transitions, so we track the whole session length here).
  const startedAtRef = useRef<number>(Date.now());

  const [index, setIndex] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [running, setRunning] = useState(true);
  // Global pause: an overlay that stops timers and offers Resume or a
  // deliberate hold-to-finish (so a stray tap can't end the workout).
  const [paused, setPaused] = useState(false);
  const [sessions, setSessions] = useState<WorkoutSession[]>([]);
  const [entry, setEntry] = useState<SetEntry>({});
  const step = steps[index];

  const beep = useBeep();

  const actualsRef = useRef<Map<string, ActualBucket>>(new Map());
  const recordedRef = useRef<Set<number>>(new Set());
  const stepStartRef = useRef<string>(new Date().toISOString());
  const indexRef = useRef(0);
  const entryRef = useRef<SetEntry>({});
  useEffect(() => {
    entryRef.current = entry;
  }, [entry]);

  // Load prior sessions once, for "last time" + overload suggestions.
  useEffect(() => {
    let alive = true;
    getRepository()
      .then((r) => r.listWorkoutSessions(200))
      .then((s) => alive && setSessions(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const isRepStep = (s: PlayerStep | undefined): s is Extract<PlayerStep, { kind: "work" }> =>
    s?.kind === "work" && s.durationSec == null;

  // Record the currently-active work step from the entered values (rep/weighted)
  // or the prescribed duration (timed). Idempotent per step index.
  const recordCurrent = useCallback(() => {
    const i = indexRef.current;
    const s = steps[i];
    if (!s || s.kind !== "work" || recordedRef.current.has(i)) return;
    recordedRef.current.add(i);
    const key = normalizeExerciseKey(s.exerciseName);
    const bucket =
      actualsRef.current.get(key) ??
      { exerciseKey: key, name: s.exerciseName, sets: [], order: s.exerciseIndex };
    const timed = s.durationSec != null;
    const e = entryRef.current;
    bucket.sets.push({
      reps: timed ? undefined : e.reps ?? s.reps ?? undefined,
      weightKg: timed ? undefined : e.weightKg ?? s.weightKg,
      durationSec: timed ? s.durationSec ?? undefined : undefined,
      rpe: e.rpe,
      startedAt: stepStartRef.current,
      completedAt: new Date().toISOString(),
    });
    actualsRef.current.set(key, bucket);
  }, [steps]);

  const buildByExercise = (): ExerciseActual[] =>
    [...actualsRef.current.values()]
      .sort((a, b) => a.order - b.order)
      .map((e) => ({ exerciseKey: e.exerciseKey, name: e.name, sets: e.sets }));

  const advance = useCallback(() => {
    recordCurrent();
    setIndex((i) => {
      const next = i + 1;
      return next >= steps.length ? i : next;
    });
  }, [recordCurrent, steps.length]);

  const finish = useCallback(() => {
    recordCurrent();
    const by = buildByExercise();
    const elapsedSec = Math.round((Date.now() - startedAtRef.current) / 1000);
    if (by.length === 0) onCancel();
    else onFinish(by, elapsedSec);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordCurrent, onCancel, onFinish]);

  // Initialize each step: countdown for timed/rest, prefill the recorder for
  // rep sets from the prescription then last time.
  useEffect(() => {
    if (!step) return;
    indexRef.current = index;
    stepStartRef.current = new Date().toISOString();
    if (step.kind === "rest") setSecondsLeft(step.durationSec);
    else if (step.durationSec != null) setSecondsLeft(step.durationSec);
    else setSecondsLeft(null);
    setRunning(true);
    if (isRepStep(step)) {
      const last = lastSetFor(sessions, normalizeExerciseKey(step.exerciseName));
      setEntry({
        reps: step.reps ?? last?.reps ?? undefined,
        weightKg: step.weightKg ?? last?.weightKg ?? undefined,
      });
    } else {
      setEntry({});
    }
  }, [index, step, sessions]);

  // 1 Hz countdown tick for timed work + rest.
  useEffect(() => {
    if (!running || secondsLeft == null) return;
    if (secondsLeft <= 0) {
      beep(step?.kind === "rest" ? "high" : "low");
      advance();
      return;
    }
    if (secondsLeft <= 3) beep("tick");
    const t = setTimeout(() => setSecondsLeft((s) => (s == null ? s : s - 1)), 1000);
    return () => clearTimeout(t);
  }, [running, secondsLeft, advance, beep, step?.kind]);

  if (!step) return null;

  const isLast = index === steps.length - 1;
  const totalWork = steps.filter((s) => s.kind === "work").length;
  const workDone = steps.slice(0, index + 1).filter((s) => s.kind === "work").length;
  const dur = step.durationSec ?? null;
  const ringPct = dur != null && dur > 0 ? ((dur - (secondsLeft ?? dur)) / dur) * 100 : 100;

  const frameTone = step.kind === "rest" ? "rest" : isRepStep(step) ? "reps" : "timed";

  return (
    <div className={`player ${step.kind} ${frameTone}`}>
      <div className="player-top">
        <button className="link-btn back-link" onClick={() => { setPaused(true); setRunning(false); }}>
          <ChevronLeft size={16} /> Pause
        </button>
        <span className="player-progress">
          Set {Math.min(workDone, totalWork)} / {totalWork}
        </span>
      </div>

      {paused && (
        <div className="pause-overlay" role="dialog" aria-label="Workout paused">
          <div className="pause-card">
            <h2>Paused</h2>
            <button
              className="btn primary block"
              onClick={() => { setPaused(false); setRunning(true); }}
            >
              Resume
            </button>
            <HoldButton label="Hold to finish" className="btn block" onComplete={finish} />
            <button className="link-btn danger-text" onClick={onCancel}>
              Discard workout
            </button>
          </div>
        </div>
      )}

      {step.kind === "work" ? (
        <div className="player-body">
          <div className="player-phase">EXERCISE</div>
          <h2 className="player-exercise">{step.exerciseName}</h2>
          <div className="player-setline">
            Set {step.setIndex + 1} of {step.setCount}
          </div>

          {step.durationSec != null ? (
            <ProgressRing pct={ringPct} tone="accent">
              <div className="timer big">{fmtClock(secondsLeft ?? step.durationSec)}</div>
            </ProgressRing>
          ) : (
            <SetRecorder
              prescribed={{ reps: step.reps, weightKg: step.weightKg, durationSec: step.durationSec }}
              last={lastSetFor(sessions, normalizeExerciseKey(step.exerciseName))}
              value={entry}
              onChange={setEntry}
            />
          )}

          {step.notes && <div className="player-notes">{step.notes}</div>}
          <ExplainerDropdown name={step.exerciseName} />
        </div>
      ) : (
        <div className="player-body">
          <div className="player-phase">REST</div>
          <ProgressRing pct={ringPct} tone="rest">
            <div className="timer big rest">{fmtClock(secondsLeft ?? step.durationSec)}</div>
          </ProgressRing>
          <div className="player-next">Next: {step.nextExerciseName}</div>
        </div>
      )}

      <div className="player-controls">
        {isRepStep(step) ? (
          <button className="btn primary block" onClick={isLast ? finish : advance}>
            {isLast ? "Finish" : "Done set"}
          </button>
        ) : (
          <>
            <button className="btn" onClick={() => setRunning((r) => !r)}>
              {running ? "Pause" : "Resume"}
            </button>
            <button className="btn" onClick={isLast ? finish : advance}>
              {isLast ? "Finish" : "Skip"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** WebAudio cue generator — short beeps for ticks + phase transitions. No
 *  asset files; tones are synthesized so the bundle stays tiny. */
function useBeep() {
  const ctxRef = useRef<AudioContext | null>(null);
  return useCallback((kind: "tick" | "low" | "high") => {
    try {
      const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = (ctxRef.current ??= new Ctor());
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = kind === "high" ? 880 : kind === "low" ? 440 : 660;
      gain.gain.value = 0.0008;
      osc.connect(gain).connect(ctx.destination);
      const now = ctx.currentTime;
      gain.gain.exponentialRampToValueAtTime(0.15, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0008, now + (kind === "tick" ? 0.08 : 0.2));
      osc.start(now);
      osc.stop(now + (kind === "tick" ? 0.09 : 0.22));
    } catch {
      /* audio is best-effort */
    }
  }, []);
}
