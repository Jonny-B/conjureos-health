import { useState } from "react";
import type { CoachAnswer, CoachQuestion } from "../features/coach/model";

/**
 * The shared check-in form — renders the coach's picked questions (1–5 scale
 * chips or a text box) and collects CoachAnswers. Used by both the post-workout
 * reflect step and the end-of-day check-in sheet; every question is optional so
 * "Send" always works (unanswered questions are simply omitted).
 */
export function CoachCheckinForm({
  questions,
  busy,
  submitLabel = "Send to coach",
  onSubmit,
  onSkip,
}: {
  questions: CoachQuestion[];
  busy: boolean;
  submitLabel?: string;
  onSubmit: (answers: CoachAnswer[]) => void;
  onSkip: () => void;
}) {
  const [scales, setScales] = useState<Record<string, number>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});

  const collect = (): CoachAnswer[] => {
    const answers: CoachAnswer[] = [];
    for (const q of questions) {
      if (q.kind === "scale") {
        const v = scales[q.id];
        if (v != null)
          answers.push({ id: q.id, question: q.text, value: `${v}/5`, scale: v, metricKey: q.metricKey });
      } else {
        const t = (texts[q.id] ?? "").trim();
        if (t) answers.push({ id: q.id, question: q.text, value: t.slice(0, 500) });
      }
    }
    return answers;
  };

  const answered = questions.some((q) =>
    q.kind === "scale" ? scales[q.id] != null : Boolean(texts[q.id]?.trim()),
  );

  return (
    <div className="checkin-form">
      {questions.map((q) => (
        <div className="checkin-q" key={q.id}>
          <div className="checkin-q-text">{q.text}</div>
          {q.kind === "scale" ? (
            <div className="checkin-scale">
              <span className="checkin-scale-label">{q.low}</span>
              <div className="chip-row">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    className={`chip${scales[q.id] === n ? " active" : ""}`}
                    onClick={() => setScales((prev) => ({ ...prev, [q.id]: n }))}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <span className="checkin-scale-label">{q.high}</span>
            </div>
          ) : (
            <textarea
              className="text-input checkin-text"
              rows={2}
              value={texts[q.id] ?? ""}
              placeholder="Optional"
              onChange={(e) => setTexts((prev) => ({ ...prev, [q.id]: e.target.value }))}
            />
          )}
        </div>
      ))}

      <div className="wizard-nav">
        <button className="btn" onClick={onSkip} disabled={busy}>
          Skip
        </button>
        <button className="btn primary" onClick={() => onSubmit(collect())} disabled={busy || !answered}>
          {busy ? "Sending…" : submitLabel}
        </button>
      </div>
    </div>
  );
}
