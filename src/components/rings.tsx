/**
 * Presentational nutrition widgets: a calorie progress ring and macro bars.
 * Pure SVG/CSS, no dependencies. Stateless — they render whatever macros they
 * are handed.
 */

import type { Goals, Macros } from "../types";
import { pctOf } from "../features/diary";

/**
 * The home screen's calorie ring. Exercise calories are added BACK to the
 * budget, so the figure shown is `goal - consumed + exercise` — going over
 * fills the ring past full rather than clamping, so the overage stays visible.
 *
 * `goal: null` is a user with no calorie target (a logging-only plan): the
 * ring shows what they ate and nothing it could be "left" or "over" against.
 */
export function CalorieRing({
  consumed,
  goal,
  exercise = 0,
}: {
  consumed: number;
  goal: number | null;
  /** Calories burned from exercise/wearable — added back to the budget. */
  exercise?: number;
}) {
  // Exercise calories raise the day's budget: remaining = goal − eaten + burned,
  // and the ring fills against the adjusted (goal + burned) budget.
  const tracking = goal !== null;
  const adjustedGoal = (goal ?? 0) + exercise;
  const remaining = adjustedGoal - consumed;
  const pct = tracking ? Math.min(100, pctOf(consumed, adjustedGoal)) : 0;
  const over = tracking && consumed > adjustedGoal;
  const R = 52;
  const C = 2 * Math.PI * R;
  const dash = (pct / 100) * C;

  return (
    <div className="ring-wrap">
      <svg
        viewBox="0 0 120 120"
        className="ring"
        role="img"
        aria-label={tracking ? `${consumed} of ${goal} calories` : `${consumed} calories eaten`}
      >
        <defs>
          <linearGradient id="cal-ring-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--cui-accent)" />
            <stop offset="100%" stopColor="var(--cui-accent-soft)" />
          </linearGradient>
        </defs>
        <circle cx="60" cy="60" r={R} className="ring-track" />
        {/* No target, no arc: even an empty one draws its round cap as a dot
            at the top, which reads as progress towards something. */}
        {tracking && (
          <circle
            cx="60"
            cy="60"
            r={R}
            className={`ring-value${over ? " over" : ""}`}
            stroke={over ? undefined : "url(#cal-ring-grad)"}
            strokeDasharray={`${dash} ${C}`}
            transform="rotate(-90 60 60)"
          />
        )}
      </svg>
      <div className="ring-center">
        <div className="ring-number">{tracking ? Math.abs(remaining) : consumed}</div>
        <div className="ring-label">{!tracking ? "cal eaten" : over ? "cal over" : "cal left"}</div>
      </div>
    </div>
  );
}

/** Protein/carbs/fat progress bars against the day's targets. With `goals:
 *  null` (no calorie target) it lists the grams eaten, with no bar to fill. */
export function MacroBars({ total, goals }: { total: Macros; goals: Goals | null }) {
  const rows: Array<{ key: keyof Macros; label: string; cls: string; goal: number | null }> = [
    { key: "protein", label: "Protein", cls: "protein", goal: goals?.protein ?? null },
    { key: "carbs", label: "Carbs", cls: "carbs", goal: goals?.carbs ?? null },
    { key: "fat", label: "Fat", cls: "fat", goal: goals?.fat ?? null },
  ];
  return (
    <div className="macro-bars">
      {rows.map((r) => {
        const value = total[r.key];
        return (
          <div className="macro-row" key={r.key}>
            <div className="macro-head">
              <span className="macro-label">
                <span className={`macro-dot ${r.cls}`} aria-hidden />
                {r.label}
              </span>
              <span className="macro-amt">{r.goal === null ? `${value} g` : `${value} / ${r.goal} g`}</span>
            </div>
            {r.goal !== null && (
              <div className="macro-track">
                <div
                  className={`macro-fill ${r.cls}`}
                  style={{ width: `${Math.min(100, pctOf(value, r.goal))}%` }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
