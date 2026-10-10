import { describe, it, expect } from "vitest";
import * as flags from "./flags";
import { HISTORY_ITEMS, visibleHistoryItems } from "./resetData";
import flagsSource from "./flags.ts?raw";
import planServiceSource from "./plan/planService.ts?raw";

/**
 * The workouts pause is a product decision, so it gets a test: the whole
 * point is that the feature is HIDDEN, not deleted, and that the data behind
 * it survives to be revived.
 */
describe("workouts pause", () => {
  it("is off: the app ships as a nutrition tracker", () => {
    expect(flags.WORKOUTS_ENABLED).toBe(false);
  });

  it("is the only flag, and it names no coach", () => {
    // Coaching is a Conjure Fitness feature, so turning workouts back on in
    // Health brings back workouts and nothing else.
    expect(Object.keys(flags)).toEqual(["WORKOUTS_ENABLED"]);
  });

  it("hides the workout reset row while paused", () => {
    const kinds = visibleHistoryItems().map((i) => i.kind);
    expect(kinds).not.toContain("workouts");
  });

  it("still offers the nutrition-side resets", () => {
    const kinds = visibleHistoryItems().map((i) => i.kind);
    expect(kinds).toContain("diary");
    expect(kinds).toContain("weights");
    expect(kinds).toContain("planHistory");
    expect(kinds).toContain("askHealth");
  });

  it("warns, on the revival checklist, that the program engine gets no preferences", () => {
    // Health calls the engine with recorded sessions only: the dislikes and
    // constraints it can honour came from the removed coach, and nothing
    // replaced them. Whoever turns workouts on has to hear that from the
    // checklist, not discover it from the prompts.
    expect(planServiceSource).toContain("calibrateToBenchmark(next, sessions)");
    expect(planServiceSource).toContain("maybeAdapt(next, sessions)");
    expect(planServiceSource).toContain("advanceToNextGroup(plan, sessions)");
    const checklist = flagsSource.slice(flagsSource.indexOf("## Turning it back on"));
    expect(checklist).toContain("`preferences`");
    expect(checklist).toContain("advanceToNextGroup");
    expect(checklist).toContain("buildAnalysisPrompt");
  });

  it("hides rows without removing them: every slice is still clearable", () => {
    // visibleHistoryItems only filters the UI; HISTORY_ITEMS (what clearAll
    // walks) must keep every kind, or paused data would become unwipeable.
    const all = HISTORY_ITEMS.map((i) => i.kind);
    expect(all).toContain("workouts");
    expect(visibleHistoryItems().length).toBeLessThan(HISTORY_ITEMS.length);
  });
});
