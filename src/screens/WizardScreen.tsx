import { useEffect, useRef, useState } from "react";
import type { ActivityLevel, AgeBand, GoalDirection, Plan, PlanMode, Profile, SafetyIntake, Sex } from "../types";
import { requiresLoggingOnly, resolveSafeMode } from "../features/safety/intakeGate";
import { deriveDirection, recommendGoals } from "../features/goals";
import { shiftDate, todayISO } from "../features/diary";
import { DisclaimerCard, DISCLAIMER_SHORT } from "../components/DisclaimerCard";
import {
  AgeField,
  BodyStatsFields,
  GoalWeightField,
  PlanDatesField,
  SexField,
  weeksBetween,
} from "../components/PlanFields";
import { AlertTriangle, CheckIcon, CloseIcon } from "../components/icons";
import { createPlan, type CreatePlanResult, type PlanStage } from "../features/plan/generate";
import { getRepository } from "../data/repository";
import type { PlanInput } from "../features/plan/model";
import { modeTracksFood } from "../features/plan/model";
import type { WizardBody } from "../features/plan/planService";
import { decidePlanEdit } from "../features/plan/planService";

type Step = "disclaimer" | "mode" | "safety" | "inputs" | "review";

const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

interface Props {
  onComplete: (plan: Plan, body: WizardBody) => void;
  onClose?: () => void;
  units?: Profile["units"];
  /**
   * The user's existing profile, if they've already entered body stats via the
   * cog (or a prior plan). The wizard PREFILLS from it so those metrics aren't
   * re-typed — and, critically, aren't overwritten on commit: without prefill
   * the wizard's hardcoded defaults (female/30/…) would clobber real cog data
   * when `commitNewPlan` merges `body.sex ?? base.sex`.
   */
  profile?: Profile | null;
  /**
   * EDIT MODE. When set, the wizard is the single "edit my plan" surface: it
   * prefills every answer from this plan and, on commit, decides via
   * `decidePlanEdit` whether the change forks a brand-new plan (`onComplete`,
   * archive + regenerate) or modifies this one in place (`onModify`, keep id +
   * goals, recompute calories). Absent → create mode as before.
   */
  editPlan?: Plan | null;
  /** Commit an in-place modification (edit mode, non-forking change). */
  onModify?: (
    body: WizardBody,
    patch: { endDate?: string; durationWeeks?: number; weeklyExerciseDays?: number },
  ) => void;
}

const STAGE_LABELS: Record<PlanStage, string> = {
  calories: "Calculating your calories…",
  goals: "Building your plan…",
  checking: "Checking it's safe for you…",
};

function ageToBand(age: number): AgeBand {
  if (age < 18) return "under_18";
  if (age <= 39) return "18_39";
  if (age <= 59) return "40_59";
  return "60_plus";
}

const EXERCISE_DAY_OPTIONS = [0, 2, 3, 4, 5, 6] as const;
const EATER_ACTIVITY_OPTIONS: { value: ActivityLevel; label: string }[] = [
  { value: "sedentary", label: "Mostly sitting" },
  { value: "light", label: "Lightly active" },
  { value: "moderate", label: "Moderately active" },
  { value: "active", label: "Very active" },
];

/**
 * The plan questionnaire — used both to CREATE a plan and to EDIT one.
 *
 * Passing `editPlan` switches to edit mode: answers are prefilled, the
 * disclaimer is skipped (already acked), and the start date becomes editable.
 * On commit, `decidePlanEdit` decides whether the change forks a brand-new
 * plan or patches the existing one — which is why edit mode needs `onModify`
 * alongside `onComplete`.
 */
export function WizardScreen({ onComplete, onClose, units = "metric", profile, editPlan, onModify }: Props) {
  const editMode = !!editPlan;
  // In edit mode the liability was already acked on the original plan, so skip
  // the disclaimer gate and open on the first real question.
  const [step, setStep] = useState<Step>(editMode ? "mode" : "disclaimer");

  // Step 1 — free-text goal prefill from the plan being edited.
  const [weeklyExerciseDays, setWeeklyExerciseDays] = useState<number>(editPlan?.weeklyExerciseDays ?? 0);
  // Every plan is food-only now. A legacy "both" or "get_fit" plan lands on
  // "eat_better", which decidePlanEdit reads as a mode change, so editing it
  // forks a fresh plan instead of carrying its workout goals forward.
  const mode: PlanMode = editPlan?.mode === "logging_only" ? "logging_only" : "eat_better";
  // Step 2 (safety intake) — age is a number now; the band is derived.
  // Prefill every body-stat field from the existing profile so nothing entered
  // in the cog is lost or re-typed; fall back to the same defaults as before
  // when there's no profile yet.
  const [age, setAge] = useState<number | undefined>(profile?.age ?? 30);
  const [pregnant, setPregnant] = useState(false);
  const [cardiacFlag, setCardiacFlag] = useState(false);
  // Step 3 (inputs)
  const [goalText, setGoalText] = useState(editPlan?.goalText ?? "");
  const [startDate, setStartDate] = useState(editPlan?.startDate ?? todayISO());
  const [endDate, setEndDate] = useState(editPlan?.endDate ?? shiftDate(todayISO(), 13)); // ~2 weeks
  const [unitPref, setUnitPref] = useState<Profile["units"]>(profile?.units ?? units);
  const [heightCm, setHeightCm] = useState<number | undefined>(profile?.heightCm);
  const [weightKg, setWeightKg] = useState<number | undefined>(profile?.weightKg);
  const [goalWeightKg, setGoalWeightKg] = useState<number | undefined>(profile?.goalWeightKg);
  const [sex, setSex] = useState<Sex>(profile?.sex ?? "female");
  const [activityLevel, setActivityLevel] = useState<ActivityLevel>(profile?.activityLevel ?? "moderate");
  // No lose/maintain/gain selector — the goal weight vs current weight already
  // says it. Below = lose, above = gain, blank/equal = maintain.
  const direction: GoalDirection = deriveDirection(weightKg, goalWeightKg);
  // The user's current weight is best represented by their latest weigh-in (a
  // real measurement) over the profile's stored number, so seed from it when
  // present — but never stomp a value the user has already typed in the wizard.
  const weightTouched = useRef(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      const repo = await getRepository();
      const ws = await repo.listWeights();
      if (alive && ws.length && !weightTouched.current) setWeightKg(ws[0]!.weightKg);
    })();
    return () => {
      alive = false;
    };
  }, []);
  // Step 4 (review)
  const [preview, setPreview] = useState<CreatePlanResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [stage, setStage] = useState<PlanStage | null>(null);
  const [tweakOpen, setTweakOpen] = useState(false);
  const [tweakText, setTweakText] = useState("");

  const ageBand = ageToBand(age ?? 30);
  const intake: SafetyIntake = { ageBand, pregnant, cardiacFlag, activityLevel };
  const gated = requiresLoggingOnly(intake);
  const effectiveMode = resolveSafeMode(mode, intake);
  const tracksFood = modeTracksFood(effectiveMode);

  /** Calorie target computed from the profile (Mifflin) — the app owns this, so
   *  a plan is never rejected just because the AI omitted the number. */
  const localCalorieTarget = (): number | null => {
    if (!tracksFood || heightCm == null || weightKg == null) return null;
    const p: Profile = {
      sex,
      age: age ?? 30,
      heightCm,
      weightKg,
      activityLevel,
      direction,
      units: unitPref,
    };
    return recommendGoals(p).calories;
  };

  const buildInput = (extraGoal = ""): PlanInput => ({
    mode: effectiveMode,
    goalText: [goalText, extraGoal].filter(Boolean).join(". Also: "),
    durationWeeks: weeksBetween(startDate, endDate),
    startDate,
    endDate,
    heightCm: tracksFood ? heightCm : undefined,
    weightKg: tracksFood ? weightKg : undefined,
    goalWeightKg: tracksFood && direction !== "maintain" ? goalWeightKg : undefined,
    age: tracksFood ? age : undefined,
    sex: tracksFood ? sex : undefined,
    calorieTarget: localCalorieTarget(),
    units: unitPref,
    safety: intake,
  });

  const PLACEHOLDER_ACK = { acknowledged: false, acceptedAt: "" };

  const runPreview = async (extraGoal = "") => {
    setPreviewLoading(true);
    setPreview(null);
    setStage("calories");
    try {
      const result = await createPlan(buildInput(extraGoal), PLACEHOLDER_ACK, { onStage: setStage });
      setPreview(result);
    } finally {
      setPreviewLoading(false);
      setStage(null);
    }
  };

  // In edit mode, whether the current answers fork a brand-new plan or modify
  // the existing one in place. Drives whether we regenerate (createPlan) or just
  // recompute targets — see decidePlanEdit for the locked trigger.
  const editDecision = editMode && editPlan
    ? decidePlanEdit(editPlan, { mode: effectiveMode, goalText, startDate })
    : "new";
  const isModify = editMode && editDecision === "modify";

  const goReview = () => {
    setStep("review");
    // A modify keeps the existing goals, so there's nothing to generate — we
    // only recompute the calorie target locally.
    if (!isModify) void runPreview();
  };

  const inputsValid = tracksFood ? heightCm != null && weightKg != null : true;

  /** The body stats to reconcile into the profile on commit (shared by the
   *  new-plan and modify-in-place paths). */
  const buildBody = (): WizardBody => ({
    sex: tracksFood ? sex : undefined,
    heightCm: tracksFood ? heightCm : undefined,
    weightKg: tracksFood ? weightKg : undefined,
    goalWeightKg: tracksFood && direction !== "maintain" ? goalWeightKg : undefined,
    age,
    ageBand,
    activityLevel,
    direction: tracksFood ? direction : undefined,
    units: unitPref,
  });

  const start = () => {
    if (!preview) return;
    const plan: Plan = {
      ...preview.plan,
      liability: { acknowledged: true, acceptedAt: new Date().toISOString(), appVersion: APP_VERSION },
      // 0 means "not tracking" — store it as absent rather than a zero target.
      ...(weeklyExerciseDays > 0 ? { weeklyExerciseDays } : {}),
    };
    onComplete(plan, buildBody());
  };

  /** Commit an in-place plan modification (edit mode, non-forking change). */
  const commitModify = () => {
    onModify?.(buildBody(), {
      endDate,
      durationWeeks: weeksBetween(startDate, endDate),
      weeklyExerciseDays,
    });
  };

  return (
    <div className="wizard">
      {onClose && (
        <div className="wizard-top">
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon size={20} />
          </button>
        </div>
      )}
      {step === "disclaimer" && <DisclaimerCard onAccept={() => setStep("mode")} />}

      {step === "mode" && (
        <div className="mode-body wizard-step">
          <WizardHead n={1} title="What's your goal?" />

          <label className="field goal-describe">
            <span className="field-label">Describe it in your own words (optional)</span>
            <textarea
              className="text-area"
              rows={2}
              placeholder="e.g. lose a couple of pounds"
              value={goalText}
              onChange={(e) => setGoalText(e.target.value)}
            />
            <span className="muted small field-hint">The more specific you are, the better your plan fits.</span>
          </label>

          <div className="wizard-nav">
            <button className="btn primary block" onClick={() => setStep("safety")}>
              Continue
            </button>
          </div>
        </div>
      )}

      {step === "safety" && (
        <div className="mode-body wizard-step">
          <WizardHead n={2} title="About you" />
          <p className="muted small">
            Everything about your body in one place. Nothing leaves your device.
          </p>

          <div className="form-grid">
            <AgeField age={age} onChange={setAge} />
            <SexField sex={sex} onChange={setSex} />
          </div>

          {tracksFood && (
            <>
              <BodyStatsFields
                units={unitPref}
                heightCm={heightCm}
                weightKg={weightKg}
                onUnits={setUnitPref}
                onHeightCm={setHeightCm}
                onWeightKg={(kg) => {
                  weightTouched.current = true;
                  setWeightKg(kg);
                }}
              />
              <GoalWeightField
                units={unitPref}
                goalWeightKg={goalWeightKg}
                onChange={setGoalWeightKg}
                optional
              />
            </>
          )}

          <div className="section-label">Safety check</div>
          <label className="check-row">
            <input type="checkbox" checked={pregnant} onChange={(e) => setPregnant(e.target.checked)} />
            <span>Pregnant or recently postpartum</span>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={cardiacFlag} onChange={(e) => setCardiacFlag(e.target.checked)} />
            <span>A heart condition, or a doctor has told me to be careful with exercise</span>
          </label>

          {gated && (
            <div className="notice notice-soft">
              <AlertTriangle />
              <span>
                Based on your answers we'll keep this to food & habit tracking. Talk to your doctor before
                adding exercise.
              </span>
            </div>
          )}

          <div className="wizard-nav">
            <button className="btn" onClick={() => setStep("mode")}>Back</button>
            <button className="btn primary" disabled={!inputsValid} onClick={() => setStep("inputs")}>
              Continue
            </button>
          </div>
        </div>
      )}

      {step === "inputs" && (
        <div className="mode-body wizard-step">
          <WizardHead n={3} title="Your plan" />

          {/* Start date is only editable when editing a plan — moving it forks a
              new plan. On first creation it's simply "today". */}
          <PlanDatesField
            startDate={startDate}
            endDate={endDate}
            onStart={setStartDate}
            onEnd={setEndDate}
            hideStart={!editMode}
          />

          <div className="field">
            <span className="field-label">How active is a typical day?</span>
            <div className="chip-row">
              {EATER_ACTIVITY_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className={`chip${activityLevel === o.value ? " active" : ""}`}
                  onClick={() => setActivityLevel(o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <span className="muted small field-hint">Used only to estimate your daily calories.</span>
          </div>

          <div className="field">
            <span className="field-label">Want to move most days?</span>
            <div className="chip-row">
              {EXERCISE_DAY_OPTIONS.map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`chip${weeklyExerciseDays === d ? " active" : ""}`}
                  onClick={() => setWeeklyExerciseDays(d)}
                >
                  {d === 0 ? "Not tracking" : `${d}× a week`}
                </button>
              ))}
            </div>
            <span className="muted small field-hint">
              We just count the days you record any exercise — nothing is prescribed.
            </span>
          </div>

          <div className="wizard-nav">
            <button className="btn" onClick={() => setStep("safety")}>Back</button>
            <button className="btn primary" disabled={!inputsValid} onClick={goReview}>
              {isModify ? "Review changes" : editMode ? "Rebuild my plan" : "Build my plan"}
            </button>
          </div>
        </div>
      )}

      {step === "review" && isModify && (
        <div className="mode-body wizard-step">
          <WizardHead n={4} title="Review your changes" />

          <p className="plan-summary">We'll update this plan in place and keep its goals as they are.</p>

          {tracksFood && localCalorieTarget() != null ? (
            <div className="calorie-callout">
              <div className="calorie-callout-num">
                <span className="big-number">{Math.round(localCalorieTarget()!)}</span>
                <span className="big-unit">kcal / day</span>
              </div>
              <span className="muted small">
                Your new daily calorie target, recomputed from your stats and goal weight. This is
                what the ring on your home screen tracks.
              </span>
            </div>
          ) : (
            <p className="muted small">Your daily targets stay the same for this kind of plan.</p>
          )}

          <div className="wizard-nav">
            <button className="btn" onClick={() => setStep("inputs")}>Back</button>
            <button className="btn primary" onClick={commitModify}>
              <CheckIcon size={16} /> Save changes
            </button>
          </div>
        </div>
      )}

      {step === "review" && !isModify && (
        <div className="mode-body wizard-step">
          <WizardHead n={4} title="Here's your plan" />

          {previewLoading || !preview ? (
            <div className="center-fill">
              <div className="spinner" />
              <p className="muted small">{stage ? STAGE_LABELS[stage] : "Putting your plan together…"}</p>
            </div>
          ) : (
            <>
              {preview.usedFallback && (
                <div className="notice notice-soft">
                  <span>We used a safe starter plan for now — tweak it or regenerate any time.</span>
                  {preview.failureReason && (
                    <div className="muted small">Why the AI didn't generate one: {preview.failureReason}</div>
                  )}
                </div>
              )}
              <p className="plan-summary">{preview.gen.summary}</p>

              {tracksFood && preview.plan.targets?.dailyCalories != null && (
                <div className="calorie-callout">
                  <div className="calorie-callout-num">
                    <span className="big-number">{Math.round(preview.plan.targets.dailyCalories)}</span>
                    <span className="big-unit">kcal / day</span>
                  </div>
                  <span className="muted small">
                    Your daily calorie target, computed from your stats and goal weight. This is
                    what the ring on your home screen tracks.
                  </span>
                </div>
              )}

              {tweakOpen && (
                <label className="field">
                  <span className="field-label">What should change?</span>
                  <input
                    className="text-input"
                    placeholder="e.g. more protein, easier breakfasts"
                    value={tweakText}
                    onChange={(e) => setTweakText(e.target.value)}
                  />
                  <button
                    className="btn block"
                    onClick={() => {
                      setTweakOpen(false);
                      void runPreview(tweakText.trim());
                      setTweakText("");
                    }}
                  >
                    Regenerate
                  </button>
                </label>
              )}

              <div className="notice notice-soft disclaimer-inline">
                <AlertTriangle />
                <span>{DISCLAIMER_SHORT}</span>
              </div>

              <div className="wizard-nav">
                {!tweakOpen && <button className="btn" onClick={() => setTweakOpen(true)}>Tweak it</button>}
                <button className="btn primary" onClick={start}>
                  <CheckIcon size={16} /> Start plan
                </button>
              </div>

            </>
          )}
        </div>
      )}
    </div>
  );
}

function WizardHead({ n, title }: { n: number; title: string }) {
  return (
    <div className="wizard-head">
      <span className="wizard-step-num">Step {n} of 4</span>
      <h1>{title}</h1>
    </div>
  );
}
