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
 * - The plan wizard's "Any injuries to work around?" question (2026-10-08,
 *   owner decision). Plans built while paused record `safety.injuries: []`
 *   (`intakeInjuries`), so no avoid-list reaches the plan prompt.
 * - The coach/workout rows in Settings → Reset health data
 *
 * ## What deliberately stays on
 * - **Apple Health / wearable exercise calories.** They adjust the day's
 *   calorie budget, which makes them a nutrition feature. The ring's Exercise
 *   row still opens a list of the day's workouts so those numbers can be
 *   corrected or removed — see `WorkoutsScreen`'s `exerciseOnly` mode.
 * - **The `logWorkout` cross-app action**, for the same reason: an assistant or
 *   wearable logging a burn still has to reach the calorie budget.
 * - **All stored data.** Existing plans keep their `program` and the
 *   `safety.injuries` they recorded (which still guard that program), and
 *   `coach.json` / session history are untouched on disk. Nothing migrates,
 *   nothing is wiped.
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
 *   5. The trainer's AI consent. CoachScreen sends buildCoachContext and the
 *      conversation to the AI with no `hasAiJournalConsent` check, and the
 *      consent wording (DISCLOSURE_SENDS) describes only the health coach and
 *      Find patterns. Gate the trainer the way askCoach is gated and word
 *      what it sends (a DISCLOSURE_VERSION bump) before this ships as true.
 *      Its history already goes through `redactHistory` (coach/ask.ts), so a
 *      Find patterns journal and any answer that can quote its notes are not
 *      resent; keep it that way, since both share coach-chat.json.
 */
export const COACH_AND_WORKOUTS_ENABLED: boolean = false;
