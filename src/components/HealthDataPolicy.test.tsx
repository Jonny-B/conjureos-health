import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

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
    const line = await planBuildLine();
    expect(line).toBe(
      "sends your goal in your own words, the plan length, height, weight, goal weight, age and sex.",
    );
    expect(line).not.toMatch(/injur|movements to avoid|training experience/i);
  });

  it("carries the revision date of that change", async () => {
    const { POLICY_UPDATED } = await import("./HealthDataPolicy");
    expect(POLICY_UPDATED).toBe("2026-10-08");
  });

  it("names both again once workouts are back", async () => {
    vi.resetModules();
    vi.doMock("../features/flags", () => ({ COACH_AND_WORKOUTS_ENABLED: true }));
    const line = await planBuildLine();
    expect(line).toContain("your training experience");
    expect(line).toContain("if you told us about an injury, a list of movements to avoid.");
  });

  it("keeps both wordings inside the copy rules", async () => {
    const paused = await planBuildLine();
    vi.resetModules();
    vi.doMock("../features/flags", () => ({ COACH_AND_WORKOUTS_ENABLED: true }));
    const live = await planBuildLine();
    for (const line of [paused, live]) {
      expect(line).not.toMatch(/—/);
      expect(line).not.toMatch(/\b(now|no longer|yet)\b/i);
    }
  });
});
