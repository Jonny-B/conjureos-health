/**
 * USDA text search goes through ConjureOS's usda-proxy and says when it did
 * not answer (conjureos-fitness#70).
 *
 * Before this, the app called api.nal.usda.gov itself on the shared DEMO_KEY
 * (30 requests an hour per IP, shared with everyone else on that key) and
 * turned every failure into an empty list, so a rate-limited search told the
 * person the food did not exist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchText } from "./usda";

const PROXY = "https://proj.supabase.co/functions/v1/usda-proxy";

const BANANA = {
  fdcId: 1105314,
  description: "BANANAS, RAW",
  dataType: "SR Legacy",
  foodNutrients: [
    { nutrientName: "Energy", value: 89 },
    { nutrientName: "Protein", value: 1.1 },
    { nutrientName: "Total lipid (fat)", value: 0.3 },
    { nutrientName: "Carbohydrate, by difference", value: 22.8 },
  ],
};

/** Shipped source, tests excluded, by path relative to this folder. */
const SHIPPED = import.meta.glob(["../../**/*.{ts,tsx}", "!../../**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const fetchMock = vi.fn();
const host = globalThis as unknown as { window?: { __conjureos?: unknown } };

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  host.window = { __conjureos: { env: { usdaProxyUrl: PROXY } } };
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete host.window;
});

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("USDA search", () => {
  it("asks ConjureOS's usda-proxy, with no key of its own", async () => {
    fetchMock.mockResolvedValue(ok({ foods: [BANANA] }));
    const foods = await searchText("banana", 5);

    expect(foods.map((f) => f.name)).toEqual(["Bananas"]);
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(`${url.origin}${url.pathname}`).toBe(PROXY);
    expect(url.searchParams.get("query")).toBe("banana");
    expect(url.searchParams.has("api_key")).toBe(false);
  });

  it("reports a rate-limited search instead of finding nothing", async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"OVER_RATE_LIMIT"}', { status: 429 }));
    await expect(searchText("banana", 5)).rejects.toMatchObject({ provider: "usda", status: 429 });
  });

  it("reports a proxy it could not reach", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(searchText("banana", 5)).rejects.toMatchObject({ provider: "usda" });
  });

  it("reports a build that has nowhere to send the search, without calling USDA", async () => {
    host.window = { __conjureos: {} };
    vi.stubEnv("VITE_SUPABASE_URL", "");
    await expect(searchText("banana", 5)).rejects.toMatchObject({ provider: "usda" });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("falls back to the build's own project when the host names no proxy", async () => {
    host.window = { __conjureos: {} };
    vi.stubEnv("VITE_SUPABASE_URL", "https://build.supabase.co");
    fetchMock.mockResolvedValue(ok({ foods: [] }));
    await searchText("banana", 5);
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(`${url.origin}${url.pathname}`).toBe("https://build.supabase.co/functions/v1/usda-proxy");
    vi.unstubAllEnvs();
  });

  it("treats a search the caller cancelled as no answer wanted, not a failure", async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValue(new DOMException("aborted", "AbortError"));
    await expect(searchText("banana", 5, controller.signal)).resolves.toEqual([]);
  });

  it("ships no USDA key and no direct call to USDA", () => {
    const offenders = Object.entries(SHIPPED)
      .filter(([, text]) => /DEMO_KEY|VITE_USDA_API_KEY|api\.nal\.usda\.gov/.test(text))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
    expect(Object.keys(SHIPPED).filter((p) => /usda/.test(p))).toEqual(["./usda.ts"]);
  });
});
