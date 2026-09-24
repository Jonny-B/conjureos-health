import { describe, expect, it, vi, afterEach } from "vitest";
import { SupabaseRestClient } from "./supabaseClient";

/**
 * Bug 3: only `remove()` (DELETE) forgot Content-Profile, so it silently
 * targeted the `public` schema instead of `fitness` — every other write verb
 * (insert/upsert/patch) got this right. These tests pin the header set per
 * verb so that regression can't come back unnoticed.
 */

function fakeResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => [],
  } as unknown as Response;
}

// Typed with fetch's own parameter list so `.mock.calls[n]` comes back as a
// [input, init] tuple instead of vi.fn's inferred no-args signature.
function fetchMock() {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => fakeResponse());
}

function client(mock: ReturnType<typeof fetchMock>): SupabaseRestClient {
  vi.stubGlobal("fetch", mock);
  return new SupabaseRestClient("https://example.supabase.co", "anon-key", async () => "token");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SupabaseRestClient header profiles", () => {
  it("sends Content-Profile on DELETE, same as the other write verbs", async () => {
    const mock = fetchMock();
    const c = client(mock);

    await c.remove("weights", "date=eq.2026-01-01");

    expect(mock).toHaveBeenCalledTimes(1);
    const [, init] = mock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(init?.method).toBe("DELETE");
    expect(headers["Content-Profile"]).toBe("fitness");
  });

  it("sends Content-Profile on PATCH", async () => {
    const mock = fetchMock();
    const c = client(mock);

    await c.patch("diary_entries", "id=eq.abc", { quantity: 2 });

    const [, init] = mock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers["Content-Profile"]).toBe("fitness");
  });

  it("does NOT send Content-Profile on a plain read (select)", async () => {
    const mock = fetchMock();
    const c = client(mock);

    await c.select("weights", "select=*");

    const [, init] = mock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers["Content-Profile"]).toBeUndefined();
    expect(headers["Accept-Profile"]).toBe("fitness");
  });
});
