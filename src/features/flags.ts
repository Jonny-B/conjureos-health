/**
 * Feature flags.
 *
 * These are deliberately plain module constants, not runtime config: flipping
 * one is a code change that goes through review, a build, and a publish. That's
 * the point — a paused feature should not be one tapped setting away from
 * reappearing in a user's app.
 */

/**
 * The adaptive workout program is PAUSED (2026-08-14, owner decision; shipped
 * in 1.21.0).
 *
 * Conjure Health is shipping as a focused weight-loss + nutrition tracker so
 * there's a product to put in front of people. The workout work is not
 * cancelled and not deleted: it is switched off at the surface.
 *
 * The AI coach paused alongside it was REMOVED from Health on 2026-10-10
 * (owner decision): coaching is a Conjure Fitness feature. Health's own AI
 * conversation is Ask Health (features/ask), which this flag does not touch.
 *
 * ## What this flag hides when false
 * - The Workouts tab and the built-in workout library
 * - The Plan tab's program section (assigned workouts + benchmark progress)
 * - The plan wizard's mode picker: plans are forced to `eat_better`
 * - The plan wizard's "Any injuries to work around?" question (2026-10-08,
 *   owner decision). Plans built while paused record `safety.injuries: []`
 *   (`intakeInjuries`), so no avoid-list reaches the plan prompt.
 * - The workout row in Settings, Reset health data
 *
 * ## What deliberately stays on
 * - **Apple Health / wearable exercise calories.** They adjust the day's
 *   calorie budget, which makes them a nutrition feature. The ring's Exercise
 *   row still opens a list of the day's workouts so those numbers can be
 *   corrected or removed: see `WorkoutsScreen`'s `exerciseOnly` mode.
 * - **The `logWorkout` cross-app action**, for the same reason: an assistant or
 *   wearable logging a burn still has to reach the calorie budget.
 * - **All stored data.** Existing plans keep their `program` and the
 *   `safety.injuries` they recorded (which still guard that program), and
 *   session history is untouched on disk. Nothing migrates, nothing is wiped.
 *   `coach.json`, the removed coach's memory, also stays on disk unread; the
 *   "Current plan" row (and so "Clear all history") wipes it.
 * - **All the paused workout code and its tests**, so it keeps compiling and
 *   can't rot silently while it's switched off.
 *
 * ## Turning it back on
 * Set this to `true`. Everything above returns, including existing users'
 * programs, because no data was ever deleted. Nothing else returns with it:
 * the coach was removed from Health, and coaching belongs to Conjure Fitness.
 * Then re-check these, which are the only things the flag does NOT restore on
 * its own:
 *   1. `package.json`: the top-level `description` and
 *      `conjureos.promptSuggestions`, which were rewritten to describe a
 *      nutrition-only app.
 *   2. The wizard's step numbering/titles, which assume a nutrition-only flow.
 *   3. The edit-mode wizard starts the injuries question empty instead of
 *      reloading `editPlan.safety.injuries`. Add that reload behind this flag;
 *      while paused it would copy old injuries into new food-only plans.
 *   4. `POLICY_UPDATED` in components/HealthDataPolicy.tsx. The health data
 *      policy's plan-build line (`PLAN_BUILD_SENDS`) reads this flag and
 *      widens to name training experience and the injury avoid-list, so set
 *      the date to the release that turns workouts on (HealthDataPolicy.test.tsx
 *      fails until it is later than 2026-10-08). Also decide whether
 *      `DISCLOSURE_VERSION` moves: it versions the consent sheet's wording,
 *      which this line is not part of, and decd535 widened this line without
 *      a bump.
 *   5. The workout runner ends on the calories-burned step and returns to the
 *      list. Its old last step, a post-workout reflection, was part of the
 *      removed coach and does not come back.
 *   6. The program adapts and progresses on recorded sessions alone. The
 *      engine still takes a `preferences` block (the user's dislikes and
 *      constraints) in `calibrateToBenchmark`, `maybeAdapt` and
 *      `advanceToNextGroup`, which feeds `buildAnalysisPrompt`. Its only
 *      source was the removed coach's memory and reflections, so planService
 *      passes none, and turning workouts on gives a person no way to say "no
 *      burpees" or "I work nights". Decide whether to add one before reviving.
 */
export const WORKOUTS_ENABLED: boolean = false;
