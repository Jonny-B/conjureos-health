import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { readFileSync } from "node:fs";

// Inject package.json's version at build time so the app can show it in the
// footer. Bump `version` in package.json before building to see the new value.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const APP_VERSION = pkg.version as string;

// Two build outputs from the same source, matching the recipe anchor app:
//   - `npm run build`        → dist/index.html + separate JS/CSS. What the
//                              Phase 8 bundler ingests on ZIP import.
//   - `npm run build:inline` → dist/index.html with everything inlined,
//                              for embedding as a single srcdoc HTML string.
export default defineConfig(({ mode }) => {
  const inline = mode === "inline";
  return {
    define: {
      __APP_VERSION__: JSON.stringify(APP_VERSION),
    },
    plugins: [react(), ...(inline ? [viteSingleFile()] : [])],
    server: {
      port: 5181,
      strictPort: false,
    },
    build: {
      target: "es2022",
      // Never minify: ConjureOS lets users (and the in-OS AI) view + modify
      // installed app source, so the published build must stay readable.
      minify: false,
      sourcemap: !inline,
      ...(inline
        ? {
            assetsInlineLimit: 100_000_000,
            cssCodeSplit: false,
            rollupOptions: { output: { inlineDynamicImports: true } },
          }
        : {}),
    },
  };
});
