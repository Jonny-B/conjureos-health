/**
 * The one-time gate in front of every feature that sends anything to the AI.
 * One agreement covers them all (features/aiConsent.ts, `AI_FEATURES`), so
 * the sheet names them all and its list says what each sends. Only the agree
 * button follows the caller (`purpose`), so a person who asked a question
 * agrees to "Send and ask", not to a plan they never asked for.
 *
 * The introduction, the feature names, the withdraw line and the button are
 * not part of the versioned DISCLOSURE_* wording; the lists are. Version 3
 * (2026-10-29, ConjureOS #1163) widened both: building a plan, adding food
 * from a description or a photo, and the estimates other apps ask for are
 * behind the agreement, where they used to send without it.
 *
 * Sending health data to a third party, so the user gets told exactly what
 * travels before any of it does, including a real sample line, because a
 * description of a disclosure is easier to nod past than the thing itself.
 *
 * Two decisions, deliberately separate: the accept, and whether free-text
 * symptom notes ride along. The second defaults to off and stays off unless
 * they tick it. Bundling it into the main accept would be exactly the kind
 * of all-or-nothing consent the health-privacy statutes exist to stop.
 */

import { useState } from "react";
import {
  AI_FEATURES,
  DISCLOSURE_SAMPLE,
  DISCLOSURE_SENDS,
  DISCLOSURE_WITHHOLDS,
} from "../features/aiConsent";

/**
 * Which feature opened the sheet: it names the agree button. Those that send
 * the moment the person agrees say so; Add food's AI mode only turns on.
 */
export type AiConsentPurpose = "patterns" | "ask" | "plan" | "package" | "food";

const AGREE_LABEL: Record<AiConsentPurpose, string> = {
  patterns: "Send and find patterns",
  ask: "Send and ask",
  plan: "Send and build my plan",
  package: "Send and read",
  food: "Agree",
};

export function AiConsentSheet({
  purpose,
  onAccept,
  onCancel,
}: {
  purpose: AiConsentPurpose;
  /** Called with the notes opt-in. Owner persists it, then sends. */
  onAccept: (includeNotes: boolean) => void;
  onCancel: () => void;
}) {
  const [includeNotes, setIncludeNotes] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <div className="sheet-backdrop" onClick={onCancel}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2>Before anything goes to the AI</h2>
        </header>

        <div className="sheet-body">
          <p className="muted small">
            These features send what they need to an AI service outside this app. They only
            send when you use them, never in the background. One agreement covers all of them.
          </p>
          <ul className="consent-list consent-features">
            {AI_FEATURES.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>

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

          <div className="section-label">A day from your journal, as Find patterns sends it</div>
          <pre className="consent-sample">{DISCLOSURE_SAMPLE}</pre>

          <label className="consent-toggle">
            <input
              type="checkbox"
              checked={includeNotes}
              onChange={(e) => setIncludeNotes(e.target.checked)}
            />
            <span>
              Also send the notes I type on symptoms.
              <span className="muted small"> Off by default. You can change this in Settings.</span>
            </span>
          </label>

          <p className="muted small">
            You can withdraw this at any time in Settings, under Privacy. Withdrawing stops all
            of them sending anything more, and to use them again you agree again. It cannot
            pull back what was already sent.
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
            {AGREE_LABEL[purpose]}
          </button>
        </footer>
      </div>
    </div>
  );
}
