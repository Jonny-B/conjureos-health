/**
 * Where Ask Health keeps its conversation, and the one way to empty it from
 * outside Ask Health.
 *
 * Its own module so that withdrawing the AI agreement (features/aiConsent.ts)
 * can clear the conversation without importing features/ask/ask.ts, which
 * imports the agreement. See ask.ts for what the file holds and why
 * `coach-chat.json` is never read.
 */

import { writeJsonOrThrow } from "../../bridge/vfs";

/** Ask Health's conversation, oldest first: the same file on the main line. */
export const ASK_CHAT_PATH = "ask-health.json";

/**
 * Empty the conversation. Withdrawing the AI agreement does this (owner
 * decision 2026-10-22, ConjureOS #1163): what the sheet held goes with the
 * agreement, and agreeing again starts a fresh conversation. Returns whether
 * it was saved.
 */
export async function clearAskConversation(): Promise<boolean> {
  try {
    await writeJsonOrThrow(ASK_CHAT_PATH, []);
    return true;
  } catch {
    return false;
  }
}
