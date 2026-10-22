/**
 * Emits one `@conjureos:file <path>` marker per source module into the built
 * app (ConjureOS #998).
 *
 * The store build (`npm run build:inline`) is one HTML file. When ConjureOS's
 * Sandbox edits an app that large, it folds the bundle to fit the model's
 * budget. With these markers it folds per source file instead: the model is
 * shown the file list and the files a request needs, so a change to a screen
 * can land in that screen's code.
 *
 * - Scripts: `// @conjureos:file src/App.tsx @preserve` on its own line before each
 *   module's rendered code. Placed in `renderChunk` from Rollup's own
 *   per-module rendered text, so tree-shaking and hoisting cannot drop it.
 *   It ends in `@preserve` because the esbuild pass Vite runs after
 *   renderChunk strips every comment that is not a legal comment.
 * - Styles: `/* @conjureos:file src/styles.css *\/` at the top of each CSS
 *   module (the build is unminified, so comments survive).
 *
 * Paths are relative to the project root; dependencies keep their
 * `node_modules/...` path so ConjureOS can tell library code from app code.
 */
import path from "node:path";
import type { Plugin } from "vite";

const CSS_RE = /\.(css|scss|sass|less)(\?.*)?$/;

/** A module id as a project-relative path with forward slashes, or null for virtual modules. */
export const markerPath = (id: string, root: string): string | null => {
  if (id.startsWith("\0") || id.includes("?")) return null;
  if (!path.isAbsolute(id)) return null;
  const rel = path.relative(root, id).split(path.sep).join("/");
  if (rel.startsWith("../")) {
    const nm = rel.indexOf("node_modules/");
    return nm === -1 ? null : rel.slice(nm);
  }
  return rel;
};

/**
 * Inserts a marker before each module's rendered code in a chunk. Modules are
 * found in order from a moving cursor; one whose text is empty or cannot be
 * found is skipped rather than guessed at.
 */
export const markChunk = (
  code: string,
  modules: Array<{ id: string; code: string | null }>,
  root: string,
): string => {
  let out = "";
  let cursor = 0;
  for (const m of modules) {
    const text = m.code;
    const rel = markerPath(m.id, root);
    if (!text || !rel || rel.endsWith(".css")) continue;
    const at = code.indexOf(text, cursor);
    if (at === -1) continue;
    out += code.slice(cursor, at);
    if (out.length > 0 && !out.endsWith("\n")) out += "\n";
    out += `// @conjureos:file ${rel} @preserve\n`;
    cursor = at;
  }
  return out + code.slice(cursor);
};

export const conjureFileMarkers = (): Plugin => {
  let root = process.cwd();
  return {
    name: "conjureos-file-markers",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    transform(code, id) {
      if (!CSS_RE.test(id)) return null;
      const rel = markerPath(id.replace(/\?.*$/, ""), root);
      if (!rel) return null;
      return { code: `/* @conjureos:file ${rel} */\n${code}`, map: null };
    },
    renderChunk(code, chunk) {
      const modules = Object.entries(chunk.modules).map(([id, m]) => ({ id, code: m.code }));
      return { code: markChunk(code, modules, root), map: null };
    },
  };
};
