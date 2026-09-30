# Conjure Health, an app for ConjureOS

> **ACTIVE (relaunched 2026-07-11).** Back in development and returning to the
> App Stores. See [STATUS.md](STATUS.md) for what shipped, what is in flight, and
> the current focus.

> Renamed from "Conjure Fitness" on 2026-06-24, and moved here from
> `Jonny-B/conjureos-fitness` on 2026-09-24 with its full history; that repo is
> now Conjure Fitness, a separate app. The store slug stays `fitness`: it names the
> existing listing and where each user's data lives, so changing it would start
> a new listing and leave that data behind.

Calorie, nutrition, and weight tracking. A My Net Diary-style daily tracker:
log food by search, barcode, or plain language; see calories + macros against
your goals, with exercise calories added back; and weigh in.

A keystone (anchor) app for [ConjureOS](https://github.com/Jonny-B/ConjureOS),
built as a standalone Vite + React + TypeScript project and imported via the
Phase 8 bundler. **Open source app, private backend** — see below.

## What's here today

- **Diary** — daily food log grouped by meal, calorie ring + macro bars vs.
  goals, per-entry quantity stepping, day-to-day navigation.
- **Add food** — four ways to log:
  - **Search** Open Food Facts (branded) + USDA FoodData Central (whole foods).
  - **Scan** barcodes via the camera (`BarcodeDetector`), with manual entry as
    a fallback where the API isn't supported (iOS Safari / Firefox).
  - **Describe** what you ate in plain language → AI estimates structured
    entries you adjust.
  - **Recipes** — pull a saved recipe from the [Recipes app](https://github.com/Jonny-B/conjureos-app-recipes)
    (cross-app actions) and log its per-serving macros, marking it cooked.
- **Trends** — weight tracking with a trend sparkline + BMI.
- **Exercise on the calorie ring** — calories burned go back into the day's
  budget: synced from Apple Health (or another wearable), logged by another app
  through `logWorkout`, linked from Conjure Fitness, or added by hand. The
  ring's Exercise row opens the day's list to review, correct, or add to it.
  Workouts themselves — a library, guided sessions, programs, the AI trainer —
  are not part of Conjure Health; they live in
  [Conjure Fitness](https://github.com/Jonny-B/conjureos-fitness), the way
  recipes live in the Recipes app.
- **Profile & goals** — Mifflin-St Jeor recommendation with manual override.

Nutrition logging is the core; weight tracking and exercise calories support
it.

## Architecture

Three layers, so a contributor can run everything locally and the backend can
swap without touching the UI:

- **`src/bridge/`** — thin wrappers over the ConjureOS host surface
  (`ai.complete`, VFS, cross-app actions, host auth), each with a dev mock so
  the app runs outside the OS.
- **`src/data/`** — a single `Repository` interface. A VFS-backed **mock**
  (default) and a **Supabase** implementation sit behind it, picked at runtime.
  Nothing above this line knows which backend is live.
- **`src/features/`** + **`src/screens/`** — pure logic (diary math, goals,
  food search) and the React UI.

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
```

With no configuration the app runs entirely on the **mock data layer** (in
memory + the app's VFS scope), so logging, the diary, weight, and exercise all
work end-to-end offline. The AI, VFS, and cross-app bridges are mocked too.
`npm run typecheck` and `npm run build` are the CI gates.

### Backend (private)

The app uses a real backend only when (1) the shared ConjureOS Supabase
project's `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` are set, **and** (2)
ConjureOS hands the app the signed-in user's session token via its auth bridge.
The `fitness`-schema SQL + edge functions live in a **separate private repo**;
this app talks to them through `src/data/supabaseRepository.ts`. Single
sign-on (use whoever is signed into ConjureOS, no per-app login) depends on a
platform auth bridge in ConjureOS — until it ships, the app stays on the mock.

See `.env.example` for configuration.

## Import into ConjureOS

```bash
npm run build       # dist/ — ingested by the Phase 8 bundler on ZIP import
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

- **Every read returns `value`**, one line answering the question in the
  user's units. Ask ConjureOS shows an action's answer only through that field.
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

Deliberately not exposed: AI-journal consent, the pattern finder and the
coach, bulk clears, goal / profile / plan writes, and symptom or sleep notes on
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
`https://conjureos.com/launch/fitness?intent=addFood&query=greek%20yogurt`
after the user agrees. Links only navigate: nothing is logged until the user
taps. Desktop only for now.

| Intent | Params | Opens |
|---|---|---|
| `addFood` | `query`, `barcode`, `meal`, `date` | Add food with the search filled in, or the barcode's food ready to log |
| `openDay` | `date` | That day's diary |
| `exercise` | `date` | That day's Exercise screen |

## License

MIT — see [LICENSE](LICENSE).
