import { encryptAesEcb } from "./aes-ecb.js";

const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

export function getCdnBaseUrl(): string {
  return process.env.WEIXIN_CDN_BASE_URL ?? CDN_BASE_URL;
}

export function buildCdnDownloadUrl(encryptedQueryParam: string, cdnBaseUrl: string): string {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

export function buildCdnUploadUrl(
  cdnBaseUrl: string,
  uploadParam: string,
  filekey: string,
): string {
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

export async function uploadBufferToCdn(params: {
  buf: Buffer;
  uploadFullUrl?: string;
  uploadParam?: string;
  filekey: string;
  cdnBaseUrl: string;
  aeskey: Buffer;
}): Promise<{ downloadParam: string }> {
  const { buf, uploadFullUrl, uploadParam, filekey, cdnBaseUrl, aeskey } = params;

  const ciphertext = encryptAesEcb(buf, aeskey);

  let cdnUrl: string;
  const trimmedFull = uploadFullUrl?.trim();
  if (trimmedFull) {
    cdnUrl = trimmedFull;
  } else if (uploadParam) {
    cdnUrl = buildCdnUploadUrl(cdnBaseUrl, uploadParam, filekey);
  } else {
    throw new Error("uploadBufferToCdn: neither uploadFullUrl nor uploadParam provided");
  }

  const maxRetries = 3;
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      });
      if (!res.ok) {
        throw new Error(`CDN upload HTTP ${res.status}: ${await res.text()}`);
      }
      const downloadParam = res.headers.get("x-encrypted-param");
      if (!downloadParam) {
        throw new Error("CDN upload missing x-encrypted-param header");
      }
      return { downloadParam };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }
  throw lastErr;
}

export async function downloadCdnBuffer(
  encryptedQueryParam: string,
  cdnBaseUrl: string,
  fullUrl?: string,
): Promise<Buffer> {
  const url = fullUrl || buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`CDN download HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}