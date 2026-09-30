import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Node test environment: give the bridge a window to live on.
const g = globalThis as unknown as { window?: unknown };
if (!g.window) g.window = globalThis;

const complete = vi.fn();
const files: Record<string, string> = {};

vi.mock("../../bridge/ai", async (orig) => ({
  ...(await orig<typeof import("../../bridge/ai")>()),
  complete: (...a: unknown[]) => complete(...a),
  isAiAvailable: () => true,
}));
vi.mock("../../bridge/vfs", () => ({
  readJson: async (p: string, d: unknown) => (files[p] ? JSON.parse(files[p]) : d),
  writeJson: async (p: string, v: unknown) => {
    files[p] = JSON.stringify(v);
  },
}));
// No consent on file: askCoach answers without personal context.
vi.mock("../aiConsent", () => ({ hasAiJournalConsent: async () => false }));

import {
  answerHubMessage,
  loadAskHistory,
  onAskHistoryChange,
  recordAskTurn,
  resetCoachChatHub,
  startCoachChatHub,
} from "./ask";

type Msg = { id: string; role: "user" | "assistant"; content: string; status?: string };

function installHub(opts: { listenOk?: boolean; messages?: Msg[] } = {}) {
  const messages: Msg[] = opts.messages ?? [];
  let handler: ((m: { threadId: string; messageId: string; content: string }) => Promise<string>) | null = null;
  const chat = {
    post: vi.fn(async (m: { role: "user" | "assistant"; content: string; threadId?: string }) => {
      messages.push({ id: `m${messages.length}`, role: m.role, content: m.content });
      return { ok: true };
    }),
    history: vi.fn(async () => ({ ok: true, messages: [...messages] })),
    onMessage: vi.fn(async (fn: typeof handler) => {
      handler = fn;
      return opts.listenOk === false ? { ok: false, reason: "permission" } : { ok: true };
    }),
  };
  (window as unknown as { __conjureos: unknown }).__conjureos = { chat };
  return { chat, messages, deliver: (m: { threadId: string; messageId: string; content: string }) => handler!(m) };
}

beforeEach(() => {
  for (const k of Object.keys(files)) delete files[k];
  complete.mockReset();
  resetCoachChatHub();
});
afterEach(() => {
  delete (window as unknown as { __conjureos?: unknown }).__conjureos;
});

describe("coach chat on the ConjureOS chat hub", () => {
  it("without the hub (older shell), history is the app's own file", async () => {
    files["coach-chat.json"] = JSON.stringify([{ role: "user", content: "hi" }]);
    expect(await startCoachChatHub()).toBe(false);
    expect(await loadAskHistory()).toEqual([{ role: "user", content: "hi" }]);
    await recordAskTurn([{ role: "user", content: "a" }, { role: "assistant", content: "b" }], "a", "b");
    expect(JSON.parse(files["coach-chat.json"]!)).toHaveLength(2);
  });

  it("registers a handler on the single main thread", async () => {
    const { chat } = installHub();
    expect(await startCoachChatHub()).toBe(true);
    expect(chat.onMessage).toHaveBeenCalledTimes(1);
  });

  it("reports a refused registration", async () => {
    installHub({ listenOk: false });
    expect(await startCoachChatHub()).toBe(false);
  });

  it("posts both sides of an in-app turn to the hub and keeps the local copy", async () => {
    const { chat } = installHub();
    await recordAskTurn([{ role: "user", content: "q" }, { role: "assistant", content: "r" }], "q", "r");
    expect(chat.post.mock.calls.map((c) => [c[0].threadId, c[0].role, c[0].content])).toEqual([
      ["main", "user", "q"],
      ["main", "assistant", "r"],
    ]);
    expect(JSON.parse(files["coach-chat.json"]!)).toHaveLength(2);
  });

  it("reads the shared thread, dropping unanswered and failed messages", async () => {
    installHub({
      messages: [
        { id: "1", role: "user", content: "from chat" },
        { id: "2", role: "assistant", content: "answer" },
        { id: "3", role: "user", content: "waiting", status: "pending" },
        { id: "4", role: "user", content: "broke", status: "failed" },
      ],
    });
    expect(await loadAskHistory()).toEqual([
      { role: "user", content: "from chat" },
      { role: "assistant", content: "answer" },
    ]);
  });

  it("copies an existing in-app conversation into an empty hub thread once", async () => {
    files["coach-chat.json"] = JSON.stringify([
      { role: "user", content: "old q" },
      { role: "assistant", content: "old a" },
    ]);
    const { chat } = installHub();
    expect(await loadAskHistory()).toHaveLength(2);
    expect(chat.post).toHaveBeenCalledTimes(2);
    expect(await loadAskHistory()).toEqual([
      { role: "user", content: "old q" },
      { role: "assistant", content: "old a" },
    ]);
    expect(chat.post).toHaveBeenCalledTimes(2);
  });

  it("answers a Chat panel message with the thread as context, and tells an open sheet", async () => {
    const hub = installHub({
      messages: [
        { id: "1", role: "user", content: "earlier" },
        { id: "2", role: "assistant", content: "earlier answer" },
        { id: "3", role: "user", content: "Is rice high in fiber?", status: "pending" },
      ],
    });
    complete.mockResolvedValue("Not very, about 1 g a cup.");
    await startCoachChatHub();
    const seen = vi.fn();
    onAskHistoryChange(seen);

    const reply = await hub.deliver({ threadId: "main", messageId: "3", content: "Is rice high in fiber?" });

    expect(reply).toBe("Not very, about 1 g a cup.");
    const sent = complete.mock.calls[0]![0].messages;
    expect(sent.map((m: { content: string }) => m.content)).toEqual([
      "earlier",
      "earlier answer",
      "Is rice high in fiber?",
    ]);
    // The hub records the message and reply itself: nothing is posted again.
    expect(hub.chat.post).not.toHaveBeenCalled();
    expect(JSON.parse(files["coach-chat.json"]!)).toHaveLength(4);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("answerHubMessage falls back to the local file when history is refused", async () => {
    const hub = installHub();
    hub.chat.history.mockResolvedValue({ ok: false, reason: "permission" } as never);
    files["coach-chat.json"] = JSON.stringify([{ role: "user", content: "local" }]);
    complete.mockResolvedValue("ok");
    await answerHubMessage({ threadId: "main", messageId: "x", content: "q" });
    expect(complete.mock.calls[0]![0].messages[0].content).toBe("local");
  });
});
