/** Stable id generator — `crypto.randomUUID` with a non-crypto fallback for
 *  any environment that lacks it (older embedded webviews). Ids are opaque. */
export function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
