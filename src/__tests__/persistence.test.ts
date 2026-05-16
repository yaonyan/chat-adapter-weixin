import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PersistenceStore } from "../persistence.js";

function tempFile(): string {
  return path.join(os.tmpdir(), `weixin-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

describe("PersistenceStore", () => {
  let filePath: string;

  beforeEach(() => {
    filePath = tempFile();
  });

  afterEach(() => {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  });

  it("starts with empty pollingBuf when file does not exist", () => {
    const store = new PersistenceStore(filePath);
    expect(store.getPollingBuf()).toBe("");
  });

  it("persists and reloads pollingBuf", () => {
    const store = new PersistenceStore(filePath);
    store.setPollingBuf("buf-abc123");

    const store2 = new PersistenceStore(filePath);
    expect(store2.getPollingBuf()).toBe("buf-abc123");
  });

  it("persists and reloads context tokens", () => {
    const store = new PersistenceStore(filePath);
    store.setContextToken("alice@im.wechat", "ctx-aaa");
    store.setContextToken("bob@im.wechat", "ctx-bbb");

    const store2 = new PersistenceStore(filePath);
    expect(store2.getContextToken("alice@im.wechat")).toBe("ctx-aaa");
    expect(store2.getContextToken("bob@im.wechat")).toBe("ctx-bbb");
  });

  it("returns undefined for unknown user", () => {
    const store = new PersistenceStore(filePath);
    expect(store.getContextToken("nobody@im.wechat")).toBeUndefined();
  });

  it("updates context token and overwrites old value", () => {
    const store = new PersistenceStore(filePath);
    store.setContextToken("alice@im.wechat", "old-token");
    store.setContextToken("alice@im.wechat", "new-token");

    const store2 = new PersistenceStore(filePath);
    expect(store2.getContextToken("alice@im.wechat")).toBe("new-token");
  });

  it("skips flush when value is unchanged", () => {
    const store = new PersistenceStore(filePath);
    store.setPollingBuf("same");
    const mtime1 = fs.statSync(filePath).mtimeMs;

    // Set same value — should not re-write file
    store.setPollingBuf("same");
    const mtime2 = fs.statSync(filePath).mtimeMs;
    expect(mtime2).toBe(mtime1);
  });

  it("recovers from corrupted file by starting fresh", () => {
    fs.writeFileSync(filePath, "{ not valid json }", "utf-8");
    const store = new PersistenceStore(filePath);
    expect(store.getPollingBuf()).toBe("");
  });

  it("persists both pollingBuf and contextTokens together", () => {
    const store = new PersistenceStore(filePath);
    store.setPollingBuf("buf-xyz");
    store.setContextToken("user@im.wechat", "ctx-xyz");

    const store2 = new PersistenceStore(filePath);
    expect(store2.getPollingBuf()).toBe("buf-xyz");
    expect(store2.getContextToken("user@im.wechat")).toBe("ctx-xyz");
  });
});
