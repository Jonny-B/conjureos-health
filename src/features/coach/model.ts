/**
 * Coach domain model (Phase 2). The coach is the app-wide AI trainer: it asks
 * short check-in questions after workouts and at the end of the day, keeps a
 * durable memory of what it learns, chats free-form, and can apply small,
 * validated adjustments to the active plan. Everything persists to the VFS
 * (coach.json / coach-chat.json) — no new backend surface.
 */

import type { Goals, Plan, Profile } from "../../types";

// ── Memory ───────────────────────────────────────────────────────────

/** The kinds of notable moment the coach records in its memory timeline. */
export type CoachEventKind =
  | "workout_reflect"
  | "day_checkin"
  | "plan_started"
  | "plan_adjusted"
  | "note";

/** One timeline entry — something the coach should remember happened. */
export interface CoachEvent {
  /** ISO timestamp. */
  at: string;
  kind: CoachEventKind;
  text: string;
}

/** One numeric data point from a check-in (difficulty, day rating, energy…). */
export interface CoachMetric {
  /** ISO timestamp. */
  at: string;
  /** YYYY-MM-DD the metric belongs to. */
  date: string;
  /** e.g. "workout_difficulty", "day_rating", "day_energy" — 1–5 scales. */
  key: string;
  value: number;
}

/**
 * The coach's durable memory, one VFS doc (`coach.json`). Additive shape;
 * lists are capped on write so the doc never grows unbounded.
 */
export interface CoachMemory {
  v: 1;
  /** Durable facts/preferences ("hates burpees", "night-shift schedule"). */
  notes: string[];
  /** Model-maintained one-paragraph running summary of the user's journey. */
  summary?: string;
  /** Notable events, newest first. */
  events: CoachEvent[];
  /** Check-in metrics, newest first. */
  metrics: CoachMetric[];
}

/** A blank coach memory. Clone before mutating — this is a shared module
 *  constant, not a fresh object per read. */
export const EMPTY_MEMORY: CoachMemory = { v: 1, notes: [], events: [], metrics: [] };

// ── Check-ins ────────────────────────────────────────────────────────

/** Which check-in a question bank is being drawn for: right after a workout,
 *  or at the end of a day. */
export type CheckinKind = "workout" | "day";

/** One question from the hardcoded bank. `scale` renders 1–5 chips. */
export interface CoachQuestion {
  id: string;
  text: string;
  kind: "scale" | "text";
  /** Scale endpoint labels. */
  low?: string;
  high?: string;
  /** When set, a scale answer is logged as this CoachMetric key. */
  metricKey?: string;
}

/** A user's answer, carried verbatim into the evaluation prompt + memory. */
export interface CoachAnswer {
  id: string;
  question: string;
  /** Display value — "4/5" for scales, the raw text otherwise. */
  value: string;
  /** The numeric value for scale answers. */
  scale?: number;
  metricKey?: string;
}

// ── Context ──────────────────────────────────────────────────────────

/**
 * Everything the coach knows at prompt time. `rendered` is the compact
 * history block (recent food days, weight trend, sessions, check-ins, past
 * plans, memory) built once by context.ts and shared by every coach call.
 */
export interface CoachContext {
  plan: Plan | null;
  profile: Profile | null;
  goals: Goals;
  memory: CoachMemory;
  rendered: string;
}

// ── Plan-change proposals (coach asks before it changes anything) ──────

/** One choice on a coach proposal — a short chip label. */
export interface CoachProposalOption {
  label: string;
}

/**
 * When the coach wants to change the plan it ASKS first, in chat, instead of
 * silently applying. This is that question, rendered as interactive chips (plus
 * a free-text box + a "leave it as is" decline the UI always adds). The user's
 * answer goes back to the coach, which then applies the change (or asks one
 * follow-up). Mirrors the app's own multi/single-choice + free-text prompts.
 */
export interface CoachProposal {
  /** Why the coach is suggesting a change (1–2 sentences). */
  rationale?: string;
  /** The question shown above the choices. */
  question: string;
  /** single = pick one; multi = pick any. Free text is always available too. */
  type: "single" | "multi";
  options: CoachProposalOption[];
}

/** One persisted chat item — a plain message, optionally an assistant proposal. */
export interface CoachChatItem {
  role: "user" | "assistant";
  content: string;
  /** Present on an assistant item that asks the user to choose a change. */
  proposal?: CoachProposal;
  /** True once the user has answered this proposal (locks the card). */
  answered?: boolean;
}

/** Result of an evaluation or chat turn that may have touched the plan. */
export interface CoachOutcome {
  reply: string;
  /** Set when a validated plan adjustment was applied and persisted. */
  planUpdate?: { plan: Plan; summary: string };
  /** Set when the coach wants a change but is ASKING first — the UI renders it
   *  as choice chips + free text; the answer comes back as the next turn. */
  proposal?: CoachProposal;
}
