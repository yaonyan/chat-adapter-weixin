import type {
  Adapter,
  AdapterPostableMessage,
  ChatInstance,
  EmojiValue,
  FetchOptions,
  FetchResult,
  FormattedContent,
  RawMessage,
  ThreadInfo,
} from "chat";
import { Message, NotImplementedError, parseMarkdown, stringifyMarkdown } from "chat";

import { getUpdates, sendMessage, type WeixinApiOptions } from "./api.js";
import { defaultStateFilePath, PersistenceStore } from "./persistence.js";
import type { WeixinMessage } from "./types.js";
import { MessageItemType, MessageState, MessageType } from "./types.js";

// ---------------------------------------------------------------------------
// Thread ID format: "weixin:{userId}"
// ---------------------------------------------------------------------------

export interface WeixinThreadId {
  userId: string;
}

function encodeThreadId(userId: string): string {
  return `weixin:${userId}`;
}

function decodeUserId(threadId: string): string {
  // "weixin:{userId}" → userId
  return threadId.startsWith("weixin:") ? threadId.slice(7) : threadId;
}

// ---------------------------------------------------------------------------
// Message text extraction
// ---------------------------------------------------------------------------

function extractText(msg: WeixinMessage): string {
  const items = msg.item_list ?? [];
  const textParts: string[] = [];
  for (const item of items) {
    if (item.text_item?.text) {
      textParts.push(item.text_item.text);
    } else if (item.voice_item?.text) {
      // Voice-to-text transcript
      textParts.push(item.voice_item.text);
    }
  }
  return textParts.join("\n");
}

function toAdapterText(msg: AdapterPostableMessage): string {
  if (typeof msg === "string") return msg;
  if ("raw" in msg) return String(msg.raw);
  if ("markdown" in msg) return msg.markdown;
  if ("ast" in msg) return stringifyMarkdown(msg.ast);
  // CardElement / PostableCard — best-effort fallback
  return "[rich content]";
}

// ---------------------------------------------------------------------------
// Adapter config
// ---------------------------------------------------------------------------

export interface WeixinAdapterConfig {
  /** WeChat iLink API base URL (e.g. "https://ilink.weixin.qq.com/"). */
  baseUrl?: string;
  /** Bearer token for authentication. Defaults to WEIXIN_BOT_TOKEN env var. */
  token?: string;
  /** Bot's own WeChat user ID (optional; used for isMe checks). */
  botUserId?: string;
  /**
   * Path to the JSON file used for persisting polling buf + context tokens.
   * Defaults to WEIXIN_STATE_FILE env var, then `.weixin-state.json` in cwd.
   * Pass `false` to disable persistence (in-memory only, e.g. for tests).
   */
  stateFile?: string | false;
}

// ---------------------------------------------------------------------------
// WeixinAdapter
// ---------------------------------------------------------------------------

export class WeixinAdapter implements Adapter<WeixinThreadId, WeixinMessage> {
  readonly name = "weixin";
  /** WeChat is DM-only; persist thread history for history support. */
  readonly persistThreadHistory = true;
  /** Each WeChat user is an independent DM thread; use thread-level locking for concurrency. */
  readonly lockScope = "thread" as const;
  /** Required by Adapter interface — bot display name. */
  readonly userName: string;

  readonly botUserId?: string;

  private readonly apiOpts: WeixinApiOptions;
  private readonly store: PersistenceStore | null;

  private chat?: ChatInstance;
  private pollingActive = false;

  constructor(config: WeixinAdapterConfig = {}) {
    const baseUrl =
      config.baseUrl ?? process.env.WEIXIN_BASE_URL ?? "https://ilink.weixin.qq.com/";
    const token = config.token ?? process.env.WEIXIN_BOT_TOKEN;
    this.apiOpts = { baseUrl, token };
    this.botUserId = config.botUserId ?? process.env.WEIXIN_BOT_USER_ID;
    this.userName = config.botUserId ?? process.env.WEIXIN_BOT_USER_ID ?? "weixin-bot";
    this.store =
      config.stateFile === false
        ? null
        : new PersistenceStore(config.stateFile ?? defaultStateFilePath());
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.pollingActive = true;
    console.log(`[WeixinAdapter] initialize: token=${this.apiOpts.token ? "yes(" + this.apiOpts.token.length + ")" : "NONE"} baseUrl=${this.apiOpts.baseUrl} stateFile=${this.store ? "yes" : "no"}`);
    this.startPolling();
  }

  async disconnect(): Promise<void> {
    this.pollingActive = false;
  }

  // -------------------------------------------------------------------------
  // Thread ID encoding/decoding
  // -------------------------------------------------------------------------

  encodeThreadId(data: WeixinThreadId): string {
    return encodeThreadId(data.userId);
  }

  decodeThreadId(threadId: string): WeixinThreadId {
    return { userId: decodeUserId(threadId) };
  }

  channelIdFromThreadId(threadId: string): string {
    // WeChat DMs — channel == thread
    return threadId;
  }

  isDM(_threadId: string): boolean {
    return true;
  }

  // -------------------------------------------------------------------------
  // Posting
  // -------------------------------------------------------------------------

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<WeixinMessage>> {
    const toUserId = decodeUserId(threadId);
    const text = toAdapterText(message);
    const contextToken = this.store?.getContextToken(toUserId);
    const clientId = `weixin-bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const outMsg: WeixinMessage = {
      to_user_id: toUserId,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: contextToken,
      item_list: text ? [{ type: MessageItemType.TEXT, text_item: { text } }] : [],
    };

    await sendMessage({ ...this.apiOpts, body: { msg: outMsg } });
    console.log(`[WeixinAdapter] sendMessage ok to=${toUserId} baseUrl=${this.apiOpts.baseUrl} contextToken=${contextToken ? "yes" : "none"}`);

    return {
      id: String(Date.now()),
      threadId,
      raw: outMsg,
    };
  }

  async editMessage(
    _threadId: string,
    _messageId: string,
    _message: AdapterPostableMessage,
  ): Promise<RawMessage<WeixinMessage>> {
    throw new NotImplementedError("WeixinAdapter does not support editMessage");
  }

  async deleteMessage(_threadId: string, _messageId: string): Promise<void> {
    throw new NotImplementedError("WeixinAdapter does not support deleteMessage");
  }

  async addReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string,
  ): Promise<void> {
    // WeChat does not support reactions
  }

  async removeReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string,
  ): Promise<void> {
    // WeChat does not support reactions
  }

  /** Render a FormattedContent (mdast) to plain text for WeChat. */
  renderFormatted(content: FormattedContent): string {
    return stringifyMarkdown(content);
  }

  // -------------------------------------------------------------------------
  // Typing indicator
  // -------------------------------------------------------------------------

  async startTyping(_threadId: string): Promise<void> {
    // sendTyping requires typing_ticket from getConfig; skip silently if unavailable.
    // Advanced callers can call the api directly if needed.
  }

  // -------------------------------------------------------------------------
  // Fetch (no server-side history API; return empty)
  // -------------------------------------------------------------------------

  async fetchMessages(
    _threadId: string,
    _options?: FetchOptions,
  ): Promise<FetchResult<WeixinMessage>> {
    return { messages: [], nextCursor: undefined };
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    return {
      id: threadId,
      channelId: threadId,
      isDM: true,
      metadata: {},
    };
  }

  // -------------------------------------------------------------------------
  // Webhook (not used; WeChat uses long-poll)
  // -------------------------------------------------------------------------

  async handleWebhook(_request: Request): Promise<Response> {
    return new Response("not supported", { status: 404 });
  }

  // -------------------------------------------------------------------------
  // Mention detection (not applicable for DMs — every message is relevant)
  // -------------------------------------------------------------------------

  /** Convert a WeixinMessage to the normalized Message format. */
  parseMessage(raw: WeixinMessage): Message<WeixinMessage> {
    const fromUserId = raw.from_user_id ?? "unknown";
    const threadId = encodeThreadId(fromUserId);
    const text = extractText(raw);

    const msg = new Message<WeixinMessage>({
      id: String(raw.message_id ?? raw.seq ?? Date.now()),
      threadId,
      text,
      formatted: parseMarkdown(text),
      raw,
      author: {
        userId: fromUserId,
        userName: fromUserId,
        fullName: fromUserId,
        isBot: raw.message_type === MessageType.BOT,
        isMe: raw.message_type === MessageType.BOT && fromUserId === this.botUserId,
      },
      metadata: {
        dateSent: raw.create_time_ms ? new Date(raw.create_time_ms) : new Date(),
        edited: false,
      },
      attachments: [],
      isMention: true,
    });

    return msg;
  }

  // -------------------------------------------------------------------------
  // Long-poll loop
  // -------------------------------------------------------------------------

  private startPolling(): void {
    void this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    console.log("[WeixinAdapter] pollLoop started");
    while (this.pollingActive) {
      try {
        console.log("[WeixinAdapter] calling getUpdates...");
        const resp = await getUpdates({
          ...this.apiOpts,
          get_updates_buf: this.store?.getPollingBuf() ?? "",
        });
        console.log(`[WeixinAdapter] getUpdates returned: msgs=${resp.msgs?.length ?? 0} hasBuf=${Boolean(resp.get_updates_buf)}`);

        if (resp.get_updates_buf) {
          this.store?.setPollingBuf(resp.get_updates_buf);
        }

        const msgs = resp.msgs ?? [];
        for (const raw of msgs) {
          console.log(`[WeixinAdapter] msg: type=${raw.message_type} from=${raw.from_user_id} text=${JSON.stringify(raw.item_list?.map(i => i.text_item?.text).filter(Boolean))}`);
          // Only handle inbound user messages
          if (raw.message_type !== MessageType.USER) continue;
          if (!raw.from_user_id) continue;

          // Save context_token for use in replies
          if (raw.context_token) {
            this.store?.setContextToken(raw.from_user_id, raw.context_token);
          }

          this.dispatchMessage(raw);
        }
      } catch (err) {
        if (!this.pollingActive) break;
        // Back off briefly on unexpected errors, then retry
        console.error("[WeixinAdapter] polling error:", err);
        await sleep(5_000);
      }
    }
    console.log("[WeixinAdapter] pollLoop ended");
  }

  private dispatchMessage(raw: WeixinMessage): void {
    if (!this.chat) return;
    const message = this.parseMessage(raw);
    // All WeChat DMs are treated as @-mentions (no prefix required in DM)
    void this.chat.processMessage(this, message.threadId, message);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWeixinAdapter(config?: WeixinAdapterConfig): WeixinAdapter {
  return new WeixinAdapter(config);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
