/**
 * Feature flags.
 *
 * These are deliberately plain module constants, not runtime config: flipping
 * one is a code change that goes through review, a build, and a publish. That's
 * the point — a paused feature should not be one tapped setting away from
 * reappearing in a user's app.
 */

/**
 * The AI coach and the adaptive workout program are PAUSED (2026-08-04, owner
 * decision).
 *
 * Conjure Health is shipping as a focused weight-loss + nutrition tracker so
 * there's a product to put in front of people. The coaching and workout work is
 * not cancelled and not deleted — it is switched off at the surface.
 *
 * ## What this flag hides when false
 * - The Workouts tab and the built-in workout library
 * - The Coach chat tab and the Plan tab's coach launcher
 * - The evening "how did your day go?" check-in banner + sheet
 * - The Plan tab's program section (assigned workouts + benchmark progress)
 * - The plan wizard's mode picker — plans are forced to `eat_better`
 * - The coach/workout rows in Settings → Reset health data
 *
 * ## What deliberately stays on
 * - **Apple Health / wearable exercise calories.** They adjust the day's
 *   calorie budget, which makes them a nutrition feature. The ring's Exercise
 *   row still opens a list of the day's workouts so those numbers can be
 *   corrected or removed — see `WorkoutsScreen`'s `exerciseOnly` mode.
 * - **The `logWorkout` cross-app action**, for the same reason: an assistant or
 *   wearable logging a burn still has to reach the calorie budget.
 * - **All stored data.** Existing plans keep their `program`, and `coach.json` /
 *   session history are untouched on disk. Nothing migrates, nothing is wiped.
 * - **All the paused code and its tests**, so it keeps compiling and can't rot
 *   silently while it's switched off.
 *
 * ## Turning it back on
 * Set this to `true`. Everything above returns, including existing users'
 * programs, because no data was ever removed. Then re-check these, which are
 * the only things the flag does NOT restore on its own:
 *   1. `package.json` → `conjureos.description` + `promptSuggestions`, which
 *      were rewritten to describe a nutrition-only app.
 *   2. The wizard's step numbering/titles, which assume a nutrition-only flow.
 */
export const COACH_AND_WORKOUTS_ENABLED: boolean = false;
