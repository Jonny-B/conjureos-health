import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The date the paused plan-build wording went out. History, not a setting:
 * the live wording is the wider one, so it must go out under a later date.
 */
const PAUSED_WORDING_DATE = "2026-10-08";

/** Loads the policy fresh with the workouts flag set to `on`. */
function withWorkouts(on: boolean) {
  vi.resetModules();
  vi.doMock("../features/flags", () => ({ COACH_AND_WORKOUTS_ENABLED: on }));
}

/** The policy's "Building or changing your plan" line, as a reader sees it. */
async function planBuildLine(): Promise<string> {
  const { HealthDataPolicy } = await import("./HealthDataPolicy");
  const html = renderToStaticMarkup(<HealthDataPolicy onClose={() => {}} />);
  const line = /<li><strong>Building or changing your plan<\/strong>(.*?)<\/li>/s.exec(html)?.[1];
  expect(line).toBeDefined();
  return line!.replace(/\s+/g, " ").trim();
}

afterEach(() => {
  vi.doUnmock("../features/flags");
  vi.resetModules();
});

describe("health data policy, plan building", () => {
  it("lists only what a paused plan build sends: no injury avoid-list, no training experience", async () => {
    withWorkouts(false);
    const line = await planBuildLine();
    expect(line).toBe(
      "sends your goal in your own words, the plan length, height, weight, goal weight, age and sex.",
    );
    expect(line).not.toMatch(/injur|movements to avoid|training experience/i);
  });

  it("names both again once workouts are back", async () => {
    withWorkouts(true);
    const line = await planBuildLine();
    expect(line).toContain("your training experience");
    expect(line).toContain("if you told us about an injury, a list of movements to avoid.");
  });

  it("keeps both wordings inside the copy rules", async () => {
    withWorkouts(false);
    const paused = await planBuildLine();
    withWorkouts(true);
    const live = await planBuildLine();
    for (const line of [paused, live]) {
      expect(line).not.toMatch(/—/);
      expect(line).not.toMatch(/\b(now|no longer|yet)\b/i);
    }
  });

  // Reads the REAL flag on purpose. The wording above follows the flag on its
  // own, the date does not, so this is what fails when workouts come back and
  // POLICY_UPDATED still names the day the narrower wording went out.
  it("dates the wording it shows: the paused wording's date only while paused", async () => {
    const { COACH_AND_WORKOUTS_ENABLED } = await import("../features/flags");
    const { POLICY_UPDATED } = await import("./HealthDataPolicy");
    if (COACH_AND_WORKOUTS_ENABLED) {
      expect(
        POLICY_UPDATED > PAUSED_WORDING_DATE,
        `Workouts are on, so the policy names training experience and the injury avoid-list. ` +
          `Move POLICY_UPDATED (${POLICY_UPDATED}) to this release's date (flags.ts, item 4).`,
      ).toBe(true);
    } else {
      expect(POLICY_UPDATED).toBe(PAUSED_WORDING_DATE);
    }
  });
});

/**
 * Agreeing to send what you log to the AI is asked for again when the wording
 * of what is sent changes (DISCLOSURE_VERSION), so "the first time" is not
 * the only time.
 */
describe("health data policy, the AI agreement", () => {
  it("says it is asked for before anything is sent, and again when that changes", async () => {
    const { HealthDataPolicy } = await import("./HealthDataPolicy");
    const text = renderToStaticMarkup(<HealthDataPolicy onClose={() => {}} />)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
    expect(text).not.toMatch(/the first time/i);
    expect(text).toContain(
      "Before anything is sent, you are shown exactly what would be sent and can decline, and you are asked again whenever that changes.",
    );
    expect(text).not.toMatch(/\b(now|yet|no longer)\b|\u2014/i);
  });
});
