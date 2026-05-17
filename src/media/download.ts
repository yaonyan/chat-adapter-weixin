import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { downloadCdnBuffer, getCdnBaseUrl } from "./cdn.js";
import { decryptAesEcb, parseAesKey } from "./aes-ecb.js";
import { getExtensionFromMime } from "./mime.js";
import type { MessageItem } from "../types.js";
import { MessageItemType } from "../types.js";

const MEDIA_TEMP_DIR = path.join(os.tmpdir(), "weixin-adapter-media");

async function ensureMediaDir(subdir: string): Promise<string> {
  const dir = path.join(MEDIA_TEMP_DIR, subdir);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function downloadAndDecryptBuffer(
  encryptedQueryParam: string,
  aesKeyBase64: string,
  cdnBaseUrl: string,
  fullUrl?: string,
): Promise<Buffer> {
  const encrypted = await downloadCdnBuffer(encryptedQueryParam, cdnBaseUrl, fullUrl);
  const key = parseAesKey(aesKeyBase64);
  return decryptAesEcb(encrypted, key);
}

export interface DownloadedMediaInfo {
  filePath: string;
  mimeType: string;
  type: "image" | "video" | "file" | "audio";
}

export async function downloadMediaFromItem(
  item: MessageItem,
  cdnBaseUrl?: string,
): Promise<DownloadedMediaInfo | null> {
  const baseUrl = cdnBaseUrl ?? getCdnBaseUrl();
  const inboundDir = await ensureMediaDir("inbound");

  if (item.type === MessageItemType.IMAGE && item.image_item?.media?.encrypt_query_param) {
    const img = item.image_item;
    const aesKeyBase64 = img.aeskey
      ? Buffer.from(img.aeskey, "hex").toString("base64")
      : img.media!.aes_key!;
    const buf = await downloadAndDecryptBuffer(
      img.media!.encrypt_query_param!,
      aesKeyBase64,
      baseUrl,
      img.media!.full_url,
    );
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    const filePath = path.join(inboundDir, name);
    await writeFile(filePath, buf);
    return { filePath, mimeType: "image/jpeg", type: "image" };
  }

  if (item.type === MessageItemType.VIDEO && item.video_item?.media?.encrypt_query_param) {
    const video = item.video_item;
    const buf = await downloadAndDecryptBuffer(
      video.media!.encrypt_query_param!,
      video.media!.aes_key!,
      baseUrl,
      video.media!.full_url,
    );
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
    const filePath = path.join(inboundDir, name);
    await writeFile(filePath, buf);
    return { filePath, mimeType: "video/mp4", type: "video" };
  }

  if (item.type === MessageItemType.FILE && item.file_item?.media?.encrypt_query_param) {
    const file = item.file_item;
    const buf = await downloadAndDecryptBuffer(
      file.media!.encrypt_query_param!,
      file.media!.aes_key!,
      baseUrl,
      file.media!.full_url,
    );
    const origName = file.file_name ?? "file.bin";
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${origName}`;
    const filePath = path.join(inboundDir, name);
    await writeFile(filePath, buf);
    return { filePath, mimeType: "application/octet-stream", type: "file" };
  }

  return null;
}