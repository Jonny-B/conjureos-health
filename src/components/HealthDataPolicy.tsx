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
 * different things. And a material change to what the AI receives means
 * bumping `DISCLOSURE_VERSION`, which re-asks everyone rather than assuming
 * old agreement covers new wording.
 *
 * The "other apps" section (2026-09-28) did not bump it: that route isn't
 * authorized by the AI agreement at all but by ConjureOS's own prompt, per
 * app, before another app's request runs — so re-asking the AI question
 * would authorize nothing. Its lists must match bridge/actions.ts and
 * features/sharedSummary.ts.
 *
 * This is a plain-language policy written against how the app behaves. It is
 * not legal advice and has not been through counsel.
 */

import { DISCLOSURE_SENDS, DISCLOSURE_WITHHOLDS } from "../features/aiConsent";

/** Last material revision. Shown so a reader can tell what they agreed to. */
export const POLICY_UPDATED = "2026-09-30";

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
            you slept, how much you drank, symptoms you noticed, and exercise you did. Some
            privacy laws call this <strong>consumer health data</strong>. This page explains
            what happens to it.
          </p>
          <p>
            Conjure Health is made by ConjureOS LLC. It is not a doctor, a clinic, an insurer, or
            any other kind of healthcare provider, and it is not part of one. That means your entries here are
            not medical records and HIPAA does not apply to them. The protections described
            on this page are the ones we actually implement, not ones HIPAA imposes on us.
          </p>

          <h3>Where it lives</h3>
          <p>
            Your journal is stored on your device and in your own ConjureOS account, so it can
            follow you between devices you sign in on. Other people cannot see it, unless you
            let another app read it (below). ConjureOS LLC can access stored data only to run
            and secure the service, or when the law requires it. It is never sold, and it is
            never used for advertising or marketing, by us or by anyone we send it to.
          </p>

          <h3>When it leaves</h3>
          <p>
            Only when you use a feature that needs it. Nothing is sent on a schedule.
          </p>

          <h4>To an AI, when a feature needs one</h4>
          <ul className="consent-list">
            <li>
              <strong>Building or changing your plan</strong> sends your goal in your own words,
              the plan length, and, for a plan that tracks food, your height, weight, goal
              weight, age and sex.
            </li>
            <li>
              <strong>Logging food by describing it or with a photo</strong>, or reading a
              nutrition label or the front of a package, sends the words or the photo you gave
              it.
            </li>
          </ul>
          <p>
            <strong>Barcodes and food search</strong> look up the food in the shared ConjureOS
            food database, then in Open Food Facts and USDA FoodData Central. Only the barcode or
            the search words are sent, nothing about you. If you add a food to the shared
            database, it is linked to your account so we can stop abuse; other people can find
            the food, but never see who added it.
          </p>

          <h4>To an AI, when you ask it about your journal</h4>
          <p>
            Two features send part of your journal to an AI: <strong>Find patterns</strong> on
            the Journal tab, which looks for things that go together, and asking the coach from{" "}
            <strong>Ask about food</strong>. They run only when you press the button, and only
            after you have agreed to what they send.
          </p>
          <p>The AI receives:</p>
          <ul className="consent-list">
            {DISCLOSURE_SENDS.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p>It does not receive:</p>
          <ul className="consent-list withheld">
            {DISCLOSURE_WITHHOLDS.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>

          <h4>To other apps on ConjureOS, when you allow them</h4>
          <p>
            Other apps you install on ConjureOS, and ConjureOS's own assistant, can ask Conjure
            Health for your data or add to it: a recipe app checking how many calories you
            have left, say, or a fitness app adding a run. ConjureOS asks you before another
            app's request goes through, and you choose to allow it once, always, or not at
            all. ConjureOS's assistant acts when you ask it to. To answer, ConjureOS may start
            Conjure Health in the background.
          </p>
          <p>What they can read:</p>
          <ul className="consent-list">
            <li>What you ate: foods, calories, protein, carbs and fat, and your daily targets</li>
            <li>Your exercise, water and sleep totals, and your weigh-ins</li>
            <li>Symptoms you logged, with the severity and time</li>
            <li>
              A short summary of your food, water and exercise for the last 14 days, which
              ConjureOS reads to answer a question when nothing else fits
            </li>
          </ul>
          <p>What they never get:</p>
          <ul className="consent-list withheld">
            <li>The free-text notes on your symptoms and sleep</li>
            <li>Your profile, your plan's details, or your AI agreement</li>
            <li>Why you have no calorie target, if you don't have one</li>
          </ul>
          <p>
            They can add entries (a food, a drink, a workout), correct them, and remove one entry
            at a time. They cannot change your targets or plan, and cannot clear a history.
            Once another app has your data, what it does with it is up to that app and its
            own policy.
          </p>

          <h3>Who processes it</h3>
          <p>
            AI requests go through ConjureOS. By default they are sent to{" "}
            <strong>Anthropic</strong>, our AI provider, which processes them to produce the
            answer and, under its commercial terms, does not train its models on them. If you
            have added your own AI provider key in ConjureOS Settings, requests go to that
            provider instead, under your own agreement with them. Apart from that and the other
            apps you allow, above, we do not disclose your health data to anyone, except where
            the law requires it.
          </p>

          <h3>Your choices and rights</h3>
          <ul className="consent-list">
            <li>
              Nothing from your journal goes to the AI until you agree to it. The first time
              you press Find patterns or ask the coach, you are shown exactly what would be
              sent and can decline.
            </li>
            <li>
              Other apps get nothing until you allow them. You can turn app-to-app connections
              off entirely in ConjureOS Settings → Apps.
            </li>
            <li>
              The free-text note on a symptom is a separate choice, off unless you turn it on.
            </li>
            <li>
              You can withdraw your agreement at any time in Settings → Privacy. Future
              analysis stops immediately. Withdrawing cannot recall something already sent.
            </li>
            <li>
              You can delete your journal, all of it or one kind at a time, in Settings →
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
            and any regulator we are required to notify. Report a concern from Settings, or
            through your ConjureOS account.
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
