# Conjure Health, an app for ConjureOS

> Conjure Health publishes as its own App Store listing, slug `health`, on dev
> and prod. `fitness` is a withdrawn listing (Conjure Health's old one, under a
> legacy name) and is never published to. See [STATUS.md](STATUS.md) for what
> shipped, what is in flight, and the current focus.

> Renamed from "Conjure Fitness" on 2026-06-24, and moved here from
> `Jonny-B/conjureos-fitness` on 2026-09-24 with its full history. Workouts and
> the AI coach left with it: that repo is now
> [Conjure Fitness](https://github.com/Jonny-B/conjureos-fitness), a separate app
> (slug `conjure-fitness`). Conjure Health has no workouts and no coach.

Calorie, nutrition, and weight tracking, with a journal for sleep, water and
symptoms. A My Net Diary-style daily tracker: log food by search, barcode, or
plain language; see calories + macros against your goals, with exercise calories
added back; and weigh in.

A keystone (anchor) app for [ConjureOS](https://github.com/Jonny-B/ConjureOS),
built as a standalone Vite + React + TypeScript project and published to the App
Store as one self-contained HTML file. It is sealed (`appType: "sealed"`,
`editable: false`): the AI changes nothing in it. Its shared food database lives
in the ConjureOS repo, not here (see below).

## What's here today

The tabs are Diary, Add, Plan and Journal; Settings is the cog in the header.

- **Diary** — daily food log grouped by meal, calorie ring + macro bars vs.
  goals, per-entry quantity stepping and editing (including moving an entry to
  another meal), day-to-day navigation, and cards for weight, your plan, water,
  sleep and symptoms, and Ask Health.
- **Add food** — three ways to log, each also reachable from a meal's buttons:
  - **Scan** a barcode with the camera (`BarcodeDetector`, with the
    `barcode-detector` polyfill where the browser has none), with manual entry as
    a fallback when the camera is denied or unsupported. A barcode is looked up
    in the shared Conjure Health food database first, then Open Food Facts. One
    nobody knows can be read from a photo of the nutrition label or the package
    front.
  - **AI**: describe what you ate in plain language, or photograph the meal, and
    the AI estimates structured entries you review and adjust before logging.
  - **Search** Open Food Facts (branded), USDA FoodData Central (whole foods,
    through ConjureOS's `usda-proxy`) and the foods you added yourself. When
    search finds nothing you can add your own food. Saved recipes from a recipe
    app (the Recipes app, via cross-app discovery) show up in the results too;
    logging one copies its per-serving macros and marks it cooked.
- **Plan** — a wizard (disclaimer, your goal in your own words, a short safety
  and body-stats step, dates and inputs, review) builds a food plan. Calories
  come from a Mifflin-St Jeor estimate for your goal, with a manual override, and
  the AI writes the plan's goals. The safety step puts anyone under 18, pregnant
  or with a heart condition on a logging-only plan with no calorie target; no
  number, "left" or "over" is shown or handed out for it. The Plan tab holds the
  daily targets, the weekly movement goal and its progress, and the weight graph
  with a weigh-in, history and BMI.
- **Journal** — a month grid, a day's timeline of food, water, sleep, symptoms,
  weight and exercise, and a printable range. **Find patterns** asks the AI
  about the month on screen.
- **Ask Health**: the app's own AI Q&A about food and nutrition, answered
  against what you have logged: today in full plus the two days before from the
  home card, or the month on screen from the journal's "Find patterns". It
  answers and changes nothing. (Coaching is a Conjure Fitness feature; Health
  has no coach.)
- **Exercise on the calorie ring** — calories burned go back into the day's
  budget: synced from Apple Health or Health Connect (phone only; Health reads
  your workouts and their energy, nothing else, and never writes to either),
  logged by another app through `logWorkout`, read from a fitness app through the
  `workoutSource` need, or added by hand. The ring's Exercise row opens the
  day's list to review, correct, or add to it. Workouts themselves — a library,
  guided sessions, programs — are not part of Conjure Health; they belong in
  Conjure Fitness, the way recipes live in the Recipes app.
- **Profile & goals** — Mifflin-St Jeor recommendation with manual override.

Nutrition logging is the core; weight tracking and exercise calories support
it.

### Privacy and the AI

Two agreements, both stored as files in the app's VFS so they follow the person
between devices:

- **Agreement to keep health data** (`health-consent.json`), asked on the first
  screen before anything is stored. Until it is given, only that screen renders
  and every cross-app action refuses. Withdrawing it in Settings stops
  collection at once and returns to that screen; if the withdrawal could not be
  saved, the screen says so and offers a retry.
- **AI agreement** (`ai-consent.json`, disclosure version 3), asked in place the
  first time a feature needs it, or in Settings. One agreement covers every
  feature that sends anything to the AI (`AI_FEATURES` in
  `src/features/aiConsent.ts`): building a plan, adding food from a description
  or a photo, food estimates for ConjureOS's assistant and other apps, Find
  patterns and Ask Health. With no agreement nothing is sent; withdrawing it
  stops all of them at once and clears the Ask Health conversation, and an answer
  that arrives after a withdrawal is thrown away. Free-text symptom notes are a
  separate opt-in. `src/features/aiGate.ts` is the one place a request leaves
  for the AI, and `src/features/aiAgreement.test.ts` holds every module to it.

Settings also holds units, the Consumer Health Data Privacy policy (the text
lives in `src/components/HealthDataPolicy.tsx`; keep it true when a data flow
changes) and Reset health data, which clears one history at a time or all of
them.

### Community food database

Barcode lookups ask the shared food database first: the `health-foods-db` Edge
Function and its tables live in the ConjureOS repo; `src/features/foods/conjureHealthDb.ts`
is the client. On a miss it checks Open Food Facts and copies the answer into
its own table. A food someone submits stays hidden from other people's lookups
until an admin promotes it (only promoted rows and rows imported from Open Food
Facts or USDA are served), and the contributor is never shown. A weekly
moderation sweep (`health-foods-moderation-sweep`, Sundays 14:00 UTC) emails a
digest when someone has three or more flagged submissions in a week at a 30%
flag rate, or 100 or more submissions in a day; its schedule does nothing until
the project has a `conjure_project_url` Vault secret. Pushing contributions back
to Open Food Facts is not built; Health only reads from it.

## Architecture

Three layers, so a contributor can run everything locally and the backend can
swap without touching the UI:

- **`src/bridge/`** — thin wrappers over the ConjureOS host surface
  (`ai.complete`, VFS, cross-app actions and discovery, native health, host
  auth), each with a mock or a no-op outside ConjureOS so the app runs under
  `npm run dev`.
- **`src/data/`** — a single `Repository` interface. `MockRepository`, the
  default and the one a store install uses, keeps the data in `localStorage`
  (authoritative per device) with a best-effort mirror in the VFS file
  `store.json`. A **Supabase** implementation sits behind the same interface
  (see Backend). Nothing above this line knows which is live.
- **`src/features/`** + **`src/screens/`** — pure logic (diary math, goals,
  food search, plan generation, the AI gate) and the React UI.

## Appearance

Conjure Health **inherits the ConjureOS theme + flavor** — whatever palette
and light/dark mode the OS is wearing, this app wears too, live. There is no
in-app override: no lock, no settings control.

`src/theme.ts` applies the OS appearance from the shim at boot (kills the
launch flash) and from every broadcast after, and exposes it through
`hostAppearance()`. No host (standalone / `npm run dev`) or no OS override
both fall back to the Conjure default + the browser's light/dark preference,
which `@conjureos/ui`'s tokens.css already treats as "no `data-theme`"/"no
`data-flavor`" — the correct behavior, not a missing case.

This app used to be locked to Winter dark; the lock has been lifted. It never
meant deaf even then — `hostAppearance()` predates the unlock — but every
literal color in `src/styles.css` had to stop assuming Winter dark once the
palette could actually change under it.

Never hardcode a colour. `--cui-on-accent` is dark in six of the nine
palettes, so `color: #fff` on a filled control is a bug. The camera and
scanner overlays are the exception: their white sits over a live video feed,
not over a themed surface. The macro/status palette
(`--protein`/`--carbs`/`--fat`/`--good`/`--bad`) and the timeline "kind"
palette (`--kind-*`, one colour per journal entry type) are also exceptions,
deliberately fixed rather than theme-following — see the comment at the top
of `src/styles.css`.

## Development

```bash
npm install
npm run dev
npm run typecheck && npm test && npm run build:inline   # before pushing
```

With no host the app runs on the local store, the AI answers from a canned mock,
and the VFS is in memory, so logging, the diary, weight, the journal and
exercise all work end to end offline. The repo has no CI workflow besides the
store publish, which runs `npm run build:inline`.

### Backend

The per-user data (diary, plan, weight, sleep, water, symptoms) is kept in the
on-device store, mirrored to a VFS file that ConjureOS syncs to the account (a
new device seeds itself from it once). `src/data/supabaseRepository.ts` can use
the shared ConjureOS project's `fitness` schema (SQL and edge functions in a
private backend repo, not in this tree), but only when `VITE_SUPABASE_URL` +
`VITE_SUPABASE_ANON_KEY` are baked in **and** the host hands the app a user
session token. ConjureOS gives that token only to built-in apps, so a store
install gets none and stays on the local store. The publish workflow does bake
the URL and key in, for the shared food database (`health-foods-db`) and as the
fallback address of the `usda-proxy`. See `.env.example`.

## Build

```bash
npm run build         # dist/: separate JS and CSS, what a ZIP import ingests
npm run build:inline  # dist/index.html, one self-contained file: what the store publish ships
```

## Cross-app integration

Other ConjureOS apps and ConjureOS's own assistant can use Conjure Health in
three ways: actions, a summary file, and deep links. ConjureOS asks the user
before another app's request runs, reads included, unless they chose "Always
allow" for that app; its assistant acts when the user asks it to.

### Actions

`package.json` → `conjureos.actions` is the contract: ConjureOS validates
params against it, and its AI router picks actions by their descriptions, so
units, defaults and "pass X or Y" live in the description text. Conventions:

- **Every action returns `value`**, one line answering the question in the
  user's units. Ask ConjureOS shows an action's answer only through that field.
  Every write that adds a record also returns `display: { title, text }`, the
  card ConjureOS Chat shows under that line.
- **Without the person's agreement to keep health data, every action refuses**
  with `NEEDS_CONSENT:` and one line saying so. ConjureOS Chat turns that into
  "Conjure Health needs your agreement first" with an Open button. The actions
  are registered at startup, agreement or not, so a call before it gets that
  answer rather than none.
- **`tracksCalories: false`** means the user has no calorie target (the safety
  gate puts under-18, pregnant and heart-condition users on a logging-only
  plan). Nothing then carries a target, a "remaining" or an "over", and the
  reason never leaves the app.
- **Writes that miss say so.** Updating or deleting an id that doesn't exist
  fails with the reason instead of reporting success; `dayEntries` lists a
  day's records with their ids.
- **Estimates are labelled** (`estimated: true`, "AI estimate"), and fail with
  the reason rather than logging 0. ConjureOS pauses AI for apps in the
  background, so estimating needs Conjure Health open on screen.
- **Estimates need the AI agreement too.** `estimateNutrition` and `logFood`
  without `calories` answer `NEEDS_CONSENT` (pointing at Settings) when there is
  none, or when it is withdrawn while the estimate is out: nothing is sent and
  nothing is logged. Pass `calories` to log a food with no AI involved.
- **`logWorkout` is idempotent** with `externalId` + `sourceApp`: a re-sent
  workout replaces the earlier entry. Read `dayExercise` first when a workout
  may also sync from Apple Health or Health Connect.

<!-- actions:start (generated by npm run docs:actions; do not edit) -->
| Action | Kind | What it does |
|---|---|---|
| `logFood({ name, calories?, protein?, carbs?, fat?, meal?, date? })` | write | Log food to the user's diary. |
| `logMeal({ items, meal?, date? })` | write | Log several foods to one meal in one call, each with its own numbers - for an app that already knows the meal (a planned dinner, a composed plate). |
| `copyMeal({ meal, fromDate?, toDate?, toMeal? })` | write | Copy every food from one meal on one day to another day - "log the same breakfast as yesterday". |
| `logRecipeMeal({ slug, servings?, meal?, date? })` | write | Log a saved recipe from the Recipes app as a meal by slug, copying its per-serving nutrition into the diary and marking the recipe cooked. |
| `updateFoodEntry({ id, meal?, quantity?, name?, calories?, protein?, carbs?, fat? })` | write | Correct a logged food: move it to another meal, change how many servings, rename it, or fix its per-serving calories/protein/carbs/fat (grams). |
| `setFoodQuantity({ id, quantity })` | write | Change how many servings of an already-logged food the user had - 'make that two'. |
| `todayTotals()` | read | Return today's nutrition: calories and protein/carbs/fat (grams) eaten, exercise calories, and - when the user tracks a calorie target - their targets and the calories left (target - eaten + exercise). |
| `dayNutrition({ date? })` | read | Return what the user ate on a date: each food with its id, meal, servings, calories, protein/carbs/fat (grams) and whether it's an AI estimate, the day's totals, exercise calories, and - when they track a calorie target - targets and what's left. |
| `recentNutrition({ days? })` | read | Return daily nutrition totals - calories, protein/carbs/fat (grams) and exercise calories - for the last N days, oldest first, for trends. |
| `nutritionTargets()` | read | Return the targets the user works to and how they read amounts: daily calories and protein/carbs/fat (grams) when they track a calorie target, units (metric or imperial), the daily water goal in ml, and their weekly movement goal with this week's progress. |
| `dayEntries({ date? })` | read | Return every record logged on a date, each with the kind and id that deleteEntry, setFoodQuantity and updateFoodEntry take: foods (meal, servings, calories, macros), drinks (ml), sleep (minutes), symptoms (label, severity, time), the weigh-in (id is the date) and workouts stored in this app. |
| `estimateNutrition({ text?, ingredients?, servings? })` | read | Estimate the calories and macros of a described meal or a recipe's ingredients WITHOUT logging anything - for a recipe or meal-planning app that wants a number. |
| `findFood({ barcode?, query?, limit? })` | read | Look up a food's nutrition by barcode, or search by name, across the user's own foods, USDA, Open Food Facts and Conjure Health's shared food database. |
| `logWorkout({ calories, type?, durationMin?, date?, externalId?, sourceApp? })` | write | Log a completed workout so its burned calories add back into the day's calorie budget. |
| `dayExercise({ date? })` | read | Return the exercise on a day's calorie ring from every source - added by hand, logged by an app (with its externalId), or read from Apple Health / Health Connect - with calories, minutes, whether it counts toward the day, and whether deleteEntry can remove it. |
| `logWater({ ml?, oz?, date? })` | write | Log a drink. |
| `logSleep({ bedTime, wakeTime, quality?, wakeDate? })` | write | Log a night's sleep from the clock times the user gives. |
| `logSymptom({ label, severity?, note?, date? })` | write | Record something the user felt — a headache, heartburn, anything they describe. |
| `logWeight({ kg?, lb?, date? })` | write | Record the user's weight for a day. |
| `dayWellbeing({ date? })` | read | Return the non-food side of a day: water drunk (ml), sleep length (minutes), weight in kg if recorded, and symptoms with their severity and time. |
| `recentWellbeing({ days? })` | read | Return the same non-food day summary for the last N days, oldest first, for trends in sleep, water, weight and symptoms. |
| `weightTrend({ days? })` | read | Return the user's weight over the last N days (default 30, max 365): the latest weigh-in, every weigh-in in the window oldest first, and the change across it, all in kg, plus the user's units for display. |
| `deleteEntry({ kind, id })` | write | Remove ONE record the user logged by mistake - the undo for a double-log. |
<!-- actions:end -->

Deliberately not exposed: AI-journal consent, the pattern finder and Ask
Health, bulk clears, goal / profile / plan writes, and symptom or sleep notes on
read. The header of `src/bridge/actions.ts` says why.

Conjure Health also consumes data from other apps, through `needs` that
ConjureOS matches by shape (no app is named anywhere):

| Need | Who provides it today | What Health does with it |
|---|---|---|
| `recipeSource` | Recipes' `listRecipes` | Log a saved recipe as a meal (`src/bridge/recipeBridge.ts`) |
| `workoutSource` | Conjure Fitness's `listWorkouts` | Count its workouts on the calorie ring, next to Apple Health (`src/bridge/workoutSource.ts`) |

`workoutSource` requires `id`, `date` and `caloriesBurned` on each workout and
reads `name`, `durationMin` and `completedAt` when present. Linked workouts can
be removed from the ring or have their calories corrected on the Exercise
screen, like Apple Health ones; neither changes the other app. A fetch covers a
whole week and is cached for a minute, and any failure just means no linked
workouts. A linked workout the same app also sent through `logWorkout` (same
`sourceApp` and `externalId`) is counted once. Changing either side's schema can
silently break the match: check it with `schemaSatisfies` from
`@conjureos/bridge` (conjureos-fitness's `ACTIONS.md` has the snippet).

### Summary file

`dataReadable` lists one file, `nutrition-summary.json`: food, water and
exercise for the last 14 days, rewritten after every change. ConjureOS reads
it, with the user's permission, to answer a question no action fits ("how has
my protein been this week?"). It holds no symptoms, sleep, weight, profile or
plan. Desktop only for now.

### Deep links

ConjureOS opens a link like
`https://conjureos.com/launch/health?intent=addFood&query=greek%20yogurt`
after the user agrees. Links only navigate: nothing is logged until the user
taps. Desktop only for now.

| Intent | Params | Opens |
|---|---|---|
| `addFood` | `query`, `barcode`, `meal`, `date` | Add food with the search filled in, or the barcode's food ready to log |
| `openDay` | `date` | That day's diary |
| `exercise` | `date` | That day's Exercise screen |

## License

MIT — see [LICENSE](LICENSE).
