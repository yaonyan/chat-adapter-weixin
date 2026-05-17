import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { WeixinAdapter } from "../adapter.js";
import { parseMarkdown } from "chat";
import type { WeixinMessage } from "../types.js";
import { MessageType } from "../types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encryptAesEcb } from "../media/aes-ecb.js";

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

  describe("media — parseMessage (inbound)", () => {
    it("creates image attachment from image_item", () => {
      const raw = makeUserMessage({
        item_list: [{
          type: 2, // IMAGE
          image_item: {
            media: {
              encrypt_query_param: "img-ep",
              aes_key: "img-key-b64",
              encrypt_type: 1,
            },
            aeskey: "abcdef1234567890abcdef1234567890",
          },
        }],
      });
      const msg = adapter.parseMessage(raw);
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments[0].type).toBe("image");
      expect(msg.attachments[0].fetchMetadata?.encryptQueryParam).toBe("img-ep");
    });

    it("creates video attachment from video_item", () => {
      const raw = makeUserMessage({
        item_list: [{
          type: 5, // VIDEO
          video_item: {
            media: {
              encrypt_query_param: "vid-ep",
              aes_key: "vid-key-b64",
              encrypt_type: 1,
            },
          },
        }],
      });
      const msg = adapter.parseMessage(raw);
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments[0].type).toBe("video");
    });

    it("creates file attachment from file_item", () => {
      const raw = makeUserMessage({
        item_list: [{
          type: 4, // FILE
          file_item: {
            media: {
              encrypt_query_param: "file-ep",
              aes_key: "file-key-b64",
              encrypt_type: 1,
            },
            file_name: "report.pdf",
            len: "12345",
          },
        }],
      });
      const msg = adapter.parseMessage(raw);
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments[0].type).toBe("file");
      expect(msg.attachments[0].name).toBe("report.pdf");
    });

    it("builds multiple attachments from mixed item_list", () => {
      const raw = makeUserMessage({
        item_list: [
          { type: 1, text_item: { text: "hello" } },
          { type: 2, image_item: { media: { encrypt_query_param: "ep1", aes_key: "k1" } } },
          { type: 5, video_item: { media: { encrypt_query_param: "ep2", aes_key: "k2" } } },
          { type: 4, file_item: { media: { encrypt_query_param: "ep3", aes_key: "k3" }, file_name: "doc.txt" } },
        ],
      });
      const msg = adapter.parseMessage(raw);
      expect(msg.text).toBe("hello");
      expect(msg.attachments).toHaveLength(3);
      expect(msg.attachments.map(a => a.type).sort()).toEqual(["file", "image", "video"]);
    });

    it("returns empty attachments when no media items", () => {
      const raw = makeUserMessage();
      const msg = adapter.parseMessage(raw);
      expect(msg.attachments).toEqual([]);
    });

    it("attachment fetchData downloads and decrypts from CDN", async () => {
      const key = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
      const plaintext = Buffer.from("hello weixin media test 1234");
      const ciphertext = encryptAesEcb(plaintext, key);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new Uint8Array([...ciphertext]).buffer),
      });

      const raw = makeUserMessage({
        item_list: [{
          type: 2,
          image_item: {
            media: {
              encrypt_query_param: "test-ep",
              aes_key: key.toString("base64"),
              encrypt_type: 1,
            },
          },
        }],
      });
      const msg = adapter.parseMessage(raw);
      const buf = await msg.attachments[0].fetchData!();
      expect(buf.toString()).toBe("hello weixin media test 1234");
    });
  });

  describe("media — postMessage (outbound)", () => {
    it("sends image attachment via CDN pipeline", async () => {
      // getUploadUrl → ok
      mockPostOk({ upload_full_url: "https://cdn.example.com/upload", upload_param: "uparam" });
      // CDN upload → ok with header
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([["x-encrypted-param", "download-param-x"]]),
        text: () => Promise.resolve(""),
      });
      // sendMessage → ok
      mockPostOk({});

      await adapter.postMessage(
        "weixin:alice@im.wechat",
        { raw: "see pic", attachments: [{ type: "image", data: Buffer.from("fake-image-data"), mimeType: "image/png" }] },
      );

      // Should have made 3 fetch calls: getUploadUrl → CDN upload → sendMessage
      expect(mockFetch).toHaveBeenCalledTimes(3);
      const calls = mockFetch.mock.calls;
      expect((calls[0][0] as string)).toContain("getuploadurl");
      expect((calls[1][0] as string)).toContain("cdn");
      expect((calls[2][0] as string)).toContain("sendmessage");

      // Verify sendMessage body contains IMAGE item
      const sendBody = JSON.parse((calls[2][1] as RequestInit).body as string);
      const items = sendBody.msg.item_list;
      expect(items[0].text_item.text).toBe("see pic");
      expect(items[1].type).toBe(2); // IMAGE
      expect(items[1].image_item.media.encrypt_query_param).toBe("download-param-x");
    });

    it("sends file from FileUpload", async () => {
      // getUploadUrl
      mockPostOk({ upload_full_url: "https://cdn.example.com/upload2" });
      // CDN upload
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([["x-encrypted-param", "file-dl-param"]]),
        text: () => Promise.resolve(""),
      });
      // sendMessage
      mockPostOk({});

      await adapter.postMessage(
        "weixin:bob@im.wechat",
        { markdown: "here is your file", files: [{ data: Buffer.from("pdf-content"), filename: "doc.pdf", mimeType: "application/pdf" }] },
      );

      const [, , sendCall] = mockFetch.mock.calls;
      const sendBody = JSON.parse((sendCall[1] as RequestInit).body as string);
      const items = sendBody.msg.item_list;
      expect(items[0].text_item.text).toBe("here is your file");
      expect(items[1].type).toBe(4); // FILE
      expect(items[1].file_item.file_name).toBe("doc.pdf");
    });
  });
});
