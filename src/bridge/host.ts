/**
 * Host identity bridge.
 *
 * The single-sign-on contract for keystone apps: ConjureOS owns the user's
 * session against the *shared* Supabase project, and hands keystone apps a
 * usable access token + identity so they never prompt for a second login.
 *
 * This is exposed by ConjureOS as `window.__conjureos.auth` and gated behind
 * an `auth.identity` permission (first-party keystone apps only). When the
 * bridge is absent — `npm run dev`, an older host, or a permission the user
 * declined — `getAccessToken()` resolves to null and the data layer falls back
 * to the mock, so the app stays fully usable offline.
 *
 * ConjureOS Phase 30 (cross-origin app isolation): apps now run at
 * <slug>.conjureos.app and cannot read the kernel's localStorage.
 * Identity reads MUST go through the bridge — there's no fallback to
 * "peek at supabase.auth.token in localStorage." This module is the
 * single source of host identity. `auth.whoami()` is the new safe
 * identity op that all apps can call (vs `auth.getUser`/`getAccessToken`
 * which are still built-in-only).
 */

export interface HostUser {
  id: string;
  email?: string;
}

/**
 * ConjureOS Phase 30g — safe identity subset returned by `auth.whoami()`.
 * Every field optional except `signedIn`. Granted to ALL apps, not just
 * built-ins.
 */
export interface HostWhoami {
  signedIn: boolean;
  email?: string;
  persona?: string;
  isAdmin?: boolean;
}

declare global {
  interface ConjureosBridge {
    auth?: {
      /** The signed-in user, or null when signed out. Built-in apps only. */
      getUser?: () => Promise<HostUser | null>;
      /** A Supabase access token valid against the shared project, or null. */
      getAccessToken?: () => Promise<string | null>;
      /**
       * Phase 30g — safe identity subset. Granted to ALL apps. Use this
       * instead of getUser when you only need signedIn / email / persona
       * / isAdmin and not the full user object or a token.
       */
      whoami?: () => Promise<HostWhoami>;
    };
    /**
     * First-party identity token (ConjureOS Phase 16c-hardening reuse). Mints a
     * short-lived, origin-scoped ConjureOS token (signed by mint-app-token,
     * `sub` = user id, `aud` = this project's origin) that an app forwards to a
     * ConjureOS backend to prove who the user is — WITHOUT the raw Supabase
     * session ever entering the WebView. This is the ONLY way to authenticate a
     * community-DB write on mobile, where `auth.getAccessToken` returns null by
     * design. Gated behind a one-time consent. Absent on hosts that predate it.
     */
    identity?: {
      token?: () => Promise<{ token: string; expiresIn: number } | null>;
    };
    /** Read-only mirror ConjureOS already injects today. */
    signedIn?: boolean;
  }
}

function authBridge() {
  return window.__conjureos?.auth;
}

/** True when the host can supply a real session token (SSO available). */
export function isHostAuthAvailable(): boolean {
  return typeof authBridge()?.getAccessToken === "function";
}

/** Coarse signed-in mirror that every ConjureOS version exposes. */
export function isSignedIn(): boolean {
  return window.__conjureos?.signedIn === true;
}

/**
 * The signed-in ConjureOS user, or null when the host predates the auth
 * bridge, nobody is signed in, or the call failed. Never throws — a missing
 * identity is an ordinary state here, not an error.
 */
export async function getHostUser(): Promise<HostUser | null> {
  const fn = authBridge()?.getUser;
  if (!fn) return null;
  try {
    return await fn();
  } catch {
    return null;
  }
}

/**
 * The host session's raw access token for authenticating a backend call, or
 * null when unavailable. Present on desktop; absent in the mobile WebView by
 * design, where `mintIdentityToken()` is the supported path instead.
 */
export async function getAccessToken(): Promise<string | null> {
  const fn = authBridge()?.getAccessToken;
  if (!fn) return null;
  try {
    return await fn();
  } catch {
    return null;
  }
}

/**
 * A short-lived minted ConjureOS identity token to authenticate a first-party
 * ConjureOS backend call (e.g. contributing to the community food DB) when the
 * raw session isn't available in the WebView — the mobile case. Returns null
 * when the host predates the bridge, the user declined consent, or minting
 * failed; callers then fall back to `getAccessToken()` (desktop) or degrade.
 */
export async function getIdentityToken(): Promise<string | null> {
  const fn = window.__conjureos?.identity?.token;
  if (typeof fn !== "function") return null;
  try {
    const res = await fn();
    return res?.token ?? null;
  } catch {
    return null;
  }
}

/**
 * Phase 30g safe identity read. Returns `{ signedIn: false }` when no
 * bridge is wired (e.g., `npm run dev`, older host, or any failure).
 */
export async function whoami(): Promise<HostWhoami> {
  const fn = authBridge()?.whoami;
  if (!fn) return { signedIn: false };
  try {
    return await fn();
  } catch {
    return { signedIn: false };
  }
}
