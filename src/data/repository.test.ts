import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Pretend the host is signed in and hands us a token, so the selector would
// otherwise pick the Supabase backend.
vi.mock("../bridge/host", () => ({
  isHostAuthAvailable: () => true,
  getAccessToken: async () => "fake-token",
}));

// …but the Supabase backend is BROKEN: init succeeds, the reachability probe
// (getProfile) throws — exactly the "fitness schema not exposed" case.
const probe = vi.fn(async () => {
  throw new Error("PGRST106: Invalid schema: fitness");
});
vi.mock("./supabaseRepository", () => ({
  SupabaseRepository: class {
    kind = "supabase" as const;
    async init() {}
    getProfile = probe;
  },
}));

import { getRepository, __resetRepository } from "./repository";

describe("getRepository backend selection hardening", () => {
  beforeEach(() => {
    __resetRepository();
    probe.mockClear();
    vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-key");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("falls back to the durable local store when the Supabase backend is unreachable", async () => {
    const repo = await getRepository();
    expect(probe).toHaveBeenCalled(); // we actually probed reachability
    expect(repo.kind).toBe("mock"); // …and did NOT hand back the broken backend
  });

  it("returns the same instance on repeat + concurrent calls (idempotent)", async () => {
    const [a, b, c] = await Promise.all([getRepository(), getRepository(), getRepository()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});
