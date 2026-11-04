/**
 * The agreement as ConjureOS Chat sees it (ConjureOS #1230): four states read
 * from the file, a refusal that is not an agreement, and the reports the host
 * hears in order. Each test loads the modules afresh, because a withdrawal
 * holds for the rest of its session.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const files: Record<string, string> = {};
const log: string[] = [];
let failWrites = false;

vi.mock("../bridge/vfs", () => ({
  readJson: async (p: string, d: unknown) => {
    try {
      if (files[p] === undefined) throw new Error("ENOENT");
      return JSON.parse(files[p]!);
    } catch {
      return d;
    }
  },
  writeJsonOrThrow: async (p: string, v: unknown) => {
    log.push(`write:${p}`);
    if (failWrites) throw new Error("disk full");
    files[p] = JSON.stringify(v);
  },
  vfs: {
    exists: async (p: string) => files[p] !== undefined,
    read: async (p: string) => {
      if (files[p] === undefined) throw new Error("ENOENT");
      return files[p]!;
    },
    rm: async (p: string) => void delete files[p],
  },
}));
vi.mock("../bridge/agreement", () => ({
  reportAgreement: (s: string) => void log.push(`report:${s}`),
  onAgreementRequest: () => () => {},
}));
vi.mock("../data/repository", () => ({
  getRepository: async () => ({ getProfile: async () => null, saveProfile: async () => {} }),
}));
vi.mock("./ask/conversationFile", () => ({ clearAskConversation: async () => true }));

type Consent = typeof import("./aiConsent");
let c: Consent;

beforeEach(async () => {
  vi.resetModules();
  for (const k of Object.keys(files)) delete files[k];
  log.length = 0;
  failWrites = false;
  c = await import("./aiConsent");
});

const accepted = (version: number) => JSON.stringify({ acceptedAt: "2026-11-01T09:00:00.000Z", version, includeNotes: false });

describe("aiAgreementState", () => {
  it("is on the wording that names ConjureOS Chat", () => {
    expect(c.DISCLOSURE_VERSION).toBe(4);
    expect(c.AI_FEATURES).toContain("Answers from ConjureOS Chat about your health");
    expect(c.DISCLOSURE_SENDS.some((l) => l.startsWith("ConjureOS Chat, when you ask it about your health:"))).toBe(true);
    for (const l of [...c.AI_FEATURES, ...c.DISCLOSURE_SENDS]) expect(l).not.toContain("—");
  });

  it("reads a v3 agreement as not answered under v4", async () => {
    files[c.AI_CONSENT_PATH] = accepted(3);
    expect(await c.aiAgreementState()).toBe("not_answered");
    expect(await c.hasAiJournalConsent()).toBe(false);
  });

  it("reads a current agreement as agreed", async () => {
    files[c.AI_CONSENT_PATH] = accepted(4);
    expect(await c.aiAgreementState()).toBe("agreed");
  });

  it("tells a missing file (not answered) from a JSON null (withdrawn)", async () => {
    expect(await c.aiAgreementState()).toBe("not_answered");
    files[c.AI_CONSENT_PATH] = "null";
    expect(await c.aiAgreementState()).toBe("withdrawn");
  });

  it("reads {refusedAt} as refused, and not as an agreement", async () => {
    files[c.AI_CONSENT_PATH] = JSON.stringify({ refusedAt: "2026-11-01T09:00:00.000Z", version: 4 });
    expect(await c.aiAgreementState()).toBe("refused");
    expect(await c.hasAiJournalConsent()).toBe(false);
    expect(await c.readAiJournalConsent()).toBeUndefined();
  });

  it("fails closed on junk and on a file that cannot be read", async () => {
    files[c.AI_CONSENT_PATH] = "{not json";
    expect(await c.aiAgreementState()).toBe("not_answered");
    files[c.AI_CONSENT_PATH] = JSON.stringify({ acceptedAt: 5 });
    expect(await c.aiAgreementState()).toBe("not_answered");
  });

  it("holds a withdrawal for the session whatever the file says", async () => {
    files[c.AI_CONSENT_PATH] = accepted(4);
    failWrites = true;
    await c.withdrawAiJournalConsent();
    expect(await c.aiAgreementState()).toBe("withdrawn");
  });
});

describe("recordAiRefusal", () => {
  it("writes {refusedAt, version} and reports refused", async () => {
    expect(await c.recordAiRefusal()).toBe(true);
    const f = JSON.parse(files[c.AI_CONSENT_PATH]!);
    expect(typeof f.refusedAt).toBe("string");
    expect(f.version).toBe(4);
    expect(log).toContain("report:refused");
    expect(await c.aiAgreementState()).toBe("refused");
  });

  it("reads a refusal after a withdrawal in this session as refused", async () => {
    files[c.AI_CONSENT_PATH] = accepted(4);
    await c.withdrawAiJournalConsent();
    expect(await c.recordAiRefusal()).toBe(true);
    expect(await c.aiAgreementState()).toBe("refused");
    expect(await c.hasAiJournalConsent()).toBe(false);
  });
});

describe("reports to the host", () => {
  it("withdraw reports before the write, even when the write fails", async () => {
    files[c.AI_CONSENT_PATH] = accepted(4);
    failWrites = true;
    expect(await c.withdrawAiJournalConsent()).toBe(false);
    expect(log.indexOf("report:withdrawn")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("report:withdrawn")).toBeLessThan(log.indexOf(`write:${c.AI_CONSENT_PATH}`));
  });

  it("agree reports only after the save", async () => {
    await c.recordAiJournalConsent(false);
    expect(log).toEqual([`write:${c.AI_CONSENT_PATH}`, "report:agreed"]);
  });

  it("agree reports nothing when the save fails", async () => {
    failWrites = true;
    expect(await c.recordAiJournalConsent(false)).toBe(false);
    expect(log).not.toContain("report:agreed");
  });
});

describe("the manifest", () => {
  it("declares the agreement the host reads, on the version this app asks for", async () => {
    const pkg = (await import("../../package.json")) as unknown as {
      default: { conjureos: { aiAgreement?: { file: string; version: number }; dataReadable: string[] } };
    };
    expect(pkg.default.conjureos.aiAgreement).toEqual({ file: c.AI_CONSENT_PATH, version: c.DISCLOSURE_VERSION });
    expect(pkg.default.conjureos.dataReadable).toEqual(["nutrition-summary.json"]);
  });
});
