import fs from "node:fs";
import path from "node:path";

/**
 * JSON shape written to disk.
 */
interface PersistedState {
  /** get_updates_buf cursor; empty string means "start from beginning". */
  pollingBuf: string;
  /** Map of userId → context_token for outbound replies. */
  contextTokens: Record<string, string>;
}

const EMPTY_STATE: PersistedState = { pollingBuf: "", contextTokens: {} };

/**
 * Simple file-backed store for adapter state that must survive process restarts.
 *
 * Writes are synchronous and atomic (write-to-temp + rename) to avoid
 * partial-write corruption. Reads are lazy (only on load).
 */
export class PersistenceStore {
  private readonly filePath: string;
  private state: PersistedState;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.state = this.load();
  }

  // -------------------------------------------------------------------------
  // polling buf
  // -------------------------------------------------------------------------

  getPollingBuf(): string {
    return this.state.pollingBuf;
  }

  setPollingBuf(buf: string): void {
    if (this.state.pollingBuf === buf) return;
    this.state.pollingBuf = buf;
    this.flush();
  }

  // -------------------------------------------------------------------------
  // context tokens
  // -------------------------------------------------------------------------

  getContextToken(userId: string): string | undefined {
    return this.state.contextTokens[userId];
  }

  setContextToken(userId: string, token: string): void {
    if (this.state.contextTokens[userId] === token) return;
    this.state.contextTokens[userId] = token;
    this.flush();
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private load(): PersistedState {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      return {
        pollingBuf: typeof parsed.pollingBuf === "string" ? parsed.pollingBuf : "",
        contextTokens:
          parsed.contextTokens && typeof parsed.contextTokens === "object"
            ? parsed.contextTokens
            : {},
      };
    } catch {
      // File doesn't exist or is malformed — start fresh.
      return { ...EMPTY_STATE, contextTokens: {} };
    }
  }

  private flush(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf-8");
    fs.renameSync(tmp, this.filePath);
  }
}

/**
 * Default state file path.
 * Can be overridden via WEIXIN_STATE_FILE env var.
 */
export function defaultStateFilePath(): string {
  return process.env.WEIXIN_STATE_FILE ?? path.join(process.cwd(), ".weixin-state.json");
}
