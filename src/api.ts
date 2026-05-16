import crypto from "node:crypto";

import type {
  GetConfigResp,
  GetUpdatesReq,
  GetUpdatesResp,
  SendMessageReq,
  SendTypingReq,
} from "./types.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;

export interface WeixinApiOptions {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  longPollTimeoutMs?: number;
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/** X-WECHAT-UIN header: random uint32 -> decimal string -> base64. */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

async function postJson<T>(params: {
  baseUrl: string;
  endpoint: string;
  body: unknown;
  token?: string;
  timeoutMs?: number;
}): Promise<T> {
  const url = new URL(params.endpoint, ensureTrailingSlash(params.baseUrl));
  const controller =
    params.timeoutMs !== undefined ? new AbortController() : undefined;
  const t =
    controller && params.timeoutMs !== undefined
      ? setTimeout(() => controller.abort(), params.timeoutMs)
      : undefined;
  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: buildHeaders(params.token),
      body: JSON.stringify(params.body),
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (t !== undefined) clearTimeout(t);
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`[weixin] ${params.endpoint} HTTP ${res.status}: ${text}`);
    }
    return JSON.parse(text) as T;
  } catch (err) {
    if (t !== undefined) clearTimeout(t);
    throw err;
  }
}

/**
 * Long-poll getUpdates.
 * Returns an empty response on client-side timeout so the caller can retry.
 */
export async function getUpdates(
  opts: WeixinApiOptions & GetUpdatesReq,
): Promise<GetUpdatesResp> {
  const timeout = opts.longPollTimeoutMs ?? opts.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  try {
    return await postJson<GetUpdatesResp>({
      baseUrl: opts.baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: { get_updates_buf: opts.get_updates_buf ?? "" },
      token: opts.token,
      timeoutMs: timeout,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: opts.get_updates_buf };
    }
    throw err;
  }
}

/** Send a message downstream. */
export async function sendMessage(
  opts: WeixinApiOptions & { body: SendMessageReq },
): Promise<void> {
  await postJson<unknown>({
    baseUrl: opts.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: opts.body,
    token: opts.token,
    timeoutMs: opts.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
  });
}

/** Fetch bot config, including typing_ticket. */
export async function getConfig(
  opts: WeixinApiOptions & { ilinkUserId: string; contextToken?: string },
): Promise<GetConfigResp> {
  return postJson<GetConfigResp>({
    baseUrl: opts.baseUrl,
    endpoint: "ilink/bot/getconfig",
    body: {
      ilink_user_id: opts.ilinkUserId,
      context_token: opts.contextToken,
    },
    token: opts.token,
    timeoutMs: opts.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
  });
}

/** Send a typing indicator. */
export async function sendTyping(
  opts: WeixinApiOptions & { body: SendTypingReq },
): Promise<void> {
  await postJson<unknown>({
    baseUrl: opts.baseUrl,
    endpoint: "ilink/bot/sendtyping",
    body: opts.body,
    token: opts.token,
    timeoutMs: opts.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
  });
}
