/**
 * The one-time gate in front of the health coach and "Find patterns".
 *
 * Both send what the user logged to an AI service, which is health data going
 * to a third party, so the user gets told exactly what travels before any of
 * it does, including real sample lines, because a description of a disclosure
 * is easier to nod past than the thing itself.
 *
 * Two decisions, deliberately separate: the accept, and whether free-text
 * symptom notes ride along. The second defaults to off and stays off unless
 * they tick it — bundling it into the main accept would be exactly the kind
 * of all-or-nothing consent the health-privacy statutes exist to stop.
 */

import { useState } from "react";
import { createPortal } from "react-dom";
import { useScrollLock } from "../hooks/useScrollLock";
import {
  DISCLOSURE_COACH_SAMPLE,
  DISCLOSURE_SAMPLE,
  DISCLOSURE_SENDS,
  DISCLOSURE_WITHHOLDS,
} from "../features/aiConsent";

export function AiConsentSheet({
  onAccept,
  onCancel,
  acceptLabel = "Agree and continue",
}: {
  /** Called with the notes opt-in. Owner persists it, then runs the analysis. */
  onAccept: (includeNotes: boolean) => void;
  onCancel: () => void;
  /** The accept button, named for what pressing it does from where the sheet
   *  was opened ("Send and find patterns", "Agree and ask"). */
  acceptLabel?: string;
}) {
  const [includeNotes, setIncludeNotes] = useState(false);
  const [busy, setBusy] = useState(false);
  useScrollLock();

  // Portaled to <body> so no transformed or clipped ancestor can crop the sheet
  // or hide its footer buttons on a phone.
  return createPortal(
    <div className="sheet-backdrop" onClick={onCancel}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2>Before the AI reads your health data</h2>
        </header>

        <div className="sheet-body">
          <p className="muted small">
            Asking your health coach or finding patterns sends part of what you log to an AI
            service outside this app. It only happens when you ask, never in the background.
          </p>

          <div className="section-label">What gets sent</div>
          <ul className="consent-list">
            {DISCLOSURE_SENDS.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>

          <div className="section-label">What does not</div>
          <ul className="consent-list withheld">
            {DISCLOSURE_WITHHOLDS.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>

          <div className="section-label">One day sent by Find patterns looks like this</div>
          <pre className="consent-sample">{DISCLOSURE_SAMPLE}</pre>

          <div className="section-label">The coach's summary includes lines like these</div>
          <pre className="consent-sample">{DISCLOSURE_COACH_SAMPLE}</pre>

          <label className="consent-toggle">
            <input
              type="checkbox"
              checked={includeNotes}
              onChange={(e) => setIncludeNotes(e.target.checked)}
            />
            <span>
              When finding patterns, also send the notes I type on symptoms.
              <span className="muted small"> Off by default. You can change this in Settings.</span>
            </span>
          </label>

          <p className="muted small">
            You can withdraw this at any time in Settings, under Privacy. Withdrawing stops
            future analysis; it cannot pull back what was already sent.
          </p>
        </div>

        <footer className="sheet-foot consent-foot">
          <button className="btn ghost" onClick={onCancel} disabled={busy}>
            Not now
          </button>
          <button
            className="btn primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              onAccept(includeNotes);
            }}
          >
            {acceptLabel}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
