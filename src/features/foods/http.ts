/**
 * Small fetch helpers shared by the food providers.
 *
 * Text search fans out to two third-party APIs in parallel and waits for both
 * (`Promise.all`). Open Food Facts' search endpoint is frequently slow, so
 * without a cap one hung request wedges the whole search into a permanent
 * "Searching…" with nothing shown. `withTimeout` bounds each request so a slow
 * or dead provider fails fast to an empty list and the other's results still
 * render.
 */

/** Wall-clock cap for a single food-search request. */
export const SEARCH_TIMEOUT_MS = 7000;

/**
 * Combine an optional caller `AbortSignal` (debounce cancellation) with an
 * internal timeout, returning a signal that aborts on whichever fires first.
 * Uses `AbortSignal.timeout`/`.any` when available and degrades gracefully.
 */
export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const anyFn = (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  const timeoutFn = (AbortSignal as { timeout?: (ms: number) => AbortSignal }).timeout;
  if (timeoutFn && anyFn) {
    const timeout = timeoutFn(ms);
    return signal ? anyFn([signal, timeout]) : timeout;
  }
  // Fallback for engines without AbortSignal.any/timeout: forward the caller's
  // signal and start our own timer on a fresh controller.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const cleanup = () => clearTimeout(timer);
  controller.signal.addEventListener("abort", cleanup, { once: true });
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

/** The two providers a text search asks. */
export type SearchProvider = "usda" | "openfoodfacts";

/**
 * A provider that did not answer a text search: offline, timed out,
 * rate-limited, refused, or not configured in this build.
 *
 * Thrown rather than returned as `[]` so the search can tell the person, and
 * so "no matches" only ever means the provider answered and knew nothing
 * (conjureos-fitness#70). A search the caller cancelled is not one of these:
 * nobody is waiting for its answer.
 */
export class ProviderUnavailableError extends Error {
  constructor(
    readonly provider: SearchProvider,
    /** The HTTP status, when the provider answered with a refusal. */
    readonly status?: number,
  ) {
    super(`${provider} did not answer${status ? ` (HTTP ${status})` : ""}`);
    this.name = "ProviderUnavailableError";
  }
}
