/**
 * Compact plan summary for the home screen: the active plan's headline (mode,
 * top goals, daily calorie target), tapping through to the Plan tab. With no
 * plan it invites the user to build one.
 */

import type { Goals, Plan } from "../types";
import { planModeLabel, visiblePlanGoals } from "../features/plan/display";
import { planTracksCalories } from "../features/plan/model";
import { ChevronRight, TrendsIcon } from "./icons";

/** Home-screen card summarizing the active plan, or a create-a-plan prompt
 *  when there isn't one. Tapping it opens the Plan tab. */
export function PlanCard({
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
      className="home-card plan-card"
      onClick={onOpen}
      aria-label={plan ? "Open your plan" : "Build a plan"}
    >
      <div className="home-card-head">
        <span className="home-card-title">
          <TrendsIcon size={16} /> Your plan
        </span>
        <ChevronRight size={18} className="muted" />
      </div>

      {plan ? (
        <>
          <div className="plan-card-plan">
            <span className="plan-card-mode">{planModeLabel(plan)}</span>
            {/* A logging-only plan has no calorie target to show. */}
            {planTracksCalories(plan) && (
              <>
                <span className="muted small">·</span>
                <span className="muted small">{goals.calories.toLocaleString()} cal/day</span>
              </>
            )}
          </div>
          {topGoals.length > 0 && (
            <ul className="plan-card-goals">
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
