import fs from "node:fs/promises";
import crypto from "node:crypto";

import { getUploadUrl } from "../api.js";
import type { WeixinApiOptions } from "../api.js";
import { UploadMediaType } from "../types.js";
import { aesEcbPaddedSize } from "./aes-ecb.js";
import { getCdnBaseUrl, uploadBufferToCdn } from "./cdn.js";

export interface UploadedFileInfo {
  filekey: string;
  downloadEncryptedQueryParam: string;
  aeskey: string;
  fileSize: number;
  fileSizeCiphertext: number;
}

async function uploadMediaToCdn(params: {
  data: Buffer;
  toUserId: string;
  opts: WeixinApiOptions;
  cdnBaseUrl: string;
  mediaType: (typeof UploadMediaType)[keyof typeof UploadMediaType];
}): Promise<UploadedFileInfo> {
  const { data: plaintext, toUserId, opts, cdnBaseUrl, mediaType } = params;

  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);

  const uploadUrlResp = await getUploadUrl({
    ...opts,
    body: {
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aeskey.toString("hex"),
    },
  });

  const uploadFullUrl = uploadUrlResp.upload_full_url?.trim();
  const uploadParam = uploadUrlResp.upload_param;

  const { downloadParam } = await uploadBufferToCdn({
    buf: plaintext,
    uploadFullUrl: uploadFullUrl || undefined,
    uploadParam: uploadParam ?? undefined,
    filekey,
    cdnBaseUrl,
    aeskey,
  });

  return {
    filekey,
    downloadEncryptedQueryParam: downloadParam,
    aeskey: aeskey.toString("hex"),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}

export async function uploadFileToWeixin(
  filePathOrData: string | Buffer,
  toUserId: string,
  opts: WeixinApiOptions,
  cdnBaseUrl?: string,
): Promise<UploadedFileInfo> {
  const data = typeof filePathOrData === "string" ? await fs.readFile(filePathOrData) : filePathOrData;
  return uploadMediaToCdn({
    data,
    toUserId,
    opts,
    cdnBaseUrl: cdnBaseUrl ?? getCdnBaseUrl(),
    mediaType: UploadMediaType.IMAGE,
  });
}

export async function uploadVideoToWeixin(
  filePathOrData: string | Buffer,
  toUserId: string,
  opts: WeixinApiOptions,
  cdnBaseUrl?: string,
): Promise<UploadedFileInfo> {
  const data = typeof filePathOrData === "string" ? await fs.readFile(filePathOrData) : filePathOrData;
  return uploadMediaToCdn({
    data,
    toUserId,
    opts,
    cdnBaseUrl: cdnBaseUrl ?? getCdnBaseUrl(),
    mediaType: UploadMediaType.VIDEO,
  });
}

export async function uploadFileAttachmentToWeixin(
  filePathOrData: string | Buffer,
  toUserId: string,
  opts: WeixinApiOptions,
  cdnBaseUrl?: string,
): Promise<UploadedFileInfo> {
  const data = typeof filePathOrData === "string" ? await fs.readFile(filePathOrData) : filePathOrData;
  return uploadMediaToCdn({
    data,
    toUserId,
    opts,
    cdnBaseUrl: cdnBaseUrl ?? getCdnBaseUrl(),
    mediaType: UploadMediaType.FILE,
  });
}