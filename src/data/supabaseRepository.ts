/**
 * Supabase-backed repository — the real data layer against the shared project's
 * `fitness` schema. Selected only when the project is configured AND the host
 * supplies an SSO session token (see repository.ts).
 *
 * Row ownership is enforced server-side: every table defaults `user_id` to
 * `auth.uid()` and RLS scopes reads/writes to the caller, so this client never
 * sends or trusts a user id — it just sends the session token.
 *
 * The schema + RLS live in the private backend repo (staged under `_backend/`
 * in this checkout). Table/column names here must match those migrations.
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
import { getAccessToken } from "../bridge/host";
import type {
  DayLogPatch,
  NewDiaryEntry,
  NewSymptomEntry,
  NewWaterEntry,
  Repository,
} from "./repository";
import { SupabaseRestClient } from "./supabaseClient";

interface ProfileRow {
  sex: Profile["sex"];
  age: number;
  height_cm: number;
  weight_kg: number;
  activity_level: Profile["activityLevel"];
  direction: Profile["direction"];
  goal_weight_kg: number | null;
  units: Profile["units"];
}
interface GoalsRow {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}
interface DiaryRow {
  id: string;
  date: string;
  meal: DiaryEntry["meal"];
  food: DiaryEntry["food"];
  quantity: number;
  logged_at: string;
}
interface WeightRow {
  date: string;
  weight_kg: number;
}

/**
 * Postgres-backed {@link Repository}, selected when VITE_SUPABASE_URL and
 * VITE_SUPABASE_ANON_KEY are set. Rows are scoped to the signed-in user by
 * RLS; `init()` performs an anonymous sign-in when no session exists.
 *
 * Profile, goals, diary and weights live on the server. Everything else
 * (plans, check-offs, workout sessions, sleep, water, symptoms) has no server
 * table and lives on-device in the local store (see `localStore`).
 */
export class SupabaseRepository implements Repository {
  readonly kind = "supabase" as const;
  private client: SupabaseRestClient;

  constructor() {
    this.client = new SupabaseRestClient(
      import.meta.env.VITE_SUPABASE_URL!,
      import.meta.env.VITE_SUPABASE_ANON_KEY!,
      getAccessToken,
    );
  }

  async init(): Promise<void> {
    // Token is fetched per-request; nothing to warm. Presence was already
    // verified by the selector before we got constructed.
  }

  /**
   * Data with no server table lives in the same on-device store the local
   * backend uses: localStorage, mirrored to the app's VFS `store.json`, which
   * platform sync backs up. Loaded lazily, so the local store only enters the
   * bundle path when that data is actually touched.
   */
  private local: Promise<Repository> | null = null;
  private localStore(): Promise<Repository> {
    if (!this.local) {
      this.local = import("./mockRepository").then(async ({ MockRepository }) => {
        const repo = new MockRepository();
        await repo.init();
        return repo;
      });
    }
    return this.local;
  }

  async getProfile(): Promise<Profile | null> {
    const rows = await this.client.select<ProfileRow>("profiles", "select=*&limit=1");
    const r = rows[0];
    if (!r) return null;
    return {
      sex: r.sex,
      age: r.age,
      heightCm: r.height_cm,
      weightKg: r.weight_kg,
      activityLevel: r.activity_level,
      direction: r.direction,
      goalWeightKg: r.goal_weight_kg ?? undefined,
      units: r.units,
    };
  }

  async saveProfile(p: Profile): Promise<void> {
    await this.client.upsert(
      "profiles",
      {
        sex: p.sex,
        age: p.age,
        height_cm: p.heightCm,
        weight_kg: p.weightKg,
        activity_level: p.activityLevel,
        direction: p.direction,
        goal_weight_kg: p.goalWeightKg ?? null,
        units: p.units,
      },
      "user_id",
    );
  }

  async getGoals(): Promise<Goals> {
    const rows = await this.client.select<GoalsRow>("goals", "select=*&limit=1");
    const r = rows[0];
    return r ? { calories: r.calories, protein: r.protein, carbs: r.carbs, fat: r.fat } : { ...DEFAULT_GOALS };
  }

  async saveGoals(g: Goals): Promise<void> {
    await this.client.upsert("goals", { ...g }, "user_id");
  }

  async listDiary(date: string): Promise<DiaryEntry[]> {
    const rows = await this.client.select<DiaryRow>(
      "diary_entries",
      `select=*&date=eq.${encodeURIComponent(date)}&order=logged_at.asc`,
    );
    return rows.map(rowToEntry);
  }

  async addDiaryEntry(entry: NewDiaryEntry): Promise<DiaryEntry> {
    const rows = await this.client.insert<DiaryRow>("diary_entries", {
      date: entry.date,
      meal: entry.meal,
      food: entry.food,
      quantity: entry.quantity,
    });
    const r = rows[0];
    if (!r) throw new Error("insert returned no row");
    return rowToEntry(r);
  }

  async updateDiaryEntry(
    id: string,
    patch: Partial<Pick<DiaryEntry, "quantity" | "meal" | "food">>,
  ): Promise<void> {
    const body: Record<string, unknown> = {};
    if (patch.quantity !== undefined) body.quantity = patch.quantity;
    if (patch.meal !== undefined) body.meal = patch.meal;
    if (patch.food !== undefined) body.food = patch.food;
    if (Object.keys(body).length === 0) return;
    await this.client.patch("diary_entries", `id=eq.${encodeURIComponent(id)}`, body);
  }

  async removeDiaryEntry(id: string): Promise<void> {
    await this.client.remove("diary_entries", `id=eq.${encodeURIComponent(id)}`);
  }

  async listWeights(): Promise<WeightEntry[]> {
    const rows = await this.client.select<WeightRow>("weights", "select=*&order=date.desc");
    return rows.map((r) => ({ date: r.date, weightKg: r.weight_kg }));
  }

  async upsertWeight(entry: WeightEntry): Promise<void> {
    await this.client.upsert("weights", { date: entry.date, weight_kg: entry.weightKg }, "user_id,date");
  }

  async removeWeight(date: string): Promise<void> {
    await this.client.remove("weights", `date=eq.${encodeURIComponent(date)}`);
  }

  // RLS scopes deletes to the caller's rows; the always-true filter satisfies
  // PostgREST's require-a-filter rule for bulk deletes.
  async clearDiary(): Promise<void> {
    await this.client.remove("diary_entries", "id=not.is.null");
  }

  async clearWeights(): Promise<void> {
    await this.client.remove("weights", "date=not.is.null");
  }

  async clearWorkoutHistory(): Promise<void> {
    // Workout sessions are on-device (see localStore); nothing server-side.
    await (await this.localStore()).clearWorkoutHistory();
  }

  // ── On-device data: sleep, water, symptoms, plans, check-offs ──
  // No server tables for these, so they use the same on-device store as
  // workout sessions (see localStore).

  async clearSleep(): Promise<void> {
    await (await this.localStore()).clearSleep();
  }
  async clearWater(): Promise<void> {
    await (await this.localStore()).clearWater();
  }
  async clearSymptoms(): Promise<void> {
    await (await this.localStore()).clearSymptoms();
  }
  async listSleep(date: string): Promise<SleepEntry[]> {
    return (await this.localStore()).listSleep(date);
  }
  async listSleepRange(from: string, to: string): Promise<SleepEntry[]> {
    return (await this.localStore()).listSleepRange(from, to);
  }
  async saveSleep(entry: SleepEntry): Promise<void> {
    await (await this.localStore()).saveSleep(entry);
  }
  async removeSleep(id: string): Promise<void> {
    await (await this.localStore()).removeSleep(id);
  }
  async listWater(date: string): Promise<WaterEntry[]> {
    return (await this.localStore()).listWater(date);
  }
  async listWaterRange(from: string, to: string): Promise<WaterEntry[]> {
    return (await this.localStore()).listWaterRange(from, to);
  }
  async addWater(entry: NewWaterEntry): Promise<WaterEntry> {
    return (await this.localStore()).addWater(entry);
  }
  async updateWater(id: string, patch: Parameters<Repository["updateWater"]>[1]): Promise<void> {
    await (await this.localStore()).updateWater(id, patch);
  }
  async removeWater(id: string): Promise<void> {
    await (await this.localStore()).removeWater(id);
  }
  async listSymptoms(date: string): Promise<SymptomEntry[]> {
    return (await this.localStore()).listSymptoms(date);
  }
  async listSymptomsRange(from: string, to: string): Promise<SymptomEntry[]> {
    return (await this.localStore()).listSymptomsRange(from, to);
  }
  async addSymptom(entry: NewSymptomEntry): Promise<SymptomEntry> {
    return (await this.localStore()).addSymptom(entry);
  }
  async updateSymptom(id: string, patch: Parameters<Repository["updateSymptom"]>[1]): Promise<void> {
    await (await this.localStore()).updateSymptom(id, patch);
  }
  async removeSymptom(id: string): Promise<void> {
    await (await this.localStore()).removeSymptom(id);
  }

  async getPlan(): Promise<Plan | null> {
    return (await this.localStore()).getPlan();
  }
  async savePlan(plan: Plan): Promise<void> {
    await (await this.localStore()).savePlan(plan);
  }
  async clearPlan(): Promise<void> {
    await (await this.localStore()).clearPlan();
  }
  async getDayLog(date: string): Promise<DailyCheckoff | null> {
    return (await this.localStore()).getDayLog(date);
  }
  async saveDayLog(date: string, patch: DayLogPatch): Promise<void> {
    await (await this.localStore()).saveDayLog(date, patch);
  }
  async markCheckoff(goalId: string, date: string, done: boolean): Promise<void> {
    await (await this.localStore()).markCheckoff(goalId, date, done);
  }
  async listWorkoutSessions(limit?: number): Promise<WorkoutSession[]> {
    return (await this.localStore()).listWorkoutSessions(limit);
  }
  async saveWorkoutSession(session: WorkoutSession): Promise<void> {
    await (await this.localStore()).saveWorkoutSession(session);
  }
  async removeWorkoutSession(id: string): Promise<void> {
    await (await this.localStore()).removeWorkoutSession(id);
  }
}

function rowToEntry(r: DiaryRow): DiaryEntry {
  return {
    id: r.id,
    date: r.date,
    meal: r.meal,
    food: r.food,
    quantity: Number(r.quantity),
    loggedAt: r.logged_at,
  };
}
