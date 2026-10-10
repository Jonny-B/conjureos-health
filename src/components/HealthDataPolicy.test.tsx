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
  vi.doMock("../features/flags", () => ({ WORKOUTS_ENABLED: on }));
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
    const { WORKOUTS_ENABLED } = await import("../features/flags");
    const { POLICY_UPDATED } = await import("./HealthDataPolicy");
    if (WORKOUTS_ENABLED) {
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

/** The policy's "Your choices and rights" list, as a reader sees it. */
async function choicesText(): Promise<string> {
  const { HealthDataPolicy } = await import("./HealthDataPolicy");
  const html = renderToStaticMarkup(<HealthDataPolicy onClose={() => {}} />);
  const section = /<h3>Your choices and rights<\/h3>(.*?)<h3>/s.exec(html)?.[1];
  expect(section).toBeDefined();
  return section!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

describe("health data policy, withdrawing the journal agreement", () => {
  // One agreement covers Find patterns and Ask Health. "Analysis" describes
  // only Find patterns, so a withdraw line that says analysis stops leaves an
  // Ask Health user unsure whether their questions still send their journal.
  // The consent sheet says it of both; the policy says the same.
  it("says withdrawing stops both features sending, not only analysis", async () => {
    const text = await choicesText();
    expect(text).not.toMatch(/future analysis/i);
    expect(text).toContain(
      "You can withdraw that agreement at any time in Settings, under Privacy. Find patterns " +
        "and Ask Health stop sending anything from your journal at once. Withdrawing cannot " +
        "recall something already sent.",
    );
  });

  it("keeps the choices list inside the copy rules", async () => {
    const text = await choicesText();
    expect(text).not.toMatch(/—/);
    expect(text).not.toMatch(/\b(now|no longer|yet)\b/i);
    expect(text).not.toMatch(/coach/i);
  });
});
