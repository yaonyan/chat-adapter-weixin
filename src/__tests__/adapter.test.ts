import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { WeixinAdapter } from "../adapter.js";
import { parseMarkdown } from "chat";
import type { WeixinMessage } from "../types.js";
import { MessageType } from "../types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Mock fetch globally
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockPostOk(body: unknown): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUserMessage(overrides: Partial<WeixinMessage> = {}): WeixinMessage {
  return {
    seq: 1,
    message_id: 1001,
    from_user_id: "alice@im.wechat",
    to_user_id: "bot@im.wechat",
    message_type: MessageType.USER,
    create_time_ms: 1700000000000,
    context_token: "ctx-abc123",
    item_list: [{ text_item: { text: "Hello bot!" } }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WeixinAdapter", () => {
  let adapter: WeixinAdapter;
  let stateFile: string;

  beforeEach(() => {
    mockFetch.mockReset();
    stateFile = path.join(os.tmpdir(), `weixin-adapter-test-${Date.now()}.json`);
    adapter = new WeixinAdapter({
      baseUrl: "https://ilink.example.com/",
      token: "test-token",
      botUserId: "bot@im.wechat",
      stateFile,
    });
  });

  afterEach(() => {
    try { fs.unlinkSync(stateFile); } catch { /* ignore */ }
  });

  describe("encodeThreadId / decodeThreadId", () => {
    it("encodes userId to weixin: thread ID", () => {
      expect(adapter.encodeThreadId({ userId: "alice@im.wechat" })).toBe(
        "weixin:alice@im.wechat",
      );
    });

    it("decodes weixin: thread ID back to userId", () => {
      expect(adapter.decodeThreadId("weixin:alice@im.wechat")).toEqual({
        userId: "alice@im.wechat",
      });
    });

    it("decodes bare ID without prefix", () => {
      expect(adapter.decodeThreadId("alice@im.wechat")).toEqual({
        userId: "alice@im.wechat",
      });
    });
  });

  describe("isDM", () => {
    it("always returns true", () => {
      expect(adapter.isDM("weixin:anyone@im.wechat")).toBe(true);
    });
  });

  describe("channelIdFromThreadId", () => {
    it("returns the same thread ID (channel == thread for DMs)", () => {
      const id = "weixin:alice@im.wechat";
      expect(adapter.channelIdFromThreadId(id)).toBe(id);
    });
  });

  describe("parseMessage", () => {
    it("extracts text from text_item", () => {
      const raw = makeUserMessage();
      const msg = adapter.parseMessage(raw);
      expect(msg.text).toBe("Hello bot!");
    });

    it("sets isMention = true for all inbound messages", () => {
      const raw = makeUserMessage();
      const msg = adapter.parseMessage(raw);
      expect(msg.isMention).toBe(true);
    });

    it("uses from_user_id as thread ID", () => {
      const raw = makeUserMessage({ from_user_id: "bob@im.wechat" });
      const msg = adapter.parseMessage(raw);
      expect(msg.threadId).toBe("weixin:bob@im.wechat");
    });

    it("sets dateSent from create_time_ms", () => {
      const raw = makeUserMessage({ create_time_ms: 1700000000000 });
      const msg = adapter.parseMessage(raw);
      expect(msg.metadata.dateSent).toEqual(new Date(1700000000000));
    });

    it("falls back to current time when create_time_ms absent", () => {
      const before = Date.now();
      const raw = makeUserMessage({ create_time_ms: undefined });
      const msg = adapter.parseMessage(raw);
      expect(msg.metadata.dateSent.getTime()).toBeGreaterThanOrEqual(before);
    });

    it("extracts voice-to-text transcript", () => {
      const raw = makeUserMessage({
        item_list: [{ voice_item: { text: "voice transcript" } }],
      });
      const msg = adapter.parseMessage(raw);
      expect(msg.text).toBe("voice transcript");
    });
  });

  describe("postMessage", () => {
    it("sends text to the correct user", async () => {
      mockPostOk({});
      await adapter.postMessage("weixin:alice@im.wechat", "Hello Alice!");
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("ilink/bot/sendmessage");
      const body = JSON.parse(init.body as string);
      expect(body.msg.to_user_id).toBe("alice@im.wechat");
      expect(body.msg.item_list[0].text_item.text).toBe("Hello Alice!");
    });

    it("includes context_token from store in reply", async () => {
      // Directly prime the persistence store
      (adapter as any).store.setContextToken("charlie@im.wechat", "tok-xyz");

      mockPostOk({});
      await adapter.postMessage("weixin:charlie@im.wechat", "Reply");
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.msg.context_token).toBe("tok-xyz");
    });

    it("returns a RawMessage with the correct threadId", async () => {
      mockPostOk({});
      const result = await adapter.postMessage("weixin:alice@im.wechat", "Hi");
      expect(result.threadId).toBe("weixin:alice@im.wechat");
    });
  });

  describe("fetchMessages", () => {
    it("returns empty list (no server-side history)", async () => {
      const result = await adapter.fetchMessages("weixin:alice@im.wechat");
      expect(result.messages).toEqual([]);
    });
  });

  describe("fetchThread", () => {
    it("returns isDM: true", async () => {
      const info = await adapter.fetchThread("weixin:alice@im.wechat");
      expect(info.isDM).toBe(true);
      expect(info.id).toBe("weixin:alice@im.wechat");
    });
  });

  describe("renderFormatted", () => {
    it("converts mdast to plain text string", () => {
      const formatted = parseMarkdown("**bold** text");
      const rendered = adapter.renderFormatted(formatted);
      expect(typeof rendered).toBe("string");
      expect(rendered).toContain("bold");
    });
  });
});
