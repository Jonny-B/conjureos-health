import { useEffect, useState } from "react";
import type { Plan } from "../types";
import { getRepository } from "../data/repository";
import { persist } from "../data/saveFailure";
import { buildDayView } from "../features/diary";
import { buildCoachContext } from "../features/coach/context";
import { evaluateCheckin } from "../features/coach/coach";
import { dayQuestions } from "../features/coach/questions";
import type { CoachAnswer, CoachContext, CoachQuestion } from "../features/coach/model";
import { CoachCheckinForm } from "./CoachCheckinForm";
import { CloseIcon } from "./icons";

/**
 * End-of-day check-in — banner only (owner decision: no notifications). The
 * banner appears in the evening above the Today tracker until the day is
 * checked in (or dismissed for the session); tapping it opens a sheet with 3–4
 * coach-picked questions from the day's data. Submitting saves the check-in on
 * the day's log, feeds coach memory, and may apply a small plan tweak.
 */

/** Evening = 5pm onward; before that the banner stays out of the way. */
export const isEvening = (d = new Date()): boolean => d.getHours() >= 17;

/** Evening prompt above the Today tracker inviting an end-of-day check-in.
 *  Dismissible for the session; render only when {@link isEvening}. */
export function DayCheckinBanner({ onOpen, onDismiss }: { onOpen: () => void; onDismiss: () => void }) {
  return (
    <div className="setup-banner checkin-banner">
      <button className="setup-banner-main" onClick={onOpen}>
        <span className="setup-banner-text">How did your day go? Check in with your coach</span>
        <span className="setup-banner-cta">Check in</span>
      </button>
      <button className="icon-btn setup-banner-x" aria-label="Dismiss" onClick={onDismiss}>
        <CloseIcon size={16} />
      </button>
    </div>
  );
}

/**
 * The end-of-day check-in sheet: 3-4 questions the coach picks from the day's
 * own data. Submitting writes the check-in to the day log, feeds coach memory,
 * and may apply a small plan tweak — which is why it takes `onPlanChange`.
 */
export function DayCheckinSheet({
  date,
  onClose,
  onComplete,
  onPlanChange,
}: {
  /** The day being checked in (today). */
  date: string;
  onClose: () => void;
  /** Called once the check-in has been saved (banner should go away). */
  onComplete: () => void;
  onPlanChange: (plan: Plan) => void;
}) {
  const [questions, setQuestions] = useState<CoachQuestion[] | null>(null);
  const [ctx, setCtx] = useState<CoachContext | null>(null);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<string | null>(null);
  const [planNote, setPlanNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const repo = await getRepository();
      const [context, entries, dayLog] = await Promise.all([
        buildCoachContext(),
        repo.listDiary(date).catch(() => []),
        repo.getDayLog(date).catch(() => null),
      ]);
      const total = buildDayView(date, entries).total;
      const done = new Set(dayLog?.goalsCompleted ?? []);
      const missedGoals = (context.plan?.goals ?? []).filter((g) => !done.has(g.id)).map((g) => g.label);
      const qs = await dayQuestions({ calories: total.calories, goal: context.goals.calories, missedGoals });
      if (!alive) return;
      setCtx(context);
      setQuestions(qs);
    })().catch(() => alive && onClose());
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  const submit = async (answers: CoachAnswer[]) => {
    if (!ctx || answers.length === 0) return onClose();
    setBusy(true);
    try {
      const repo = await getRepository();
      await persist(
        "your check-in",
        repo.saveDayLog(date, {
          checkin: { at: new Date().toISOString(), answers: answers.map((a) => ({ question: a.question, answer: a.value })) },
        }),
      );
      const outcome = await evaluateCheckin("day", answers, ctx);
      if (outcome.planUpdate) {
        onPlanChange(outcome.planUpdate.plan);
        setPlanNote(outcome.planUpdate.summary);
      }
      setReply(outcome.reply);
      onComplete();
    } catch {
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet checkin-sheet" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2>How did your day go?</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon size={20} />
          </button>
        </header>

        <div className="sheet-body">
          {reply != null ? (
            <>
              <div className="coach-reply-card">
                <div className="coach-reply-tag">Your coach</div>
                <p>{reply}</p>
                {planNote && <div className="coach-plan-note">✓ Plan updated: {planNote}</div>}
              </div>
              <button className="btn primary block" onClick={onClose}>
                Done
              </button>
            </>
          ) : questions == null ? (
            <div className="center-fill">
              <div className="spinner" />
              <div className="muted small">Your coach is looking at your day…</div>
            </div>
          ) : (
            <CoachCheckinForm questions={questions} busy={busy} onSubmit={submit} onSkip={onClose} />
          )}
        </div>
      </div>
    </div>
  );
}
