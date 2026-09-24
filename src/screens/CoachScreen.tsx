import { Fragment, useEffect, useRef, useState } from "react";
import type { Plan } from "../types";
import { aiErrorMessage, type ChatMessage } from "../bridge/ai";
import { readJson, writeJson } from "../bridge/vfs";
import { buildCoachContext } from "../features/coach/context";
import { coachChat } from "../features/coach/coach";
import type { CoachChatItem, CoachContext, CoachProposal } from "../features/coach/model";

const CHAT_PATH = "coach-chat.json";
const MAX_STORED = 40;
/** How many proposals the coach may show in one change episode (initial + one
 *  follow-up). Past this, a returned proposal is dropped and it must apply/drop. */
const MAX_PROPOSAL_ROUNDS = 2;

/**
 * Chat with your trainer — the app-wide coach surface. The coach sees the
 * user's real data (context.ts) + its memory and replies in character. When it
 * wants to change the plan it ASKS first: a proposal renders as choice chips +
 * a free-text box (accept / modify / decline), exactly like the app's own
 * prompts; the answer goes back and the coach applies the change (or asks one
 * follow-up). History persists to the VFS so the relationship feels continuous.
 */
export function CoachScreen({
  onPlanChange,
  initialPrompt,
}: {
  onPlanChange: (plan: Plan) => void;
  /** A question submitted from the Plan tab's coach launcher — sent once on
   *  mount so the user lands in an already-started conversation. */
  initialPrompt?: string | null;
}) {
  const [messages, setMessages] = useState<CoachChatItem[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  // Live answer state for the one active (last, unanswered) proposal card.
  const [picks, setPicks] = useState<string[]>([]);
  const [otherText, setOtherText] = useState("");
  const ctxRef = useRef<CoachContext | null>(null);
  const busyRef = useRef(false);
  const sentInitialRef = useRef(false);
  // Consecutive proposals shown this episode; caps the coach's follow-ups.
  const roundRef = useRef(0);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [history, ctx] = await Promise.all([readJson<CoachChatItem[]>(CHAT_PATH, []), buildCoachContext()]);
      if (!alive) return;
      ctxRef.current = ctx;
      const base = Array.isArray(history) ? history : [];
      setMessages(base);
      const q = initialPrompt?.trim();
      if (q && !sentInitialRef.current) {
        sentInitialRef.current = true;
        void runTurn(q, base, false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, busy]);

  // The AI sees plain role/content; a proposal item carries its question +
  // options along so the coach remembers what it asked.
  const toChatMessages = (items: CoachChatItem[]): ChatMessage[] =>
    items.map((m) => ({
      role: m.role,
      content: m.proposal
        ? `${m.content ? `${m.content}\n\n` : ""}${m.proposal.question}\nOptions: ${m.proposal.options
            .map((o) => o.label)
            .join(" / ")}`
        : m.content,
    }));

  const lastPendingProposal = (items: CoachChatItem[]): boolean => {
    const last = items[items.length - 1];
    return Boolean(last?.proposal && !last.answered);
  };

  // Lock the trailing proposal card once it's been answered.
  const markAnswered = (items: CoachChatItem[]): CoachChatItem[] =>
    items.map((m, i) => (i === items.length - 1 && m.proposal && !m.answered ? { ...m, answered: true } : m));

  /**
   * Run one turn: append the user's text, ask the coach, append its reply
   * (which may itself be a proposal), applying a plan update if one came back.
   * `answering` = this text answers a pending proposal (only then may a change
   * apply). Shared by the input row, the proposal card, and the mount auto-send.
   */
  const runTurn = async (text: string, base: CoachChatItem[], answering: boolean) => {
    const t = text.trim();
    if (!t || busyRef.current) return;
    const grounded = answering ? markAnswered(base) : base;
    const withUser: CoachChatItem[] = [...grounded, { role: "user", content: t }];
    setMessages(withUser);
    setPicks([]);
    setOtherText("");
    busyRef.current = true;
    setBusy(true);
    // A fresh (non-answering) message starts a new change episode.
    if (!answering) roundRef.current = 0;
    try {
      const ctx = ctxRef.current ?? (await buildCoachContext());
      const outcome = await coachChat(toChatMessages(withUser), ctx, {
        answering,
        canPropose: roundRef.current < MAX_PROPOSAL_ROUNDS,
      });
      if (outcome.planUpdate) {
        onPlanChange(outcome.planUpdate.plan);
        ctxRef.current = await buildCoachContext();
      }
      const assistant: CoachChatItem = {
        role: "assistant",
        content: outcome.reply,
        ...(outcome.proposal ? { proposal: outcome.proposal } : {}),
      };
      roundRef.current = outcome.proposal ? roundRef.current + 1 : 0;
      const next = [...withUser, assistant];
      setMessages(next);
      await writeJson(CHAT_PATH, next.slice(-MAX_STORED));
    } catch (err) {
      setMessages([
        ...withUser,
        { role: "assistant", content: aiErrorMessage(err, "Sorry — I couldn’t reach the AI service just now. Try again in a moment.") },
      ]);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  // Main input: a pending proposal makes a typed message the free-text answer.
  const send = () => {
    const text = draft.trim();
    if (!text || busy || messages == null) return;
    setDraft("");
    void runTurn(text, messages, lastPendingProposal(messages));
  };

  const togglePick = (label: string, type: CoachProposal["type"]) => {
    setPicks((prev) =>
      type === "single"
        ? [label]
        : prev.includes(label)
          ? prev.filter((l) => l !== label)
          : [...prev, label],
    );
  };

  const answerProposal = () => {
    if (messages == null || busy) return;
    const parts = [...picks];
    if (otherText.trim()) parts.push(otherText.trim());
    if (parts.length === 0) return;
    void runTurn(parts.join("; "), messages, true);
  };

  const declineProposal = () => {
    if (messages == null || busy) return;
    void runTurn("Leave my plan as it is for now.", messages, true);
  };

  if (messages == null) {
    return (
      <div className="center-fill">
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className="coach-screen">
      <div className="coach-thread">
        {messages.length === 0 && (
          <div className="coach-empty">
            <h2>Your coach</h2>
            <p className="muted">
              Ask anything — form checks, swaps, motivation, what to eat before a workout. Your coach can
              see your plan, food, weight, and workout history, and will ask before changing your program.
            </p>
            <div className="coach-suggestions">
              {["How am I doing this week?", "This plan feels too hard", "What should I focus on tomorrow?"].map(
                (s) => (
                  <button key={s} className="chip" onClick={() => setDraft(s)}>
                    {s}
                  </button>
                ),
              )}
            </div>
          </div>
        )}
        {messages.map((m, i) => {
          const activeProposal = m.proposal && !m.answered && i === messages.length - 1 && !busy;
          return (
            <Fragment key={i}>
              {m.content && <div className={`coach-msg ${m.role}`}>{m.content}</div>}
              {m.proposal &&
                (activeProposal ? (
                  <ProposalCard
                    proposal={m.proposal}
                    picks={picks}
                    otherText={otherText}
                    onToggle={(label) => togglePick(label, m.proposal!.type)}
                    onOther={setOtherText}
                    onSubmit={answerProposal}
                    onDecline={declineProposal}
                  />
                ) : (
                  <div className="coach-proposal done muted small">Asked: {m.proposal.question}</div>
                ))}
            </Fragment>
          );
        })}
        {busy && <div className="coach-msg assistant typing">…</div>}
        <div ref={endRef} />
      </div>

      <div className="coach-input-row">
        <textarea
          className="text-input coach-input"
          rows={1}
          value={draft}
          placeholder="Message your coach"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="btn primary" onClick={() => void send()} disabled={busy || !draft.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}

/** An interactive plan-change proposal — choice chips + free text + decline. */
function ProposalCard({
  proposal,
  picks,
  otherText,
  onToggle,
  onOther,
  onSubmit,
  onDecline,
}: {
  proposal: CoachProposal;
  picks: string[];
  otherText: string;
  onToggle: (label: string) => void;
  onOther: (text: string) => void;
  onSubmit: () => void;
  onDecline: () => void;
}) {
  const canSubmit = picks.length > 0 || otherText.trim().length > 0;
  return (
    <div className="coach-proposal">
      {proposal.rationale && <p className="coach-proposal-why muted small">{proposal.rationale}</p>}
      <p className="coach-proposal-q">{proposal.question}</p>
      <div className="coach-proposal-opts">
        {proposal.options.map((o) => (
          <button
            key={o.label}
            className={`chip${picks.includes(o.label) ? " selected" : ""}`}
            onClick={() => onToggle(o.label)}
          >
            {o.label}
          </button>
        ))}
      </div>
      <textarea
        className="text-input coach-proposal-other"
        rows={1}
        value={otherText}
        placeholder={proposal.type === "multi" ? "…or add your own" : "…or tell me something different"}
        onChange={(e) => onOther(e.target.value)}
      />
      <div className="coach-proposal-actions">
        <button className="link-btn" onClick={onDecline}>
          Leave it as is
        </button>
        <button className="btn primary" disabled={!canSubmit} onClick={onSubmit}>
          Send to coach
        </button>
      </div>
    </div>
  );
}
