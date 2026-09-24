/**
 * Compact plan summary for the home screen: the active plan's headline (mode,
 * top goals, daily calorie target), tapping through to the Plan tab.
 *
 * While the coach is paused (features/flags) this card must not mention it.
 * The coach's running one-liner is stored context about a plan that may no
 * longer exist — it was still being printed here after the pause, which is how
 * a cleared plan kept showing an old narrative about Murph training.
 */

import { useEffect, useState } from "react";
import type { Goals, Plan } from "../types";
import { loadMemory } from "../features/coach/memory";
import { planModeLabel, visiblePlanGoals } from "../features/plan/display";
import { COACH_AND_WORKOUTS_ENABLED } from "../features/flags";
import { CoachIcon, ChevronRight } from "./icons";

/** Home-screen card summarizing the active plan, or a create-a-plan prompt
 *  when there isn't one. Tapping it opens the Plan tab. */
export function CoachPlanCard({
  plan,
  goals,
  onOpen,
}: {
  plan: Plan | null;
  goals: Goals;
  onOpen: () => void;
}) {
  const [summary, setSummary] = useState<string | null>(null);

  useEffect(() => {
    // The summary is the coach's own memory. With the coach paused there is
    // nothing keeping it current, so it must not be shown at all.
    if (!COACH_AND_WORKOUTS_ENABLED) return;
    let alive = true;
    loadMemory()
      .then((m) => {
        if (alive) setSummary(m.summary?.trim() || null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const topGoals = plan ? visiblePlanGoals(plan).slice(0, 3).map((g) => g.label) : [];

  return (
    <button
      className="home-card coach-card"
      onClick={onOpen}
      aria-label={plan ? "Open your plan" : "Build a plan"}
    >
      <div className="home-card-head">
        <span className="home-card-title">
          <CoachIcon size={16} />{" "}
          {plan ? "Your plan" : COACH_AND_WORKOUTS_ENABLED ? "Your coach" : "Your plan"}
        </span>
        <ChevronRight size={18} className="muted" />
      </div>

      {plan ? (
        <>
          <div className="coach-card-plan">
            <span className="coach-card-mode">{planModeLabel(plan)}</span>
            <span className="muted small">·</span>
            <span className="muted small">{goals.calories.toLocaleString()} cal/day</span>
          </div>
          {topGoals.length > 0 && (
            <ul className="coach-card-goals">
              {topGoals.map((g, i) => (
                <li key={i}>{g}</li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <div className="muted small">
          {COACH_AND_WORKOUTS_ENABLED
            ? "Get stat-aware check-ins and a coach that can tune your plan. Tap to chat."
            : "Set a calorie target and a weekly movement goal. Tap to start one."}
        </div>
      )}

      {summary && <div className="coach-card-summary muted small">{summary}</div>}
    </button>
  );
}
