/**
 * Every Conjure Health feature that sends anything to an AI needs the AI
 * agreement. Owner decision, 2026-10-29 (ConjureOS #1163): "If you remove
 * consent, we should stop the plan builder and photo, and you would have to
 * re-agree."
 *
 * Find patterns and Ask Health were behind it already (features/ask). This
 * file holds the rest to the same rules, feature by feature: building a plan,
 * food from a description, food from a photo (a meal, a nutrition label, a
 * package front), and the estimates other apps ask for (`estimateNutrition`,
 * and `logFood` without calories).
 *
 *   - Not agreed: nothing is sent.
 *   - Withdrawn: nothing is sent, until the person agrees again.
 *   - Withdrawn while the request is out: the answer is thrown away and
 *     nothing of it is kept.
 *
 * Each test loads the modules afresh, because a withdrawal holds for the rest
 * of the session it happened in, and a test's session ends with the test.
 * Only the AI call, the files and the stored profile and diary are stand-ins.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatImage } from "../bridge/ai";
import type { DiaryEntry, LiabilityAck, Profile } from "../types";
import type { PlanInput } from "./plan/model";

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

const PERSON: Profile = {
  sex: "female", age: 34, heightCm: 168, weightKg: 70, activityLevel: "moderate",
  direction: "lose", units: "metric",
};
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

type Consent = typeof import("./aiConsent");
let consent: Consent;

const PHOTO: ChatImage = { mediaType: "image/jpeg", data: "AAAA" };
const MEAL = JSON.stringify({
  items: [{ name: "Grilled chicken", servingSize: "6 oz", calories: 280, protein: 52, carbs: 0, fat: 6 }],
  groupName: "Grilled chicken",
});
const LABEL = JSON.stringify({
  name: "Oat bar", servingSize: "1 bar", servingGrams: 40, calories: 190, protein: 4, carbs: 29, fat: 7,
  confidence: 0.9,
});
const FRONT = JSON.stringify({
  name: "Oat bar", servingSize: "1 bar", servingGrams: 40, calories: 190, protein: 4, carbs: 29, fat: 7,
  confidence: 0.8, estimationBasis: "front_estimate", warningNote: "",
});
const PLAN = JSON.stringify({
  summary: "A steady plan.",
  dailyCalorieTarget: 1800,
  goals: [
    { label: "Stay around 1800 kcal", kind: "nutrition" },
    { label: "Protein at every meal", kind: "nutrition" },
    { label: "Water before each meal", kind: "habit" },
  ],
});
const PLAN_INPUT: PlanInput = {
  mode: "eat_better", goalText: "lose a few pounds", durationWeeks: 4, heightCm: 168, weightKg: 70,
  age: 34, sex: "female", calorieTarget: 1800,
  safety: { ageBand: "18_39", pregnant: false, cardiacFlag: false, activityLevel: "moderate" },
};
const ACK: LiabilityAck = { acknowledged: false, acceptedAt: "" };

/**
 * Every newly covered feature, as a call and the model answer it reads.
 * `kept` says whether the call returned something to keep.
 */
const FEATURES: { name: string; answer: string; run: () => Promise<unknown> }[] = [
  {
    name: "building a plan",
    answer: PLAN,
    run: async () => (await import("./plan/generate")).createPlan(PLAN_INPUT, ACK),
  },
  {
    name: "adding food from a description",
    answer: MEAL,
    run: async () => (await import("./naturalLanguage")).parseMealWithGroup({ text: "grilled chicken" }),
  },
  {
    name: "adding food from a photo of the meal",
    answer: MEAL,
    run: async () => (await import("./naturalLanguage")).parseMealWithGroup({ image: PHOTO }),
  },
  {
    name: "reading a nutrition label from a photo",
    answer: LABEL,
    run: async () => (await import("./foods/labelParse")).parseNutritionLabel(PHOTO, "0123456789012"),
  },
  {
    name: "estimating from a photo of the package front",
    answer: FRONT,
    run: async () => (await import("./foods/frontParse")).estimateFromFront(PHOTO),
  },
];

/** Agree, the way the consent sheet does. */
async function agree() {
  expect(await consent.recordAiJournalConsent(false)).toBe(true);
}

/** Call a feature and say whether it handed anything back. */
async function outcome(run: () => Promise<unknown>): Promise<"kept" | "refused"> {
  try {
    const res = await run();
    return res ? "kept" : "refused";
  } catch {
    return "refused";
  }
}

beforeEach(async () => {
  vi.resetModules();
  complete.mockReset();
  for (const k of Object.keys(files)) delete files[k];
  profile = { ...PERSON };
  diary = [];
  consent = await import("./aiConsent");
});

describe.each(FEATURES)("$name", ({ answer, run }) => {
  beforeEach(() => complete.mockImplementation(async () => answer));

  it("sends nothing before the person agrees", async () => {
    expect(await outcome(run)).toBe("refused");
    expect(complete).not.toHaveBeenCalled();
  });

  it("sends nothing after the agreement is withdrawn", async () => {
    await agree();
    await consent.withdrawAiJournalConsent();
    expect(await outcome(run)).toBe("refused");
    expect(complete).not.toHaveBeenCalled();
  });

  it("throws away an answer that lands after a withdrawal", async () => {
    await agree();
    complete.mockImplementation(async () => {
      await consent.withdrawAiJournalConsent();
      return answer;
    });
    expect(await outcome(run)).toBe("refused");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("throws away an answer that lands after a withdrawal and a new agreement", async () => {
    await agree();
    complete.mockImplementation(async () => {
      await consent.withdrawAiJournalConsent();
      await agree();
      return answer;
    });
    expect(await outcome(run)).toBe("refused");
  });

  it("sends once agreed, and agreeing again after a withdrawal turns it back on", async () => {
    await agree();
    expect(await outcome(run)).toBe("kept");
    expect(complete).toHaveBeenCalledTimes(1);
    await consent.withdrawAiJournalConsent();
    await agree();
    expect(await outcome(run)).toBe("kept");
    expect(complete).toHaveBeenCalledTimes(2);
  });
});

describe("the plan builder", () => {
  it("does not fall back to a starter plan when the answer was thrown away", async () => {
    // A starter plan in place of the discarded one would read as the plan
    // builder having worked, after the person withdrew.
    await agree();
    complete.mockImplementation(async () => {
      await consent.withdrawAiJournalConsent();
      return PLAN;
    });
    const { createPlan } = await import("./plan/generate");
    await expect(createPlan(PLAN_INPUT, ACK)).rejects.toMatchObject({ name: "AiNotAgreedError" });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("does not retry after a withdrawal", async () => {
    await agree();
    complete.mockImplementation(async () => {
      await consent.withdrawAiJournalConsent();
      return "not json";
    });
    const { createPlan } = await import("./plan/generate");
    await expect(createPlan(PLAN_INPUT, ACK)).rejects.toMatchObject({ name: "AiNotAgreedError" });
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe("the estimates other apps ask for", () => {
  type Handler = (params?: unknown) => Promise<unknown>;
  let actions: Record<string, Handler>;

  beforeEach(async () => {
    complete.mockImplementation(async () => MEAL);
    // The cross-app actions need the agreement to keep health data first.
    files["health-consent.json"] = JSON.stringify({ acceptedAt: "2026-09-01T09:00:00.000Z", version: 1 });
    actions = {};
    (globalThis as { window?: unknown }).window = {
      __conjureos: { actions: { register: async (map: Record<string, Handler>) => void (actions = map) } },
    };
    const { registerActions } = await import("../bridge/actions");
    await registerActions();
  });

  const estimate = () => actions.estimateNutrition!({ text: "a bowl of chili" });
  const logUnpriced = () => actions.logFood!({ name: "chicken sandwich" });
  const needsConsent = (p: Promise<unknown>) => expect(p).rejects.toThrow(/^NEEDS_CONSENT:/);

  it("estimateNutrition answers NEEDS_CONSENT before the person agrees, and sends nothing", async () => {
    await needsConsent(estimate());
    expect(complete).not.toHaveBeenCalled();
  });

  it("estimateNutrition answers NEEDS_CONSENT after a withdrawal, and sends nothing", async () => {
    await agree();
    await consent.withdrawAiJournalConsent();
    await needsConsent(estimate());
    expect(complete).not.toHaveBeenCalled();
  });

  it("estimateNutrition hands back nothing when the withdrawal lands while it is out", async () => {
    await agree();
    complete.mockImplementation(async () => {
      await consent.withdrawAiJournalConsent();
      return MEAL;
    });
    await needsConsent(estimate());
  });

  it("logFood without calories answers NEEDS_CONSENT before the person agrees, and logs nothing", async () => {
    await needsConsent(logUnpriced());
    expect(complete).not.toHaveBeenCalled();
    expect(diary).toEqual([]);
  });

  it("logFood without calories answers NEEDS_CONSENT after a withdrawal, and logs nothing", async () => {
    await agree();
    await consent.withdrawAiJournalConsent();
    await needsConsent(logUnpriced());
    expect(complete).not.toHaveBeenCalled();
    expect(diary).toEqual([]);
  });

  it("logFood logs nothing from an estimate that lands after a withdrawal", async () => {
    await agree();
    complete.mockImplementation(async () => {
      await consent.withdrawAiJournalConsent();
      return MEAL;
    });
    await needsConsent(logUnpriced());
    expect(diary).toEqual([]);
  });

  it("logFood logs nothing from an estimate that lands after consent to keep health data was withdrawn", async () => {
    await agree();
    const collection = await import("./healthConsent");
    expect(await collection.loadHealthConsent()).toBe(true);
    complete.mockImplementation(async () => {
      await collection.withdrawHealthConsent();
      return MEAL;
    });
    await expect(logUnpriced()).rejects.toThrow(/^NEEDS_CONSENT:/);
    expect(diary).toEqual([]);
  });

  it("estimates once agreed, and logFood with calories needs no AI agreement", async () => {
    await expect(actions.logFood!({ name: "black coffee", calories: 5 })).resolves.toBeDefined();
    expect(complete).not.toHaveBeenCalled();
    await agree();
    await expect(estimate()).resolves.toMatchObject({ estimated: true });
    await expect(logUnpriced()).resolves.toMatchObject({ estimated: true });
    expect(complete).toHaveBeenCalledTimes(2);
  });
});

describe("the agreement itself", () => {
  it("can be given before there is a profile, so a first plan can be built", async () => {
    // A new person has no profile until their first plan is saved, and the
    // plan builder is behind the agreement.
    profile = null;
    await agree();
    expect(await consent.hasAiJournalConsent()).toBe(true);
  });

  it("is asked again of everyone who agreed to the earlier wording", async () => {
    profile = {
      ...PERSON,
      aiJournalConsent: { version: 2, acceptedAt: "2026-10-01T09:00:00.000Z", includeNotes: false },
    };
    expect(consent.DISCLOSURE_VERSION).toBe(3);
    expect(await consent.hasAiJournalConsent()).toBe(false);
  });

  it("stays withdrawn when a profile read before the withdrawal is saved after it", async () => {
    // Settings saves the units choice over the profile App read at startup.
    await agree();
    const readAtStartup = profile ? { ...profile } : null;
    await consent.withdrawAiJournalConsent();
    profile = readAtStartup;
    // The next session.
    vi.resetModules();
    consent = await import("./aiConsent");
    expect(await consent.hasAiJournalConsent()).toBe(false);
  });
});

/**
 * The rules above hold because every request goes through features/aiGate.ts.
 * A module that called the bridge itself would route around them, and one that
 * sent through the gate without being named would send under an agreement
 * whose wording never mentions it.
 */
describe("the gate is the one way to the AI", () => {
  /** Shipped source, tests excluded, by path under src/. */
  const SHIPPED = Object.fromEntries(
    Object.entries(
      import.meta.glob(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}"], {
        query: "?raw",
        import: "default",
        eager: true,
      }) as Record<string, string>,
    ).map(([path, text]) => [path.replace(/^\.\.\//, "").replace(/^\.\//, "features/"), text]),
  );

  /** Every module that sends through the gate, and the features it serves. */
  const SENDERS: Record<string, string[]> = {
    "features/ask/ask.ts": ["Find patterns", "Ask Health"],
    "features/plan/generate.ts": ["Building a plan"],
    "features/naturalLanguage.ts": [
      "Adding food from a description",
      "Adding food from a photo",
      "Food estimates for ConjureOS's assistant and other apps",
    ],
    "features/foods/labelParse.ts": ["Adding food from a photo"],
    "features/foods/frontParse.ts": ["Adding food from a photo"],
  };

  it("no module but the gate imports complete() from the bridge", () => {
    const importers = Object.entries(SHIPPED)
      .filter(([, text]) => /import\s*\{[^}]*\bcomplete\b[^}]*\}\s*from\s*["'][./]+bridge\/ai["']/.test(text))
      .map(([path]) => path);
    expect(importers).toEqual(["features/aiGate.ts"]);
  });

  it("no module but the bridge reaches the host's AI", () => {
    const reach = Object.entries(SHIPPED)
      .filter(([, text]) => /__conjureos\??\.ai\b/.test(text))
      .map(([path]) => path);
    expect(reach).toEqual(["bridge/ai.ts"]);
  });

  it("every module that sends through the gate serves a feature the agreement names", () => {
    const senders = Object.entries(SHIPPED)
      .filter(([path, text]) => path !== "features/aiGate.ts" && /\bcompleteUnderAgreement\(/.test(text))
      .map(([path]) => path)
      .sort();
    expect(senders).toEqual(Object.keys(SENDERS).sort());
    for (const names of Object.values(SENDERS)) {
      for (const name of names) expect(consent.AI_FEATURES).toContain(name);
    }
  });
});
