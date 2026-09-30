import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupBarcode, lookupBarcodeDetailed } from "./openFoodFacts";

const reply = (body: unknown, init: { status?: number } = {}) =>
  ({
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    json: async () => body,
  }) as unknown as Response;

const stubFetch = (impl: () => Promise<Response>) => vi.stubGlobal("fetch", vi.fn(impl));

const product = (nutriments: Record<string, unknown>) => ({
  status: 1,
  product: { product_name: "Mystery Bar", brands: "Acme", nutriments },
});

describe("off.lookupBarcodeDetailed", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports a hit with per-100g energy", async () => {
    stubFetch(async () => reply(product({ "energy-kcal_100g": 250, proteins_100g: 5 })));
    const r = await lookupBarcodeDetailed("012345678905");
    expect(r.kind).toBe("hit");
    if (r.kind === "hit") {
      expect(r.food.perServing.calories).toBe(250);
      expect(r.food.servingSize).toBe("100 g");
    }
  });

  it("keeps a real 0 kcal serving (water)", async () => {
    stubFetch(async () => reply(product({ "energy-kcal_serving": 0 })));
    const r = await lookupBarcodeDetailed("012345678905");
    expect(r.kind).toBe("hit");
  });

  it("treats a named product with no energy data as a miss, not 0 kcal", async () => {
    stubFetch(async () => reply(product({})));
    expect(await lookupBarcodeDetailed("012345678905")).toEqual({ kind: "miss" });
    expect(await lookupBarcode("012345678905")).toBeNull();
    // A null serving value does not count as present either.
    stubFetch(async () => reply(product({ "energy-kcal_serving": null })));
    expect(await lookupBarcodeDetailed("012345678905")).toEqual({ kind: "miss" });
  });

  it("reports definite misses: 404, status 0, no product", async () => {
    stubFetch(async () => reply({}, { status: 404 }));
    expect(await lookupBarcodeDetailed("012345678905")).toEqual({ kind: "miss" });
    stubFetch(async () => reply({ status: 0 }));
    expect(await lookupBarcodeDetailed("012345678905")).toEqual({ kind: "miss" });
    stubFetch(async () => reply({ status: 1 }));
    expect(await lookupBarcodeDetailed("012345678905")).toEqual({ kind: "miss" });
  });

  it("reports failures as errors and never rejects", async () => {
    stubFetch(async () => Promise.reject(new TypeError("offline")));
    expect(await lookupBarcodeDetailed("012345678905")).toEqual({ kind: "error" });
    stubFetch(async () => reply({}, { status: 429 }));
    expect(await lookupBarcodeDetailed("012345678905")).toEqual({ kind: "error" });
    stubFetch(async () => reply({}, { status: 503 }));
    expect(await lookupBarcodeDetailed("012345678905")).toEqual({ kind: "error" });
    // 200 with a non-JSON body (captive portal), and an abort while reading it.
    stubFetch(async () => ({ ok: true, status: 200, json: async () => JSON.parse("<html>") }) as unknown as Response);
    expect(await lookupBarcodeDetailed("012345678905")).toEqual({ kind: "error" });
    stubFetch(async () => ({ ok: true, status: 200, json: async () => { throw new DOMException("aborted", "AbortError"); } }) as unknown as Response);
    expect(await lookupBarcode("012345678905")).toBeNull();
  });

  it("tolerates a null JSON body", async () => {
    stubFetch(async () => reply(null));
    expect(await lookupBarcodeDetailed("012345678905")).toEqual({ kind: "miss" });
  });
});
