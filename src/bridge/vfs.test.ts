import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readJson, readJsonStrict, vfs } from "./vfs";

describe("readJsonStrict", () => {
  beforeEach(() => {
    (globalThis as unknown as { window: unknown }).window = {};
  });
  afterEach(() => vi.restoreAllMocks());

  it("returns the fallback only for a missing or empty file", async () => {
    await vfs.rm("strict.json");
    expect(await readJsonStrict("strict.json", { v: 0 })).toEqual({ v: 0 });
    await vfs.write("strict.json", "");
    expect(await readJsonStrict("strict.json", { v: 0 })).toEqual({ v: 0 });
  });

  it("returns the stored value when the file reads", async () => {
    await vfs.write("strict.json", JSON.stringify({ v: 1 }));
    expect(await readJsonStrict("strict.json", { v: 0 })).toEqual({ v: 1 });
  });

  it("throws on a read failure instead of returning the fallback", async () => {
    await vfs.write("strict.json", JSON.stringify({ v: 1 }));
    vi.spyOn(vfs, "read").mockRejectedValue(new Error("vfs timeout"));
    await expect(readJsonStrict("strict.json", { v: 0 })).rejects.toThrow("vfs timeout");
    // readJson keeps its lenient contract for caches.
    expect(await readJson("strict.json", { v: 0 })).toEqual({ v: 0 });
  });

  it("throws when exists() fails, and on corrupt JSON", async () => {
    vi.spyOn(vfs, "exists").mockRejectedValue(new Error("permission denied"));
    await expect(readJsonStrict("strict.json", { v: 0 })).rejects.toThrow("permission denied");
    vi.restoreAllMocks();
    await vfs.write("strict.json", "{not json");
    await expect(readJsonStrict("strict.json", { v: 0 })).rejects.toThrow();
  });

  it("treats a file deleted between exists() and read() as missing", async () => {
    vi.spyOn(vfs, "exists").mockResolvedValue(true);
    vi.spyOn(vfs, "read").mockRejectedValue(new Error("ENOENT: gone.json"));
    expect(await readJsonStrict("gone.json", { v: 0 })).toEqual({ v: 0 });
  });
});
