import { useEffect, useState } from "react";
import type { Goals, Plan, Profile, WeightEntry } from "../types";
import { DEFAULT_GOALS } from "../types";
import { getRepository } from "../data/repository";
import { todayISO } from "../features/diary";
import { bmi } from "../features/goals";
import { modeTracksFood } from "../features/plan/model";
import { goalsToTargets, targetsToGoals, updatePlan } from "../features/plan/planService";
import { fmtWeight, weightToDisplay, weightToKg, weightUnit } from "../features/units";
import { Sparkline } from "../components/Sparkline";
import { NumberField } from "../components/NumberField";
import { pickWeightKg } from "../components/WeightCard";
import { toIntInRange } from "../features/num";
import { weekExerciseProgress, type WeekExerciseProgress } from "../features/exercise";

/**
 * Plan hub — the home for the user's plan and how it's tracking. Sections:
 *   1. Your plan: the headline and the "Edit plan" entry point (or a call to
 *      build one).
 *   2. Daily targets, for plans that track food.
 *   3. Movement: days this week with any exercise, when the plan sets a goal.
 *   4. Trends: the weight graph + weigh-in + history, with a graceful empty
 *      state that keeps the graph's footprint fixed (no layout jump).
 */
export function PlanScreen({
  profile,
  plan,
  goals,
  onPlanChange,
  onEditPlan,
  onStartPlan,
  nonce = 0,
}: {
  profile: Profile | null;
  plan: Plan | null;
  goals: Goals;
  onPlanChange: (plan: Plan | null) => void;
  /** Edit the whole plan — re-opens the wizard questions (goals, dates, stats). */
  onEditPlan: () => void;
  /** Open the plan wizard — the Plan tab's own entry point when no plan exists. */
  onStartPlan: () => void;
  /** Bumped by the app after any write, so derived views re-read. */
  nonce?: number;
}) {
  return (
    <div className="plan-screen">
      {!plan && <PlanCtaCard onStartPlan={onStartPlan} />}
      {plan && <PlanHeaderSection plan={plan} onEditPlan={onEditPlan} />}
      {plan && modeTracksFood(plan.mode) && (
        <PlanTargetsSection plan={plan} goals={goals} onPlanChange={onPlanChange} />
      )}
      {plan && (plan.weeklyExerciseDays ?? 0) > 0 && (
        <ExerciseGoalSection target={plan.weeklyExerciseDays!} nonce={nonce} />
      )}
      <TrendsPanel profile={profile} />
    </div>
  );
}

/** The plan's headline + the "Edit plan" entry point. */
function PlanHeaderSection({ plan, onEditPlan }: { plan: Plan; onEditPlan: () => void }) {
  return (
    <section className="plan-section">
      <div className="section-label">
        Your plan
        <span className="section-actions">
          <button className="link-btn section-action" onClick={onEditPlan}>
            Edit plan
          </button>
        </span>
      </div>
      {plan.goalText && <p className="plan-goal-text">{plan.goalText}</p>}
      <p className="muted small">
        {plan.targets?.dailyCalories != null
          ? `${plan.targets.dailyCalories.toLocaleString()} cal a day`
          : "Daily targets below"}
        {plan.endDate ? ` · until ${plan.endDate}` : ""}
      </p>
    </section>
  );
}

// ── Daily targets (advanced manual override) ───────────────────────────

type GoalsDraft = { calories?: number; protein?: number; carbs?: number; fat?: number };
/** A draft field the user may have blanked out: fall back to `dflt`. */
function clampNum(v: number | undefined, min: number, max: number, dflt: number): number {
  return toIntInRange(v, min, max) ?? dflt;
}
function draftToGoals(d: GoalsDraft): Goals {
  return {
    calories: clampNum(d.calories, 0, 10000, DEFAULT_GOALS.calories),
    protein: clampNum(d.protein, 0, 600, DEFAULT_GOALS.protein),
    carbs: clampNum(d.carbs, 0, 900, DEFAULT_GOALS.carbs),
    fat: clampNum(d.fat, 0, 400, DEFAULT_GOALS.fat),
  };
}

/**
 * Manual override of the plan's daily calorie/macro targets. Lives on the Plan
 * tab (targets are a plan property); collapsed by default. Editing here writes
 * straight to `plan.targets` so the diary ring updates — until the next plan
 * edit recomputes them from your stats.
 */
function PlanTargetsSection({
  plan,
  goals,
  onPlanChange,
}: {
  plan: Plan;
  goals: Goals;
  onPlanChange: (plan: Plan | null) => void;
}) {
  const current = targetsToGoals(plan, goals);
  const [open, setOpen] = useState(false);
  const [g, setG] = useState<GoalsDraft>(current);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const fg = draftToGoals(g);
      const { plan: next } = await updatePlan(plan, { targets: goalsToTargets(fg) }, { currentGoals: fg });
      onPlanChange(next);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="plan-section">
      <div className="section-label">
        Daily targets
        <button
          className="link-btn section-action"
          onClick={() => {
            setG(current);
            setOpen((o) => !o);
          }}
        >
          {open ? "Cancel" : "Adjust"}
        </button>
      </div>

      {!open ? (
        <div className="summary-card targets-summary">
          <span className="targets-cal">
            <strong>{current.calories}</strong> cal
          </span>
          <span className="muted small">
            P {current.protein} · C {current.carbs} · F {current.fat} g
          </span>
        </div>
      ) : (
        <div className="summary-card column">
          <p className="muted small">
            Set your own targets. This overrides what your plan computed, until your next plan edit
            recalculates it.
          </p>
          <div className="form-grid">
            <label className="field">
              <span>Calories</span>
              <NumberField value={g.calories} min={0} max={10000} onChange={(n) => setG({ ...g, calories: n })} aria-label="Calories" />
            </label>
            <label className="field">
              <span>Protein (g)</span>
              <NumberField value={g.protein} min={0} max={600} onChange={(n) => setG({ ...g, protein: n })} aria-label="Protein grams" />
            </label>
            <label className="field">
              <span>Carbs (g)</span>
              <NumberField value={g.carbs} min={0} max={900} onChange={(n) => setG({ ...g, carbs: n })} aria-label="Carbs grams" />
            </label>
            <label className="field">
              <span>Fat (g)</span>
              <NumberField value={g.fat} min={0} max={400} onChange={(n) => setG({ ...g, fat: n })} aria-label="Fat grams" />
            </label>
          </div>
          <button className="btn primary block" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save targets"}
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * Empty-state entry point shown on the Plan tab when the user has no plan yet —
 * so the tab is a second, obvious way to start one (not a blank screen). Any
 * body stats / weigh-ins already entered are carried into the wizard, so
 * starting here never loses that data.
 */
function PlanCtaCard({ onStartPlan }: { onStartPlan: () => void }) {
  return (
    <section className="plan-section">
      <div className="section-label">Your plan</div>
      <div className="summary-card column plan-cta-card">
        <div className="plan-cta-title">Build your plan</div>
        <p className="muted small plan-cta-blurb">
          A plan sets your daily calorie and macro targets from your goal, and tracks your weight
          against it. It takes a minute, and your stats and weigh-ins carry straight in.
        </p>
        <button className="btn primary block" onClick={onStartPlan}>
          Build your plan
        </button>
      </div>
    </section>
  );
}

/**
 * Weekly movement goal: how many days this week the user recorded any exercise,
 * against their plan's target. Read-only — nothing is prescribed; it just
 * reflects what already reached the calorie ring, so the two can never disagree.
 */
function ExerciseGoalSection({ target, nonce = 0 }: { target: number; nonce?: number }) {
  const [prog, setProg] = useState<WeekExerciseProgress | null>(null);

  useEffect(() => {
    let alive = true;
    weekExerciseProgress(target)
      .then((r) => alive && setProg(r))
      .catch(() => alive && setProg(null));
    return () => {
      alive = false;
    };
  }, [target, nonce]);

  const done = prog?.days ?? 0;
  const hit = done >= target;
  return (
    <section className="plan-section">
      <div className="section-label">Movement</div>
      <div className="summary-card column">
        <div className="exercise-goal-head">
          <strong>
            {done} of {target}
          </strong>{" "}
          <span className="muted">days this week</span>
          {hit && <span className="exercise-goal-hit">✓ goal met</span>}
        </div>
        <div className="exercise-goal-dots" aria-hidden>
          {(prog?.weekDates ?? []).map((d) => (
            <span
              key={d}
              className={`exercise-dot${prog?.activeDates.includes(d) ? " on" : ""}`}
              title={d}
            />
          ))}
        </div>
        <p className="muted small">
          Counts any day with exercise — logged here or synced from Apple Health.
        </p>
      </div>
    </section>
  );
}

// ── Trends ─────────────────────────────────────────────────────────────

function TrendsPanel({ profile }: { profile: Profile | null }) {
  const [weights, setWeights] = useState<WeightEntry[]>([]);
  const [input, setInput] = useState("");

  const reload = async () => {
    const repo = await getRepository();
    setWeights(await repo.listWeights());
  };
  useEffect(() => {
    reload();
  }, []);

  const units = profile?.units ?? "metric";

  const add = async () => {
    const shown = Number(input);
    if (!Number.isFinite(shown) || shown <= 0) return;
    const kg = weightToKg(shown, units);
    const repo = await getRepository();
    // Store kg to 2 decimals so a 1-decimal lb entry (0.1 lb ≈ 0.045 kg) round-trips.
    await repo.upsertWeight({ date: todayISO(), weightKg: Math.round(kg * 100) / 100 });
    setInput("");
    await reload();
  };

  // Graceful "last known weight": newest weigh-in, else the plan/profile weight;
  // only truly empty when neither exists (then a prompt, never a bare dash).
  const latestKg = pickWeightKg(weights);
  const oldest = weights[weights.length - 1];
  const latest = weights[0];
  const changeKg = latest && oldest && weights.length > 1 ? latest.weightKg - oldest.weightKg : 0;
  const changeDisplay =
    units === "imperial" ? Math.round(changeKg * 2.2046226218 * 10) / 10 : Math.round(changeKg * 10) / 10;

  return (
    <section className="plan-section">
      <div className="section-label">Trends</div>
      {/* Fixed min-height so the card's footprint stays constant whether it's
          empty, a single weigh-in, or a full trend. */}
      <section className="summary-card column trends-card">
        {latestKg != null ? (
          <>
            <div className="big-stat">
              <span className="big-number">{weightToDisplay(latestKg, units)}</span>
              <span className="big-unit">{weightUnit(units)}</span>
            </div>
            <div className="stat-row">
              {weights.length > 1 && (
                <span className={changeKg <= 0 ? "good" : "bad"}>
                  {changeKg > 0 ? "+" : ""}
                  {changeDisplay} {weightUnit(units)} overall
                </span>
              )}
              {profile && (
                <span className="muted">
                  BMI {bmi({ ...profile, weightKg: latest?.weightKg ?? profile.weightKg })}
                </span>
              )}
            </div>
            <Sparkline points={[...weights].reverse().map((w) => w.weightKg)} />
          </>
        ) : (
          <div className="trends-empty muted">Log your first weigh-in to start tracking your trend.</div>
        )}
      </section>

      <div className="row gap weigh-in">
        <input
          className="text-input"
          type="number"
          inputMode="decimal"
          placeholder={`Today's weight (${weightUnit(units)})`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button className="btn primary" disabled={!input} onClick={add}>
          Log
        </button>
      </div>

      {weights.length > 0 && (
        <ul className="weight-list">
          {weights.map((w) => (
            <li key={w.date} className="weight-row">
              <span>{w.date}</span>
              <span>{fmtWeight(w.weightKg, units)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
