/**
 * The coach's AI interface — evaluate a submitted check-in, chat free-form,
 * and (in either) apply a SMALL plan adjustment. Adjustments reuse the exact
 * machinery of the adaptation engine (analyze.ts): same bounded op set, same
 * applyAdjustment, same validateProgram rails — so nothing the coach does can
 * degrade a valid plan; a failed parse/validation is a strict no-op.
 */

import type { Plan } from "../../types";
import { complete, extractJson, isAiAvailable, type ChatMessage } from "../../bridge/ai";
import { todayISO } from "../diary";
import { applyAdjustment, parseAdjustment, type PlanAdjustment } from "../plan/analyze";
import { validateProgram } from "../plan/validate";
import { applyCoachPlanChange, saveProgram, type CoachPlanChange } from "../plan/planService";
import { renderMemory } from "./context";
import { remember } from "./memory";
import type {
  CheckinKind,
  CoachAnswer,
  CoachContext,
  CoachEventKind,
  CoachMetric,
  CoachOutcome,
  CoachProposal,
} from "./model";

const ADJUSTMENT_SHAPE = `{ "summary": string, "deload"?: boolean, "benchmarkTargetDelta"?: number,
  "changes": [ { "op": "setReps"|"setWeight"|"setRest"|"swap", "exerciseKey": string, "reps"?: number, "weightKg"?: number, "restSec"?: number, "toName"?: string } ] }`;

const PLAN_CHANGE_SHAPE = `{ "summary": string, "goalWeightKg"?: number (KILOGRAMS), "dailyCalories"?: number, "endDate"?: "YYYY-MM-DD" }`;

const EVAL_SYSTEM = `You are the user's wellness coach inside their fitness app. Friendly, brief, specific — never a doctor.
They just answered a short check-in. Reply with ONLY a JSON object:
  { "reply": string,
    "notes": string[],
    "summary": string,
    "adjustment": ${ADJUSTMENT_SHAPE} | null }
Rules:
- "reply": 1-3 encouraging sentences reacting to THEIR answers and history. Reference specifics (a PR, a trend, their words). No generic filler.
- "notes": 0-3 SHORT durable facts worth remembering long-term (preferences, constraints, recurring struggles). Empty array if none.
- "summary": one paragraph (<80 words) updating the running summary of their journey, folding in today.
- "adjustment": null unless their answers CLEARLY warrant a small program tweak (e.g. everything too hard -> ease off; too easy -> nudge up). Prefer null. "exerciseKey" must be a key from the program exercises listed in the context. Keep changes tiny and safe.
- Output ONLY the JSON. No prose, no markdown fences.`;

const CHAT_SYSTEM_BASE = `You are the user's personal trainer + nutrition coach inside their fitness app ("Conjure Health"). Warm, direct, practical. You are NOT a doctor — for pain, injury, or medical questions, advise seeing a professional.
You can see their real data (plan, food, weight, workouts, check-ins, past plans) and your own memory of them — use it; reference specifics instead of generic advice.

CHANGING THEIR PROGRAM — always ASK first, never apply silently. When you want to change the workout program (they asked, or you can see they need it), include ONE block:
<propose>{ "rationale": string, "question": string, "type": "single" | "multi", "options": [ { "label": string } ] }</propose>
- 2–4 short, concrete options (e.g. "Ease off — lighter legs this week", "Swap squats for something kinder", "Add a rest day"). The app ALWAYS adds a free-text box and a "Leave it as is" choice — don't add those yourself.
- "type": "single" when the options are mutually exclusive, "multi" when they could stack.
ONLY AFTER the user answers a proposal, apply the change with ONE block:
- Workout program (reps/weights/rest/swaps): <adjust>${ADJUSTMENT_SHAPE}</adjust> using ONLY exerciseKeys listed in the context.
- Plan-level (their goal weight, daily calorie target, or plan end date): <planchange>${PLAN_CHANGE_SHAPE}</planchange>. You CAN change these now — changing goal weight also recomputes their calorie target. goalWeightKg is in KILOGRAMS (convert if they speak in lb).
The app validates + applies whichever block(s) you include. If they decline, leave things and say so warmly. Ask AT MOST ONE follow-up <propose> before you apply or drop it. Never mention these tags.

MEMORY — when the user shares something durable worth remembering (a preference, dislike, constraint, injury, schedule, or goal — e.g. "I hate burpees", "I train early", "my knee is cranky"), silently record it by including ONE block: <remember>{ "notes": string[], "summary"?: string }</remember> — 0-3 short notes, optionally an updated one-paragraph running summary. This shapes their FUTURE workouts too. Never mention this tag.
Keep replies short (2-5 sentences) unless they ask for detail.`;

/**
 * Apply a coach-proposed adjustment through the same rails as the adaptation
 * engine. Returns the persisted plan, or null when there's no program, the
 * adjustment is empty, or validation fails (no-op).
 */
async function applyToPlan(plan: Plan | null, adj: PlanAdjustment): Promise<Plan | null> {
  if (!plan?.program) return null;
  if (adj.changes.length === 0 && !adj.deload && adj.benchmarkTargetDelta == null) return null;
  const candidate = applyAdjustment(plan.program, adj);
  const reasons = validateProgram(candidate, plan.mode, plan.safety.injuries ?? []);
  if (reasons.length > 0) return null;
  return saveProgram(plan, candidate);
}

const metricsFrom = (answers: CoachAnswer[]): CoachMetric[] => {
  const now = new Date().toISOString();
  const date = todayISO();
  return answers
    .filter((a): a is CoachAnswer & { scale: number; metricKey: string } => a.scale != null && a.metricKey != null)
    .map((a) => ({ at: now, date, key: a.metricKey, value: a.scale }));
};

const answersBlock = (answers: CoachAnswer[]): string =>
  answers.map((a) => `Q: ${a.question}\nA: ${a.value}`).join("\n");

/**
 * Evaluate a submitted check-in (post-workout or end-of-day): coach reply,
 * memory update (notes/summary/event/metrics), and an optional validated plan
 * tweak. Never throws; without an AI bridge the check-in is still recorded.
 */
export async function evaluateCheckin(
  kind: CheckinKind,
  answers: CoachAnswer[],
  ctx: CoachContext,
): Promise<CoachOutcome> {
  const eventKind: CoachEventKind = kind === "workout" ? "workout_reflect" : "day_checkin";
  const at = new Date().toISOString();
  const eventText = answers.map((a) => `${a.question} → ${a.value}`).join(" · ");
  const metrics = metricsFrom(answers);

  if (!isAiAvailable()) {
    await remember({ events: [{ at, kind: eventKind, text: eventText }], metrics });
    return { reply: "Logged — thanks for checking in. Keep it up!" };
  }

  try {
    const raw = await complete({
      system: EVAL_SYSTEM,
      messages: [
        {
          role: "user",
          content: `CONTEXT\n${ctx.rendered}\n\nCOACH MEMORY\n${renderMemory(ctx)}\n\nCHECK-IN (${kind})\n${answersBlock(answers)}`,
        },
      ],
      maxTokens: 1024,
      tier: "capable",
    });
    const o = JSON.parse(extractJson(raw)) as Record<string, unknown>;
    const reply =
      typeof o.reply === "string" && o.reply.trim() ? o.reply.trim() : "Logged — thanks for checking in.";
    const notes = Array.isArray(o.notes) ? o.notes.filter((n): n is string => typeof n === "string") : [];
    const summary = typeof o.summary === "string" ? o.summary : undefined;

    let planUpdate: CoachOutcome["planUpdate"];
    if (o.adjustment && typeof o.adjustment === "object") {
      const adj = parseAdjustment(JSON.stringify(o.adjustment));
      if (adj) {
        const updated = await applyToPlan(ctx.plan, adj);
        if (updated) planUpdate = { plan: updated, summary: adj.summary };
      }
    }

    await remember({
      notes,
      summary,
      metrics,
      events: [
        { at, kind: eventKind, text: eventText },
        ...(planUpdate ? [{ at, kind: "plan_adjusted" as const, text: planUpdate.summary }] : []),
      ],
    });
    return { reply, planUpdate };
  } catch {
    await remember({ events: [{ at, kind: eventKind, text: eventText }], metrics });
    return { reply: "Logged — thanks for checking in. Keep it up!" };
  }
}

/** Parse a `<propose>` block into a CoachProposal, or null if absent/invalid. */
function parseProposal(raw: string): CoachProposal | null {
  const m = raw.match(/<propose>([\s\S]*?)<\/propose>/);
  if (!m?.[1]) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(extractJson(m[1])) as Record<string, unknown>;
  } catch {
    return null;
  }
  const question = typeof o.question === "string" ? o.question.trim().slice(0, 160) : "";
  if (!question) return null;
  const rawOptions = Array.isArray(o.options) ? o.options : [];
  const options = rawOptions
    .map((op) => {
      if (typeof op === "string") return { label: op.trim().slice(0, 80) };
      if (op && typeof op === "object" && typeof (op as { label?: unknown }).label === "string")
        return { label: (op as { label: string }).label.trim().slice(0, 80) };
      return null;
    })
    .filter((op): op is { label: string } => Boolean(op?.label))
    .slice(0, 4);
  if (options.length === 0) return null;
  return {
    question,
    type: o.type === "multi" ? "multi" : "single",
    options,
    ...(typeof o.rationale === "string" && o.rationale.trim()
      ? { rationale: o.rationale.trim().slice(0, 240) }
      : {}),
  };
}

const stripTags = (s: string): string =>
  s
    .replace(/<propose>[\s\S]*?<\/propose>/g, "")
    .replace(/<adjust>[\s\S]*?<\/adjust>/g, "")
    .replace(/<planchange>[\s\S]*?<\/planchange>/g, "")
    .replace(/<remember>[\s\S]*?<\/remember>/g, "")
    .trim();

/** Parse a `<remember>` block into notes + summary, or null if absent/empty. */
function parseRemember(raw: string): { notes?: string[]; summary?: string } | null {
  const m = raw.match(/<remember>([\s\S]*?)<\/remember>/);
  if (!m?.[1]) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(extractJson(m[1])) as Record<string, unknown>;
  } catch {
    return null;
  }
  const notes = Array.isArray(o.notes)
    ? o.notes.filter((n): n is string => typeof n === "string" && n.trim().length > 0).slice(0, 3)
    : [];
  const summary = typeof o.summary === "string" && o.summary.trim() ? o.summary : undefined;
  if (notes.length === 0 && !summary) return null;
  return { ...(notes.length ? { notes } : {}), ...(summary ? { summary } : {}) };
}

/** Parse a `<planchange>` block into a CoachPlanChange, or null if absent/empty. */
function parsePlanChange(raw: string): CoachPlanChange | null {
  const m = raw.match(/<planchange>([\s\S]*?)<\/planchange>/);
  if (!m?.[1]) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(extractJson(m[1])) as Record<string, unknown>;
  } catch {
    return null;
  }
  const numOf = (v: unknown): number | undefined => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const change: CoachPlanChange = {
    summary: typeof o.summary === "string" && o.summary.trim() ? o.summary.trim().slice(0, 200) : "Updated your plan",
  };
  const gw = numOf(o.goalWeightKg);
  if (gw != null) change.goalWeightKg = gw;
  const cal = numOf(o.dailyCalories);
  if (cal != null) change.dailyCalories = cal;
  if (typeof o.endDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.endDate)) change.endDate = o.endDate;
  if (change.goalWeightKg == null && change.dailyCalories == null && change.endDate == null) return null;
  return change;
}

/** Per-turn switches that govern how much authority the coach has to change
 *  things. Both default to the safest reading when omitted. */
export interface CoachChatOptions {
  /** True when this turn is the user answering a pending proposal — only then
   *  may a returned <adjust> actually apply. */
  answering?: boolean;
  /** False once the one-follow-up budget is spent — a returned <propose> is
   *  dropped (the coach must apply or drop the change instead of asking again). */
  canPropose?: boolean;
}

/**
 * One free-form chat turn with the trainer. `history` includes the user's
 * newest message last. Plan changes are ASK-FIRST: a `<propose>` block is
 * surfaced to the user as choices (never applied); an `<adjust>` block only
 * applies when the user is answering a prior proposal (`answering`). If the
 * coach tries to `<adjust>` cold, it's converted into a confirm proposal so the
 * user always gets the final say.
 */
export async function coachChat(
  history: ChatMessage[],
  ctx: CoachContext,
  opts?: CoachChatOptions,
): Promise<CoachOutcome> {
  if (!isAiAvailable()) {
    return {
      reply:
        "Your coach needs the ConjureOS AI service, which isn't available right now — try again inside ConjureOS.",
    };
  }
  const system = `${CHAT_SYSTEM_BASE}\n\nCONTEXT\n${ctx.rendered}\n\nCOACH MEMORY\n${renderMemory(ctx)}`;
  const raw = await complete({ system, messages: history.slice(-16), maxTokens: 1024, tier: "capable" });
  const reply = stripTags(raw);

  // 0. Learn from the conversation: persist any durable notes/summary the coach
  //    extracted (silent, best-effort) — this is what makes chat feedback shape
  //    FUTURE workouts, not just the current reply.
  const mem = parseRemember(raw);
  if (mem) await remember(mem);

  // 1. A proposal (the ask) takes precedence, unless the follow-up budget is spent.
  if (opts?.canPropose !== false) {
    const proposal = parseProposal(raw);
    if (proposal) return { reply: reply || proposal.question, proposal };
  }

  // 2. Changes — program (<adjust>) and/or plan-level (<planchange>). Only apply
  //    when the user is answering a prior proposal; otherwise convert to a
  //    confirm proposal so nothing changes unasked.
  const adjMatch = raw.match(/<adjust>([\s\S]*?)<\/adjust>/);
  const adj = adjMatch?.[1] ? parseAdjustment(adjMatch[1]) : null;
  const planChange = parsePlanChange(raw);

  if (adj || planChange) {
    if (opts?.answering) {
      let plan = ctx.plan;
      const summaries: string[] = [];
      if (planChange) {
        const res = await applyCoachPlanChange(plan, ctx.profile, ctx.goals, planChange).catch(() => null);
        if (res) {
          plan = res.plan;
          summaries.push(planChange.summary);
        }
      }
      if (adj) {
        const updated = await applyToPlan(plan, adj);
        if (updated) {
          plan = updated;
          summaries.push(adj.summary);
        }
      }
      if (plan && plan !== ctx.plan && summaries.length) {
        const summary = summaries.join("; ");
        await remember({
          events: [{ at: new Date().toISOString(), kind: "plan_adjusted", text: summary }],
        });
        return {
          reply: reply ? `${reply}\n\n✓ Plan updated: ${summary}` : `✓ Plan updated: ${summary}`,
          planUpdate: { plan, summary },
        };
      }
      return { reply: reply || "I couldn't apply that change safely, so I left your plan as-is." };
    }
    if (opts?.canPropose !== false) {
      // Coach jumped to a change without asking — turn it into a confirmation.
      return {
        reply,
        proposal: {
          question: "Want me to apply this change?",
          rationale: planChange?.summary ?? adj?.summary,
          type: "single",
          options: [{ label: "Yes, apply it" }],
        },
      };
    }
  }

  return { reply: reply || "…" };
}
