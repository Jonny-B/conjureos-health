// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { onAgreementRequest, reportAgreement } from "./agreement";

afterEach(() => {
  delete (window as { __conjureos?: unknown }).__conjureos;
});

describe("the host agreement bridge", () => {
  it("does nothing, and does not throw, when the host has no agreement API", async () => {
    expect(() => reportAgreement("withdrawn")).not.toThrow();
    const off = onAgreementRequest(() => ({ shown: true }));
    expect(typeof off).toBe("function");
    expect(() => off()).not.toThrow();
    (window as { __conjureos?: unknown }).__conjureos = { ai: {} };
    expect(() => reportAgreement("agreed")).not.toThrow();
    expect(() => onAgreementRequest(() => ({ shown: true }))()).not.toThrow();
  });

  it("forwards a report to the host", () => {
    const report = vi.fn();
    (window as { __conjureos?: unknown }).__conjureos = { ai: { reportAgreement: report } };
    reportAgreement("refused");
    expect(report).toHaveBeenCalledWith("refused");
  });

  it("never lets a host that throws break the caller", () => {
    (window as { __conjureos?: unknown }).__conjureos = {
      ai: { reportAgreement: () => { throw new Error("boom"); } },
    };
    expect(() => reportAgreement("withdrawn")).not.toThrow();
  });

  it("registers the handler with the host and returns its unsubscribe", () => {
    const unsub = vi.fn();
    const on = vi.fn(() => unsub);
    (window as { __conjureos?: unknown }).__conjureos = { ai: { onAgreementRequest: on } };
    const fn = vi.fn(() => ({ shown: true }));
    const off = onAgreementRequest(fn);
    expect(on).toHaveBeenCalledWith(fn);
    off();
    expect(unsub).toHaveBeenCalled();
  });
});
