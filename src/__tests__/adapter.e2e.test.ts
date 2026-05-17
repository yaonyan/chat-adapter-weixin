/**
 * E2E integration test for WeixinAdapter + Chat SDK.
 *
 * Validates the full pipeline:
 *   getUpdates (long-poll) → message dispatch → onNewMention → postMessage
 *
 * HTTP is mocked at the fetch level; no real WeChat server required.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { WeixinAdapter } from "../adapter.js";
import type { GetUpdatesResp } from "../types.js";
import { MessageType } from "../types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// fetch mock
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

/**
 * Route-aware fetch mock.
 * Maintains separate queues for getUpdates and sendMessage.
 */
class FetchRouter {
  private readonly updateQueue: Array<GetUpdatesResp> = [];
  private readonly sendQueue: Array<Record<string, unknown>> = [];
  private blocker: Promise<void> | null = null;
  private releaseBlocker: (() => void) | null = null;

  constructor() {
    mockFetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.includes("getupdates")) {
        if (this.updateQueue.length > 0) {
          const resp = this.updateQueue.shift()!;
          return { ok: true, status: 200, text: async () => JSON.stringify(resp) };
        }
        // Block until released (simulates real long-poll)
        if (!this.blocker) {
          this.blocker = new Promise<void>((r) => { this.releaseBlocker = r; });
        }
        await this.blocker;
        return { ok: true, status: 200, text: async () => JSON.stringify({ ret: 0, msgs: [] }) };
      }
      if (url.includes("sendmessage")) {
        const body = JSON.parse(init.body as string);
        this.sendQueue.push(body);
        return { ok: true, status: 200, text: async () => "{}" };
      }
      return { ok: true, status: 200, text: async () => "{}" };
    });
  }

  queueUpdates(resp: GetUpdatesResp): void {
    this.updateQueue.push(resp);
  }

  async waitForSend(timeoutMs = 2000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (this.sendQueue.length === 0) {
      if (Date.now() > deadline) throw new Error("waitForSend timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
    return this.sendQueue.shift()!;
  }

  async waitForSends(n: number, timeoutMs = 2000): Promise<Array<Record<string, unknown>>> {
    const results: Array<Record<string, unknown>> = [];
    for (let i = 0; i < n; i++) results.push(await this.waitForSend(timeoutMs));
    return results;
  }

  release(): void {
    this.releaseBlocker?.();
  }
}

/** Block until predicate is true, polling every 10ms. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let msgIdCounter = 1000;

function makeInboundMsg(text: string, userId = "alice@im.wechat") {
  return {
    seq: ++msgIdCounter,
    message_id: msgIdCounter,
    from_user_id: userId,
    to_user_id: "bot@im.wechat",
    message_type: MessageType.USER,
    create_time_ms: Date.now(),
    context_token: `ctx-${userId}`,
    item_list: [{ text_item: { text } }],
  };
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("WeixinAdapter e2e", () => {
  let adapter: WeixinAdapter;
  let bot: Chat;
  let stateFile: string;
  let router: FetchRouter;

  beforeEach(() => {
    mockFetch.mockReset();
    msgIdCounter = 1000; // reset per test for isolation
    stateFile = path.join(os.tmpdir(), `weixin-e2e-${Date.now()}.json`);
    router = new FetchRouter();
    adapter = new WeixinAdapter({
      baseUrl: "https://ilink.example.com/",
      token: "test-token",
      botUserId: "bot@im.wechat",
      stateFile,
    });
    bot = new Chat({
      userName: "test-bot",
      adapters: { weixin: adapter },
      state: createMemoryState(),
    });
  });

  afterEach(async () => {
    router.release(); // unblock polling loop so shutdown is clean
    await bot.shutdown();
    try { fs.unlinkSync(stateFile); } catch { /* ignore */ }
  });

  it("dispatches inbound message to onNewMention handler", async () => {
    const received: string[] = [];
    bot.onNewMention(async (thread, message) => {
      received.push(message.text);
      await thread.post(`echo: ${message.text}`);
    });

    router.queueUpdates({
      ret: 0,
      msgs: [makeInboundMsg("Hello WeChat!")],
      get_updates_buf: "buf-001",
    });

    await bot.initialize();

    await waitFor(() => received.length > 0);
    expect(received[0]).toBe("Hello WeChat!");
  });

  it("sends reply to the correct user with context_token", async () => {
    bot.onNewMention(async (thread) => {
      await thread.post("pong");
    });

    router.queueUpdates({
      ret: 0,
      msgs: [makeInboundMsg("ping", "charlie@im.wechat")],
      get_updates_buf: "buf-002",
    });

    await bot.initialize();

    const sentBody = await router.waitForSend();
    const msg = (sentBody as any).msg;
    expect(msg.to_user_id).toBe("charlie@im.wechat");
    expect(msg.item_list[0].text_item.text).toBe("pong");
    expect(msg.context_token).toBe("ctx-charlie@im.wechat");
  });

  it("persists get_updates_buf to disk after receiving messages", async () => {
    bot.onNewMention(async () => { /* no-op */ });

    router.queueUpdates({
      ret: 0,
      msgs: [makeInboundMsg("hi")],
      get_updates_buf: "persisted-buf-xyz",
    });

    await bot.initialize();

    await waitFor(() => {
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
        return state.pollingBuf === "persisted-buf-xyz";
      } catch { return false; }
    });

    const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    expect(state.pollingBuf).toBe("persisted-buf-xyz");
    expect(state.contextTokens["alice@im.wechat"]).toBe("ctx-alice@im.wechat");
  });

  it("handles messages from multiple users across polling rounds", async () => {
    const received: string[] = [];
    bot.onNewMention(async (thread, message) => {
      received.push(message.text);
      await thread.post("ok");
    });

    // Each user sends a message in a separate polling round
    router.queueUpdates({
      ret: 0,
      msgs: [makeInboundMsg("msg1", "u1@im.wechat")],
      get_updates_buf: "buf-1",
    });
    router.queueUpdates({
      ret: 0,
      msgs: [makeInboundMsg("msg2", "u2@im.wechat")],
      get_updates_buf: "buf-2",
    });
    router.queueUpdates({
      ret: 0,
      msgs: [makeInboundMsg("msg3", "u3@im.wechat")],
      get_updates_buf: "buf-3",
    });

    await bot.initialize();

    await waitFor(() => received.length >= 3, 8000);
    expect(received.sort()).toEqual(["msg1", "msg2", "msg3"]);
  }, 10000);

  it("skips bot messages (message_type !== USER)", async () => {
    const received: string[] = [];
    bot.onNewMention(async (_thread, message) => {
      received.push(message.text);
    });

    router.queueUpdates({
      ret: 0,
      msgs: [
        { ...makeInboundMsg("bot echo"), message_type: MessageType.BOT },
        makeInboundMsg("real user msg"),
      ],
      get_updates_buf: "buf-skip",
    });

    await bot.initialize();

    await waitFor(() => received.length > 0);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe("real user msg");
  });
});
