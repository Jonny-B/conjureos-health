# Conjure Health: instructions for Claude

A ConjureOS anchor app, in its own repo. Project status is in `STATUS.md`.

## App type

Sealed (ConjureOS Phase 62): the AI changes nothing in this app. `package.json`
declares `"appType": "sealed"` plus `"editable": false`, the mirror older
clients read. Never drop either key: a manifest that declares no type is read
as an AI-editable applet. Do not add `editStyle`; the store and the kernel write
the legacy keys themselves. `src/manifest.test.ts` holds all three.

## Versioning

`package.json` is the only place the version lives (`vite.config.ts` injects it
as `__APP_VERSION__`). Bump it with `npm install --package-lock-only` so the
lockfile follows, and take the number at push time, after a fetch. `main` is
the prod line (1.40.x); `dev` has its own series (1.43.x).

## Before pushing

```
npm run typecheck && npm test && npm run build:inline
```

## Publishing

A push to `dev` or `main` publishes nothing. The store only changes when the
"Publish to ConjureOS App Store" workflow runs (a hand dispatch, or a published
release, which goes to prod).
