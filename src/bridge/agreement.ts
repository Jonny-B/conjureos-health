/**
 * Wrappers for the host's AI-agreement bridge (ConjureOS #1230).
 *
 * ConjureOS Chat and its orchestrator check this app's AI agreement before any
 * of its data reaches a model. The host reads the agreement from the file
 * (`ai-consent.json`, declared as `conjureos.aiAgreement` in package.json);
 * these two calls are the app's side of the conversation:
 *
 *   - `reportAgreement`: tell the host a change at once, before the file is
 *     written. "withdrawn" and "refused" hold for the session whatever the
 *     file says. "agreed" only makes the host read the file again: the file is
 *     the only thing that can make this app agreed.
 *   - `onAgreementRequest`: the host asks the app to show its agreement when
 *     Chat needs it. The handler answers true when it put something on screen, false when it did not.
 *
 * Both are no-ops on a host that predates them (and under `npm run dev`), so
 * the app works the same there; the host then falls back to its own list and
 * fails closed.
 */

export type AgreementReport = "withdrawn" | "refused" | "agreed";

/** What the host sends when Chat needs the agreement shown. */
export interface AgreementRequest {
  id?: string;
  purpose?: "chat";
}

interface AgreementHost {
  reportAgreement?: (state: AgreementReport) => void;
  onAgreementRequest?: (
    fn: (req: AgreementRequest) => boolean | Promise<boolean>,
  ) => (() => void) | void;
}

// The `ai` member is typed in bridge/ai.ts; these two are optional extras of it.
const ai = (): AgreementHost | undefined =>
  typeof window !== "undefined" ? (window.__conjureos?.ai as AgreementHost | undefined) : undefined;

/** Tell the host the agreement changed. Never throws, and never waits. */
export function reportAgreement(state: AgreementReport): void {
  try {
    const fn = ai()?.reportAgreement;
    if (typeof fn === "function") fn(state);
  } catch {
    /* a host that cannot take the report is no reason to stop a withdrawal */
  }
}

/** Answer the host's request to show the agreement. Returns the unsubscribe. */
export function onAgreementRequest(
  fn: (req: AgreementRequest) => boolean | Promise<boolean>,
): () => void {
  try {
    const on = ai()?.onAgreementRequest;
    if (typeof on === "function") {
      const off = on(fn);
      if (typeof off === "function") return off;
    }
  } catch {
    /* fall through to the no-op */
  }
  return () => {};
}
