/**
 * The AI agreement, for a screen with a feature that sends to the AI: building
 * a plan, adding food from a description or a photo, reading package photos.
 *
 * Owner decision, 2026-10-29 (ConjureOS #1163): every such feature needs the
 * agreement, and a withdrawal stops it until the person agrees again. This is
 * what gives the person the CHANCE to agree, in place, before anything goes:
 * `withAgreement(send)` runs `send` at once when the agreement is in force,
 * and otherwise shows the consent sheet (`sheet`, which the screen renders)
 * and runs it only after the agreement is saved. The gate itself is
 * features/aiGate.ts, which refuses to send without one either way; this is
 * not the backstop.
 *
 * `agreed` is null while the first read is out, then follows the agreement:
 * false the moment it is withdrawn in this session, true once the person
 * agrees here. A screen whose feature is off without it reads this.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  aiConsentGeneration,
  hasAiJournalConsent,
  onAiConsentWithdrawn,
  recordAiJournalConsent,
} from "../features/aiConsent";
import { AiConsentSheet, type AiConsentPurpose } from "./AiConsentSheet";

export interface AiAgreement {
  /** Null until read; then whether the agreement is in force. */
  agreed: boolean | null;
  /** Run `send` under the agreement, asking for it first when there is none. */
  withAgreement: (send?: () => void) => void;
  /** The gate said no after all (withdrawn on another device): show it off. */
  lost: () => void;
  /** The consent sheet while it is up. Render it. */
  sheet: ReactNode;
  /** The person agreed, but the agreement could not be saved, so nothing was sent. */
  notSaved: boolean;
}

export function useAiAgreement(purpose: AiConsentPurpose): AiAgreement {
  const [agreed, setAgreed] = useState<boolean | null>(null);
  // Set while the sheet is up: what to run once the person agrees.
  const [asking, setAsking] = useState<{ send?: () => void } | null>(null);
  const [notSaved, setNotSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    const at = aiConsentGeneration();
    void hasAiJournalConsent().then((ok) => {
      // An agreement or a withdrawal meanwhile has already said.
      if (alive && at === aiConsentGeneration()) setAgreed(ok);
    });
    const off = onAiConsentWithdrawn(() => {
      setAgreed(false);
      setAsking(null);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const withAgreement = useCallback((send?: () => void) => {
    setNotSaved(false);
    void (async () => {
      const ok = await hasAiJournalConsent();
      setAgreed(ok);
      if (ok) send?.();
      else setAsking({ send });
    })();
  }, []);

  const lost = useCallback(() => setAgreed(false), []);

  const sheet = asking ? (
    <AiConsentSheet
      purpose={purpose}
      onCancel={() => setAsking(null)}
      onAccept={async (includeNotes) => {
        // Saved BEFORE anything is sent: an agreement that survives only in
        // memory is not a record, so a failed save sends nothing.
        const stored = await recordAiJournalConsent(includeNotes);
        const send = asking.send;
        setAsking(null);
        setNotSaved(!stored);
        if (!stored) return;
        setAgreed(true);
        send?.();
      }}
    />
  ) : null;

  return { agreed, withAgreement, lost, sheet, notSaved };
}
