import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Plan } from "../../types";
import { DEFAULT_GOALS } from "../../types";
import { EMPTY_MEMORY, type CoachContext } from "./model";

const { complete } = vi.hoisted(() => ({ complete: vi.fn<() => Promise<string>>() }));
// Stub only the host-dependent surface; pure helpers (extractJson) stay real.
vi.mock("../../bridge/ai", async (orig) => ({
  ...(await orig<typeof import("../../bridge/ai")>()),
  complete,
  isAiAvailable: () => true,
}));

import { coachChat } from "./coach";

const plan: Plan = {
  id: "p",
  mode: "both",
  durationWeeks: 4,
  startDate: "2026-07-01",
  endDate: "2026-07-28",
  goals: [],
  safety: { ageBand: "18_39", pregnant: false, cardiacFlag: false, injuries: [], activityLevel: "active" },
  liability: { acknowledged: true, acceptedAt: "2026-07-01T00:00:00Z" },
  createdAt: "2026-07-01T00:00:00Z",
  program: {
    workouts: [
      {
        id: "pw",
        workout: {
          id: "w",
          name: "Leg Day",
          exercises: [{ id: "e", name: "Squat", sets: [{ reps: 10, durationSec: null, restSec: 60 }] }],
          origin: "built-in",
        },
        isBenchmark: true,
        benchmarkId: "b",
        benchmarkIds: ["b"],
      },
    ],
    benchmarks: [
      { id: "b", exerciseKey: "squat", name: "Squat", metric: "reps", baseline: 8, target: 20, unit: "reps", history: [] },
    ],
    analysisCursor: 0,
  },
};
const ctx: CoachContext = {
  plan,
  profile: null,
  goals: DEFAULT_GOALS,
  memory: EMPTY_MEMORY,
  rendered: "Program exercises (use these exact keys): squat.",
};

const PROPOSE = `Sounds like the legs are cooked.
<propose>{ "rationale": "Your last sessions were near-max effort.", "question": "How should we ease off?", "type": "single", "options": [ { "label": "Lighter squats this week" }, { "label": "Swap in lunges" } ] }</propose>`;
const ADJUST = `<adjust>{ "summary": "Lighter squats", "changes": [ { "op": "setReps", "exerciseKey": "squat", "reps": 8 } ] }</adjust>`;

beforeEach(() => complete.mockReset());

describe("coachChat — ask before changing the plan", () => {
  it("surfaces a <propose> as a proposal and does NOT change the plan", async () => {
    complete.mockResolvedValueOnce(PROPOSE);
    const out = await coachChat([{ role: "user", content: "legs are wrecked" }], ctx);
    expect(out.proposal).toBeTruthy();
    expect(out.proposal!.options.map((o) => o.label)).toContain("Lighter squats this week");
    expect(out.planUpdate).toBeUndefined();
    expect(out.reply).not.toContain("<propose>");
  });

  it("applies an <adjust> only when the user is answering a proposal", async () => {
    complete.mockResolvedValueOnce(ADJUST);
    const out = await coachChat([{ role: "user", content: "lighter squats" }], ctx, { answering: true });
    expect(out.planUpdate).toBeTruthy();
    expect(out.planUpdate!.summary).toMatch(/lighter squats/i);
  });

  it("converts a cold <adjust> (not answering) into a confirm proposal — no silent change", async () => {
    complete.mockResolvedValueOnce(ADJUST);
    const out = await coachChat([{ role: "user", content: "how are my legs" }], ctx, { answering: false });
    expect(out.planUpdate).toBeUndefined();
    expect(out.proposal).toBeTruthy();
    expect(out.proposal!.question).toMatch(/apply this change/i);
  });

  it("drops a follow-up proposal once the round budget is spent", async () => {
    complete.mockResolvedValueOnce(PROPOSE);
    const out = await coachChat([{ role: "user", content: "still too hard" }], ctx, {
      answering: true,
      canPropose: false,
    });
    expect(out.proposal).toBeUndefined(); // asked too many times → falls through to prose
  });
});
