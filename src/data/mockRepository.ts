/**
 * Mock data layer — the default backend.
 *
 * Holds everything in memory and persists it two ways:
 *
 *  1. **`localStorage` (authoritative).** The device-local source of truth.
 *     Each app runs on its own origin (desktop `<slug>.conjureos.app`, mobile
 *     `<slug>.mobile.conjureos.app`), so this is app-private and survives an
 *     iframe/WebView reload — AND it is NOT part of ConjureOS cloud file-sync.
 *     That last property is the whole point: a value you entered on a device
 *     can never be silently reverted by a stale cloud pull, nor by another
 *     open surface blind-flushing its own stale copy of the store.
 *
 *  2. **VFS `store.json` (best-effort mirror).** Still written on every change
 *     so `npm run dev` reloads work with no localStorage, and so a brand-new
 *     device can seed itself from whatever last synced. It is NEVER read back
 *     as authoritative once a device-local copy exists — reading it back is
 *     what let a stale synced blob revert on-device data.
 *
 * Why this split exists: the store is one JSON document, and the mock flushes
 * the WHOLE document on every write. When that document is a single cloud-
 * synced file edited from multiple live surfaces, whole-file last-write-wins
 * means the last blind-flusher clobbers every field — so a units change on one
 * device gets reverted the moment another (stale) surface writes anything.
 * Pinning the truth to un-synced localStorage removes that failure class
 * without changing the platform's sync approach. Cross-device propagation is
 * therefore best-effort (seed-on-first-run), not live — a deliberate, data-loss-
 * averse trade.
 *
 * Behaviour is intended to match SupabaseRepository exactly — same method
 * contracts, same ordering guarantees — so swapping backends changes nothing
 * above the Repository interface.
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
import { DEFAULT_GOALS } from "../types";
import { readJsonStrict, vfs, writeJson } from "../bridge/vfs";
import type {
  DayLogPatch,
  NewDiaryEntry,
  NewSymptomEntry,
  NewWaterEntry,
  Repository,
} from "./repository";
import { newId } from "./id";

const STORE_PATH = "store.json";
/** Device-local authoritative key. App origins partition it per app already,
 *  but the name is explicit for clarity when inspecting devtools storage. It
 *  keeps the app's old name on purpose: every user's saved data sits under
 *  it, so renaming it would make that data vanish. */
const LOCAL_KEY = "conjure-fitness:store:v2";

/** v1: profile/goals/diary/weights only. Retained for the migration path. */
interface StoreShapeV1 {
  v: 1;
  profile: Profile | null;
  goals: Goals | null;
  diary: DiaryEntry[];
  weights: WeightEntry[];
}

/** v2: adds the plan / daily check-off / workout-session slices. */
interface StoreShapeV2 {
  v: 2;
  profile: Profile | null;
  goals: Goals | null;
  diary: DiaryEntry[];
  weights: WeightEntry[];
  plan: Plan | null;
  dayLogs: Record<string, DailyCheckoff>;
  workoutSessions: WorkoutSession[];
  updatedAt?: string;
}

/** v3: adds sleep, water and symptoms. */
interface StoreShape {
  v: 3;
  profile: Profile | null;
  goals: Goals | null;
  diary: DiaryEntry[];
  weights: WeightEntry[];
  plan: Plan | null;
  /** Keyed by YYYY-MM-DD. */
  dayLogs: Record<string, DailyCheckoff>;
  workoutSessions: WorkoutSession[];
  sleep: SleepEntry[];
  water: WaterEntry[];
  symptoms: SymptomEntry[];
  /** Wall-clock of the last local write. Informational (aids debugging and any
   *  future explicit cross-device merge); not used for reconciliation today. */
  updatedAt?: string;
}

/** Guarded access to `localStorage` — absent in SSR/tests, or throwing when a
 *  browser has storage disabled (private mode, blocked third-party storage). */
function localStore(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Read the device-local authoritative copy, or null when absent/unreadable. */
function readLocal(): StoreShape | null {
  const ls = localStore();
  if (!ls) return null;
  try {
    const raw = ls.getItem(LOCAL_KEY);
    if (!raw) return null;
    return migrate(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Persist the device-local authoritative copy. Returns whether it actually
 *  landed — a quota error or disabled storage must never THROW into a caller
 *  mid-save (see flush(), which decides success from this return value plus
 *  the VFS mirror's), but the failure can no longer be silently swallowed. */
function writeLocal(store: StoreShape): boolean {
  const ls = localStore();
  if (!ls) return false;
  try {
    ls.setItem(LOCAL_KEY, JSON.stringify(store));
    return true;
  } catch {
    return false; // quota / disabled — the VFS mirror is the fallback
  }
}

/** Mirror write with the same "tell me if it actually landed" contract as
 *  writeLocal(). `writeJson` (used for the best-effort migration write in
 *  init()) intentionally never reports failure; flush() needs to, because a
 *  write is only truly lost when BOTH copies fail. */
async function writeMirror(store: StoreShape): Promise<boolean> {
  try {
    await vfs.write(STORE_PATH, JSON.stringify(store));
    return true;
  } catch {
    // No `window` at all (as opposed to a window with no `__vfs` mounted)
    // means we're not running in a browser tab or WebView at all — every real
    // deployment target of this app has one, so this is specifically the
    // headless/test-harness case, which `vfs`'s own in-memory fallback exists
    // to serve and cannot actually fail (a Map.set can't throw). Report
    // success there rather than letting an unrelated environment gap read as
    // a genuine on-device persistence failure.
    return typeof window === "undefined";
  }
}

/** Drop the device-local copy. Only for a copy known to be stale (a write just
 *  failed and the VFS mirror holds the newer store); removal frees quota and
 *  never throws into the caller. */
function removeLocal(): void {
  try {
    localStore()?.removeItem(LOCAL_KEY);
  } catch {
    /* storage disabled — nothing to remove */
  }
}

/** Subscribe to cross-tab writes of LOCAL_KEY. The `storage` event only fires
 *  in tabs OTHER than the one that wrote, which is exactly what we want: our
 *  own writes already update `this.store` directly. Best-effort — no
 *  `window`/`addEventListener` (SSR, tests, a host without either) just means
 *  this tab's reads go stale until its next mutate(), which re-reads anyway. */
function watchLocalStorage(onChange: (fresh: StoreShape) => void): void {
  try {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    window.addEventListener("storage", (e: StorageEvent) => {
      if (e.key !== LOCAL_KEY || e.newValue == null) return;
      try {
        onChange(migrate(JSON.parse(e.newValue)));
      } catch {
        /* corrupt payload from the other tab — ignore; next mutate() re-reads */
      }
    });
  } catch {
    /* no window / addEventListener unsupported */
  }
}

const EMPTY: StoreShape = {
  v: 3,
  profile: null,
  goals: null,
  diary: [],
  weights: [],
  plan: null,
  dayLogs: {},
  workoutSessions: [],
  sleep: [],
  water: [],
  symptoms: [],
};

/**
 * Normalise whatever was on disk into the current StoreShape. A v1 document is
 * migrated by retaining its slices and synthesising empty v2 fields; anything
 * else (missing, corrupt, future version) resets to EMPTY.
 */
function migrate(loaded: unknown): StoreShape {
  if (!loaded || typeof loaded !== "object") return structuredClone(EMPTY);
  const doc = loaded as { v?: number };
  // Even a current-version document gets its collections normalised. Trusting
  // the shape wholesale means one truncated write, hand-edit or partial sync
  // turns every read into "Cannot read properties of undefined" — and the
  // fallback for a corrupt store is EMPTY, which would silently discard the
  // slices that ARE intact. Filling gaps keeps whatever survived.
  if (doc.v === 3) {
    const v3 = loaded as Partial<StoreShape>;
    return {
      v: 3,
      profile: v3.profile ?? null,
      goals: v3.goals ?? null,
      diary: Array.isArray(v3.diary) ? v3.diary : [],
      weights: Array.isArray(v3.weights) ? v3.weights : [],
      plan: v3.plan ?? null,
      dayLogs: v3.dayLogs && typeof v3.dayLogs === "object" ? v3.dayLogs : {},
      workoutSessions: Array.isArray(v3.workoutSessions) ? v3.workoutSessions : [],
      sleep: Array.isArray(v3.sleep) ? v3.sleep : [],
      water: Array.isArray(v3.water) ? v3.water : [],
      symptoms: Array.isArray(v3.symptoms) ? v3.symptoms : [],
      ...(v3.updatedAt ? { updatedAt: v3.updatedAt } : {}),
    };
  }
  // v2 → v3 is purely additive: every existing slice is kept as-is and the
  // three new ones start empty. Losing a user's diary to a version bump would
  // be unforgivable, so this path never discards.
  if (doc.v === 2) {
    const v2 = loaded as Partial<StoreShapeV2>;
    return {
      v: 3,
      profile: v2.profile ?? null,
      goals: v2.goals ?? null,
      diary: Array.isArray(v2.diary) ? v2.diary : [],
      weights: Array.isArray(v2.weights) ? v2.weights : [],
      plan: v2.plan ?? null,
      dayLogs: v2.dayLogs && typeof v2.dayLogs === "object" ? v2.dayLogs : {},
      workoutSessions: Array.isArray(v2.workoutSessions) ? v2.workoutSessions : [],
      sleep: [],
      water: [],
      symptoms: [],
    };
  }
  if (doc.v === 1) {
    const v1 = loaded as StoreShapeV1;
    return {
      ...structuredClone(EMPTY),
      profile: v1.profile ?? null,
      goals: v1.goals ?? null,
      diary: v1.diary ?? [],
      weights: v1.weights ?? [],
    };
  }
  return structuredClone(EMPTY);
}

/**
 * The default {@link Repository}: everything lives in one JSON blob held in
 * memory and mirrored to the app's VFS (plus localStorage in the browser), so
 * a fresh checkout runs end-to-end with zero configuration and no network.
 *
 * It is also the on-device store {@link SupabaseRepository} uses for the data
 * that has no server table (plans, check-offs, sessions, sleep, water, symptoms).
 * Reads are served from the in-memory copy; every mutation persists eagerly.
 */
export class MockRepository implements Repository {
  readonly kind = "mock" as const;
  private store: StoreShape = structuredClone(EMPTY);
  /** The last local write failed (quota / disabled), so localStorage holds an
   *  OLDER document than `this.store`. While set, mutate() must build on
   *  `this.store`, not re-read that stale copy. Recomputed by every flush(). */
  private localDirty = false;
  /** init() had no local copy and could not read the VFS store (timeout,
   *  permission, corrupt), so `this.store` is a placeholder, not the user's
   *  data. Writes must not go out until a retry reads it. */
  private storeUnread = false;
  private watching = false;

  async init(): Promise<void> {
    // Registered on every init path (not just first run), so an idle tab's
    // reads follow another tab's writes. Keeps the in-memory copy from going
    // stale: the `storage` event fires in OTHER tabs whenever one of them
    // writes our key. This only helps reads between mutations — every
    // mutate() call below re-reads localStorage itself regardless, which is
    // what actually prevents one tab's write from clobbering another's (see
    // mutate()).
    if (!this.watching) {
      this.watching = true;
      watchLocalStorage((fresh) => {
        this.store = fresh;
      });
    }

    // Device-local copy wins whenever it exists: it's the authoritative store
    // and — crucially — it is NOT cloud-synced, so it can't have been reverted
    // by a stale pull or another surface's blind whole-store flush. We do NOT
    // consult the (synced) VFS store.json here even if it looks newer: adopting
    // it is precisely how a stale synced blob used to clobber on-device data.
    const local = readLocal();
    if (local) {
      this.store = local;
      return;
    }

    // First run on this device (no local copy): seed from the VFS mirror, which
    // may carry data synced from another device on install. Migrate, adopt, and
    // pin it locally so every subsequent load is device-authoritative.
    let loaded: unknown;
    try {
      loaded = await readJsonStrict<unknown>(STORE_PATH, structuredClone(EMPTY));
    } catch {
      // A failed read is not a missing file. Don't adopt or pin an empty store
      // (that would abandon the synced data and let the first flush overwrite
      // the mirror with it); mutate() retries the read before any write.
      this.storeUnread = true;
      return;
    }
    const before = (loaded as { v?: number } | null)?.v;
    this.store = migrate(loaded);
    writeLocal(this.store);
    // Persist the upgrade immediately so a doc already on the current version
    // doesn't get rewritten every load. Compared against EMPTY.v (the current
    // schema version), not a hardcoded old number, so the next version bump
    // doesn't leave this check silently stale again.
    if (before !== EMPTY.v) await writeJson(STORE_PATH, this.store);
  }

  /** Retry the store read init() could not complete. Resolves once the store
   *  is loaded (from a local copy another tab pinned, or the VFS); throws while
   *  it is still unreadable, so the write fails loudly instead of overwriting. */
  private async recoverUnreadStore(): Promise<void> {
    const local = readLocal();
    if (local) {
      this.store = local;
      this.storeUnread = false;
      return;
    }
    try {
      this.store = migrate(await readJsonStrict<unknown>(STORE_PATH, structuredClone(EMPTY)));
    } catch (err) {
      throw new Error("MockRepository: refusing to save — the stored data could not be read.", {
        cause: err,
      });
    }
    this.storeUnread = false;
  }

  /**
   * Apply a mutation and persist it — the single path every mutator method
   * below goes through instead of poking `this.store` directly and flushing.
   *
   * Two tabs share one localStorage document with no coordination. If a
   * mutator just edited our own (possibly stale) in-memory `this.store` and
   * blind-wrote it, a tab holding an older snapshot could silently erase
   * writes another tab already persisted — e.g. tab A logs a diary entry and
   * flushes, then tab B, still holding its pre-A snapshot, saves a profile
   * change and flushes ITS snapshot, wiping A's entry with no error. Re-reading
   * the freshest local copy right before applying `fn`, and running `fn`
   * against THAT copy instead of `this.store`, means whatever the other tab
   * already saved is still there when we write — every other slice of the
   * document passes through untouched, and `fn` only edits the slice this call
   * actually cares about. That's last-write-wins per mutation rather than per
   * whole-document, which is all a single-user app opened in two tabs needs;
   * it is deliberately not a CRDT, so two tabs racing to edit the exact same
   * field can still overwrite each other — acceptable for this app.
   *
   * Reads only localStorage here, never the VFS mirror — same reasoning as
   * init(): the synced mirror must never be treated as authoritative.
   */
  private async mutate<T>(fn: (s: StoreShape) => T): Promise<T> {
    if (this.storeUnread) await this.recoverUnreadStore();
    // A failed local write leaves localStorage OLDER than this.store; building
    // on that stale copy would silently drop everything written since.
    const fresh = this.localDirty ? this.store : (readLocal() ?? this.store);
    const result = fn(fresh);
    this.store = fresh;
    await this.flush();
    return result;
  }

  /**
   * Persist the whole store. localStorage is the durable, synchronous,
   * un-syncable source of truth; the VFS write is a best-effort export/mirror
   * (and the dev-server persistence when localStorage is unavailable).
   *
   * A write is only genuinely lost when BOTH copies fail — the VFS mirror is
   * documented (see the class-level comment) as the fallback for exactly this
   * case — so that's the only time this throws. Silently resolving a mutation
   * that landed nowhere was the bug: callers reasonably treat resolution as
   * "this is saved," and it wasn't.
   */
  private async flush(): Promise<void> {
    this.store.updatedAt = new Date().toISOString();
    const localOk = writeLocal(this.store);
    this.localDirty = !localOk;
    const mirrorOk = await writeMirror(this.store);
    // The stale local copy would win on the next init() and hide everything the
    // mirror holds since, so when the mirror has the newer store, drop it (the
    // next init() then seeds from the mirror and re-pins it).
    if (!localOk && mirrorOk) removeLocal();
    if (!localOk && !mirrorOk) {
      throw new Error(
        "MockRepository: failed to persist — both localStorage and the VFS mirror write failed.",
      );
    }
  }

  async getProfile(): Promise<Profile | null> {
    return this.store.profile;
  }

  async saveProfile(profile: Profile): Promise<void> {
    await this.mutate((s) => {
      s.profile = profile;
    });
  }

  async getGoals(): Promise<Goals> {
    return this.store.goals ?? { ...DEFAULT_GOALS };
  }

  async saveGoals(goals: Goals): Promise<void> {
    await this.mutate((s) => {
      s.goals = goals;
    });
  }

  async listDiary(date: string): Promise<DiaryEntry[]> {
    return this.store.diary
      .filter((e) => e.date === date)
      .sort((a, b) => a.loggedAt.localeCompare(b.loggedAt));
  }

  async getDiaryEntry(id: string): Promise<DiaryEntry | null> {
    return this.store.diary.find((e) => e.id === id) ?? null;
  }

  async addDiaryEntry(entry: NewDiaryEntry): Promise<DiaryEntry> {
    const full: DiaryEntry = { ...entry, id: newId(), loggedAt: new Date().toISOString() };
    return this.mutate((s) => {
      s.diary.push(full);
      return full;
    });
  }

  async updateDiaryEntry(
    id: string,
    patch: Partial<Pick<DiaryEntry, "quantity" | "meal" | "food">>,
  ): Promise<void> {
    await this.mutate((s) => {
      const e = s.diary.find((x) => x.id === id);
      if (!e) return;
      if (patch.quantity !== undefined) e.quantity = patch.quantity;
      if (patch.meal !== undefined) e.meal = patch.meal;
      if (patch.food !== undefined) e.food = patch.food;
    });
  }

  async removeDiaryEntry(id: string): Promise<void> {
    await this.mutate((s) => {
      s.diary = s.diary.filter((x) => x.id !== id);
    });
  }

  async listWeights(): Promise<WeightEntry[]> {
    return [...this.store.weights].sort((a, b) => b.date.localeCompare(a.date));
  }

  async upsertWeight(entry: WeightEntry): Promise<void> {
    await this.mutate((s) => {
      const existing = s.weights.find((w) => w.date === entry.date);
      if (existing) existing.weightKg = entry.weightKg;
      else s.weights.push(entry);
    });
  }

  async removeWeight(date: string): Promise<void> {
    await this.mutate((s) => {
      s.weights = s.weights.filter((w) => w.date !== date);
    });
  }

  async clearDiary(): Promise<void> {
    await this.mutate((s) => {
      s.diary = [];
    });
  }

  async clearWeights(): Promise<void> {
    await this.mutate((s) => {
      s.weights = [];
    });
  }

  async clearWorkoutHistory(): Promise<void> {
    await this.mutate((s) => {
      s.workoutSessions = [];
      s.dayLogs = {};
    });
  }

  async clearSleep(): Promise<void> {
    await this.mutate((s) => {
      s.sleep = [];
    });
  }

  async clearWater(): Promise<void> {
    await this.mutate((s) => {
      s.water = [];
    });
  }

  async clearSymptoms(): Promise<void> {
    await this.mutate((s) => {
      s.symptoms = [];
    });
  }

  // ── Sleep, water & symptoms ────────────────────────────────────────
  //
  // All three are flat arrays filtered by `date`, matching how the diary
  // already works. Ranges are inclusive on both ends and compare the
  // YYYY-MM-DD strings directly, which sorts correctly because the format is
  // fixed-width — no Date parsing, no timezone to get wrong.

  async listSleep(date: string): Promise<SleepEntry[]> {
    return this.store.sleep.filter((e) => e.date === date);
  }

  async listSleepRange(from: string, to: string): Promise<SleepEntry[]> {
    return this.store.sleep
      .filter((e) => e.date >= from && e.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  async saveSleep(entry: SleepEntry): Promise<void> {
    await this.mutate((s) => {
      const idx = s.sleep.findIndex((e) => e.id === entry.id);
      if (idx >= 0) s.sleep[idx] = entry;
      else s.sleep.push(entry);
    });
  }

  async removeSleep(id: string): Promise<void> {
    await this.mutate((s) => {
      s.sleep = s.sleep.filter((e) => e.id !== id);
    });
  }

  async listWater(date: string): Promise<WaterEntry[]> {
    return this.store.water
      .filter((e) => e.date === date)
      .sort((a, b) => a.loggedAt.localeCompare(b.loggedAt));
  }

  async listWaterRange(from: string, to: string): Promise<WaterEntry[]> {
    return this.store.water
      .filter((e) => e.date >= from && e.date <= to)
      .sort((a, b) => a.loggedAt.localeCompare(b.loggedAt));
  }

  async addWater(entry: NewWaterEntry): Promise<WaterEntry> {
    const stored: WaterEntry = {
      ...entry,
      id: newId(),
      loggedAt: entry.loggedAt ?? new Date().toISOString(),
    };
    return this.mutate((s) => {
      s.water.push(stored);
      return stored;
    });
  }

  async updateWater(id: string, patch: Partial<Pick<WaterEntry, "ml" | "loggedAt">>): Promise<void> {
    await this.mutate((s) => {
      const idx = s.water.findIndex((e) => e.id === id);
      if (idx < 0) return;
      s.water[idx] = { ...s.water[idx]!, ...patch };
    });
  }

  async removeWater(id: string): Promise<void> {
    await this.mutate((s) => {
      s.water = s.water.filter((e) => e.id !== id);
    });
  }

  async listSymptoms(date: string): Promise<SymptomEntry[]> {
    return this.store.symptoms
      .filter((e) => e.date === date)
      .sort((a, b) => a.loggedAt.localeCompare(b.loggedAt));
  }

  async listSymptomsRange(from: string, to: string): Promise<SymptomEntry[]> {
    return this.store.symptoms
      .filter((e) => e.date >= from && e.date <= to)
      .sort((a, b) => a.loggedAt.localeCompare(b.loggedAt));
  }

  async addSymptom(entry: NewSymptomEntry): Promise<SymptomEntry> {
    const stored: SymptomEntry = {
      ...entry,
      id: newId(),
      loggedAt: entry.loggedAt ?? new Date().toISOString(),
    };
    return this.mutate((s) => {
      s.symptoms.push(stored);
      return stored;
    });
  }

  async updateSymptom(
    id: string,
    patch: Partial<Pick<SymptomEntry, "label" | "severity" | "note" | "loggedAt">>,
  ): Promise<void> {
    await this.mutate((s) => {
      const idx = s.symptoms.findIndex((e) => e.id === id);
      if (idx < 0) return;
      const next = { ...s.symptoms[idx]!, ...patch };
      // An explicitly cleared severity/note must actually go away, not linger as
      // a stale value the user can no longer see.
      if (patch.severity === undefined && "severity" in patch) delete next.severity;
      if (patch.note === undefined && "note" in patch) delete next.note;
      s.symptoms[idx] = next;
    });
  }

  async removeSymptom(id: string): Promise<void> {
    await this.mutate((s) => {
      s.symptoms = s.symptoms.filter((e) => e.id !== id);
    });
  }

  // ── v2: plans + daily check-off + exercise entries ──────────────────

  async getPlan(): Promise<Plan | null> {
    return this.store.plan;
  }

  async savePlan(plan: Plan): Promise<void> {
    await this.mutate((s) => {
      s.plan = plan;
    });
  }

  async clearPlan(): Promise<void> {
    await this.mutate((s) => {
      s.plan = null;
    });
  }

  async getDayLog(date: string): Promise<DailyCheckoff | null> {
    return this.store.dayLogs[date] ?? null;
  }

  async saveDayLog(date: string, patch: DayLogPatch): Promise<void> {
    await this.mutate((s) => {
      const current = s.dayLogs[date] ?? { date, goalsCompleted: [] };
      s.dayLogs[date] = { ...current, ...patch, date };
    });
  }

  async markCheckoff(goalId: string, date: string, done: boolean): Promise<void> {
    await this.mutate((s) => {
      const current = s.dayLogs[date] ?? { date, goalsCompleted: [] };
      const set = new Set(current.goalsCompleted);
      if (done) set.add(goalId);
      else set.delete(goalId);
      s.dayLogs[date] = { ...current, date, goalsCompleted: [...set] };
    });
  }

  async listWorkoutSessions(limit?: number): Promise<WorkoutSession[]> {
    const sorted = [...this.store.workoutSessions].sort((a, b) =>
      b.completedAt.localeCompare(a.completedAt),
    );
    return limit != null ? sorted.slice(0, limit) : sorted;
  }

  async saveWorkoutSession(session: WorkoutSession): Promise<void> {
    await this.mutate((s) => {
      const idx = s.workoutSessions.findIndex((w) => w.id === session.id);
      if (idx >= 0) s.workoutSessions[idx] = session;
      else s.workoutSessions.push(session);
    });
  }

  async removeWorkoutSession(id: string): Promise<void> {
    await this.mutate((s) => {
      s.workoutSessions = s.workoutSessions.filter((w) => w.id !== id);
    });
  }
}
