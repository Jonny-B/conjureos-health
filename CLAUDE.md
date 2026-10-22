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
lockfile follows, and take the number at push time, after a fetch.

## Before pushing

```
npm run typecheck && npm test && npm run build:inline
```

## Publishing

The store slug is `health`; never publish to `fitness`, a withdrawn listing
(Conjure Health's old one, under a legacy name). Both publish steps in
`.github/workflows/publish-store.yml` name `health`, and
`scripts/storeSlug.test.mjs` holds them and the `/launch/health` deep-link
examples.

A push to `dev` or `main` publishes nothing. The store only changes when the
"Publish to ConjureOS App Store" workflow runs (a hand dispatch, or a published
release, which goes to prod).

GitHub runs the copy of the workflow on the branch picked under
"Use workflow from" (a Release runs the copy at its tag), and both default to
`main`, the default branch. Run it only from a branch whose copy says
`slug: health`.

The listing is created once per project, by hand, with ConjureOS's
`publish-app.mjs --first-publish --featured --display-name "Conjure Health"`;
the workflow's header has the whole command. `--featured` is what makes
`/launch/health` resolve and reserves the slug.
