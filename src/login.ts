import { randomUUID } from "node:crypto";

import { getJson, postJson } from "./api.js";

/** Base URL used exclusively for QR login (different from the message API). */
const LOGIN_BASE_URL = "https://ilinkai.weixin.qq.com";

/** Default bot_type for iLink QR login. */
const DEFAULT_BOT_TYPE = "3";

/** Client-side long-poll timeout for get_qrcode_status. */
const QR_POLL_TIMEOUT_MS = 35_000;

/** Maximum number of QR code refreshes before giving up. */
const MAX_QR_REFRESH = 3;

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export type QRStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect";

interface StatusResponse {
  status: QRStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export type LoginResult =
  | { ok: true; botToken: string; accountId: string; baseUrl: string; userId?: string }
  | { ok: false; reason: string };

export type LoginCallbacks = {
  /**
   * Called once a QR code URL is available. Display it to the user.
   * `qrcodeUrl` is the URL that encodes the QR payload (suitable for qrcode-terminal).
   */
  onQRCode: (qrcodeUrl: string) => void | Promise<void>;
  /**
   * Called when the QR code has expired and a new one was fetched.
   * The caller should re-display the new QR code.
   */
  onQRRefresh?: (qrcodeUrl: string) => void | Promise<void>;
  /**
   * Called when the server requires a numeric verify code (pairing PIN).
   * The callback must return the code entered by the user.
   */
  onVerifyCode: (isRetry: boolean) => string | Promise<string>;
  /** Called when the user has scanned but not yet confirmed. */
  onScanned?: () => void | Promise<void>;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function fetchQRCode(
  botType: string,
  existingTokens: string[],
): Promise<QRCodeResponse> {
  const endpoint = `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`;
  return postJson<QRCodeResponse>({
    baseUrl: LOGIN_BASE_URL,
    endpoint,
    body: { local_token_list: existingTokens },
    timeoutMs: 15_000,
  });
}

async function pollQRStatus(
  baseUrl: string,
  qrcode: string,
  verifyCode?: string,
): Promise<StatusResponse> {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) {
    endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
  }
  try {
    return await getJson<StatusResponse>({
      baseUrl,
      endpoint,
      timeoutMs: QR_POLL_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    // Treat network/gateway errors as transient; keep polling.
    return { status: "wait" };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LoginOptions {
  /** Session ID for deduplication; auto-generated when omitted. */
  sessionId?: string;
  /** Bot type passed to get_bot_qrcode (default: "3"). */
  botType?: string;
  /** Tokens already stored locally — sent to the server to avoid duplicate bindings. */
  existingTokens?: string[];
  /** Overall timeout in ms (default: 480_000 = 8 minutes). */
  timeoutMs?: number;
  callbacks: LoginCallbacks;
}

/**
 * Run the full WeChat QR-code login flow.
 *
 * 1. Fetches a QR code from the login API.
 * 2. Calls `callbacks.onQRCode` so the caller can display it.
 * 3. Long-polls `get_qrcode_status` until confirmed, expired (auto-refresh),
 *    or timed out.
 * 4. Handles verify-code challenges and IDC redirects transparently.
 *
 * Returns `{ ok: true, botToken, accountId, baseUrl }` on success,
 * or `{ ok: false, reason }` on failure.
 */
export async function login(opts: LoginOptions): Promise<LoginResult> {
  const botType = opts.botType ?? DEFAULT_BOT_TYPE;
  const existingTokens = opts.existingTokens ?? [];
  const timeoutMs = opts.timeoutMs ?? 480_000;
  const deadline = Date.now() + timeoutMs;

  // Fetch initial QR code
  let qrResponse: QRCodeResponse;
  try {
    qrResponse = await fetchQRCode(botType, existingTokens);
  } catch (err) {
    return { ok: false, reason: `Failed to fetch QR code: ${String(err)}` };
  }

  await opts.callbacks.onQRCode(qrResponse.qrcode_img_content);

  let qrcode = qrResponse.qrcode;
  let pollingBaseUrl = LOGIN_BASE_URL;
  let pendingVerifyCode: string | undefined;
  let scannedNotified = false;
  let refreshCount = 0;

  async function refreshQR(): Promise<boolean> {
    refreshCount++;
    if (refreshCount > MAX_QR_REFRESH) return false;
    try {
      const fresh = await fetchQRCode(botType, existingTokens);
      qrcode = fresh.qrcode;
      scannedNotified = false;
      pendingVerifyCode = undefined;
      await (opts.callbacks.onQRRefresh ?? opts.callbacks.onQRCode)(
        fresh.qrcode_img_content,
      );
      return true;
    } catch {
      return false;
    }
  }

  while (Date.now() < deadline) {
    const resp = await pollQRStatus(pollingBaseUrl, qrcode, pendingVerifyCode);

    switch (resp.status) {
      case "wait":
        break;

      case "scaned":
        if (pendingVerifyCode) {
          // Server accepted the verify code; clear it.
          pendingVerifyCode = undefined;
        }
        if (!scannedNotified) {
          scannedNotified = true;
          await opts.callbacks.onScanned?.();
        }
        break;

      case "confirmed": {
        if (!resp.ilink_bot_id) {
          return { ok: false, reason: "Login confirmed but ilink_bot_id missing." };
        }
        return {
          ok: true,
          botToken: resp.bot_token ?? "",
          accountId: resp.ilink_bot_id,
          baseUrl: resp.baseurl ?? LOGIN_BASE_URL,
          userId: resp.ilink_user_id,
        };
      }

      case "expired": {
        const ok = await refreshQR();
        if (!ok) {
          return { ok: false, reason: `QR code expired ${MAX_QR_REFRESH} times, giving up.` };
        }
        break;
      }

      case "need_verifycode": {
        const isRetry = Boolean(pendingVerifyCode);
        pendingVerifyCode = await opts.callbacks.onVerifyCode(isRetry);
        // Don't wait 1 s before sending the verify code.
        continue;
      }

      case "verify_code_blocked": {
        pendingVerifyCode = undefined;
        const ok = await refreshQR();
        if (!ok) {
          return { ok: false, reason: "Verify code blocked too many times." };
        }
        break;
      }

      case "scaned_but_redirect": {
        if (resp.redirect_host) {
          pollingBaseUrl = `https://${resp.redirect_host}`;
        }
        break;
      }

      case "binded_redirect":
        return {
          ok: false,
          reason: "This bot is already bound to another instance.",
        };
    }

    await new Promise((r) => setTimeout(r, 1_000));
  }

  return { ok: false, reason: "Login timed out." };
}

// ---------------------------------------------------------------------------
// Convenience: session-based two-step login (start + wait)
// ---------------------------------------------------------------------------

type ActiveSession = {
  sessionId: string;
  qrcodeUrl: string;
  qrcode: string;
  pollingBaseUrl: string;
  pendingVerifyCode?: string;
  startedAt: number;
};

const SESSION_TTL_MS = 5 * 60_000;
const activeSessions = new Map<string, ActiveSession>();

function purgeExpired(): void {
  const now = Date.now();
  for (const [id, s] of activeSessions) {
    if (now - s.startedAt > SESSION_TTL_MS) activeSessions.delete(id);
  }
}

export type StartLoginResult =
  | { ok: true; sessionId: string; qrcodeUrl: string }
  | { ok: false; reason: string };

/**
 * Step 1: fetch a QR code and return the URL + a session ID.
 * The caller displays the QR code, then calls `waitForLogin(sessionId, ...)`.
 */
export async function startLogin(opts?: {
  botType?: string;
  existingTokens?: string[];
  sessionId?: string;
}): Promise<StartLoginResult> {
  purgeExpired();

  const sessionId = opts?.sessionId ?? randomUUID();
  const botType = opts?.botType ?? DEFAULT_BOT_TYPE;
  const existingTokens = opts?.existingTokens ?? [];

  try {
    const qr = await fetchQRCode(botType, existingTokens);
    activeSessions.set(sessionId, {
      sessionId,
      qrcodeUrl: qr.qrcode_img_content,
      qrcode: qr.qrcode,
      pollingBaseUrl: LOGIN_BASE_URL,
      startedAt: Date.now(),
    });
    return { ok: true, sessionId, qrcodeUrl: qr.qrcode_img_content };
  } catch (err) {
    return { ok: false, reason: `Failed to fetch QR code: ${String(err)}` };
  }
}

export type WaitLoginResult = LoginResult & {
  /** Present when the server requires a pairing PIN from the user. */
  needsVerifyCode?: true;
};

/**
 * Step 2: poll once for the current QR scan status.
 * Intended for HTTP-server / MCP-tool usage where the caller drives the polling loop.
 *
 * - Returns `{ ok: false, needsVerifyCode: true }` when a PIN is required.
 *   Call again with `verifyCode` to submit it.
 * - Returns `{ ok: true, ... }` when login is complete.
 * - Returns `{ ok: false, reason }` on terminal errors or unknown session.
 */
export async function waitForLogin(
  sessionId: string,
  opts?: { verifyCode?: string; botType?: string; existingTokens?: string[] },
): Promise<WaitLoginResult> {
  const session = activeSessions.get(sessionId);
  if (!session) {
    return { ok: false, reason: "Unknown or expired session. Call startLogin() first." };
  }
  if (Date.now() - session.startedAt > SESSION_TTL_MS) {
    activeSessions.delete(sessionId);
    return { ok: false, reason: "Session expired. Call startLogin() again." };
  }

  if (opts?.verifyCode) {
    session.pendingVerifyCode = opts.verifyCode;
  }

  const resp = await pollQRStatus(
    session.pollingBaseUrl,
    session.qrcode,
    session.pendingVerifyCode,
  );

  switch (resp.status) {
    case "wait":
    case "scaned":
      if (session.pendingVerifyCode && resp.status === "scaned") {
        session.pendingVerifyCode = undefined;
      }
      return { ok: false, reason: resp.status === "wait" ? "Waiting for scan." : "Scanned, waiting for confirmation." };

    case "confirmed": {
      activeSessions.delete(sessionId);
      if (!resp.ilink_bot_id) {
        return { ok: false, reason: "Login confirmed but ilink_bot_id missing." };
      }
      return {
        ok: true,
        botToken: resp.bot_token ?? "",
        accountId: resp.ilink_bot_id,
        baseUrl: resp.baseurl ?? LOGIN_BASE_URL,
        userId: resp.ilink_user_id,
      };
    }

    case "need_verifycode":
      return { ok: false, reason: "Verify code required.", needsVerifyCode: true };

    case "verify_code_blocked":
      session.pendingVerifyCode = undefined;
      return { ok: false, reason: "Verify code blocked. Please try again." };

    case "expired": {
      // Auto-refresh QR code
      const botType = opts?.botType ?? DEFAULT_BOT_TYPE;
      const existingTokens = opts?.existingTokens ?? [];
      try {
        const fresh = await fetchQRCode(botType, existingTokens);
        session.qrcode = fresh.qrcode;
        session.qrcodeUrl = fresh.qrcode_img_content;
        session.startedAt = Date.now();
        session.pendingVerifyCode = undefined;
        return { ok: false, reason: "QR expired, refreshed.", qrcodeUrl: fresh.qrcode_img_content } as WaitLoginResult & { qrcodeUrl: string };
      } catch (err) {
        activeSessions.delete(sessionId);
        return { ok: false, reason: `QR expired and refresh failed: ${String(err)}` };
      }
    }

    case "scaned_but_redirect":
      if (resp.redirect_host) {
        session.pollingBaseUrl = `https://${resp.redirect_host}`;
      }
      return { ok: false, reason: "IDC redirect, continuing." };

    case "binded_redirect":
      activeSessions.delete(sessionId);
      return { ok: false, reason: "Bot already bound to another instance." };
  }
}
