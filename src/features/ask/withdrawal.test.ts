/**
 * Withdrawing the AI agreement (owner decision 2026-10-22, ConjureOS #1163):
 * "Withdrawn consent means they have withdrawn consent."
 *
 * After a person withdraws, Ask Health and Find patterns send nothing: no
 * question, no earlier conversation, no health data, no follow-up. The
 * conversation is cleared at withdrawal, an answer in flight when it lands is
 * thrown away, and agreeing again starts a fresh conversation.
 *
 * Each test loads the modules afresh, because a withdrawal holds for the rest
 * of the session it happened in, and a test's session ends with the test.
 * Only the AI call, the files and the stored profile are stand-ins.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiJournalConsent, Profile } from "../../types";

const complete = vi.fn();
const files: Record<string, string> = {};
/** When true, every file write fails, the way an offline bridge does. */
let writesFail = false;
/** When true, saving the profile fails. */
let profileSaveFails = false;

vi.mock("../../bridge/ai", async (orig) => ({
  ...(await orig<typeof import("../../bridge/ai")>()),
  complete: (...a: unknown[]) => complete(...a),
  isAiAvailable: () => true,
}));
vi.mock("../../bridge/vfs", () => ({
  readJson: async (p: string, d: unknown) => (files[p] ? JSON.parse(files[p]!) : d),
  writeJson: async (p: string, v: unknown) => {
    if (!writesFail) files[p] = JSON.stringify(v);
  },
  writeJsonOrThrow: async (p: string, v: unknown) => {
    if (writesFail) throw new Error("vfs offline");
    files[p] = JSON.stringify(v);
  },
}));

let profile: Profile;
vi.mock("../../data/repository", () => ({
  getRepository: async () => ({
    getGoals: async () => ({ calories: 2200, protein: 150, carbs: 200, fat: 70 }),
    getProfile: async () => profile,
    saveProfile: async (p: Profile) => {
      if (profileSaveFails) throw new Error("backend down");
      profile = p;
    },
    listDiary: async () => [],
    listWater: async () => [],
    listSleep: async () => [],
    listSymptoms: async (d: string) =>
      [{ id: "s1", label: "Heartburn", loggedAt: `${d}T21:40:00Z`, severity: 3 }],
    listWeights: async () => [],
  }),
}));
vi.mock("../exercise", () => ({ exerciseCaloriesForDate: async () => 0 }));

type Ask = typeof import("./ask");
type Consent = typeof import("../aiConsent");
let ask: Ask;
let consent: Consent;

const AGREED_AT = "2026-10-01T09:00:00.000Z";
const agreement = (): AiJournalConsent => ({
  version: consent.DISCLOSURE_VERSION,
  acceptedAt: AGREED_AT,
  includeNotes: false,
});

const SEPT =
  "Here is my journal for 2026-09-01 to 2026-09-30. What patterns do you notice?\n\n" +
  "2026-09-03: symptoms: Migraine at 14:00 (4/5); ate: aged cheddar";

/** A conversation asked under the agreement: a home card pair and a Find patterns pair, today. */
function conversation() {
  const at = new Date().toISOString();
  return [
    { role: "user" as const, content: "what should I eat tonight?", at },
    { role: "assistant" as const, content: "you have 1450 cal left", at },
    { role: "user" as const, content: SEPT, at, patternsRun: "r1" },
    { role: "assistant" as const, content: "Migraines follow aged cheddar.", at, patternsRun: "r1" },
  ];
}
const stored = () => JSON.parse(files["ask-health.json"] ?? "[]") as unknown[];

beforeEach(async () => {
  vi.resetModules();
  complete.mockReset();
  complete.mockImplementation(async () => "ok");
  for (const k of Object.keys(files)) delete files[k];
  writesFail = false;
  profileSaveFails = false;
  consent = await import("../aiConsent");
  ask = await import("./ask");
  profile = {
    sex: "female", age: 34, heightCm: 168, weightKg: 70, activityLevel: "moderate",
    direction: "lose", units: "metric", aiJournalConsent: agreement(),
  };
  files["ask-health.json"] = JSON.stringify(conversation());
});

describe("after the agreement is withdrawn, nothing is sent", () => {
  it("not a question from the home card, nor the conversation before it", async () => {
    const history = await ask.loadAskHistory();
    await consent.withdrawAiJournalConsent();
    const reply = await ask.askHealth("and for dessert?", history, ask.ASK_FROM_HOME);
    expect(complete).not.toHaveBeenCalled();
    expect(reply).toBeNull();
  });

  it("not a follow-up in a Find patterns sheet, which would resend the month", async () => {
    const history = await ask.loadAskHistory();
    await consent.withdrawAiJournalConsent();
    await ask.askHealth("what about the cheese?", history, { kind: "patterns", run: "r1" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("not a new Find patterns run", async () => {
    await consent.withdrawAiJournalConsent();
    await ask.askHealth(SEPT, [], ask.newPatternsRun());
    expect(complete).not.toHaveBeenCalled();
  });

  it("not even a question with no context, from anyone who has not agreed", async () => {
    delete profile.aiJournalConsent;
    const reply = await ask.askHealth("are bananas high in fiber?");
    expect(complete).not.toHaveBeenCalled();
    expect(reply).toBeNull();
  });

  it("not when the profile could not be saved: the withdrawal holds for the session", async () => {
    profileSaveFails = true;
    const saved = await consent.withdrawAiJournalConsent();
    expect(saved).toBe(false);
    expect(profile.aiJournalConsent).toBeDefined(); // the write failed
    expect(await consent.hasAiJournalConsent()).toBe(false);
    expect(await consent.readAiJournalConsent()).toBeUndefined();
    await ask.askHealth("and for dessert?", conversation(), ask.ASK_FROM_HOME);
    expect(complete).not.toHaveBeenCalled();
    expect(consent.aiWithdrawalNotSaved()).toBe(true);
  });

  it("and trying again clears the not-saved state once it saves", async () => {
    profileSaveFails = true;
    await consent.withdrawAiJournalConsent();
    profileSaveFails = false;
    expect(await consent.withdrawAiJournalConsent()).toBe(true);
    expect(consent.aiWithdrawalNotSaved()).toBe(false);
    expect(profile.aiJournalConsent).toBeUndefined();
  });
});

describe("the conversation is cleared at withdrawal", () => {
  it("is emptied on disk", async () => {
    expect(stored()).toHaveLength(4);
    expect(await consent.withdrawAiJournalConsent()).toBe(true);
    expect(stored()).toEqual([]);
    expect(await ask.loadAskHistory()).toEqual([]);
  });

  it("a withdrawal that could not clear it says it was not saved", async () => {
    writesFail = true;
    expect(await consent.withdrawAiJournalConsent()).toBe(false);
    expect(consent.aiWithdrawalNotSaved()).toBe(true);
    // Nothing of it is shown or sent meanwhile.
    expect(await ask.loadAskHistory()).toEqual([]);
  });

  it("tells an open sheet to let go of what it holds", async () => {
    const heard = vi.fn();
    consent.onAiConsentWithdrawn(heard);
    await consent.withdrawAiJournalConsent();
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe("an answer in flight when the withdrawal lands", () => {
  it("is thrown away, and nothing is added to the conversation", async () => {
    let answer!: (s: string) => void;
    complete.mockImplementation(() => new Promise<string>((r) => (answer = r)));
    const history = await ask.loadAskHistory();
    const asking = ask.askAndAppend("and for dessert?", history, ask.ASK_FROM_HOME);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));

    await consent.withdrawAiJournalConsent();
    answer("a square of dark chocolate");
    expect(await asking).toBeNull();
    expect(stored()).toEqual([]);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("is thrown away even when the person agrees again before it lands", async () => {
    let answer!: (s: string) => void;
    complete.mockImplementation(() => new Promise<string>((r) => (answer = r)));
    const asking = ask.askHealth("and for dessert?", await ask.loadAskHistory(), ask.ASK_FROM_HOME);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));

    await consent.withdrawAiJournalConsent();
    expect(await consent.recordAiJournalConsent(false)).toBe(true);
    answer("a square of dark chocolate");
    expect(await asking).toBeNull();
  });

  it("is thrown away when the call fails, too: no error turn is kept either", async () => {
    let fail!: (e: Error) => void;
    complete.mockImplementation(() => new Promise<string>((_r, j) => (fail = j)));
    const asking = ask.askAndAppend("and for dessert?", [], ask.ASK_FROM_HOME);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    await consent.withdrawAiJournalConsent();
    fail(new Error("network"));
    expect(await asking).toBeNull();
  });

  it("is thrown away when the agreement was withdrawn somewhere else meanwhile", async () => {
    // Another device withdrew: this session only sees the profile change.
    let answer!: (s: string) => void;
    complete.mockImplementation(() => new Promise<string>((r) => (answer = r)));
    const asking = ask.askHealth("and for dessert?", [], ask.ASK_FROM_HOME);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    delete profile.aiJournalConsent;
    answer("a square of dark chocolate");
    expect(await asking).toBeNull();
  });
});

describe("agreeing again starts a fresh conversation", () => {
  it("shows and sends none of the conversation from before, even when clearing it failed", async () => {
    writesFail = true;
    await consent.withdrawAiJournalConsent();
    writesFail = false;
    // The old turns are still on disk.
    expect(stored()).toHaveLength(4);
    const before = conversation();

    vi.setSystemTime(new Date(Date.now() + 60_000));
    try {
      expect(await consent.recordAiJournalConsent(false)).toBe(true);
      expect(await ask.loadAskHistory()).toEqual([]);

      const reply = await ask.askHealth("and for dessert?", before, ask.ASK_FROM_HOME);
      expect(reply).toBe("ok");
      const sent = complete.mock.calls[0]![0] as { messages: { content: string }[] };
      expect(sent.messages.map((m) => m.content)).toEqual(["and for dessert?"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the turns asked under the agreement in force (positive control)", async () => {
    expect(await ask.loadAskHistory()).toHaveLength(4);
    await ask.askHealth("and for dessert?", await ask.loadAskHistory(), ask.ASK_FROM_HOME);
    const sent = complete.mock.calls[0]![0] as { messages: { content: string }[] };
    expect(sent.messages.map((m) => m.content)).toEqual([
      "what should I eat tonight?",
      "you have 1450 cal left",
      "and for dessert?",
    ]);
  });
});

describe("what a person reads about it", () => {
  it("keeps the copy rules: no em-dash, no now, no longer or yet", async () => {
    const { AGREEMENT_GONE } = await import("../../components/AskHealthSheet");
    const settings = (await import("../../screens/SettingsSheet.tsx?raw")).default;
    const line = /<p className="muted small">\s*(Withdrawing stops both[^<]*)<\/p>/.exec(settings)?.[1];
    expect(line).toBeDefined();
    for (const text of [AGREEMENT_GONE, consent.AI_WITHDRAW_NOT_SAVED, line!]) {
      expect(text).not.toContain("—");
      expect(text).not.toMatch(/\b(now|no longer|yet)\b/i);
      expect(text[0]).toBe(text[0]!.toUpperCase());
    }
  });
});
