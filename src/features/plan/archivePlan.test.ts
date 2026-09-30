import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Plan } from "../../types";
import { vfs } from "../../bridge/vfs";
import { archivePlan } from "./planService";

const plan = (id: string) => ({ id, mode: "eat_better", goals: [] }) as unknown as Plan;

describe("archivePlan", () => {
  beforeEach(async () => {
    (globalThis as unknown as { window: unknown }).window = {};
    await vfs.rm("plan-archive.json");
  });
  afterEach(() => vi.restoreAllMocks());

  it("prepends to the existing archive", async () => {
    await archivePlan(plan("a"));
    await archivePlan(plan("b"));
    const stored = JSON.parse(await vfs.read("plan-archive.json")) as Plan[];
    expect(stored.map((p) => p.id)).toEqual(["b", "a"]);
  });

  it("leaves the archive alone when it cannot be read", async () => {
    await archivePlan(plan("a"));
    await archivePlan(plan("b"));
    const before = await vfs.read("plan-archive.json");
    vi.spyOn(vfs, "read").mockRejectedValue(new Error("vfs timeout"));
    await archivePlan(plan("c"));
    vi.restoreAllMocks();
    expect(await vfs.read("plan-archive.json")).toBe(before);
  });
});
