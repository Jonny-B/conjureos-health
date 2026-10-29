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

The workflow adds versions to a listing that exists. A project's listing is
created once: dispatch the workflow with `first_publish` ticked (it hands
`first-publish`, the display name and `featured` to the shared action, and is
refused if the listing exists), or by hand with ConjureOS's
`publish-app.mjs --first-publish --featured --display-name "Conjure Health"`
(the workflow's header has the whole command). `--featured` is what makes
`/launch/health` resolve and reserves the slug.

## Every AI request goes through the gate

`completeUnderAgreement` in `src/features/aiGate.ts` is the one place a request
leaves for the AI, and `AI_FEATURES` in `src/features/aiConsent.ts` names every
feature that sends anything. Nothing is sent without the AI agreement, a
withdrawal stops all of them, and an answer that lands after a withdrawal is
thrown away. A new AI feature joins `AI_FEATURES` and `DISCLOSURE_SENDS`, and
`DISCLOSURE_VERSION` (3 today) is bumped when the wording changes materially, so
everyone is asked again. `src/features/aiAgreement.test.ts` fails if a module
reaches the AI any other way. Keep the policy in
`src/components/HealthDataPolicy.tsx` true when a data flow changes.

Health has no coach: coaching is a Conjure Fitness feature, and
`src/noCoach.test.ts` fails on a coach or trainer left in shipped source.
