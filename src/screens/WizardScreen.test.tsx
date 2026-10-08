import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { INJURY_REGIONS } from "../features/safety/injuryExclusions";
import { PLAN_BUILD_SENDS } from "../components/HealthDataPolicy";

// The wizard opens on its disclaimer, and getting past it takes a click, which
// a server render cannot make. Steer the step state's first value to the
// "About you" step instead; every other piece of state starts as it would.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const useState = ((initial: unknown) =>
    actual.useState(initial === "disclaimer" ? "safety" : initial)) as typeof actual.useState;
  return { ...actual, default: { ...actual, useState }, useState };
});

const QUESTION = "Any injuries to work around?";

/** Server-render a fresh wizard on its "About you" step. */
async function renderAboutYouStep(): Promise<string> {
  const { WizardScreen } = await import("./WizardScreen");
  const html = renderToStaticMarkup(<WizardScreen onComplete={() => {}} />);
  // Prove the steer landed: without this, a missing question could just mean
  // some other step rendered.
  expect(html).toContain("Safety check");
  expect(html).toContain("Pregnant or recently postpartum");
  return html;
}

afterEach(() => {
  vi.doUnmock("../features/flags");
  vi.resetModules();
});

describe("plan wizard injuries question", () => {
  it("is hidden while workouts are paused, chips and all", async () => {
    const html = await renderAboutYouStep();
    expect(html).not.toContain(QUESTION);
    for (const region of INJURY_REGIONS) {
      expect(html).not.toContain(`>${region.label}</button>`);
    }
  });

  it("comes back with workouts, because it is gated and not deleted", async () => {
    vi.resetModules();
    vi.doMock("../features/flags", () => ({ COACH_AND_WORKOUTS_ENABLED: true }));
    const html = await renderAboutYouStep();
    expect(html).toContain(QUESTION);
    for (const region of INJURY_REGIONS) {
      expect(html).toContain(`>${region.label}</button>`);
    }
  });
});

/**
 * The step collects height, weight, goal weight, age and sex, and building
 * the plan sends them to the AI, as the privacy policy says. Its intro said
 * "Nothing leaves your device", on the screen collecting the data.
 */
describe("plan wizard About you step", () => {
  it("says what building the plan sends, in the policy's own words", async () => {
    const html = await renderAboutYouStep();
    expect(html).not.toMatch(/Nothing leaves your device/i);
    expect(html).toContain(`Building your plan sends the AI ${PLAN_BUILD_SENDS}.`);
  });
});
