/**
 * The Consumer Health Data Privacy Policy.
 *
 * Deliberately a SEPARATE document rather than a section of a general privacy
 * policy: Washington's My Health My Data Act requires a distinct consumer
 * health data policy, linked in its own right, and Nevada's SB 370 is close
 * enough that one document serves both.
 *
 * Two rules for editing this file. It must describe what the code actually
 * does — the "what we send" list renders from the same `DISCLOSURE_SENDS`
 * constant the consent sheet uses, so the two cannot drift into saying
 * different things. And a material change here means bumping
 * `DISCLOSURE_VERSION`, which re-asks everyone rather than assuming old
 * agreement covers new wording.
 *
 * Plain-language policy written against how the app behaves. Final copy as of
 * 2026-10-08 (POLICY_UPDATED); keep it true when a data flow changes.
 */

import { DISCLOSURE_SENDS, DISCLOSURE_WITHHOLDS } from "../features/aiConsent";
import { COACH_AND_WORKOUTS_ENABLED } from "../features/flags";

/**
 * Last material revision. Shown so a reader can tell what they agreed to.
 *
 * 2026-10-08 is the date of the PAUSED wording of `PLAN_BUILD_SENDS` below.
 * That line reads COACH_AND_WORKOUTS_ENABLED, so turning workouts back on
 * widens the policy without editing this file: move this date to the release
 * that turns them on (flags.ts, "Turning it back on", item 4).
 * HealthDataPolicy.test.tsx fails until it is later than 2026-10-08.
 */
export const POLICY_UPDATED = "2026-10-08";

/**
 * What building a plan sends, matching `buildUserPrompt` in plan/generate.ts.
 * Training experience goes only with a workout plan, and the injury avoid-list
 * only when the wizard asked about injuries (see `intakeInjuries`). The wizard
 * asks for neither while workouts are paused (COACH_AND_WORKOUTS_ENABLED), so
 * the paused wording leaves both out. The live wording is the wider one: it
 * must not go out under the paused wording's date (see `POLICY_UPDATED`).
 */
export const PLAN_BUILD_SENDS = COACH_AND_WORKOUTS_ENABLED
  ? "your goal in your own words, the plan length, your training experience, height, weight, " +
    "goal weight, age and sex, and, if you told us about an injury, a list of movements to avoid"
  : "your goal in your own words, the plan length, height, weight, goal weight, age and sex";

export function HealthDataPolicy({ onClose }: { onClose: () => void }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet policy" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2>Consumer Health Data Privacy</h2>
        </header>

        <div className="sheet-body policy-body">
          <p className="muted small">Last updated {POLICY_UPDATED}.</p>

          <h3>What this covers</h3>
          <p>
            Conjure Health records things about your body: what you ate, what you weigh, how
            you slept, how much you drank, symptoms you noticed, and the goals in your plan.
            Some privacy laws call this <strong>consumer health data</strong>. This page explains
            what happens to it.
          </p>
          <p>
            Conjure Health is made by ConjureOS LLC. It is not a doctor, a clinic, an insurer, or
            any other kind of healthcare provider, and it is not part of one. That means your
            entries here are not medical records and HIPAA does not apply to them. The
            protections described on this page are the ones we actually implement, not ones
            HIPAA imposes on us.
          </p>

          <h3>Where it lives</h3>
          <p>
            Your entries are stored on your device and in your own ConjureOS account, so they can
            follow you between devices you sign in on. Other people cannot see them. ConjureOS
            LLC can access stored data only to run and secure the service, or when the law
            requires it. It is never sold, and it is never used for advertising or marketing,
            by us or by anyone we send it to.
          </p>

          <h3>When it leaves</h3>
          <p>
            Some features need an AI to work. Each one sends only what that request needs, and
            only when you use it. Nothing is sent on a schedule, in the background, or while
            the app is closed.
          </p>
          <ul className="consent-list">
            <li>
              <strong>Building or changing your plan</strong> sends {PLAN_BUILD_SENDS}.
            </li>
            <li>
              <strong>Logging food by describing it or with a photo</strong>, or reading a
              nutrition label or the front of a package, sends the words or the photo you gave
              it.
            </li>
            <li>
              <strong>Find patterns</strong> and <strong>asking your health coach</strong> send
              parts of what you log, including a summary of your weight history and your plan,
              and ask for your agreement first. They send:
            </li>
          </ul>
          <ul className="consent-list">
            {DISCLOSURE_SENDS.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p>None of these send:</p>
          <ul className="consent-list withheld">
            {DISCLOSURE_WITHHOLDS.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p>
            <strong>Barcodes and food search</strong> look up the food in the shared ConjureOS
            food database, then in Open Food Facts and USDA FoodData Central. Only the barcode or
            the search words are sent, nothing about you. If you add a food to the shared
            database, it is linked to your account so we can stop abuse; other people can find
            the food, but never see who added it.
          </p>

          <h3>Apple Health and Health Connect</h3>
          <p>
            On the ConjureOS phone app, Conjure Health can read from Apple Health (iPhone) or Health
            Connect (Android) if you allow it. ConjureOS asks you first, then your phone shows
            its own Health screen where you choose what to share. Conjure Health reads one kind of
            data: your workouts and the energy they burned, to count the exercise you did on your calorie ring. It never writes anything to
            Apple Health or Health Connect, never puts what it reads in iCloud Drive or
            CloudKit, and never uses it for advertising, marketing or anything other than your
            own health and fitness tracking. You can stop it at any time in your phone's Health
            settings, or in ConjureOS under Settings, Manage apps.
          </p>

          <h3>Who processes it</h3>
          <p>
            AI requests go through ConjureOS. By default they are sent to{" "}
            <strong>Anthropic</strong>, our AI provider, which processes them to produce the
            answer and, under its commercial terms, does not train its models on them. If you
            have added your own AI provider key in ConjureOS Settings, requests go to that
            provider instead, under your own agreement with them. We do not disclose your health
            data to anyone else, except where the law requires it.
          </p>

          <h3>Your choices and rights</h3>
          <ul className="consent-list">
            <li>
              Conjure Health collects nothing until you agree on its first screen. You can
              withdraw that agreement at any time in Settings, under Privacy, and collection
              stops at once.
            </li>
            <li>
              Find patterns and your health coach send nothing you have logged until you agree to
              that separately. Before anything is sent, you are shown exactly what would be sent
              and can decline, and you are asked again whenever that changes.
            </li>
            <li>
              The free-text note on a symptom is a separate choice, off unless you turn it on.
              Then only Find patterns sends it, once, with the question that asked for it.
            </li>
            <li>
              You can withdraw that agreement at any time in Settings, under Privacy. Future
              analysis stops immediately. Withdrawing cannot recall something already sent.
            </li>
            <li>
              You can delete your journal, all of it or one kind at a time, in Settings, under
              Reset health data. Deleting is permanent.
            </li>
            <li>
              To ask what we hold about you, get a copy of it, or delete it along with your
              ConjureOS account, email{" "}
              <a href="mailto:abuse@conjureos.com">abuse@conjureos.com</a>. We answer within 45
              days. If we turn down a request, reply to ask us to reconsider; if you live in
              Washington and still disagree, you can contact the Washington State Attorney
              General.
            </li>
          </ul>

          <h3>If something goes wrong</h3>
          <p>
            If health data is ever exposed to someone who should not have it, we will tell you
            and any regulator we are required to notify.
          </p>

          <h3>Contact</h3>
          <p>
            ConjureOS LLC, Ohio, USA.{" "}
            <a href="mailto:abuse@conjureos.com">abuse@conjureos.com</a>. This page sits
            alongside the ConjureOS{" "}
            <a href="https://www.conjureos.com/privacy.html" target="_blank" rel="noreferrer">
              privacy policy
            </a>
            , which covers your ConjureOS account as a whole.
          </p>
        </div>

        <footer className="sheet-foot">
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
