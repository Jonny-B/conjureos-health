import { describe, expect, it, vi } from "vitest";

// Plain node environment: run the component's effect through a minimal hook
// runtime so the unmount-while-getUserMedia-pending race can be reproduced.
const rt = vi.hoisted(() => {
  const st = { slots: [] as unknown[], i: 0, effects: [] as Array<() => void | (() => void)> };
  const useState = (init: unknown) => {
    const idx = st.i++;
    if (!(idx in st.slots)) st.slots[idx] = { v: init };
    const slot = st.slots[idx] as { v: unknown };
    return [slot.v, (n: unknown) => void (slot.v = typeof n === "function" ? (n as (p: unknown) => unknown)(slot.v) : n)];
  };
  const useRef = (init: unknown) => {
    const idx = st.i++;
    if (!(idx in st.slots)) st.slots[idx] = { current: init };
    return st.slots[idx];
  };
  const useEffect = (fn: () => void | (() => void)) => {
    st.i++;
    st.effects.push(fn);
  };
  return { st, hooks: { useState, useRef, useEffect } };
});

vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), ...rt.hooks }));
vi.mock("../features/barcode", () => ({
  isScanSupported: () => true,
  scanFromVideo: vi.fn(),
}));

import { BarcodeScanner } from "./BarcodeScanner";

describe("BarcodeScanner releases the camera if unmounted while getUserMedia is pending (h-addfood#2)", () => {
  it("stops the tracks of a stream that arrives after unmount", async () => {
    let resolveStream!: (s: unknown) => void;
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: () => new Promise((r) => (resolveStream = r)) },
    });
    (BarcodeScanner as (p: unknown) => unknown)({ onDetected: vi.fn() });
    expect(rt.st.effects).toHaveLength(1);
    const cleanup = rt.st.effects[0]!() as () => void;

    // The user leaves (videoRef is null, signal aborted) before the camera opens.
    cleanup();
    const stop = vi.fn();
    resolveStream({ getTracks: () => [{ stop }], getVideoTracks: () => [] });
    await new Promise((r) => setTimeout(r, 0));

    expect(stop).toHaveBeenCalled();
  });
});
