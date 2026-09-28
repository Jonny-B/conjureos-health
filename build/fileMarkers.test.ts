import { describe, it, expect } from "vitest";
import { markChunk, markerPath } from "./fileMarkers";

const root = "/repo";

describe("markerPath", () => {
  it("is project-relative, keeps node_modules paths, and skips virtual modules", () => {
    expect(markerPath("/repo/src/App.tsx", root)).toBe("src/App.tsx");
    expect(markerPath("/repo/node_modules/react-dom/index.js", root)).toBe("node_modules/react-dom/index.js");
    expect(markerPath("\0vite/modulepreload-polyfill.js", root)).toBeNull();
    expect(markerPath("/repo/node_modules/react/index.js?commonjs-module", root)).toBeNull();
    expect(markerPath("/elsewhere/x.ts", root)).toBeNull();
  });
});

describe("markChunk", () => {
  it("puts one marker on its own line before each module's code", () => {
    const a = "const a = 1;";
    const b = "function App() { return a; }";
    const code = `(function(){${a}\n${b}\n})();`;
    const out = markChunk(code, [
      { id: "/repo/src/a.ts", code: a },
      { id: "/repo/src/App.tsx", code: b },
    ], root);
    expect(out).toBe(`(function(){\n// @conjureos:file src/a.ts @preserve\n${a}\n// @conjureos:file src/App.tsx @preserve\n${b}\n})();`);
    expect(out.replace(/^\/\/ @conjureos:file .*\n/gm, "").replace("{\n", "{")).toBe(code);
  });

  it("skips modules it cannot place instead of guessing", () => {
    const code = "x();";
    expect(markChunk(code, [{ id: "/repo/src/gone.ts", code: "y();" }, { id: "\0virtual", code: "x();" }], root)).toBe(code);
  });
});
