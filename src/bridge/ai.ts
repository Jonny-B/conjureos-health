/**
 * Wrapper around `window.__conjureos.ai.complete` with a dev-mode mock so
 * natural-language logging is iterable outside ConjureOS. Gated on the
 * `ai.complete` permission. ConjureOS routes to the user's BYK key (Sonnet)
 * or the hosted free-tier proxy (Haiku) — quality differs, shape doesn't.
 */

/**
 * Which model ConjureOS routes a request to. `cheap` for high-volume parsing,
 * `capable` for reasoning (plan generation, coaching), `epic` for the rare
 * heavyweight call. Costs the user more as it climbs, so default to the
 * cheapest tier that produces a usable answer.
 */
export type ModelTier = "cheap" | "capable" | "epic";

/** An image attached to a chat message, for the vision-backed capture flows. */
export interface ChatImage {
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  /** Raw base64 — no `data:image/...;base64,` prefix. */
  data: string;
}

/** One turn of a conversation sent to the model. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Attached images; only meaningful on `user` turns. */
  images?: ChatImage[];
}

/** A single completion request. Mirrors the bridge's wire shape exactly. */
export interface CompleteRequest {
  /** System prompt: the model's role, rules, and required output shape. */
  system: string;
  /** Conversation so far, oldest first. */
  messages: ChatMessage[];
  /** Response cap. Defaults to the host's own limit when omitted. */
  maxTokens?: number;
  /** Model tier; the host picks a sensible default when omitted. */
  tier?: ModelTier;
}

declare global {
  interface ConjureosBridge {
    ai?: {
      complete: (req: CompleteRequest) => Promise<{ content: string }>;
    };
  }
  interface Window {
    __conjureos?: ConjureosBridge;
  }
}

const bridge = () =>
  typeof window !== "undefined" ? window.__conjureos?.ai?.complete : undefined;

/**
 * Whether a real host is present to serve completions. False under `npm run
 * dev`, in tests, and during SSR — `complete` still resolves there, but from
 * the canned mock below, so gate any *user-facing* "ask the AI" affordance on
 * this rather than assuming a live model.
 */
export function isAiAvailable(): boolean {
  return typeof bridge() === "function";
}

/**
 * Run one completion and return the model's text. Falls back to a deterministic
 * mock when no host bridge is present, so every AI-backed flow stays walkable
 * outside ConjureOS.
 *
 * Rejects only if the host itself fails. Callers own the parsing: model output
 * is untrusted text, so pair this with `extractJson` plus explicit validation
 * and always keep a non-AI fallback path.
 */
export async function complete(req: CompleteRequest): Promise<string> {
  const fn = bridge();
  if (fn) return (await fn(req)).content;
  return mockComplete(req);
}

/**
 * Turn a rejected `complete()` into something worth reading.
 *
 * The host rejects with its own reason — "out_of_credits", "rate limit",
 * "ai.complete blocked: this app's window is minimized", "ai timeout" — and
 * every one of those was being reported to the user as "check your
 * connection", which is both wrong and unactionable. Running out of credits
 * is not a network problem and no amount of retrying fixes it.
 *
 * Known reasons map to a sentence that says what to DO. Anything unrecognised
 * keeps the host's own words in parentheses rather than being swallowed: in
 * alpha, a reason we haven't seen before is worth more on screen than a
 * reassuring generic.
 */
export function aiErrorMessage(err: unknown, fallback = "The AI didn't answer. Try again."): string {
  const raw = (err instanceof Error ? err.message : String(err ?? "")).trim();
  const m = raw.toLowerCase();
  // Ordered most-specific first: the proxy's 402/429 bodies mention credits
  // AND limits, so "out of credits" must be decided before the daily cap.
  // Anthropic answers an exhausted account with a 400, not a 402, and the
  // proxy forwards its body verbatim: "Your credit balance is too low to
  // access the Anthropic API." That is the platform's balance (or the user's
  // own pasted key), never their ConjureOS credits, so it gets its own line.
  if (m.includes("credit balance is too low")) {
    return "The AI service is out of credit. Top up the Anthropic account behind ConjureOS (or the key in your settings) and try again.";
  }
  // ConjureOS rewrites that same provider rejection before it reaches the
  // app, so the raw Anthropic sentence rarely arrives. Its hosted wording
  // names "the ConjureOS account"; a user's own key gets "Your Anthropic
  // account". Neither is the user's ConjureOS credits, and neither is a
  // connection problem.
  if (m.includes("conjureos account") && m.includes("out of credit")) {
    return "The AI service ConjureOS uses is out of credit, so estimates are paused. This is on ConjureOS's side, not your credits. Try again later.";
  }
  if (/your (anthropic|openai) account is out of credit/.test(m)) {
    return "Your own AI key is out of credit. Add credit with your AI provider, or remove the key in ConjureOS settings to use your ConjureOS credits.";
  }
  if (m.includes("out_of_credits") || m.includes("out of credits")) {
    return "You're out of AI credits. Top up in ConjureOS settings, or add your own Anthropic key.";
  }
  if (m.includes("daily_cap") || m.includes("free_tier") || m.includes("free-tier") || m.includes("daily")) {
    return "You've used up today's AI allowance. It resets at midnight UTC.";
  }
  if (m.includes("rate limit") || m.includes("rate_limited")) {
    return "Too many AI requests just now. Wait a few seconds and try again.";
  }
  if (m.includes("busy right now") || m.includes("overloaded") || m.includes("temporarily unavailable")) {
    return "The AI service is busy or down for a moment. Try again shortly.";
  }
  if (m.includes("failed to fetch") || m.includes("network") || m.includes("load failed")) {
    return "Couldn't reach the AI. Check your connection and try again.";
  }
  if (m.includes("timeout") || m.includes("timed out")) {
    return "The AI took too long to answer. Try again.";
  }
  if (m.includes("background") || m.includes("minimized")) {
    return "AI is paused while this app isn't the one on screen. Bring it to the front and try again.";
  }
  if (m.includes("sign in") || m.includes("authentication")) {
    return "Sign in to ConjureOS to use AI.";
  }
  if (m.includes("permission")) {
    return "This app doesn't have AI permission yet. Grant it in ConjureOS and try again.";
  }
  if (m.includes("unsupported_model")) {
    return "Your plan can't run the model this needs. Check your ConjureOS plan.";
  }
  if (m.includes("configured") || m.includes("not available") || m.includes("isn't available")) {
    return "AI isn't available here yet.";
  }
  if (!raw) return fallback;
  return `${fallback} (${raw})`;
}

/**
 * Pull the JSON payload out of a model reply.
 *
 * Every JSON-returning prompt in this app ends with "output ONLY the JSON",
 * and models still wrap it in ```fences``` or a sentence of preamble often
 * enough that parsing the raw string is a reliable source of failures.
 *
 * Worse, a model may answer TWICE — Sonnet reliably does this for the meal
 * prompt, emitting an object, then "Let me correct that — carbs must be a
 * number:", then a corrected object. Taking the widest `{…}` span (what this
 * used to do) swallows the prose between them and produces something that
 * cannot parse, so a perfectly good answer was reported to the user as
 * unreadable. So: scan for balanced top-level objects and return the LAST one
 * that actually parses — a self-correction supersedes the attempt it corrects.
 *
 * Returns a *candidate* string, never a parsed value. It does no schema
 * validation and does not throw, so the caller still wraps `JSON.parse` in
 * try/catch and validates the shape before trusting it.
 */
export function extractJson(raw: string): string {
  // Fenced blocks first — a model that fenced its answer fenced each attempt,
  // so the last parseable fence wins for the same reason as below.
  const fences = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)]
    .map((m) => (m[1] ?? "").trim())
    .filter(Boolean);
  const parseableFence = lastParseable(fences);
  if (parseableFence) return parseableFence;
  if (fences.length > 0 && fences[fences.length - 1]) return fences[fences.length - 1] as string;

  const objects = balancedObjects(raw);
  const parseable = lastParseable(objects);
  if (parseable) return parseable;

  // Nothing parsed. Fall back to the old widest-span guess so behaviour for
  // an unparseable reply is unchanged — the caller reports it either way.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) return raw.slice(start, end + 1);
  return raw.trim();
}

/** The last candidate that is valid JSON, or null when none is. */
function lastParseable(candidates: string[]): string | null {
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i];
    if (c === undefined) continue;
    try {
      JSON.parse(c);
      return c;
    } catch {
      /* try the one before it */
    }
  }
  return null;
}

/**
 * Every balanced top-level `{…}` span in the text, in order.
 *
 * Brace counting has to ignore braces inside string literals — a food named
 * `Rice {special}` would otherwise close the object early — so this tracks
 * quoting and backslash escapes as it walks.
 */
function balancedObjects(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          out.push(raw.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return out;
}

/**
 * Dev-mode mock for natural-language meal parsing. Returns a deterministic
 * structured payload so the logging UI is exercisable via `npm run dev`. The
 * real model output will differ in detail but matches this shape.
 */
async function mockComplete(req: CompleteRequest): Promise<string> {
  await new Promise((r) => setTimeout(r, 500));
  const text = req.messages.at(-1)?.content?.toLowerCase() ?? "";
  const items: Array<Record<string, unknown>> = [];
  const push = (name: string, m: number[], serving: string) =>
    items.push({
      name,
      servingSize: serving,
      calories: m[0],
      protein: m[1],
      carbs: m[2],
      fat: m[3],
    });

  if (text.includes("egg")) push("Scrambled eggs", [180, 12, 2, 13], "2 eggs");
  if (text.includes("coffee")) push("Coffee, black", [5, 0, 1, 0], "1 cup");
  if (text.includes("chicken")) push("Grilled chicken breast", [280, 52, 0, 6], "6 oz");
  if (text.includes("sandwich")) push("Sandwich", [350, 15, 45, 12], "1 sandwich");
  if (text.includes("beer")) push("Beer", [153, 2, 13, 0], "1 can (355 ml)");
  if (text.includes("rice")) push("White rice, cooked", [205, 4, 45, 0], "1 cup");
  if (text.includes("salad")) push("Garden salad", [120, 4, 14, 6], "1 bowl");
  if (text.includes("banana")) push("Banana", [105, 1, 27, 0], "1 medium");

  if (items.length === 0) {
    push("Mixed meal (estimate)", [400, 20, 40, 15], "1 serving");
  }
  return JSON.stringify({ items });
}
