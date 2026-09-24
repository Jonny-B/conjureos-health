/**
 * "Ask about food" — the home-screen entry point to the nutrition Q&A.
 *
 * The rotating suggestions are the whole point of the card: an empty box with a
 * cursor teaches nobody what to type, so the placeholder cycles real questions
 * until the user engages with the field, then holds still so it can't change
 * under them mid-thought.
 *
 * This is the ONLY entry point to the coach that had no consent check at all
 * — "Find patterns" in the journal gates on `AiConsentSheet` before it ever
 * discloses anything, this card did not. Same gate here now, same components,
 * because a second consent UI would just be a second place for the wording to
 * drift from the first. `askCoach` itself refuses to send personal context
 * without consent either way (see features/coach/ask.ts) — this check is what
 * gives the user the CHANCE to say yes, not a backstop against leaking if
 * they say no.
 */

import { useEffect, useRef, useState } from "react";
import { ASK_SUGGESTIONS } from "../features/coach/ask";
import { hasAiJournalConsent, recordAiJournalConsent } from "../features/aiConsent";
import { AiConsentSheet } from "./AiConsentSheet";
import { CoachIcon } from "./icons";

/** How long each suggestion stays up. Slow enough to finish reading one,
 *  quick enough that a second is seen before attention moves on. */
const ROTATE_MS = 3600;

export function AskCoachCard({ onAsk }: { onAsk: (question: string) => void }) {
  const [draft, setDraft] = useState("");
  const [i, setI] = useState(0);
  const [engaged, setEngaged] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // A question asked before consent is on file, parked here while the sheet
  // shows. Set only long enough to either fire on accept or drop on cancel —
  // this is not a second history, just a one-question waiting room.
  const [pending, setPending] = useState<string | null>(null);

  /**
   * Gate every question through the same consent check as "Find patterns",
   * whether it came from the input or from tapping the rotating suggestion.
   * Asking is cheap to retry, so this fails toward "ask again" rather than
   * caching a stale answer to "has the user agreed".
   */
  const ask = (question: string) => {
    void (async () => {
      if (await hasAiJournalConsent()) onAsk(question);
      else setPending(question);
    })();
  };

  // Freeze the carousel once the field is focused or has text — a placeholder
  // swapping while someone is typing reads as a glitch.
  const rotating = !engaged && draft === "";
  useEffect(() => {
    if (!rotating) return;
    const t = window.setInterval(() => setI((n) => (n + 1) % ASK_SUGGESTIONS.length), ROTATE_MS);
    return () => window.clearInterval(t);
  }, [rotating]);

  const submit = () => {
    const q = draft.trim();
    if (!q) return;
    setDraft("");
    setEngaged(false);
    inputRef.current?.blur();
    ask(q);
  };

  // An untouched field offers the visible suggestion as a one-tap question.
  const suggestion = ASK_SUGGESTIONS[i] ?? ASK_SUGGESTIONS[0]!;

  return (
    <>
      <section className="home-card ask-card" aria-label="Ask about food">
        <div className="home-card-head">
          <span className="home-card-title">
            <CoachIcon size={16} /> Ask about food
          </span>
        </div>

        <div className="ask-row">
          <input
            ref={inputRef}
            className="text-input ask-input"
            aria-label="Ask a question about food"
            value={draft}
            placeholder={suggestion}
            onFocus={() => setEngaged(true)}
            onBlur={() => setEngaged(draft !== "")}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
          <button
            className="btn primary ask-send"
            // With nothing typed the button asks whatever is on screen, so the
            // suggestions are usable rather than decorative.
            onClick={() => (draft.trim() ? submit() : ask(suggestion))}
          >
            Ask
          </button>
        </div>

        <div className="muted small ask-hint">
          Nutrition questions, answered. Your plan and diary stay untouched.
        </div>
      </section>
      {pending !== null && (
        <AiConsentSheet
          onCancel={() => setPending(null)}
          onAccept={async (includeNotes) => {
            // Persist BEFORE disclosing — same contract as JournalScreen's
            // gate. An agreement that survives only in memory is not a
            // record, so a write failure must not still let the question through.
            const stored = await recordAiJournalConsent(includeNotes);
            const q = pending;
            setPending(null);
            if (stored && q) onAsk(q);
          }}
        />
      )}
    </>
  );
}
