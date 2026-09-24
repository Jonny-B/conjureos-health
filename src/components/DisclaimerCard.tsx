/**
 * Safety layer 5 (surface 1 of 3) — the first-run liability card.
 *
 * Shown before the plan wizard can proceed. It is presentational: it renders
 * the "not medical advice" language and an explicit "I understand" action, then
 * calls `onAccept`. The parent owns building the LiabilityAck (timestamp + app
 * version) that lands on `plan.json.liability` — keeping the audit record where
 * the plan is persisted, not in the component.
 *
 * The other two disclaimer surfaces (plan-review inline, persistent coach
 * footer) reuse the same copy constants below so all three stay in sync.
 */

import { AlertTriangle } from "./icons";

/** Single source of truth for disclaimer copy across all three surfaces. */
export const DISCLAIMER_HEADLINE = "Read this before we build your plan";

/** The full disclaimer, one paragraph per entry. Legal copy — change it in
 *  one place and every surface follows. */
export const DISCLAIMER_BODY = [
  "Conjure Health creates general fitness and nutrition suggestions. It is not medical advice, diagnosis, or treatment, and it does not replace a doctor, dietitian, or physical therapist.",
  "Talk to a healthcare professional before starting a new exercise or eating plan, especially if you have a health condition, an injury, are pregnant, or take medication.",
  "Stop and seek help if you feel chest pain, shortness of breath, dizziness, or any symptom that worries you. You are always in control; skip anything that doesn't feel right.",
];

/** Short one-liner reused on the plan-review surface and the coach footer. */
export const DISCLAIMER_SHORT =
  "General guidance, not medical advice. Check with a professional and stop if anything hurts.";

interface Props {
  /** Fired when the user taps "I understand". Parent stamps the LiabilityAck. */
  onAccept: () => void;
  /** Optional back/decline affordance (returns the user to the previous step). */
  onDecline?: () => void;
}

/**
 * The blocking liability gate shown before a plan is generated. The parent
 * stamps a `LiabilityAck` on accept — the plan must not be built until it does.
 */
export function DisclaimerCard({ onAccept, onDecline }: Props) {
  return (
    <div className="mode-body disclaimer-card">
      <div className="notice notice-error disclaimer-lead">
        <span className="disclaimer-icon" aria-hidden="true">
          <AlertTriangle />
        </span>
        <strong>{DISCLAIMER_HEADLINE}</strong>
      </div>

      {DISCLAIMER_BODY.map((para, i) => (
        <p key={i} className="disclaimer-para">
          {para}
        </p>
      ))}

      <div className="disclaimer-actions">
        {onDecline && (
          <button type="button" className="btn" onClick={onDecline}>
            Not now
          </button>
        )}
        <button type="button" className="btn primary" onClick={onAccept}>
          I understand
        </button>
      </div>
    </div>
  );
}
