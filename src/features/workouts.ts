/**
 * Workout library + player sequencing.
 *
 * v1 ships a small built-in library (no persistence) so the guided player —
 * the part with real value: set timers, rest timers, audio cues — is usable
 * immediately. Saved/custom workouts and exercise history are the next slice
 * and would route through the repository like the diary does.
 */

import type { CardioActual, Exercise, ExerciseActual, ExerciseSet, Workout, WorkoutSession } from "../types";
import { newId } from "../data/id";
import { todayISO } from "./diary";

let n = 0;
const id = () => `seed-${n++}`;

function repSet(reps: number, restSec: number, weightKg?: number) {
  return { reps, durationSec: null, restSec, ...(weightKg ? { weightKg } : {}) };
}
function timedSet(durationSec: number, restSec: number) {
  return { reps: null, durationSec, restSec };
}
function ex(name: string, sets: Exercise["sets"], notes?: string): Exercise {
  return { id: id(), name, sets, ...(notes ? { notes } : {}) };
}

/** The seed workout library every user starts with, so the Workouts tab is
 *  useful before any plan exists. Static data — never mutated at runtime. */
export const BUILT_IN_WORKOUTS: Workout[] = [
  {
    id: "full-body-no-equipment",
    name: "Full-Body Express",
    summary: "20 min · no equipment · bodyweight",
    description:
      "A quick full-body circuit you can do anywhere — no equipment needed. It warms you up, then hits legs, chest, and core so you get a complete session in about 20 minutes. Move at a steady pace and scale any movement to your level.",
    exercises: [
      ex("Jumping Jacks", [timedSet(40, 20), timedSet(40, 20)], "Steady pace, full range."),
      ex("Bodyweight Squats", [repSet(15, 30), repSet(15, 30), repSet(15, 45)], "Sit back, chest up."),
      ex("Push-ups", [repSet(12, 30), repSet(12, 30), repSet(10, 45)], "Knees down to scale."),
      ex("Plank", [timedSet(45, 30), timedSet(45, 30)], "Squeeze glutes, neutral spine."),
      ex("Reverse Lunges", [repSet(10, 30), repSet(10, 45)], "Each leg."),
    ],
  },
  {
    id: "core-finisher",
    name: "Core Finisher",
    summary: "10 min · no equipment · abs",
    description:
      "A short, focused core burner to tack onto the end of any session — or do on its own. Four ab-focused movements with minimal rest to keep the intensity up. Keep your movements controlled and your lower back supported.",
    exercises: [
      ex("Crunches", [repSet(20, 20), repSet(20, 20)]),
      ex("Bicycle Kicks", [timedSet(40, 20), timedSet(40, 20)]),
      ex("Leg Raises", [repSet(12, 25), repSet(12, 25)]),
      ex("Side Plank", [timedSet(30, 15), timedSet(30, 30)], "Each side."),
    ],
  },
  {
    id: "dumbbell-upper",
    name: "Dumbbell Upper",
    summary: "25 min · dumbbells · push/pull",
    description:
      "An upper-body strength session built around a pair of dumbbells, balancing pushing and pulling movements for the chest, back, shoulders, and arms. Pick a weight that challenges the last few reps of each set, and rest fully between sets.",
    exercises: [
      ex("Dumbbell Press", [repSet(10, 60, 12), repSet(10, 60, 12), repSet(8, 75, 14)]),
      ex("Bent-Over Row", [repSet(10, 60, 12), repSet(10, 60, 12), repSet(8, 75, 14)]),
      ex("Shoulder Press", [repSet(10, 60, 8), repSet(10, 75, 8)]),
      ex("Bicep Curls", [repSet(12, 45, 8), repSet(12, 60, 8)]),
    ],
  },
  {
    id: "morning-run",
    name: "Morning Run",
    summary: "Cardio · GPS distance + pace",
    description:
      "A steady outdoor run tracked by GPS for distance and pace. Great for building aerobic base and clearing your head. Start easy, settle into a conversational effort, and let the pace come to you.",
    kind: "run",
    cardioTarget: { distanceKm: 5 },
    exercises: [],
  },
  {
    id: "bike-ride",
    name: "Bike Ride",
    summary: "Cardio · GPS distance",
    description:
      "A GPS-tracked ride for low-impact cardio that's easy on the joints. Keep a smooth, steady cadence and use the distance goal to pace yourself.",
    kind: "bike",
    cardioTarget: { distanceKm: 15 },
    exercises: [],
  },
];

/**
 * One screen of the guided workout player. `buildSteps` flattens a workout's
 * exercises and sets into this linear sequence — a work step per set, with
 * rest steps interleaved — so the player is a simple index into an array.
 */
export type PlayerStep =
  | {
      kind: "work";
      exerciseName: string;
      exerciseIndex: number;
      setIndex: number;
      setCount: number;
      reps: number | null;
      durationSec: number | null;
      weightKg?: number;
      notes?: string;
    }
  | { kind: "rest"; durationSec: number; nextExerciseName: string };

/**
 * Assemble a persistable WorkoutSession from a workout + the sets the player
 * recorded. Keeps the legacy flat `planned`/`actual` arrays populated (from the
 * prescription and the recorded sets respectively) so the old shape stays valid
 * alongside the structured `byExercise` — readers prefer the structured field.
 */
export function newSessionFrom(
  workout: Workout,
  byExercise: ExerciseActual[],
  benchmarkId?: string,
  benchmarkIds?: string[],
  elapsedSec?: number,
): WorkoutSession {
  const planned: ExerciseSet[] = workout.exercises.flatMap((e) => e.sets);
  const actual: ExerciseSet[] = byExercise.flatMap((e) =>
    e.sets.map((s) => ({
      reps: s.reps ?? null,
      durationSec: s.durationSec ?? null,
      restSec: s.restActualSec ?? 0,
      ...(s.weightKg != null ? { weightKg: s.weightKg } : {}),
    })),
  );
  return {
    id: newId(),
    date: todayISO(),
    workoutId: workout.id,
    workoutName: workout.name,
    planned,
    actual,
    reprompts: [],
    byExercise,
    ...(benchmarkId ? { benchmarkId } : {}),
    ...(benchmarkIds && benchmarkIds.length ? { benchmarkIds } : {}),
    ...(elapsedSec && elapsedSec > 0 ? { durationSec: Math.round(elapsedSec) } : {}),
    completedAt: new Date().toISOString(),
  };
}

/** Assemble a persistable cardio session (run/bike) from a tracked result. */
export function newCardioSession(
  workout: Workout,
  cardio: CardioActual,
  benchmarkId?: string,
  benchmarkIds?: string[],
): WorkoutSession {
  return {
    id: newId(),
    date: todayISO(),
    workoutId: workout.id,
    workoutName: workout.name,
    planned: [],
    actual: [],
    reprompts: [],
    cardio,
    ...(benchmarkId ? { benchmarkId } : {}),
    ...(benchmarkIds && benchmarkIds.length ? { benchmarkIds } : {}),
    ...(cardio.durationSec > 0 ? { durationSec: Math.round(cardio.durationSec) } : {}),
    completedAt: new Date().toISOString(),
  };
}

/** Flatten a workout into the ordered work/rest steps the player walks. */
export function buildSteps(workout: Workout): PlayerStep[] {
  const steps: PlayerStep[] = [];
  const exercises = workout.exercises;
  for (let ei = 0; ei < exercises.length; ei++) {
    const exercise = exercises[ei]!;
    for (let si = 0; si < exercise.sets.length; si++) {
      const set = exercise.sets[si]!;
      steps.push({
        kind: "work",
        exerciseName: exercise.name,
        exerciseIndex: ei,
        setIndex: si,
        setCount: exercise.sets.length,
        reps: set.reps,
        durationSec: set.durationSec,
        weightKg: set.weightKg,
        notes: exercise.notes,
      });
      const isLastStep = ei === exercises.length - 1 && si === exercise.sets.length - 1;
      if (set.restSec > 0 && !isLastStep) {
        const sameExercise = si < exercise.sets.length - 1;
        const next = sameExercise ? exercise.name : (exercises[ei + 1]?.name ?? "");
        steps.push({ kind: "rest", durationSec: set.restSec, nextExerciseName: next });
      }
    }
  }
  return steps;
}
