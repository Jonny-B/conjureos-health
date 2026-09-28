/**
 * Plan generation (P2 / THE HOOK). One `ai.complete` call turns the wizard's
 * inputs into a structured plan, guarded by the safety layers:
 *   - the system prompt opens "wellness coach, not a doctor",
 *   - the result is validated (validate.ts); on failure we retry once, then
 *     drop to a hardcoded fallback template.
 *
 * `createPlan` is the single entry point the wizard calls; it returns the
 * assembled, ready-to-save domain `Plan` plus whether the fallback was used.
 */

import type { LiabilityAck, Plan, PlanGoal, PlanTargets } from "../../types";
import { complete, extractJson, isAiAvailable } from "../../bridge/ai";
import { newId } from "../../data/id";
import { shiftDate, todayISO } from "../diary";
import { macrosForCalories } from "../goals";
import { fmtHeight, kgToLb } from "../units";
import type { GeneratedGoal, GeneratedPlan, PlanInput } from "./model";
import { modeTracksFood } from "./model";
import { validatePlan } from "./validate";
import { fallbackPlan } from "./fallbackTemplates";
import { toIntInRange } from "../num";

/**
 * Kept deliberately small: a plan is a summary, an optional calorie number and
 * a handful of goals. A response cut off mid-JSON throws the whole plan away,
 * so the prompt asks for nothing the plan doesn't use. Workouts are not part
 * of it — they belong to a separate fitness app — so no goal may prescribe
 * exercise (validate.ts rejects one that does).
 */
const SYSTEM_CORE = `You are a wellness coach, not a doctor. You give friendly suggestions, not medical prescriptions.
Design a specific, personalized eating plan from the user's inputs — tailored to THEIR stated goal and stats. Avoid generic filler. Return ONLY a small JSON object:
  { "summary": string,
    "dailyCalorieTarget": number | null,
    "goals": [ { "label": string, "kind": "nutrition" | "habit", "detail"?: string } ] }
Rules:
- "summary" is one encouraging sentence naming what THIS plan will do for their specific goal.
- "dailyCalorieTarget" is optional — if unsure, use null; the app supplies its own number.
- 3 to 6 goals, each a short daily/weekly action tied to their goal. Use "nutrition" for food and "habit" for everything else.
- No exercise or workout goals of any kind: this app tracks food, and movement is tracked separately.
- Output ONLY the JSON. No prose, no markdown fences.`;

const MAX_GOALS = 8;

/** Build the per-request user message from the wizard inputs + safety avoid-list.
 *  `priorReasons` (retry only) tells the model exactly why the last attempt was
 *  rejected so it can fix it instead of repeating the mistake. */
function buildUserPrompt(input: PlanInput, priorReasons?: string[]): string {
  const lines: string[] = [];
  lines.push(`Mode: ${input.mode}.`);
  lines.push(`Goal in their words: "${input.goalText || "(none given)"}".`);
  lines.push(`Plan length: ${input.durationWeeks} week(s).`);
  const imperial = input.units === "imperial";
  if (modeTracksFood(input.mode)) {
    if (input.heightCm) {
      lines.push(
        `Height: ${imperial ? `${fmtHeight(input.heightCm, "imperial")} (${Math.round(input.heightCm)} cm)` : `${input.heightCm} cm`}.`,
      );
    }
    if (input.weightKg) {
      lines.push(
        `Weight: ${imperial ? `${Math.round(kgToLb(input.weightKg))} lb (${input.weightKg} kg)` : `${input.weightKg} kg`}.`,
      );
    }
    if (input.goalWeightKg) {
      const dir = input.weightKg && input.goalWeightKg < input.weightKg ? "lose" : input.weightKg && input.goalWeightKg > input.weightKg ? "gain" : "reach";
      const shown = imperial ? `${Math.round(kgToLb(input.goalWeightKg))} lb` : `${input.goalWeightKg} kg`;
      lines.push(`Goal weight: ${shown} (they want to ${dir} weight to reach it) — reference it in the plan.`);
    }
    if (input.age) lines.push(`Age: ${input.age}.`);
    if (input.sex) lines.push(`Sex (for calorie floor only): ${input.sex}.`);
  }
  if (imperial) {
    lines.push(
      "UNITS: the user reads IMPERIAL. Every user-facing string (summary, goal labels/details) MUST use imperial numbers (lb, oz, ft/in) — never kg/km/cm.",
    );
  }
  if (priorReasons?.length) {
    lines.push(
      `Your previous attempt was REJECTED for: ${priorReasons.join("; ")}. Fix these exactly and return valid JSON.`,
    );
  }
  return lines.join("\n");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A daily calorie target from the model: null unless it's a positive, sane
 *  number of kcal (0 and negatives mean "the model didn't give us one"). */
const clampKcal = (v: unknown): number | null => {
  const n = toIntInRange(v, 0, 6000);
  return n === null || n <= 0 ? null : n;
};

const VALID_KINDS = new Set<GeneratedGoal["kind"]>(["nutrition", "workout", "habit"]);

/** Keys a model might use for a goal's user-facing text (schema drift tolerance). */
const GOAL_LABEL_KEYS = ["label", "text", "name", "title", "goal", "description"];

/** Guess a goal's kind from its wording when the model omits/mislabels it. */
function inferKind(text: string): GeneratedGoal["kind"] {
  const t = text.toLowerCase();
  if (/\b(cal|calorie|protein|carb|fat|eat|food|meal|nutrition|hydrat|water|diet)\b/.test(t)) return "nutrition";
  if (/\b(workout|exercise|run|walk|jog|bike|lift|rep|set|squat|push|pull|plank|cardio|strength|train|session|mile|5k|murph)\b/.test(t))
    return "workout";
  return "habit";
}

/**
 * Coerce one goal entry into our shape. Tolerant on purpose: the hosted
 * free-tier model (Haiku) often returns goals as plain strings or with a
 * different key than "label"/"kind" — the strict old parser rejected those and
 * forced the fallback ("AI response couldn't be understood"). Accept strings,
 * alternate label keys, and a missing/odd kind (inferred from the wording).
 */
function coerceGoal(g: unknown): GeneratedGoal | null {
  if (typeof g === "string") {
    const label = g.trim().slice(0, 120);
    return label ? { label, kind: inferKind(label) } : null;
  }
  if (!g || typeof g !== "object") return null;
  const go = g as Record<string, unknown>;
  let label = "";
  for (const k of GOAL_LABEL_KEYS) {
    const v = go[k];
    if (typeof v === "string" && v.trim()) {
      label = v.trim().slice(0, 120);
      break;
    }
  }
  if (!label) return null;
  const detail = typeof go.detail === "string" ? go.detail.trim().slice(0, 200) : undefined;
  const kind = VALID_KINDS.has(go.kind as GeneratedGoal["kind"])
    ? (go.kind as GeneratedGoal["kind"])
    : inferKind(`${label} ${detail ?? ""}`);
  return detail ? { label, kind, detail } : { label, kind };
}

/** Why a core parse failed — drives a specific, non-generic failure reason. */
type CoreFail = "truncated" | "invalid_json" | "no_goals";

type CoreParse = { plan: GeneratedPlan } | { plan: null; kind: CoreFail };

/**
 * Parse the plan response (summary + calories + goals). A valid plan needs
 * only goals. Returns a typed failure so the caller can tell "came back too
 * long" from "no goals" instead of the old catch-all "couldn't be understood".
 */
function parseCore(raw: string): CoreParse {
  const extracted = extractJson(raw);
  let json: unknown;
  try {
    json = JSON.parse(extracted);
  } catch {
    // A response cut off mid-object won't end in a closing brace — distinguish
    // "too long / truncated" from genuinely malformed JSON.
    const truncated = extracted.trim().length > 0 && !extracted.trimEnd().endsWith("}");
    return { plan: null, kind: truncated ? "truncated" : "invalid_json" };
  }
  if (!json || typeof json !== "object") return { plan: null, kind: "invalid_json" };
  const o = json as Record<string, unknown>;
  // Some models nest everything under a top-level "plan" wrapper.
  const inner = o.plan && typeof o.plan === "object" ? (o.plan as Record<string, unknown>) : o;

  // Goals may arrive as an array (of objects OR strings) or an object map.
  const rawGoals = Array.isArray(inner.goals)
    ? inner.goals
    : inner.goals && typeof inner.goals === "object"
      ? Object.values(inner.goals as Record<string, unknown>)
      : [];
  const goals: GeneratedGoal[] = [];
  for (const g of rawGoals.slice(0, MAX_GOALS)) {
    const goal = coerceGoal(g);
    if (goal) goals.push(goal);
  }
  if (goals.length === 0) return { plan: null, kind: "no_goals" };
  const summary =
    typeof inner.summary === "string" ? inner.summary.trim().slice(0, 200)
    : typeof inner.overview === "string" ? (inner.overview as string).trim().slice(0, 200)
    : "Your plan";
  return {
    plan: {
      summary,
      dailyCalorieTarget: clampKcal(inner.dailyCalorieTarget ?? inner.calorieTarget ?? inner.calories),
      goals,
    },
  };
}

/** Generate the core plan (goals). Throws on transport error; typed failure otherwise. */
async function generateCore(input: PlanInput, priorReasons?: string[]): Promise<CoreParse> {
  const raw = await complete({
    system: SYSTEM_CORE,
    messages: [{ role: "user", content: buildUserPrompt(input, priorReasons) }],
    maxTokens: 900,
    tier: "capable",
  });
  const res = parseCore(raw);
  if (!res.plan && import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.warn(`[plan-gen] core parse failed (${res.kind}):\n${raw}`);
  }
  return res;
}

const CORE_FAIL_MESSAGE: Record<CoreFail, string> = {
  truncated: "the AI plan came back too long to finish",
  invalid_json: "the AI response wasn't valid JSON",
  no_goals: "the AI response didn't include any goals",
};

const CORE_RETRY_HINT = [
  'return ONLY a short JSON object with a top-level "goals" array of 3-6 items, each { "label": string, "kind": "nutrition"|"habit" } — no workout goals',
];

/** Convert a generated plan + wizard inputs + ack into the persisted domain Plan. */
export function buildPlan(gen: GeneratedPlan, input: PlanInput, liability: LiabilityAck): Plan {
  const startDate = input.startDate ?? todayISO();
  const endDate = input.endDate ?? shiftDate(startDate, input.durationWeeks * 7 - 1);
  const goals: PlanGoal[] = gen.goals.map((g, i) => {
    const goal: PlanGoal = { id: `${i}-${newId()}`, label: g.label, kind: g.kind };
    // Carry the AI's detail through for future automation.
    if (g.detail) goal.detail = g.detail;
    return goal;
  });
  // Structured targets: the calorie target plus a macro split, so the plan — not
  // a free-text goal string — is the source of truth the diary rings read from.
  // Prefer the locally-computed target (Mifflin) over the AI's number.
  const kcal = input.calorieTarget ?? gen.dailyCalorieTarget;
  const targets: PlanTargets =
    kcal != null ? { dailyCalories: kcal, ...macrosForCalories(kcal, input.weightKg ?? 70) } : { dailyCalories: null };
  return {
    id: newId(),
    mode: input.mode,
    durationWeeks: input.durationWeeks,
    startDate,
    endDate,
    goals,
    targets,
    safety: input.safety,
    liability,
    createdAt: new Date().toISOString(),
    // Persist the free-text goal so the plan editor can prefill it and the
    // new-vs-modify diff can tell whether the goal itself changed.
    ...(input.goalText ? { goalText: input.goalText } : {}),
  };
}

/** Coarse phase the wizard shows while a plan is being built. */
export type PlanStage = "calories" | "goals" | "checking";

/** Optional hooks for a `createPlan` call. */
export interface CreatePlanOptions {
  /** Fires as generation moves through its real phases (for the spinner). */
  onStage?: (stage: PlanStage) => void;
}

/** The outcome of plan generation, including whether it fell back to a
 *  template and why — the review screen surfaces both. */
export interface CreatePlanResult {
  plan: Plan;
  gen: GeneratedPlan;
  usedFallback: boolean;
  /** When usedFallback, WHY — the AI error or the validation reasons. Surfaced
   *  for diagnostics instead of being silently swallowed. */
  failureReason?: string;
}

/**
 * The wizard's plan call: generate → validate → retry (with the reasons) →
 * fallback template. Never throws. The calorie target is supplied locally
 * (`input.calorieTarget`, from Mifflin) so a plan is NOT rejected just because
 * the model omitted the number — the #1 cause of unwanted fallbacks. When it
 * does fall back, `failureReason` records exactly why.
 */
export async function createPlan(
  input: PlanInput,
  liability: LiabilityAck,
  opts?: CreatePlanOptions,
): Promise<CreatePlanResult> {
  const ctx = { mode: input.mode, sex: input.sex };
  const onStage = opts?.onStage;

  // The app owns the calorie target; the AI never needs to supply it.
  const withTarget = (g: GeneratedPlan): GeneratedPlan =>
    input.calorieTarget != null ? { ...g, dailyCalorieTarget: input.calorieTarget } : g;

  let lastReasons: string[] = [];
  let lastError: string | undefined;

  // The calorie + safety phases are near-instant, so without a small dwell the
  // spinner would only ever visibly show "Building your plan". These pauses
  // make the honest three-stage readout actually readable.
  onStage?.("calories");
  await sleep(650);

  if (!isAiAvailable()) {
    lastError = "the AI service isn't available in this environment";
  } else {
    for (let attempt = 0; attempt < 2; attempt++) {
      onStage?.("goals");
      try {
        const core = await generateCore(input, attempt > 0 ? lastReasons : undefined);
        if (!core.plan) {
          lastError = CORE_FAIL_MESSAGE[core.kind];
          lastReasons = CORE_RETRY_HINT;
          continue;
        }
        const candidate = withTarget(core.plan);
        onStage?.("checking");
        await sleep(300);
        const v = validatePlan(candidate, ctx);
        if (!v.ok) {
          lastReasons = v.reasons;
          lastError = undefined;
          continue;
        }
        return { plan: buildPlan(candidate, input, liability), gen: candidate, usedFallback: false };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  onStage?.("checking");
  await sleep(500);
  const gen = withTarget(fallbackPlan(input.mode));
  const failureReason = lastError ?? (lastReasons.length ? lastReasons.join("; ") : "unknown");
  return { plan: buildPlan(gen, input, liability), gen, usedFallback: true, failureReason };
}
