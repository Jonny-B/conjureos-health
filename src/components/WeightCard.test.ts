import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WeightEntry } from "../types";
import { logWeighIn, pickWeightKg } from "./WeightCard";

const h = vi.hoisted(() => ({
  upsertWeight: vi.fn(),
  reportSaveFailure: vi.fn(),
}));
vi.mock("../data/repository", () => ({ getRepository: async () => ({ upsertWeight: h.upsertWeight }) }));
vi.mock("../data/saveFailure", () => ({ reportSaveFailure: h.reportSaveFailure }));

const w = (weightKg: number, date = "2026-07-16"): WeightEntry => ({ date, weightKg });

describe("pickWeightKg", () => {
  it("uses the newest weigh-in when one exists", () => {
    expect(pickWeightKg([w(78), w(80)])).toBe(78);
  });

  it("returns null when there are no weigh-ins — the cards show a prompt, never a fabricated stat", () => {
    // Even though the profile carries a weight, we do NOT surface it here: a
    // pounds-in-kg profile value was the source of the phantom "399 lb default".
    expect(pickWeightKg([])).toBeNull();
  });
});

describe("logWeighIn", () => {
  beforeEach(() => {
    h.upsertWeight.mockReset();
    h.reportSaveFailure.mockReset();
  });

  it("stores kg to 2 decimals and resolves true", async () => {
    h.upsertWeight.mockResolvedValue(undefined);
    expect(await logWeighIn(180.1, "imperial", "2026-08-09")).toBe(true);
    expect(h.upsertWeight).toHaveBeenCalledWith({ date: "2026-08-09", weightKg: 81.69 });
    expect(h.reportSaveFailure).not.toHaveBeenCalled();
  });

  it("reports a failed write and resolves false instead of rejecting", async () => {
    const err = new Error("failed to persist");
    h.upsertWeight.mockRejectedValue(err);
    expect(await logWeighIn(80, "metric", "2026-08-09")).toBe(false);
    expect(h.reportSaveFailure).toHaveBeenCalledWith("your weight", err);
  });
});
