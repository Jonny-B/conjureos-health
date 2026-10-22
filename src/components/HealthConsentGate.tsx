/**
 * The first screen for anyone who has not agreed to health data collection.
 * Nothing is stored, and no other app can write here, until they agree.
 * Rules and storage: features/healthConsent.ts.
 *
 * It is also where a withdrawal lands, at once and whatever its save does, so
 * nothing that collects stays mounted behind Settings. When that save failed,
 * this screen says so and offers a retry (ConjureOS #1156 review).
 */

import { useState } from "react";
import { HealthDataPolicy } from "./HealthDataPolicy";
import {
  CONSENT_APP_NAME,
  CONSENT_BODY,
  CONSENT_CHECKBOX,
  WITHDRAW_NOT_SAVED,
} from "../features/healthConsentCopy";

export function HealthConsentGate({
  onAgree,
  withdrawalNotSaved = false,
  onRetryWithdrawal,
}: {
  onAgree: () => void;
  /** A withdrawal in this session could not clear the stored agreement. */
  withdrawalNotSaved?: boolean;
  /** Save that withdrawal again. */
  onRetryWithdrawal?: () => Promise<unknown>;
}) {
  const [checked, setChecked] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const retry = async () => {
    if (!onRetryWithdrawal || retrying) return;
    setRetrying(true);
    try {
      await onRetryWithdrawal();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="app">
      <main className="screen">
        <div className="mode-body disclaimer-card">
          {withdrawalNotSaved && (
            <>
              <div className="notice notice-error" role="alert">
                {WITHDRAW_NOT_SAVED}
              </div>
              {onRetryWithdrawal && (
                <button
                  type="button"
                  className="btn withdraw-retry"
                  disabled={retrying}
                  onClick={() => void retry()}
                >
                  {retrying ? "Withdrawing…" : "Try again"}
                </button>
              )}
            </>
          )}

          <div className="notice disclaimer-lead">
            <strong>Your health data in {CONSENT_APP_NAME}</strong>
          </div>

          {CONSENT_BODY.map((para) => (
            <p key={para} className="disclaimer-para">
              {para}
            </p>
          ))}

          <button type="button" className="btn small ghost" onClick={() => setPolicyOpen(true)}>
            Read the Consumer Health Data Privacy policy
          </button>

          <label className="consent-toggle">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => {
                setChecked(e.target.checked);
                setDeclined(false);
              }}
            />
            <span>{CONSENT_CHECKBOX}</span>
          </label>

          {declined && (
            <p className="muted small" role="status">
              Nothing has been saved. {CONSENT_APP_NAME} cannot keep a record for you without your
              agreement, so it stays on this screen until you agree. You can close the app.
            </p>
          )}

          <div className="disclaimer-actions">
            <button type="button" className="btn" onClick={() => setDeclined(true)}>
              Not now
            </button>
            {/* Not while a retry is clearing the file: agreeing then could
                race the clear and leave no agreement on file. */}
            <button type="button" className="btn primary" disabled={!checked || retrying} onClick={onAgree}>
              Agree and continue
            </button>
          </div>

          <p className="muted small">
            You can withdraw this agreement, and delete everything stored, at any time in Settings.
          </p>
        </div>
      </main>
      {policyOpen && <HealthDataPolicy onClose={() => setPolicyOpen(false)} />}
    </div>
  );
}
