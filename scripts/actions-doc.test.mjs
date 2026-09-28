import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderActionsTable, withTable } from "./actions-doc.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

describe("README's actions table", () => {
  it("matches package.json; run `npm run docs:actions` after changing an action", () => {
    expect(withTable(readme, pkg)).toBe(readme);
  });

  it("lists every action once, with its kind", () => {
    const table = renderActionsTable(pkg);
    for (const [name, a] of Object.entries(pkg.conjureos.actions)) {
      const kind = a.permission === "actions.write" ? "write" : "read";
      expect(table).toMatch(new RegExp(`\\| \`${name}\\(.*\\| ${kind} \\|`));
    }
  });
});
