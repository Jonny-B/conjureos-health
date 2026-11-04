// @vitest-environment jsdom
/**
 * ConjureOS #1230: a person who said Don't allow to ConjureOS Chat sees that
 * choice in Settings, next to Review and agree, which is how they change it.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const files: Record<string, string> = {};
vi.mock("../bridge/vfs", () => ({
  readJson: async (p: string, d: unknown) => (files[p] !== undefined ? JSON.parse(files[p]!) : d),
  writeJson: async (p: string, v: unknown) => void (files[p] = JSON.stringify(v)),
  writeJsonOrThrow: async (p: string, v: unknown) => void (files[p] = JSON.stringify(v)),
  vfs: {
    exists: async (p: string) => files[p] !== undefined,
    read: async (p: string) => files[p]!,
    rm: async (p: string) => void delete files[p],
  },
}));
vi.mock("../data/repository", () => ({
  getRepository: async () => ({ getProfile: async () => null, saveProfile: async () => {} }),
}));

import { SettingsSheet } from "./SettingsSheet";
import { AI_CONSENT_PATH } from "../features/aiConsent";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  for (const k of Object.keys(files)) delete files[k];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const open = async () => {
  await act(async () => {
    root.render(
      <SettingsSheet goals={{ calories: 2000, protein: 120, carbs: 200, fat: 67 }} profile={null} onClose={() => {}} onSave={() => {}} />,
    );
  });
  await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
};
const privacy = () => host.querySelector(".privacy-block")?.textContent ?? "";

describe("Settings shows a refusal", () => {
  it("says so, and still offers Review and agree", async () => {
    files[AI_CONSENT_PATH] = JSON.stringify({ refusedAt: "2026-11-01T09:00:00.000Z", version: 4 });
    await open();
    expect(privacy()).toContain("You chose not to share with AI.");
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Review and agree")).toBe(true);
  });

  it("says nothing of a refusal when none was made", async () => {
    await open();
    expect(privacy()).not.toContain("You chose not to share with AI.");
  });
});
