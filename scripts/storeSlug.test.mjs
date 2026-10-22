/**
 * Conjure Health's App Store listing is `health`. `fitness` is a withdrawn
 * listing (Conjure Health's old one, under a legacy name) and nothing may
 * publish to it again: a publish there would put a new version under a listing
 * that was taken down. The workflow's slug lines are the only thing that picks
 * the listing, so they are held here, and so are the deep-link examples, which
 * name the listing in their path.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

const SLUG = "health";
const WITHDRAWN = "fitness";

function filesUnder(rel) {
  const dir = new URL(`../${rel}/`, import.meta.url);
  return readdirSync(dir).flatMap((name) => {
    const path = `${rel}/${name}`;
    return statSync(new URL(name, dir)).isDirectory() ? filesUnder(path) : [path];
  });
}

describe("the store listing Health publishes to", () => {
  const workflow = read(".github/workflows/publish-store.yml");
  const slugs = [...workflow.matchAll(/^\s*slug:\s*(\S+)\s*$/gm)].map((m) => m[1]);

  it("is `health` in both publish steps (dev and prod)", () => {
    expect(slugs).toEqual([SLUG, SLUG]);
  });

  it("is never the withdrawn `fitness` listing", () => {
    expect(workflow).not.toMatch(/slug:\s*fitness\b/);
  });

  it("is what every deep-link example opens", () => {
    const sources = ["README.md", ...filesUnder("src").filter((p) => /\.(ts|tsx)$/.test(p))];
    const launches = sources.flatMap((p) =>
      [...read(p).matchAll(/\/launch\/([a-z0-9-]+)/g)].map((m) => `${p}: ${m[1]}`),
    );
    expect(launches.length).toBeGreaterThan(0);
    expect(launches.filter((l) => !l.endsWith(`: ${SLUG}`))).toEqual([]);
  });

  it("is named in CLAUDE.md, beside the listing never to publish to", () => {
    const claude = read("CLAUDE.md");
    expect(claude).toContain(`slug is \`${SLUG}\``);
    expect(claude).toMatch(new RegExp(`never publish to \`${WITHDRAWN}\``));
  });
});
