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
 */

import { useEffect, useRef, useState } from "react";
import { askAndAppend, loadAskHistory, saveAskHistory, type AskChatItem, type AskFrom } from "../features/ask/ask";
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

  const send = async (question: string, base: AskChatItem[]) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const withReply = await askAndAppend(question, base, from, setItems);
    setItems(withReply);
    await saveAskHistory(withReply);
    busyRef.current = false;
    setBusy(false);
  };

  useEffect(() => {
    let alive = true;
    void (async () => {
      const history = await loadAskHistory();
      if (!alive) return;
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
    if (!q || busy) return;
    setDraft("");
    void send(q, items ?? []);
  };

  const empty = items !== null && items.length === 0 && !busy;

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
          {items === null && <div className="muted small">Loading…</div>}
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
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
          <button className="btn primary chat-send" disabled={busy || !draft.trim()} onClick={submit}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
