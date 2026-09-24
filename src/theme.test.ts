/**
 * Conjure Health inherits the ConjureOS appearance rather than locking to
 * one palette. These are the rules that make "inherits" mean something more
 * precise than "reads it and shrugs".
 *
 * The interesting half used to be "what does it still do despite the lock";
 * now it's "what does it fall back to when there is nothing to inherit".
 * Standalone (no host bridge) and embedded-but-no-override (host sent
 * null/null) both have to resolve to the Conjure default + the browser's
 * light/dark preference, which on <html> means no `data-theme`/`data-flavor`
 * at all — `@conjureos/ui`'s tokens.css reads an absent attribute as exactly
 * that fallback, so writing "cnj"/some default here would be redundant at
 * best and wrong the day the Conjure default's resolved hex changes.
 *
 * Runs in the default node environment against a hand-built window rather
 * than pulling jsdom in for one file. The fake covers the four things the
 * module touches: a documentElement that records attributes, a message
 * listener, a parent, and the injected bridge.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { initAppearance, hostAppearance, resetHostAppearance } from "./theme";
import indexHtml from "../index.html?raw";

interface Env {
  win: Window & typeof globalThis;
  attrs: Record<string, string>;
  posted: unknown[];
  inject(theme: unknown, flavor: unknown): void;
  fromShell(theme: unknown, flavor: unknown): void;
  fromElsewhere(theme: unknown, flavor: unknown): void;
}

function makeEnv({ embedded = true }: { embedded?: boolean } = {}): Env {
  const attrs: Record<string, string> = {};
  const posted: unknown[] = [];
  let onMessage: ((ev: MessageEvent) => void) | null = null;
  const parent = { postMessage: (m: unknown) => posted.push(m) };

  const win = {
    document: {
      documentElement: {
        setAttribute: (k: string, v: string) => {
          attrs[k] = v;
        },
        removeAttribute: (k: string) => {
          delete attrs[k];
        },
      },
    },
    addEventListener: (type: string, fn: (ev: MessageEvent) => void) => {
      if (type === "message") onMessage = fn;
    },
  } as unknown as Window & typeof globalThis;
  // Standalone is parent === self, which is what a top-level page looks like.
  (win as unknown as { parent: unknown }).parent = embedded ? parent : win;

  const fire = (source: unknown, theme: unknown, flavor: unknown) =>
    onMessage?.({ data: { type: "conjureos:theme", theme, flavor }, source } as MessageEvent);

  return {
    win,
    attrs,
    posted,
    inject: (theme, flavor) => {
      (win as unknown as { __conjureos: unknown }).__conjureos = { appearance: { theme, flavor } };
    },
    fromShell: (theme, flavor) => fire(parent, theme, flavor),
    fromElsewhere: (theme, flavor) => fire({}, theme, flavor),
  };
}

beforeEach(() => {
  resetHostAppearance();
});

describe("Conjure Health's inherited appearance", () => {
  it("sets no attributes when there is nothing to inherit", () => {
    // Standalone: no host bridge at all. Falling back to "no attribute"
    // (Conjure default + browser flavor preference) is correct here, not a
    // missing case — see the file header.
    const e = makeEnv({ embedded: false });

    initAppearance(e.win);

    expect(e.attrs).toEqual({});
  });

  it("wears the theme ConjureOS injected at boot", () => {
    const e = makeEnv();
    e.inject("hal", "light");

    initAppearance(e.win);

    expect(e.attrs).toEqual({ "data-theme": "hal", "data-flavor": "light" });
  });

  it("records what ConjureOS is wearing", () => {
    const e = makeEnv();
    e.inject("hal", "light");

    initAppearance(e.win);

    expect(hostAppearance()).toEqual({ theme: "hal", flavor: "light", inConjureOS: true });
  });

  it("changes live when the shell pushes a new theme", () => {
    // The opposite of the old lock's "deliberately no re-apply": inheriting
    // means a change after boot has to reach <html>, not just hostAppearance().
    const e = makeEnv();
    initAppearance(e.win);

    e.fromShell("xms", "light");

    expect(e.attrs).toEqual({ "data-theme": "xms", "data-flavor": "light" });
    expect(hostAppearance()).toEqual({ theme: "xms", flavor: "light", inConjureOS: true });
  });

  it("drops the flavor attribute again when the shell clears its override", () => {
    // "Follow the browser" has to be reachable, not just the initial state —
    // a user picking System in ConjureOS after picking Light needs the
    // forced data-flavor gone, not stuck on the last value it saw.
    const e = makeEnv();
    e.inject("hal", "light");
    initAppearance(e.win);
    expect(e.attrs).toEqual({ "data-theme": "hal", "data-flavor": "light" });

    e.fromShell("hal", null);

    expect(e.attrs).toEqual({ "data-theme": "hal" });
    expect(hostAppearance()).toEqual({ theme: "hal", flavor: null, inConjureOS: true });
  });

  it("knows it is inside ConjureOS even when the user has chosen nothing", () => {
    // Two nulls is still the shell talking: the user simply never opened
    // Settings. Keying "are we embedded?" off a non-null theme would report
    // standalone for most people. And two nulls means no attributes — the
    // Conjure default + browser preference IS the correct rendering here.
    const e = makeEnv();
    e.inject(null, null);

    initAppearance(e.win);

    expect(hostAppearance()).toEqual({ theme: null, flavor: null, inConjureOS: true });
    expect(e.attrs).toEqual({});
  });

  it("reports standalone when there is no host bridge", () => {
    const e = makeEnv({ embedded: false });

    initAppearance(e.win);

    expect(hostAppearance().inConjureOS).toBe(false);
    expect(e.posted).toEqual([]);
  });

  it("subscribes anyway, so the shell answers even if it booted first", () => {
    const e = makeEnv();

    initAppearance(e.win);

    expect(e.posted).toEqual([{ type: "conjureos:theme:subscribe" }]);
  });

  it("refuses a theme claim from a page that is not the embedder", () => {
    const e = makeEnv();
    initAppearance(e.win);

    e.fromElsewhere("cnd", "light");

    expect(hostAppearance()).toEqual({ theme: null, flavor: null, inConjureOS: false });
    expect(e.attrs).toEqual({});
  });

  it("refuses a theme claim from anywhere when there is no embedder at all", () => {
    // Standalone is `win.parent === win`, which used to make the bare `&&`
    // guard short-circuit to false and skip the early return entirely — a
    // message got processed no matter who sent it. No embedder means nothing
    // can speak for ConjureOS, so this has to reject even a message that
    // claims to be the parent.
    const e = makeEnv({ embedded: false });
    initAppearance(e.win);

    e.fromElsewhere("cnd", "light");

    expect(hostAppearance()).toEqual({ theme: null, flavor: null, inConjureOS: false });
    expect(e.attrs).toEqual({});
  });

  it("drops a palette it does not recognise rather than recording or wearing it", () => {
    const e = makeEnv();
    initAppearance(e.win);

    e.fromShell("brg", "neon");

    expect(hostAppearance()).toEqual({ theme: null, flavor: null, inConjureOS: true });
    expect(e.attrs).toEqual({});
  });
});

describe("index.html carries no static palette", () => {
  it("pins no data-theme/data-flavor on <html>", () => {
    // The whole point of inheritance is that ConjureOS decides, live. A
    // static pin here would reintroduce a flash of the wrong palette on
    // every boot without failing a single other test in this file — the
    // same trap the old locked-palette pin was written to catch, now in the
    // opposite direction.
    const htmlTag = indexHtml.match(/<html[^>]*>/)?.[0] ?? "";

    expect(htmlTag).not.toMatch(/data-theme=/);
    expect(htmlTag).not.toMatch(/data-flavor=/);
  });
});
