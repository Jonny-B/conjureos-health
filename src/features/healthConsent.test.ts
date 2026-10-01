import { describe, it, expect, vi, beforeEach } from "vitest";

const files = new Map<string, string>();
let failWrites = false;

vi.mock("../bridge/vfs", () => ({
  readJson: async <T,>(path: string, fallback: T): Promise<T> => {
    const raw = files.get(path);
    if (raw === undefined) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  writeJsonOrThrow: async (path: string, value: unknown): Promise<void> => {
    if (failWrites) throw new Error("vfs down");
    files.set(path, JSON.stringify(value));
  },
}));

import {
  HEALTH_CONSENT_VERSION,
  healthConsentGranted,
  loadHealthConsent,
  recordHealthConsent,
  withdrawHealthConsent,
} from "./healthConsent";

beforeEach(() => {
  files.clear();
  failWrites = false;
});

describe("consent to collect health data", () => {
  it("is absent until agreed", async () => {
    expect(await loadHealthConsent()).toBe(false);
    expect(healthConsentGranted()).toBe(false);
  });

  it("survives a reload once recorded", async () => {
    expect(await recordHealthConsent()).toBe(true);
    expect(await loadHealthConsent()).toBe(true);
    expect(healthConsentGranted()).toBe(true);
  });

  it("fails closed on an unreadable or old-version record", async () => {
    files.set("health-consent.json", "{not json");
    expect(await loadHealthConsent()).toBe(false);
    files.set("health-consent.json", JSON.stringify({ acceptedAt: "2026-01-01T00:00:00Z", version: HEALTH_CONSENT_VERSION - 1 }));
    expect(await loadHealthConsent()).toBe(false);
  });

  it("lets the person in for the session when the record can't be written, and asks again next time", async () => {
    failWrites = true;
    expect(await recordHealthConsent()).toBe(false);
    expect(healthConsentGranted()).toBe(true);
    expect(await loadHealthConsent()).toBe(false);
  });

  it("stops at once on withdrawal", async () => {
    await recordHealthConsent();
    await withdrawHealthConsent();
    expect(healthConsentGranted()).toBe(false);
    expect(await loadHealthConsent()).toBe(false);
  });
});
