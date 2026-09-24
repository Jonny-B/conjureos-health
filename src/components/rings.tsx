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
 */
export function CalorieRing({
  consumed,
  goal,
  exercise = 0,
}: {
  consumed: number;
  goal: number;
  /** Calories burned from exercise/wearable — added back to the budget. */
  exercise?: number;
}) {
  // Exercise calories raise the day's budget: remaining = goal − eaten + burned,
  // and the ring fills against the adjusted (goal + burned) budget.
  const adjustedGoal = goal + exercise;
  const remaining = adjustedGoal - consumed;
  const pct = Math.min(100, pctOf(consumed, adjustedGoal));
  const over = consumed > adjustedGoal;
  const R = 52;
  const C = 2 * Math.PI * R;
  const dash = (pct / 100) * C;

  return (
    <div className="ring-wrap">
      <svg viewBox="0 0 120 120" className="ring" role="img" aria-label={`${consumed} of ${goal} calories`}>
        <defs>
          <linearGradient id="cal-ring-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--cui-accent)" />
            <stop offset="100%" stopColor="var(--cui-accent-soft)" />
          </linearGradient>
        </defs>
        <circle cx="60" cy="60" r={R} className="ring-track" />
        <circle
          cx="60"
          cy="60"
          r={R}
          className={`ring-value${over ? " over" : ""}`}
          stroke={over ? undefined : "url(#cal-ring-grad)"}
          strokeDasharray={`${dash} ${C}`}
          transform="rotate(-90 60 60)"
        />
      </svg>
      <div className="ring-center">
        <div className="ring-number">{Math.abs(remaining)}</div>
        <div className="ring-label">{over ? "cal over" : "cal left"}</div>
      </div>
    </div>
  );
}

/**
 * Generic countdown/progress ring used by the workout player. `pct` is 0–100
 * of the ring filled; children render in the center (the big timer number).
 */
export function ProgressRing({
  pct,
  tone = "accent",
  children,
}: {
  pct: number;
  tone?: "accent" | "rest" | "reps";
  children: React.ReactNode;
}) {
  const R = 54;
  const C = 2 * Math.PI * R;
  const dash = (Math.max(0, Math.min(100, pct)) / 100) * C;
  return (
    <div className="progress-ring-wrap">
      <svg viewBox="0 0 120 120" className="progress-ring" aria-hidden>
        <circle cx="60" cy="60" r={R} className="ring-track" />
        <circle
          cx="60"
          cy="60"
          r={R}
          className={`progress-ring-value ${tone}`}
          strokeDasharray={`${dash} ${C}`}
          transform="rotate(-90 60 60)"
        />
      </svg>
      <div className="ring-center">{children}</div>
    </div>
  );
}

/** Protein/carbs/fat progress bars against the day's targets. */
export function MacroBars({ total, goals }: { total: Macros; goals: Goals }) {
  const rows: Array<{ key: keyof Macros; label: string; cls: string; goal: number }> = [
    { key: "protein", label: "Protein", cls: "protein", goal: goals.protein },
    { key: "carbs", label: "Carbs", cls: "carbs", goal: goals.carbs },
    { key: "fat", label: "Fat", cls: "fat", goal: goals.fat },
  ];
  return (
    <div className="macro-bars">
      {rows.map((r) => {
        const value = total[r.key];
        const pct = Math.min(100, pctOf(value, r.goal));
        return (
          <div className="macro-row" key={r.key}>
            <div className="macro-head">
              <span className="macro-label">
                <span className={`macro-dot ${r.cls}`} aria-hidden />
                {r.label}
              </span>
              <span className="macro-amt">
                {value} / {r.goal} g
              </span>
            </div>
            <div className="macro-track">
              <div className={`macro-fill ${r.cls}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
