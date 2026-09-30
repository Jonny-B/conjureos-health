import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./conjureHealthDb", () => ({
  lookupBarcode: vi.fn(async () => null),
  logScanAttempt: vi.fn(async () => {}),
  searchText: vi.fn(async () => []),
}));

const CACHE = "food-cache.json";

const reply = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

// vfs is re-imported after each resetModules so the test sees foodSearch's store.
let vfs: typeof import("../../bridge/vfs").vfs;
const readCache = async () => JSON.parse(await vfs.read(CACHE)) as { entries: Record<string, unknown> };

describe("foodSearch.lookupBarcode caching", () => {
  let lookupBarcode: typeof import("./foodSearch").lookupBarcode;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    (globalThis as unknown as { window: unknown }).window = new EventTarget();
    vi.resetModules(); // drop the in-memory cache singleton
    ({ vfs } = await import("../../bridge/vfs"));
    await vfs.write(CACHE, "");
    ({ lookupBarcode } = await import("./foodSearch"));
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const good = {
    status: 1,
    product: { product_name: "Greek yogurt", nutriments: { "energy-kcal_100g": 60 } },
  };

  it("does not cache a network failure, so a later online scan resolves", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    expect(await lookupBarcode("5200435000027", undefined, { log: false })).toBeNull();
    expect(await vfs.read(CACHE)).toBe(""); // nothing persisted

    fetchMock.mockResolvedValueOnce(reply(good));
    const food = await lookupBarcode("5200435000027", undefined, { log: false });
    expect(food?.name).toBe("Greek yogurt");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache 429, 5xx or an unparseable 200", async () => {
    for (const r of [reply({}, 429), reply({}, 503)]) {
      fetchMock.mockResolvedValueOnce(r);
      expect(await lookupBarcode("5200435000027", undefined, { log: false })).toBeNull();
    }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => JSON.parse("<html>") });
    expect(await lookupBarcode("5200435000027", undefined, { log: false })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await lookupBarcode("5200435000027", undefined, { log: false });
    expect(fetchMock).toHaveBeenCalledTimes(4); // not served from a cached null
  });

  it("does not cache a miss for an aborted lookup", async () => {
    const ctl = new AbortController();
    ctl.abort();
    fetchMock.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    expect(await lookupBarcode("5200435000027", ctl.signal, { log: false })).toBeNull();
    fetchMock.mockResolvedValueOnce(reply(good));
    expect(await lookupBarcode("5200435000027", undefined, { log: false })).not.toBeNull();
  });

  it("caches a definite miss (200 with status 0) and does not re-fetch", async () => {
    fetchMock.mockResolvedValue(reply({ status: 0 }));
    expect(await lookupBarcode("5200435000027", undefined, { log: false })).toBeNull();
    expect((await readCache()).entries).toEqual({ "5200435000027": null });
    expect(await lookupBarcode("5200435000027", undefined, { log: false })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats an OFF hit with no energy as a miss rather than a 0 kcal food", async () => {
    fetchMock.mockResolvedValue(reply({ status: 1, product: { product_name: "Mystery Bar", nutriments: {} } }));
    expect(await lookupBarcode("5200435000027", undefined, { log: false })).toBeNull();
  });

  it("never rejects even when the conjure provider throws", async () => {
    const conjure = await import("./conjureHealthDb");
    vi.mocked(conjure.lookupBarcode).mockRejectedValueOnce(new Error("boom"));
    fetchMock.mockResolvedValueOnce(reply(good));
    expect((await lookupBarcode("5200435000027", undefined, { log: false }))?.name).toBe("Greek yogurt");
  });
});
