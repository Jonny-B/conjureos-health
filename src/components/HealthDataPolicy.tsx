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
 * This is a plain-language policy written against how the app behaves. It is
 * not legal advice and has not been through counsel.
 */

import { DISCLOSURE_SENDS, DISCLOSURE_WITHHOLDS } from "../features/aiConsent";

/** Last material revision. Shown so a reader can tell what they agreed to. */
export const POLICY_UPDATED = "2026-09-04";

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
            you slept, how much you drank, symptoms you noticed, and workouts you did. Some
            privacy laws call this <strong>consumer health data</strong>. This page explains
            what happens to it.
          </p>
          <p>
            Conjure Health is not a doctor, a clinic, an insurer, or any other kind of
            healthcare provider, and it is not part of one. That means your entries here are
            not medical records and HIPAA does not apply to them. The protections described
            on this page are the ones we actually implement, not ones HIPAA imposes on us.
          </p>

          <h3>Where it lives</h3>
          <p>
            Your journal is stored on your device and in your own ConjureOS account, so it can
            follow you between devices you sign in on. Nobody else can read it there. It is
            never sold, and it is never used for advertising or marketing — not by us, and not
            by anyone we send it to.
          </p>

          <h3>When it leaves</h3>
          <p>
            One feature sends part of your journal outside the app: <strong>Find patterns</strong>{" "}
            on the Journal tab, which asks an AI to look for things that go together. It runs
            only when you press the button. Nothing is sent on a schedule, in the background,
            or while the app is closed.
          </p>
          <p>The AI receives, for the range you asked about:</p>
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

          <h3>Who processes it</h3>
          <p>
            The request goes through ConjureOS, which routes it to{" "}
            <strong>Anthropic</strong> as the AI provider. Anthropic processes it to produce
            the answer and does not use commercial API data to train its models. They are the
            only third party your journal is disclosed to.
          </p>

          <h3>Your choices</h3>
          <ul className="consent-list">
            <li>
              Nothing is sent until you agree to it. The first time you press Find patterns,
              you are shown exactly what would be sent and can decline.
            </li>
            <li>
              The free-text note on a symptom is a separate choice, off unless you turn it on.
            </li>
            <li>
              You can withdraw your agreement at any time in Settings → Privacy. Future
              analysis stops immediately. Withdrawing cannot recall something already sent.
            </li>
            <li>
              You can delete your journal — all of it, or one kind at a time — in Settings →
              Reset health data. Deleting is permanent.
            </li>
          </ul>

          <h3>If something goes wrong</h3>
          <p>
            If health data is ever exposed to someone who should not have it, we will tell you
            and any regulator we are required to notify. Report a concern from Settings, or
            through your ConjureOS account.
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
