/**
 * Thin wrapper around ConjureOS's `window.__vfs` with an in-memory mock so
 * the app runs outside the OS via `npm run dev`. Gated on the `vfs.read` /
 * `vfs.write` permissions declared in package.json.
 *
 * Conjure Fitness uses the VFS for two things: (1) the mock data layer persists its
 * store here so dev reloads keep your test data; (2) the food-lookup cache
 * lives here so repeat barcode/text lookups don't re-hit the network.
 */

interface VFSBridge {
  read: (path: string) => Promise<string>;
  write: (path: string, content: string) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
  ls: (path: string) => Promise<string[]>;
  mkdir: (path: string) => Promise<void>;
  rm: (path: string) => Promise<void>;
}

declare global {
  interface Window {
    __vfs?: VFSBridge;
  }
}

const real = (): VFSBridge | undefined => window.__vfs;

/** Whether a real host filesystem is mounted. False under `npm run dev` and
 *  in tests, where `vfs` transparently falls back to an in-memory store. */
export function isVfsAvailable(): boolean {
  return real() !== undefined;
}

const memStore = new Map<string, string>();

/**
 * The app's private file store, as provided by ConjureOS.
 *
 * Falls back to a process-local in-memory map when no host is mounted, so
 * every persistence path stays exercisable outside ConjureOS — but note that
 * fallback does NOT survive a reload. Paths are app-relative; `read` rejects
 * with an ENOENT-style error for a missing file, so prefer `readJson`, which
 * takes an explicit default.
 */
export const vfs: VFSBridge = {
  async read(path) {
    const r = real();
    if (r) return r.read(path);
    const v = memStore.get(path);
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    return v;
  },
  async write(path, content) {
    const r = real();
    if (r) return r.write(path, content);
    memStore.set(path, content);
  },
  async exists(path) {
    const r = real();
    if (r) return r.exists(path);
    return memStore.has(path);
  },
  async ls(path) {
    const r = real();
    if (r) return r.ls(path);
    const prefix = path.endsWith("/") ? path : path + "/";
    const out = new Set<string>();
    for (const key of memStore.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf("/");
      out.add(slash === -1 ? rest : rest.slice(0, slash));
    }
    return [...out];
  },
  async mkdir(path) {
    const r = real();
    if (r) return r.mkdir(path);
  },
  async rm(path) {
    const r = real();
    if (r) return r.rm(path);
    memStore.delete(path);
  },
};

/** Read + JSON.parse, returning `fallback` on any miss/parse error. */
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await vfs.read(path)) as T;
  } catch {
    return fallback;
  }
}

/** JSON write that throws when it fails, for data the user would miss. */
export async function writeJsonOrThrow(path: string, value: unknown): Promise<void> {
  await vfs.write(path, JSON.stringify(value));
}

/** Best-effort JSON write for caches: persistence failures never throw to callers. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  try {
    await vfs.write(path, JSON.stringify(value));
  } catch {
    /* best-effort */
  }
}
