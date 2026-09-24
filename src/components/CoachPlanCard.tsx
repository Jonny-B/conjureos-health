/**
 * Compact plan summary for the home screen: the active plan's headline (mode,
 * top goals, daily calorie target), tapping through to the Plan tab.
 */

import type { Goals, Plan } from "../types";
import { planModeLabel, visiblePlanGoals } from "../features/plan/display";
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
          Your plan
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
        <div className="muted small">Set a calorie target and a weekly movement goal. Tap to start one.</div>
      )}
    </button>
  );
}
