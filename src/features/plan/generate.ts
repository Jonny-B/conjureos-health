/**
 * Plan generation (P2 / THE HOOK). One `ai.complete` call turns the wizard's
 * inputs into a structured plan, guarded by the safety layers:
 *   - the system prompt opens "wellness coach, not a doctor",
 *   - the user's injury-excluded movements are injected as a hard avoid-list,
 *   - the result is validated (validate.ts); on failure we retry once, then
 *     drop to a hardcoded fallback template.
 *
 * `createPlan` is the single entry point the wizard calls; it returns the
 * assembled, ready-to-save domain `Plan` plus whether the fallback was used.
 */

import type { LiabilityAck, Plan, PlanGoal, PlanTargets, WorkoutProgram } from "../../types";
import { complete, extractJson, isAiAvailable } from "../../bridge/ai";
import { newId } from "../../data/id";
import { shiftDate, todayISO } from "../diary";
import { macrosForCalories } from "../goals";
import { fmtHeight, kgToLb } from "../units";
import { movementsExcludedFor } from "../safety/injuryExclusions";
import type { GeneratedGoal, GeneratedPlan, PlanInput } from "./model";
import { modeHasWorkouts, modeTracksFood } from "./model";
import { parseProgram } from "./program";
import { validatePlan, validateProgram } from "./validate";
import { fallbackPlan, fallbackProgram } from "./fallbackTemplates";
import { toIntInRange } from "../num";

/**
 * Generation is split into TWO calls, not one, on purpose. A single call for
 * "goals + a full multi-workout program" overflows the model's output budget
 * and gets truncated mid-JSON — which threw away the WHOLE plan (goals and all)
 * as "couldn't be understood," forcing the starter template every time. A valid
 * plan only needs goals (the program is optional), so we generate the small,
 * truncation-proof core first, then the bulky program as a separate best-effort
 * step whose failure can't sink the plan.
 */
const SYSTEM_CORE = `You are a wellness coach, not a doctor. You give friendly suggestions, not medical prescriptions.
Design a specific, personalized wellness plan from the user's inputs — tailored to THEIR stated goal, experience level, and schedule. Avoid generic filler. Return ONLY a small JSON object:
  { "summary": string,
    "dailyCalorieTarget": number | null,
    "goals": [ { "label": string, "kind": "nutrition" | "workout" | "habit", "detail"?: string } ] }
Rules:
- "summary" is one encouraging sentence naming what THIS plan will do for their specific goal.
- "dailyCalorieTarget" is optional — if unsure, use null; the app supplies its own number.
- 3 to 6 goals, each a short daily/weekly action tied to their goal. Use "nutrition" for food, "workout" for exercise, "habit" for everything else. For a "workout" goal, put the specific movements in "detail".
- Do NOT include a workout program here — only the fields above. Keep it short.
- Respect any HARD SAFETY avoid-list exactly.
- Output ONLY the JSON. No prose, no markdown fences.`;

const SYSTEM_PROGRAM = `You are a strength coach designing a workout program for a plan whose goals are already set.
Return ONLY a JSON object with the program:
  { "workouts": [ { "name": string, "kind"?: "strength" | "run" | "bike",
                    "description"?: string,
                    "exercises": [ { "name": string,
                                     "sets": [ { "reps"?: number, "durationSec"?: number, "restSec"?: number, "weightKg"?: number } ],
                                     "notes"?: string } ] } ],
    "benchmarks": [ { "exercise": string, "metric": "reps" | "weightKg" | "durationSec" | "distanceKm", "target": number, "unit": string, "lowerIsBetter"?: boolean } ] }
Rules:
- BENCHMARKS COME FIRST. Pick 1-4 benchmarks that ARE the measurable test of THIS person's goal — the movements they're training, tested at capacity (max reps, a rep-max weight, or a timed effort). For a compound goal (e.g. the Murph: pull-ups, push-ups, a timed run), give ONE benchmark PER component. Never a generic filler like "sit-to-stand" for someone training hard.
- If the goal NAMES a known workout, the benchmarks and the evaluation MUST use exactly its movements — Murph / half Murph = pull-ups + push-ups + air squats + a timed 1-mile run. An evaluation that omits the goal's own movements is WRONG.
- The FIRST workout MUST be the evaluation: name it "Evaluation" (or "<goal> Evaluation"), containing exactly the benchmark movements at max effort ("as many reps as possible", a timed run), so the user tests once and sets every baseline. Each benchmark's "exercise" MUST appear by name in a workout (the evaluation counts).
- Then give the training workouts — one per training day (match "days per week"), up to 5 more, each a distinct session (push / pull / legs / conditioning), 3-8 exercises, built to move those benchmarks. 1-2 sentence "description" each.
- Scale HARD to experience: beginner = form + lighter volume; intermediate/advanced = real named lifts, higher volume, progression, weighted movements. An advanced person must never get a beginner bodyweight routine.
- Sets have reps OR durationSec, plus restSec (metric units: kg, km, seconds). Include a warmup note in the evaluation's first exercise "notes".
- set lowerIsBetter=true for a timed effort (faster wins).
- Respect the user's equipment and any HARD SAFETY avoid-list exactly.
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
  if (input.experienceLevel) lines.push(`Training experience: ${input.experienceLevel}.`);
  if (modeHasWorkouts(input.mode)) {
    if (input.daysPerWeek) lines.push(`Workout days per week: ${input.daysPerWeek} (give about this many distinct workouts).`);
    lines.push(`Equipment: ${input.equipment?.trim() || "none / bodyweight"}.`);
  }
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
      "UNITS: the user reads IMPERIAL. Every user-facing string (summary, goal labels/details, workout names, descriptions, exercise notes) MUST use imperial numbers (lb, miles, ft/in) — never kg/km/cm. Numeric JSON fields (weightKg, distanceKm, durationSec) stay metric.",
    );
  }
  const avoid = movementsExcludedFor(input.safety.injuries);
  if (avoid.length) {
    lines.push(
      `HARD SAFETY RULE — the user has injuries, so NEVER include any movement matching these terms: ${avoid.join(", ")}.`,
    );
  }
  if (input.safety.ageBand === "60_plus") lines.push("Keep intensity gentle (older adult).");
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
 * Parse the CORE response (summary + calories + goals; no program). A valid plan
 * needs only goals, so this is the truncation-proof half. Returns a typed
 * failure so the caller can tell "came back too long" from "no goals" instead of
 * the old catch-all "couldn't be understood".
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

/** Program-generation prompt: the same context, plus the goals we just made. */
function buildProgramPrompt(input: PlanInput, goals: GeneratedGoal[]): string {
  const base = buildUserPrompt(input);
  const goalList = goals.map((g) => `- ${g.label}${g.detail ? ` (${g.detail})` : ""}`).join("\n");
  return `${base}\nThe plan's goals are:\n${goalList}\nDesign the workout program that delivers these goals.`;
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

/**
 * Generate the workout program (best-effort). Returns null on any failure —
 * truncation, transport error, or unparseable output — so the caller can fall
 * back to a template program without sinking the (already valid) plan.
 */
async function generateProgramOnce(
  input: PlanInput,
  goals: GeneratedGoal[],
  priorReason?: string,
): Promise<{ program: WorkoutProgram | null; reason?: string }> {
  let raw: string;
  try {
    raw = await complete({
      system: SYSTEM_PROGRAM,
      messages: [
        {
          role: "user",
          content:
            buildProgramPrompt(input, goals) +
            (priorReason
              ? `\nYour previous attempt was REJECTED for: ${priorReason}. Fix this exactly and return ONLY the compact JSON.`
              : ""),
        },
      ],
      // A full multi-day advanced program with an assessment overflows a smaller
      // budget and truncates → parse fail → the beginner fallback. Give it room.
      maxTokens: 4096,
      tier: "capable",
    });
  } catch (err) {
    return { program: null, reason: err instanceof Error ? err.message : "the AI was unreachable" };
  }
  let json: unknown;
  try {
    json = JSON.parse(extractJson(raw));
  } catch {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn(`[plan-gen] program parse failed:\n${raw}`);
    }
    const truncated = !extractJson(raw ?? "").trim().endsWith("}");
    return {
      program: null,
      reason: truncated
        ? "the output was cut off — return more COMPACT JSON (shorter descriptions, fewer exercises)"
        : "the output wasn't valid JSON",
    };
  }
  const o = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  // Accept either a bare program object or one wrapped in { program: {...} }.
  const progObj = o.program && typeof o.program === "object" ? o.program : o;
  const program = parseProgram(progObj);
  return program
    ? { program }
    : { program: null, reason: "the JSON was missing required workouts/benchmarks fields" };
}

/**
 * Generate the workout program with ONE retry, feeding the rejection reason
 * back so the model fixes it instead of repeating it (the same treatment the
 * core call already gets). Exported so the wizard's "Rebuild workouts" action
 * can re-run JUST this half without regenerating the goals.
 */
export async function regenerateProgram(
  input: PlanInput,
  goals: GeneratedGoal[],
  injuries: string[],
): Promise<{ program: WorkoutProgram | null; reason?: string }> {
  let reason: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await generateProgramOnce(input, goals, reason);
    if (res.program) {
      const rs = validateProgram(res.program, input.mode, injuries);
      if (rs.length === 0) return { program: res.program };
      reason = rs.join("; ");
    } else {
      reason = res.reason;
    }
  }
  return { program: null, reason };
}

const CORE_FAIL_MESSAGE: Record<CoreFail, string> = {
  truncated: "the AI plan came back too long to finish",
  invalid_json: "the AI response wasn't valid JSON",
  no_goals: "the AI response didn't include any goals",
};

const CORE_RETRY_HINT = [
  'return ONLY a short JSON object with a top-level "goals" array of 3-6 items, each { "label": string, "kind": "nutrition"|"workout"|"habit" } — no workout program',
];

/** Convert a generated plan + wizard inputs + ack into the persisted domain Plan. */
export function buildPlan(gen: GeneratedPlan, input: PlanInput, liability: LiabilityAck): Plan {
  const startDate = input.startDate ?? todayISO();
  const endDate = input.endDate ?? shiftDate(startDate, input.durationWeeks * 7 - 1);
  const goals: PlanGoal[] = gen.goals.map((g, i) => {
    const goal: PlanGoal = { id: `${i}-${newId()}`, label: g.label, kind: g.kind };
    // Carry the AI's movement/nutrition detail through for future automation.
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
    // Attach the adaptive program (W4) when generation produced one and the
    // mode actually prescribes workouts. Food-only plans never carry a program.
    ...(gen.program && modeHasWorkouts(input.mode) ? { program: gen.program } : {}),
  };
}

/** Coarse phase the wizard shows while a plan is being built. */
export type PlanStage = "calories" | "workouts" | "checking";

/** Optional hooks for a `createPlan` call. */
export interface CreatePlanOptions {
  /** Fires as generation moves through its real phases (for the spinner). */
  onStage?: (stage: PlanStage) => void;
}

/** The outcome of plan generation, including whether either half fell back
 *  to a template and why — the review screen surfaces both. */
export interface CreatePlanResult {
  plan: Plan;
  gen: GeneratedPlan;
  usedFallback: boolean;
  /** When usedFallback, WHY — the AI error or the validation reasons. Surfaced
   *  for diagnostics instead of being silently swallowed. */
  failureReason?: string;
  /** Goals are AI-built but the WORKOUT PROGRAM fell back to the starter
   *  template (both program attempts failed). The review flags it and offers a
   *  "Rebuild workouts" retry so a generic evaluation never masquerades as a
   *  goal-tuned one. */
  programFallback?: boolean;
  programFallbackReason?: string;
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
  const ctx = { mode: input.mode, sex: input.sex, safety: input.safety };
  const onStage = opts?.onStage;

  // The app owns the calorie target; the AI never needs to supply it.
  const withTarget = (g: GeneratedPlan): GeneratedPlan =>
    input.calorieTarget != null ? { ...g, dailyCalorieTarget: input.calorieTarget } : g;

  let lastReasons: string[] = [];
  let lastError: string | undefined;

  // The calorie + safety phases are near-instant, so without a small dwell the
  // spinner would only ever visibly show "Building your workouts". These pauses
  // make the honest three-stage readout actually readable.
  onStage?.("calories");
  await sleep(650);

  if (!isAiAvailable()) {
    lastError = "the AI service isn't available in this environment";
  } else {
    const injuries = input.safety.injuries ?? [];
    for (let attempt = 0; attempt < 2; attempt++) {
      onStage?.("workouts");
      try {
        // 1. Core goals — the small, truncation-proof half. A valid plan needs
        //    only this.
        const core = await generateCore(input, attempt > 0 ? lastReasons : undefined);
        if (!core.plan) {
          lastError = CORE_FAIL_MESSAGE[core.kind];
          lastReasons = CORE_RETRY_HINT;
          continue;
        }
        let candidate = withTarget(core.plan);
        onStage?.("checking");
        await sleep(300);
        const v = validatePlan(candidate, ctx);
        if (!v.ok) {
          lastReasons = v.reasons;
          lastError = undefined;
          continue;
        }

        // 2. Program — bulky + optional. Best-effort AI program (kept only if it
        //    passes the same safety rails), else the known-safe starter program
        //    so the Workouts tab isn't empty. Never sinks the AI plan.
        let programFallback = false;
        let programFallbackReason: string | undefined;
        if (modeHasWorkouts(input.mode)) {
          onStage?.("workouts");
          const res = await regenerateProgram(input, core.plan.goals, injuries).catch(() => ({
            program: null as WorkoutProgram | null,
            reason: "the AI was unreachable",
          }));
          if (res.program) {
            candidate = { ...candidate, program: res.program };
          } else {
            // Attach the safe starter so the Plan tab isn't empty — but SAY SO:
            // a generic evaluation next to goal-specific AI goals reads as "the
            // app ignored my goal" unless the review flags it and offers a
            // rebuild.
            const tmpl = fallbackProgram(input.mode, injuries, input.experienceLevel);
            if (tmpl) candidate = { ...candidate, program: tmpl };
            programFallback = Boolean(tmpl);
            programFallbackReason = res.reason;
          }
        }
        return {
          plan: buildPlan(candidate, input, liability),
          gen: candidate,
          usedFallback: false,
          ...(programFallback ? { programFallback, programFallbackReason } : {}),
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  onStage?.("checking");
  await sleep(500);
  const gen = withTarget(fallbackPlan(input.mode, input));
  const failureReason = lastError ?? (lastReasons.length ? lastReasons.join("; ") : "unknown");
  return { plan: buildPlan(gen, input, liability), gen, usedFallback: true, failureReason };
}
