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
  healthConsentOnFile,
  loadHealthConsent,
  recordHealthConsent,
  withdrawHealthConsent,
} from "./healthConsent";
import { CONSENT_BODY } from "./healthConsentCopy";

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

/**
 * ConjureOS #1156: the cross-app actions are registered at startup, before the
 * gate has read the file, so their guard must read it rather than refuse a
 * person who agreed long ago.
 */
describe("the cross-app actions' check", () => {
  it("reads an agreement the gate has not loaded yet", async () => {
    await withdrawHealthConsent(); // nothing in memory, as at startup
    files.set("health-consent.json", JSON.stringify({ acceptedAt: "2026-01-01T00:00:00Z", version: HEALTH_CONSENT_VERSION }));
    expect(healthConsentGranted()).toBe(false);
    expect(await healthConsentOnFile()).toBe(true);
  });

  it("says yes for the session after an agreement whose record could not be written", async () => {
    failWrites = true;
    await recordHealthConsent();
    expect(await healthConsentOnFile()).toBe(true);
  });

  it("refuses with nothing on file, and at once after a withdrawal", async () => {
    await withdrawHealthConsent();
    expect(await healthConsentOnFile()).toBe(false);
    await recordHealthConsent();
    expect(await healthConsentOnFile()).toBe(true);
    await withdrawHealthConsent();
    expect(await healthConsentOnFile()).toBe(false);
  });
});

/**
 * The gate's wording names Ask Health where it named the same feature as "the
 * food coach". That rename is not a material change (see the note on
 * HEALTH_CONSENT_VERSION), so agreements already given still count. Read that
 * note before changing either half of this.
 */
describe("the gate's wording", () => {
  it("names Ask Health behind its own agreement, and names no coach", () => {
    const body = CONSENT_BODY.join(" ");
    expect(body).toContain(
      "Find patterns and Ask Health ask for a separate agreement before they send anything.",
    );
    expect(body).not.toMatch(/coach|ask about food/i);
  });

  it("stays on the version agreements were given under", () => {
    expect(HEALTH_CONSENT_VERSION).toBe(1);
  });
});
