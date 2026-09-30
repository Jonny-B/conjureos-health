/**
 * The ConjureOS app chat hub (`window.__conjureos.chat`, ConjureOS #513).
 *
 * Health registers its food-questions chat as one continuous thread (`main`,
 * manifest `chat.threads: "single"`). The hub keeps a kernel-side copy that the
 * shell's Chat panel lists, so the person can carry the conversation on from
 * either side:
 *
 *   - In the app, every turn is recorded with `chat.post`.
 *   - Typed in the Chat panel, a message arrives through `chat.onMessage`; the
 *     reply we return is recorded by the hub, so it is not posted again.
 *   - `chat.history` reads the shared thread back, both sides.
 *
 * Everything here is best-effort and feature-detected. On an older shell (no
 * `chat` bridge) or when the hub refuses (`permission`, `not_registered`), every
 * call degrades to "not available" and the in-app chat keeps working from its
 * own `coach-chat.json`.
 */

import type { CoachChatItem } from "../features/coach/model";

export const HUB_THREAD = "main";

export interface HubMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  at?: string;
  via?: "app" | "hub";
  status?: "pending" | "answered" | "failed";
}

export interface HubInbound {
  threadId: string;
  messageId: string;
  content: string;
}

type HubResult = { ok: boolean; reason?: string; error?: string };

declare global {
  interface ConjureosBridge {
    /** ConjureOS 0.150.0+; undefined on older hosts, so always feature-detect. */
    chat?: {
      post: (msg: {
        threadId?: string;
        role: "user" | "assistant";
        content: string;
        title?: string;
      }) => Promise<HubResult & { id?: string }>;
      history: (threadId?: string) => Promise<HubResult & { messages?: HubMessage[] }>;
      threads?: () => Promise<HubResult & { threads?: unknown[] }>;
      onMessage: (
        fn: ((m: HubInbound) => Promise<string> | string) | null,
      ) => Promise<HubResult>;
    };
  }
}

const hub = () => (typeof window === "undefined" ? undefined : window.__conjureos?.chat);

/** Whether this shell offers the chat hub at all. */
export function isChatHubAvailable(): boolean {
  const c = hub();
  return !!c && typeof c.post === "function" && typeof c.history === "function";
}

/** Record one turn the in-app chat shows. Never throws. */
export async function postToHub(role: "user" | "assistant", content: string): Promise<boolean> {
  const c = hub();
  const text = content.trim();
  if (!c?.post || !text) return false;
  try {
    const r = await c.post({ threadId: HUB_THREAD, role, content: text, title: "Food questions" });
    return !!r?.ok;
  } catch {
    return false;
  }
}

/**
 * The shared thread as chat items, oldest first, or null when the hub cannot
 * answer (older shell, refused, error). Messages the app has not answered yet
 * (`pending`) and ones that failed are left out: they have no reply to pair.
 */
export async function hubHistory(excludeId?: string): Promise<CoachChatItem[] | null> {
  const c = hub();
  if (!c?.history) return null;
  try {
    const r = await c.history(HUB_THREAD);
    if (!r?.ok || !Array.isArray(r.messages)) return null;
    return r.messages
      .filter(
        (m) =>
          m &&
          m.id !== excludeId &&
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string" &&
          m.status !== "pending" &&
          m.status !== "failed",
      )
      .map((m) => ({ role: m.role, content: m.content }));
  } catch {
    return null;
  }
}

/**
 * Answer Chat panel messages. Returns whether the hub accepted the handler
 * (false on older shells and when the manifest registration is refused).
 */
export async function listenToHub(
  answer: (m: HubInbound) => Promise<string>,
): Promise<boolean> {
  const c = hub();
  if (!c?.onMessage) return false;
  try {
    const r = await c.onMessage(answer);
    return !!r?.ok;
  } catch {
    return false;
  }
}
