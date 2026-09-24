/**
 * One path for a save that did not persist: log it (dev builds only, the same
 * guard the repository selector uses) and tell the user in plain words. The
 * app shell listens for {@link SAVE_FAILED_EVENT} and shows the message.
 */

export const SAVE_FAILED_EVENT = "conjure-health:save-failed";

export interface SaveFailedDetail {
  message: string;
}

/** `what` reads as a noun phrase: "your plan", "this drink". */
export function saveFailedMessage(what: string): string {
  return `We couldn't save ${what}. Please try again.`;
}

export function reportSaveFailure(what: string, err: unknown): void {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.warn(`[conjure-health] save failed: ${what}`, err);
  }
  const target = (globalThis as { window?: Window }).window;
  if (!target || typeof target.dispatchEvent !== "function" || typeof CustomEvent === "undefined") return;
  target.dispatchEvent(
    new CustomEvent<SaveFailedDetail>(SAVE_FAILED_EVENT, { detail: { message: saveFailedMessage(what) } }),
  );
}

/** Await a write; on failure report it and resolve anyway, so the caller's flow goes on. */
export async function persist(what: string, write: Promise<unknown>): Promise<boolean> {
  try {
    await write;
    return true;
  } catch (err) {
    reportSaveFailure(what, err);
    return false;
  }
}
