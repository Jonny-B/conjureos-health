/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_USDA_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Injected at build time from package.json by vite.config.ts.
declare const __APP_VERSION__: string;
