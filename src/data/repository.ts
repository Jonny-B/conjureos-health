/**
 * Data layer contract.
 *
 * Every screen and feature talks to persistence ONLY through this interface —
 * never to Supabase or the VFS directly. That single seam is what lets the
 * app run identically against three backends:
 *
 *   - `MockRepository`     — in-memory + VFS-persisted. The default. Runs with
 *                            zero configuration, so `npm run dev` and any
 *                            contributor's checkout work end-to-end offline.
 *   - `SupabaseRepository` — real backend (Postgres + RLS + anonymous auth),
 *                            selected when VITE_SUPABASE_URL/ANON_KEY are set.
 *   - (future) a 16c BYO-Backend impl routing through `actions.invoke`.
 *
 * Keeping the contract small and behaviour-identical across impls is the whole
 * point: swap the backend, change nothing above this line.
 */

import type {
  DailyCheckoff,
  DiaryEntry,
  Goals,
  Plan,
  Profile,
  SleepEntry,
  SymptomEntry,
  WaterEntry,
  WeightEntry,
  WorkoutSession,
} from "../types";
import { getAccessToken, isHostAuthAvailable } from "../bridge/host";

/** Fields the caller supplies when logging; id + loggedAt are assigned here. */
export type NewDiaryEntry = Omit<DiaryEntry, "id" | "loggedAt">;
/** A drink before storage assigns its id + timestamp. `loggedAt` may be given
 *  to back-date an entry the user is correcting. */
export type NewWaterEntry = Omit<WaterEntry, "id" | "loggedAt"> & { loggedAt?: string };
/** A symptom before storage assigns its id + timestamp. */
export type NewSymptomEntry = Omit<SymptomEntry, "id" | "loggedAt"> & { loggedAt?: string };

/** A patch to a day's check-off; `date` is supplied separately. */
export type DayLogPatch = Partial<Omit<DailyCheckoff, "date">>;

/**
 * The persistence contract every screen and feature codes against.
 *
 * Implementations must be behaviourally identical: same ordering, same
 * idempotency, same null-vs-empty semantics. Anything that differs belongs in
 * the doc of the specific method, not in a caller's `if (repo.kind === ...)`.
 */
export interface Repository {
  /** Which backend is live — for diagnostics + a dev badge in the UI. */
  readonly kind: "mock" | "supabase";

  /** Establish a session (anonymous sign-in for Supabase) and warm caches. */
  init(): Promise<void>;

  /** The user's body + activity inputs, or null before onboarding. */
  getProfile(): Promise<Profile | null>;
  /** Replace the stored profile wholesale. */
  saveProfile(profile: Profile): Promise<void>;

  /** The active daily targets. Falls back to DEFAULT_GOALS, never null. */
  getGoals(): Promise<Goals>;
  /** Replace the stored daily targets wholesale. */
  saveGoals(goals: Goals): Promise<void>;

  /** Diary entries for one calendar date (YYYY-MM-DD). */
  listDiary(date: string): Promise<DiaryEntry[]>;
  /** Log a food; returns the stored entry with its assigned id + loggedAt. */
  addDiaryEntry(entry: NewDiaryEntry): Promise<DiaryEntry>;
  /** Patch a logged entry in place. No-op for an unknown id. */
  updateDiaryEntry(
    id: string,
    patch: Partial<Pick<DiaryEntry, "quantity" | "meal" | "food">>,
  ): Promise<void>;
  /** Delete one logged entry. Idempotent. */
  removeDiaryEntry(id: string): Promise<void>;

  // ── Sleep, water & symptoms ────────────────────────────────────────

  /** Nights filed under this date (see features/sleep for what that means).
   *  Normally 0 or 1; a list because a nap or a correction can add another. */
  listSleep(date: string): Promise<SleepEntry[]>;
  /** Sleep across a date range, inclusive, oldest first. */
  listSleepRange(from: string, to: string): Promise<SleepEntry[]>;
  /** Store a night, replacing any with the same id. */
  saveSleep(entry: SleepEntry): Promise<void>;
  /** Delete one night. Idempotent. */
  removeSleep(id: string): Promise<void>;

  /** Every drink logged on a date, oldest first. */
  listWater(date: string): Promise<WaterEntry[]>;
  /** Drinks across a date range, inclusive, oldest first. */
  listWaterRange(from: string, to: string): Promise<WaterEntry[]>;
  /** Log a drink; returns the stored entry with its id + loggedAt. */
  addWater(entry: NewWaterEntry): Promise<WaterEntry>;
  /** Change a logged drink's amount. No-op for an unknown id. */
  updateWater(id: string, patch: Partial<Pick<WaterEntry, "ml" | "loggedAt">>): Promise<void>;
  /** Delete one drink. Idempotent. */
  removeWater(id: string): Promise<void>;

  /** Symptoms logged on a date, oldest first. */
  listSymptoms(date: string): Promise<SymptomEntry[]>;
  /** Symptoms across a date range, inclusive, oldest first. */
  listSymptomsRange(from: string, to: string): Promise<SymptomEntry[]>;
  /** Record a symptom; returns the stored entry with its id + loggedAt. */
  addSymptom(entry: NewSymptomEntry): Promise<SymptomEntry>;
  /** Patch a recorded symptom. No-op for an unknown id. */
  updateSymptom(
    id: string,
    patch: Partial<Pick<SymptomEntry, "label" | "severity" | "note" | "loggedAt">>,
  ): Promise<void>;
  /** Delete one symptom. Idempotent. */
  removeSymptom(id: string): Promise<void>;

  /** Weight history, newest first. (Scaffold slice — fully wired in mock.) */
  listWeights(): Promise<WeightEntry[]>;
  /** One canonical weight per day; last write wins. */
  upsertWeight(entry: WeightEntry): Promise<void>;
  /** Remove a day's weigh-in. Idempotent. */
  removeWeight(date: string): Promise<void>;

  // ── History resets (settings → "Reset health data") ─────────────────
  /** Delete every diary entry. Destructive; no undo. */
  clearDiary(): Promise<void>;
  /** Delete the whole weight history. Destructive; no undo. */
  clearWeights(): Promise<void>;
  /** Delete all workout sessions + daily check-offs. Destructive; no undo. */
  clearWorkoutHistory(): Promise<void>;
  /** Delete every recorded night. Destructive; no undo. */
  clearSleep(): Promise<void>;
  /** Delete every logged drink. Destructive; no undo. */
  clearWater(): Promise<void>;
  /** Delete every recorded symptom. Destructive; no undo. */
  clearSymptoms(): Promise<void>;

  // ── v2: plans + daily check-off + exercise entries ──────────────────
  // No server tables: every backend keeps these in the on-device store.

  /** The active plan, or null when the user hasn't created one. */
  getPlan(): Promise<Plan | null>;
  /** Persist the (single) active plan, replacing any existing one. */
  savePlan(plan: Plan): Promise<void>;
  /** Remove the active plan. Day-log history is retained. */
  clearPlan(): Promise<void>;

  /** A day's check-off record, or null when nothing's been ticked yet. */
  getDayLog(date: string): Promise<DailyCheckoff | null>;
  /** Merge a patch into a day's check-off, creating the record if absent. */
  saveDayLog(date: string, patch: DayLogPatch): Promise<void>;
  /** Toggle a single plan goal for a date. Idempotent per (goal, date, done). */
  markCheckoff(goalId: string, date: string, done: boolean): Promise<void>;

  /** Workout sessions, newest first, optionally capped. */
  listWorkoutSessions(limit?: number): Promise<WorkoutSession[]>;
  /** Persist a workout session, replacing one with the same id. */
  saveWorkoutSession(session: WorkoutSession): Promise<void>;
  /** Delete a single workout session by id. Idempotent. */
  removeWorkoutSession(id: string): Promise<void>;
}

// ── Singleton selector ────────────────────────────────────────────────

let instance: Repository | null = null;
let initPromise: Promise<void> | null = null;

function hasSupabaseConfig(): boolean {
  return Boolean(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY);
}

/**
 * The real backend is used only when ALL of these hold:
 *   1. the shared-project URL + anon key are configured at build time,
 *   2. the host exposes the SSO auth bridge, and
 *   3. that bridge actually yields a session token (user is signed in).
 * Otherwise we use the mock — which is the path for `npm run dev`, a signed-out
 * user, or a host too old to provide identity. Net effect: the app is always
 * usable, and never half-wires a backend it can't authenticate to.
 */
async function shouldUseSupabase(): Promise<boolean> {
  if (!hasSupabaseConfig() || !isHostAuthAvailable()) return false;
  return (await getAccessToken()) !== null;
}

/**
 * Lazily construct + init the right repository. Idempotent — repeated calls
 * (including concurrent first-calls) return the same initialized instance. The
 * unused backend is dynamically imported so it never enters the parse path of
 * the path we didn't pick.
 */
export async function getRepository(): Promise<Repository> {
  if (instance) {
    if (initPromise) await initPromise;
    return instance;
  }
  // Guard concurrent first-calls (App load fans out getGoals/getProfile/loadPlan):
  // the first sets initPromise, the rest await the same build.
  if (!initPromise) {
    initPromise = buildRepository().then((repo) => {
      instance = repo;
    });
  }
  await initPromise;
  return instance!;
}

/**
 * Choose + initialize the backend, with a HARD guarantee that a broken or
 * unreachable Supabase backend can never become the active repository.
 *
 * The Supabase path is selected only when config + host SSO + a live token all
 * line up. But "has a token" doesn't mean "the fitness backend is actually
 * usable" — the schema may be unexposed, RLS may reject, or the network may be
 * down. If any of those held and we returned the Supabase repo anyway, the
 * first `getProfile()` in App.tsx's load would throw and hang the app on a
 * spinner, or writes would silently 4xx and revert. So we PROBE reachability
 * with a real read and, on any failure, fall back to the durable local store —
 * which is always usable. A signed-in user with a healthy backend is unaffected
 * (one small extra read that also warms the session).
 */
async function buildRepository(): Promise<Repository> {
  if (await shouldUseSupabase()) {
    try {
      const { SupabaseRepository } = await import("./supabaseRepository");
      const repo = new SupabaseRepository();
      await repo.init();
      // Reachability probe: getProfile resolves (Profile | null) on a healthy
      // backend and throws on an unexposed schema / RLS / network error.
      await repo.getProfile();
      return repo;
    } catch (err) {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn(
          "[conjure-health] Supabase backend unreachable; falling back to local store",
          err,
        );
      }
      // fall through to the mock (local) layer
    }
  }
  const { MockRepository } = await import("./mockRepository");
  const mock = new MockRepository();
  await mock.init();
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.info("[conjure-health] using mock data layer (no reachable shared-project backend)");
  }
  return mock;
}

/** Test/escape hatch — reset the singleton (used by no production path). */
export function __resetRepository(): void {
  instance = null;
  initPromise = null;
}
