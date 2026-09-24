import { describe, expect, it, vi, afterEach } from "vitest";

vi.mock("../bridge/host", () => ({
  getAccessToken: async () => "fake-token",
  isHostAuthAvailable: () => true,
}));

import { SupabaseRepository } from "./supabaseRepository";

/**
 * Bug 3 (second half): every other filter call site in this file
 * encodeURIComponent's its filter value; removeWeight was the one holdout.
 * Harmless while dates are plain YYYY-MM-DD, but a landmine the moment a
 * filter value needs escaping (a literal "&"/"," etc. would corrupt the
 * PostgREST query string otherwise).
 */

function fakeResponse(): Response {
  return { ok: true, status: 200, json: async () => [] } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("SupabaseRepository.removeWeight", () => {
  it("encodeURIComponent's the date filter like every other call site", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-key");
    // Typed with fetch's own parameter list so `.mock.calls[n]` comes back as
    // a [input, init] tuple instead of vi.fn's inferred no-args signature.
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      fakeResponse(),
    );
    vi.stubGlobal("fetch", fetchMock);

    const repo = new SupabaseRepository();
    // A value with characters that must be escaped in a query string, so an
    // un-encoded call site is visibly wrong rather than accidentally OK.
    await repo.removeWeight("2026-01-01&x=1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain(`date=eq.${encodeURIComponent("2026-01-01&x=1")}`);
    expect(String(url)).not.toContain("date=eq.2026-01-01&x=1");
  });
});
