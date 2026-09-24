/**
 * Conjure Health inherits the ConjureOS theme + flavor. Whatever palette and
 * light/dark mode the OS is wearing, this app wears too — at boot, and live
 * whenever the user changes it in ConjureOS. There is no in-app override: no
 * lock, no settings control, nothing for this file to arbitrate.
 *
 * This app used to be locked to Winter dark (its charts/rings/status bands
 * were tuned against one ground). That lock has been lifted — the owner
 * wants pure inheritance instead — so every literal color in src/styles.css
 * had to stop assuming Winter dark too; see that file's header comment.
 *
 * HOW INHERITANCE WORKS. `data-theme`/`data-flavor` on <html> are set from
 * whatever the host last told us: the value injected at boot (kills the
 * launch flash — see `initAppearance`), then live on every
 * `conjureos:theme` broadcast after. No host (standalone / `npm run dev`) or
 * no override from the host (`theme`/`flavor` came back null) both resolve
 * to "no attribute", which is deliberate: `@conjureos/ui`'s tokens.css reads
 * an absent `data-theme` as the Conjure default and an absent `data-flavor`
 * as the browser's light/dark preference — exactly the fallback a standalone
 * page (no OS to inherit from) should have anyway.
 *
 * The mirror of `@conjureos/ui`'s `ConjureTheme.init({ theme, flavor })`
 * (no `lock`), written here as a typed module for the same reason Recipes
 * has one: `theme.js` installs a browser global from a <script> tag, and
 * nothing in a Vite + TypeScript app should be reaching for one of those.
 */

const MSG = "conjureos:theme";

const THEME_IDS = ["cnj", "hal", "fal", "win", "spr", "sum", "xms", "est", "cnd"];

export interface HostAppearance {
  /** What ConjureOS is wearing. null means it has no override (Conjure). */
  theme: string | null;
  /** null means ConjureOS follows the browser's light/dark preference. */
  flavor: string | null;
  /** False outside the shell — `npm run dev`, or a standalone build. */
  inConjureOS: boolean;
}

const host: HostAppearance = { theme: null, flavor: null, inConjureOS: false };

const asTheme = (v: unknown): string | null =>
  typeof v === "string" && THEME_IDS.includes(v) ? v : null;

const asFlavor = (v: unknown): string | null => (v === "dark" || v === "light" ? v : null);

/**
 * What ConjureOS is wearing right now — which, with the lock gone, is also
 * what this app is wearing. Kept as its own accessor (rather than reading
 * `<html>`'s attributes back) because tests and any future settings surface
 * want the structured `{theme, flavor, inConjureOS}` shape, not a DOM read.
 */
export const hostAppearance = (): HostAppearance => ({ ...host });

/**
 * Forget what the host said. Only `theme.test.ts` calls this — the app has
 * one instance for its whole life, but a test file needs each case to start
 * from "nothing has been received yet".
 */
export const resetHostAppearance = (): void => {
  host.theme = null;
  host.flavor = null;
  host.inConjureOS = false;
};

/** Write the current host appearance onto <html>. Absent means "inherit" —
 * see the file header for why that is correct, not a missing case. */
function apply(win: Window & typeof globalThis): void {
  const el = win.document.documentElement;
  if (host.theme) el.setAttribute("data-theme", host.theme);
  else el.removeAttribute("data-theme");
  if (host.flavor) el.setAttribute("data-flavor", host.flavor);
  else el.removeAttribute("data-flavor");
}

/**
 * Read whatever appearance the host has given us so far and start
 * listening for live changes.
 *
 * Call before React mounts. `index.html` carries no static `data-theme`/
 * `data-flavor` (the Conjure-default/browser-preference fallback is already
 * correct pre-JS — see the file header), so this is the only place those
 * attributes get set for the dev server; the single-file inline build
 * (which generates its own shell) needs them set at runtime regardless, the
 * same reason `main.tsx` sets the `cui-ui` body class at runtime too.
 *
 * `win` defaults to the real window and is only ever passed by the tests,
 * which hand it a fake rather than pulling jsdom in for one file.
 */
export function initAppearance(win: Window & typeof globalThis = window): void {
  try {
    const injected = (win as unknown as {
      __conjureos?: { appearance?: { theme?: unknown; flavor?: unknown } };
    }).__conjureos?.appearance;
    if (injected) {
      host.inConjureOS = true;
      host.theme = asTheme(injected.theme);
      host.flavor = asFlavor(injected.flavor);
    }
  } catch {
    /* no host bridge: standalone, and there is nothing to record */
  }

  apply(win);

  win.addEventListener("message", (ev: MessageEvent) => {
    const data = ev.data as { type?: unknown; theme?: unknown; flavor?: unknown } | null;
    if (!data || data.type !== MSG) return;
    // Only the embedder can speak for ConjureOS. With no embedder at all —
    // this window is its own parent — there is no ConjureOS to speak for it,
    // so we reject before even checking who sent the message.
    const embedded = win.parent && win.parent !== win;
    if (!embedded) return;
    if (ev.source !== win.parent) return;
    host.inConjureOS = true;
    host.theme = asTheme(data.theme);
    host.flavor = asFlavor(data.flavor);
    apply(win);
  });

  // Announce ourselves so the shell answers with its current appearance even
  // if it booted first.
  try {
    if (win.parent && win.parent !== win) {
      win.parent.postMessage({ type: `${MSG}:subscribe` }, "*");
    }
  } catch {
    /* a cross-origin parent that refuses. Not fatal. */
  }
}
