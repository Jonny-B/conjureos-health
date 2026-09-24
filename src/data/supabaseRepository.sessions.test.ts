import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../bridge/host", () => ({
  getAccessToken: async () => "fake-token",
  isHostAuthAvailable: () => true,
}));
vi.mock("../bridge/health", () => ({ readWorkouts: vi.fn(async () => []) }));

// The feature code reaches the backend through getRepository(); point it at a
// real SupabaseRepository so this runs the signed-in path end to end.
const holder: { repo: unknown } = { repo: null };
vi.mock("./repository", async (orig) => ({
  ...(await orig<typeof import("./repository")>()),
  getRepository: async () => holder.repo,
}));

import { SupabaseRepository } from "./supabaseRepository";
import { vfs } from "../bridge/vfs";
import { addManualExercise, listCompletedWorkouts, removeSession } from "../features/exercise";

function installLocalStorage(): void {
  const map = new Map<string, string>();
  (globalThis as unknown as { window: { localStorage: Storage } }).window = {
    localStorage: {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() {
        return map.size;
      },
    },
  };
}

describe("manual exercise on the Supabase backend (ConjureOS #796)", () => {
  const fetchMock = vi.fn(async () => {
    throw new Error("no server table for workout sessions");
  });

  beforeEach(async () => {
    installLocalStorage();
    await vfs.write("store.json", "");
    vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-key");
    vi.stubGlobal("fetch", fetchMock);
    holder.repo = new SupabaseRepository();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("saves, lists and removes a manual exercise without a server call", async () => {
    const s = await addManualExercise("2026-09-24", { name: "Evening walk", durationMin: 30, calories: 140 });

    const listed = await listCompletedWorkouts("2026-09-24");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ key: s.id, name: "Evening walk", kcal: 140, sourceLabel: "Added by you" });

    // Mirrored into the app's VFS store, which platform sync backs up.
    const mirror = JSON.parse((await vfs.read("store.json")) ?? "{}");
    expect(mirror.workoutSessions.map((w: { id: string }) => w.id)).toContain(s.id);
    expect(fetchMock).not.toHaveBeenCalled();

    await removeSession(s.id);
    expect(await listCompletedWorkouts("2026-09-24")).toHaveLength(0);
  });

  it("survives a fresh repository instance on the same device", async () => {
    const s = await addManualExercise("2026-09-24", { name: "Swim", calories: 300 });
    holder.repo = new SupabaseRepository();
    const listed = await listCompletedWorkouts("2026-09-24");
    expect(listed.map((i) => i.key)).toContain(s.id);
  });
});
