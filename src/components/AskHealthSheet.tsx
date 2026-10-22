/**
 * The Ask Health conversation, as a sheet.
 *
 * Opened by asking from the home card, or by "Find patterns" in the journal:
 * the new question is already in flight when the sheet appears, below the
 * whole prior history, so a question always lands somewhere with continuity
 * rather than in a fresh empty box.
 *
 * Reuses the `.sheet*` chrome (bottom sheet on a phone, centred and capped on a
 * wide screen) and the shared scroll lock, which is what stops an iOS drag from
 * rubber-banding the page behind it.
 *
 * Withdrawn consent means withdrawn consent (owner decision 2026-10-22,
 * ConjureOS #1163). When the agreement goes, here or on another device, the
 * sheet lets go of the whole conversation, sends no follow-up, and keeps
 * nothing of an answer that was still on its way, on screen or on disk. An
 * answer that lands after the person withdrew consent to keep health data is
 * not saved either.
 */

import { useEffect, useRef, useState } from "react";
import { askAndAppend, loadAskHistory, saveAskHistory, type AskChatItem, type AskFrom } from "../features/ask/ask";
import { aiConsentGeneration, onAiConsentWithdrawn } from "../features/aiConsent";
import { healthConsentGeneration } from "../features/healthConsent";
import { useScrollLock } from "../hooks/useScrollLock";
import { CloseIcon } from "./icons";

export function AskHealthSheet({
  /** Question to send on open. Null when the sheet is opened to read back. */
  initialQuestion,
  /**
   * The entry point that opened the sheet. Its opening question and every
   * follow-up typed here are asked from it, because what goes out with a
   * question depends on where it was asked (features/ask/ask.ts).
   * Required, so a new caller has to choose.
   */
  from,
  onClose,
}: {
  initialQuestion: string | null;
  from: AskFrom;
  onClose: () => void;
}) {
  useScrollLock();
  const [items, setItems] = useState<AskChatItem[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  // Strict mode mounts effects twice; without this the opening question is
  // asked (and billed) twice.
  const sentRef = useRef(false);
  const busyRef = useRef(false);
  // The agreement went while the sheet was open: nothing held, nothing sent.
  const [gone, setGone] = useState(false);
  const goneRef = useRef(false);

  const letGo = () => {
    goneRef.current = true;
    setGone(true);
    setItems([]);
    setDraft("");
  };

  useEffect(() => onAiConsentWithdrawn(letGo), []);

  const send = async (question: string, base: AskChatItem[]) => {
    if (busyRef.current || goneRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const asked = aiConsentGeneration();
    // The agreement to keep health data this question was asked under: an
    // answer that lands after it was withdrawn is not saved (saveAskHistory).
    const collecting = healthConsentGeneration();
    const withReply = await askAndAppend(question, base, from, (shown) => {
      if (asked === aiConsentGeneration()) setItems(shown);
    });
    busyRef.current = false;
    setBusy(false);
    // Nothing to keep: no agreement in force, or it was withdrawn while the
    // question was out. This runs with the sheet closed as well, so the
    // answer is not saved where a later conversation would find it.
    if (withReply === null || asked !== aiConsentGeneration()) {
      letGo();
      return;
    }
    setItems(withReply);
    await saveAskHistory(withReply, collecting);
  };

  useEffect(() => {
    let alive = true;
    void (async () => {
      const asked = aiConsentGeneration();
      const history = await loadAskHistory();
      // A withdrawal while it was read: what came back is not to be shown.
      if (!alive || goneRef.current || asked !== aiConsentGeneration()) return;
      setItems(history);
      const q = initialQuestion?.trim();
      if (q && !sentRef.current) {
        sentRef.current = true;
        void send(q, history);
      }
    })();
    return () => {
      alive = false;
    };
    // Mount only: re-running would re-send the opening question.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the newest turn in view as it arrives.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [items, busy]);

  const submit = () => {
    const q = draft.trim();
    if (!q || busy || gone) return;
    setDraft("");
    void send(q, items ?? []);
  };

  const empty = items !== null && items.length === 0 && !busy && !gone;

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label="Ask Health" onClick={onClose}>
      <div className="sheet chat-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>Ask Health</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon size={18} />
          </button>
        </div>

        <div className="sheet-body chat-body">
          {items === null && !gone && <div className="muted small">Loading…</div>}
          {gone && (
            <div className="muted small chat-empty" role="status">
              {AGREEMENT_GONE}
            </div>
          )}
          {empty && (
            <div className="muted small chat-empty">
              Ask anything about what you have logged. Your questions and answers show up here.
            </div>
          )}
          {items?.map((m, n) => (
            <div key={n} className={`chat-bubble ${m.role}`}>
              {m.content}
            </div>
          ))}
          {busy && (
            <div className="chat-bubble assistant thinking" aria-live="polite">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </div>
          )}
          <div ref={endRef} />
        </div>

        <div className="sheet-foot chat-foot">
          <input
            className="text-input"
            aria-label="Ask a follow-up"
            placeholder="Ask a follow-up…"
            value={draft}
            disabled={gone}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
          <button className="btn primary chat-send" disabled={busy || gone || !draft.trim()} onClick={submit}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Shown in place of the conversation once the agreement is gone. True whether
 * the question went out before the withdrawal (its answer was thrown away) or
 * never went at all.
 */
export const AGREEMENT_GONE =
  "Ask Health sends nothing without your agreement, and none is on file. This conversation is cleared. To agree again, close this and ask.";
