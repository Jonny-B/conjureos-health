import { useEffect, useState } from "react";
import type { Plan, WorkoutSession } from "../types";
import { getRepository } from "../data/repository";
import { buildCoachContext } from "../features/coach/context";
import { evaluateCheckin } from "../features/coach/coach";
import { workoutQuestions } from "../features/coach/questions";
import type { CoachAnswer, CoachContext, CoachQuestion } from "../features/coach/model";
import { CoachCheckinForm } from "../components/CoachCheckinForm";

/**
 * Post-workout "how did it go?" — shown right after a session is saved. The
 * coach picks 3–4 questions from the session's recorded stats; the answers
 * feed its memory and can trigger a small validated plan tweak. Fully
 * skippable, and any failure path just returns to the workouts list.
 */
export function CoachReflect({
  session,
  onDone,
  onPlanChange,
}: {
  session: WorkoutSession;
  onDone: () => void;
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
      const [context, sessions] = await Promise.all([
        buildCoachContext(),
        getRepository().then((r) => r.listWorkoutSessions(50)).catch(() => [] as WorkoutSession[]),
      ]);
      // The just-saved session is in history now — exclude it so PR detection
      // compares against genuinely prior sessions.
      const prior = sessions.filter((s) => s.id !== session.id);
      const qs = await workoutQuestions(session, prior);
      if (!alive) return;
      setCtx(context);
      setQuestions(qs);
    })().catch(() => alive && onDone());
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  const submit = async (answers: CoachAnswer[]) => {
    if (!ctx || answers.length === 0) return onDone();
    setBusy(true);
    try {
      const outcome = await evaluateCheckin("workout", answers, ctx);
      if (outcome.planUpdate) {
        onPlanChange(outcome.planUpdate.plan);
        setPlanNote(outcome.planUpdate.summary);
      }
      setReply(outcome.reply);
    } catch {
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mode-body coach-reflect">
      <div className="summary-head">
        <h1>How did it go?</h1>
        <p className="muted">A quick word with your coach — totally optional.</p>
      </div>

      {reply != null ? (
        <>
          <div className="coach-reply-card">
            <div className="coach-reply-tag">Your coach</div>
            <p>{reply}</p>
            {planNote && <div className="coach-plan-note">✓ Plan updated: {planNote}</div>}
          </div>
          <div className="wizard-nav">
            <button className="btn primary block" onClick={onDone}>
              Done
            </button>
          </div>
        </>
      ) : questions == null ? (
        <div className="center-fill">
          <div className="spinner" />
          <div className="muted small">Your coach is looking at your session…</div>
        </div>
      ) : (
        <CoachCheckinForm questions={questions} busy={busy} onSubmit={submit} onSkip={onDone} />
      )}
    </div>
  );
}
