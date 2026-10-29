/**
 * What another app, or ConjureOS's assistant, is told when Conjure Health
 * refuses a food estimate for want of the AI agreement (ConjureOS #1163,
 * #1156's NEEDS_CONSENT pattern). Chat shows the line on a card with an Open
 * button that only opens the app, so the line has to say where in the app
 * the agreement is given; and `logFood` keeps its way to log without the AI.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiaryEntry, Profile } from "../types";

const complete = vi.fn();
const files: Record<string, string> = {};

vi.mock("../bridge/ai", async (orig) => ({
  ...(await orig<typeof import("../bridge/ai")>()),
  complete: (...a: unknown[]) => complete(...a),
  isAiAvailable: () => true,
}));
vi.mock("../bridge/vfs", () => ({
  readJson: async (p: string, d: unknown) => (files[p] ? JSON.parse(files[p]!) : d),
  writeJson: async (p: string, v: unknown) => void (files[p] = JSON.stringify(v)),
  writeJsonOrThrow: async (p: string, v: unknown) => void (files[p] = JSON.stringify(v)),
  vfs: { rm: async (p: string) => void delete files[p] },
}));

let profile: Profile | null;
let diary: DiaryEntry[];
vi.mock("../data/repository", () => ({
  getRepository: async () => ({
    getProfile: async () => profile,
    saveProfile: async (p: Profile) => void (profile = p),
    addDiaryEntry: async (e: Omit<DiaryEntry, "id" | "loggedAt">) => {
      const row = { ...e, id: `d${diary.length}`, loggedAt: new Date().toISOString() } as DiaryEntry;
      diary.push(row);
      return row;
    },
  }),
}));

type Handler = (params?: unknown) => Promise<unknown>;
let actions: Record<string, Handler>;

beforeEach(async () => {
  vi.resetModules();
  complete.mockReset();
  for (const k of Object.keys(files)) delete files[k];
  profile = null;
  diary = [];
  // The cross-app actions need the agreement to keep health data first.
  files["health-consent.json"] = JSON.stringify({ acceptedAt: "2026-09-01T09:00:00.000Z", version: 1 });
  actions = {};
  (globalThis as { window?: unknown }).window = {
    __conjureos: { actions: { register: async (map: Record<string, Handler>) => void (actions = map) } },
  };
  const { registerActions } = await import("../bridge/actions");
  await registerActions();
});

/** The refusal's message, marker included. */
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
}

/** The line Chat shows: the message after the marker, as a person reads it. */
function line(message: string): string {
  expect(message.startsWith("NEEDS_CONSENT:")).toBe(true);
  return message.slice("NEEDS_CONSENT:".length);
}

function expectCopyRules(s: string) {
  expect(s).not.toContain("—");
  expect(s).not.toMatch(/\b(now|no longer|yet)\b/i);
}

describe("the refusal says where to agree", () => {
  it("estimateNutrition names Settings in Conjure Health, within the 200 characters Chat shows", async () => {
    const msg = line(await refusal(actions.estimateNutrition!({ text: "a bowl of chili" })));
    expect(msg).toContain("Conjure Health");
    expect(msg).toContain("Settings");
    expect(msg.length).toBeLessThanOrEqual(200);
    expectCopyRules(msg);
    expect(complete).not.toHaveBeenCalled();
  });

  it("logFood without calories names Settings too, and keeps its way to log without the AI", async () => {
    const msg = line(await refusal(actions.logFood!({ name: "chicken sandwich" })));
    expect(msg).toContain("Settings");
    expect(msg).toContain("Or pass calories to log it with your own numbers.");
    expect(msg.length).toBeLessThanOrEqual(200);
    expectCopyRules(msg);
    expect(complete).not.toHaveBeenCalled();
    expect(diary).toEqual([]);
  });

  it("logFood with calories still logs without any AI agreement (positive control)", async () => {
    await expect(actions.logFood!({ name: "black coffee", calories: 5 })).resolves.toBeDefined();
    expect(diary).toHaveLength(1);
  });
});
