import type { Attachment, FileUpload } from "chat";

import type { WeixinApiOptions } from "../api.js";
import type { MessageItem } from "../types.js";
import { MessageItemType } from "../types.js";
import { uploadFileToWeixin, uploadVideoToWeixin, uploadFileAttachmentToWeixin } from "./upload.js";
import { getCdnBaseUrl, downloadCdnBuffer } from "./cdn.js";
import { decryptAesEcb, parseAesKey } from "./aes-ecb.js";
import { getMimeFromFilename } from "./mime.js";

export function extractAttachments(msg: unknown): Attachment[] {
  if (typeof msg === "string") return [];
  return ((msg as Record<string, unknown>).attachments as Attachment[] | undefined) ?? [];
}

export function extractFileUploads(msg: unknown): FileUpload[] {
  if (typeof msg === "string") return [];
  return ((msg as Record<string, unknown>).files as FileUpload[] | undefined) ?? [];
}

async function blobToBuffer(blob: Blob): Promise<Buffer> {
  return Buffer.from(await blob.arrayBuffer());
}

async function getAttachmentData(attachment: Attachment): Promise<Buffer> {
  if (attachment.data) {
    if (attachment.data instanceof Blob) {
      return blobToBuffer(attachment.data);
    }
    return attachment.data;
  }
  if (attachment.fetchData) {
    return attachment.fetchData();
  }
  throw new Error("Attachment has no data or fetchData");
}

async function getFileUploadData(file: FileUpload): Promise<Buffer> {
  if (file.data instanceof Blob) {
    return blobToBuffer(file.data);
  }
  if (file.data instanceof ArrayBuffer) {
    return Buffer.from(file.data);
  }
  return file.data;
}

export async function buildMediaItemFromAttachment(
  attachment: Attachment,
  toUserId: string,
  opts: WeixinApiOptions,
  cdnBaseUrl: string,
): Promise<MessageItem | null> {
  const data = await getAttachmentData(attachment);
  const mime = attachment.mimeType ?? "application/octet-stream";

  if (attachment.type === "image" || mime.startsWith("image/")) {
    const uploaded = await uploadFileToWeixin(data, toUserId, opts, cdnBaseUrl);
    return {
      type: MessageItemType.IMAGE,
      image_item: {
        media: {
          encrypt_query_param: uploaded.downloadEncryptedQueryParam,
          aes_key: Buffer.from(uploaded.aeskey, "hex").toString("base64"),
          encrypt_type: 1,
        },
      },
    };
  }

  if (attachment.type === "video" || mime.startsWith("video/")) {
    const uploaded = await uploadVideoToWeixin(data, toUserId, opts, cdnBaseUrl);
    return {
      type: MessageItemType.VIDEO,
      video_item: {
        media: {
          encrypt_query_param: uploaded.downloadEncryptedQueryParam,
          aes_key: Buffer.from(uploaded.aeskey, "hex").toString("base64"),
          encrypt_type: 1,
        },
        video_size: uploaded.fileSizeCiphertext,
      },
    };
  }

  const fileName = attachment.name ?? "file";
  const uploaded = await uploadFileAttachmentToWeixin(data, toUserId, opts, cdnBaseUrl);
  return {
    type: MessageItemType.FILE,
    file_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey, "hex").toString("base64"),
        encrypt_type: 1,
      },
      file_name: fileName,
      len: String(uploaded.fileSize),
    },
  };
}

export async function buildMediaItemFromFileUpload(
  file: FileUpload,
  toUserId: string,
  opts: WeixinApiOptions,
  cdnBaseUrl: string,
): Promise<MessageItem | null> {
  const data = await getFileUploadData(file);
  const mime = file.mimeType ?? getMimeFromFilename(file.filename);

  if (mime.startsWith("image/")) {
    const uploaded = await uploadFileToWeixin(data, toUserId, opts, cdnBaseUrl);
    return {
      type: MessageItemType.IMAGE,
      image_item: {
        media: {
          encrypt_query_param: uploaded.downloadEncryptedQueryParam,
          aes_key: Buffer.from(uploaded.aeskey, "hex").toString("base64"),
          encrypt_type: 1,
        },
      },
    };
  }

  if (mime.startsWith("video/")) {
    const uploaded = await uploadVideoToWeixin(data, toUserId, opts, cdnBaseUrl);
    return {
      type: MessageItemType.VIDEO,
      video_item: {
        media: {
          encrypt_query_param: uploaded.downloadEncryptedQueryParam,
          aes_key: Buffer.from(uploaded.aeskey, "hex").toString("base64"),
          encrypt_type: 1,
        },
        video_size: uploaded.fileSizeCiphertext,
      },
    };
  }

  const uploaded = await uploadFileAttachmentToWeixin(data, toUserId, opts, cdnBaseUrl);
  return {
    type: MessageItemType.FILE,
    file_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey, "hex").toString("base64"),
        encrypt_type: 1,
      },
      file_name: file.filename,
      len: String(uploaded.fileSize),
    },
  };
}

export function buildAttachmentForMediaItem(
  item: MessageItem,
  itemType: number,
  cdnBaseUrl: string,
): Attachment | null {
  if (itemType === MessageItemType.IMAGE && item.image_item?.media?.encrypt_query_param) {
    const img = item.image_item;
    const media = img.media!;
    const encryptQueryParam = media.encrypt_query_param!;
    const aesKeyBase64 = media.aes_key;
    const aesKeyHex = img.aeskey;
    const fullUrl = media.full_url;

    return {
      type: "image",
      mimeType: "image/jpeg",
      fetchData: async () => {
        let aesKey: Buffer;
        if (aesKeyBase64) {
          aesKey = parseAesKey(aesKeyBase64);
        } else if (aesKeyHex) {
          aesKey = Buffer.from(aesKeyHex, "hex");
        } else {
          throw new Error("no AES key for image attachment");
        }
        const encrypted = await downloadCdnBuffer(encryptQueryParam, cdnBaseUrl, fullUrl);
        return decryptAesEcb(encrypted, aesKey);
      },
      fetchMetadata: {
        encryptQueryParam,
        aesKey: aesKeyBase64 ?? (aesKeyHex ? Buffer.from(aesKeyHex, "hex").toString("base64") : ""),
        fullUrl: fullUrl ?? "",
      },
    };
  }

  if (itemType === MessageItemType.VIDEO && item.video_item?.media?.encrypt_query_param) {
    const video = item.video_item;
    const media = video.media!;
    const encryptQueryParam = media.encrypt_query_param!;
    const aesKeyBase64 = media.aes_key ?? "";
    const fullUrl = media.full_url;

    return {
      type: "video",
      mimeType: "video/mp4",
      fetchData: async () => {
        const key = parseAesKey(aesKeyBase64);
        const encrypted = await downloadCdnBuffer(encryptQueryParam, cdnBaseUrl, fullUrl);
        return decryptAesEcb(encrypted, key);
      },
      fetchMetadata: { encryptQueryParam, aesKey: aesKeyBase64, fullUrl: fullUrl ?? "" },
    };
  }

  if (itemType === MessageItemType.FILE && item.file_item?.media?.encrypt_query_param) {
    const file = item.file_item;
    const media = file.media!;
    const encryptQueryParam = media.encrypt_query_param!;
    const aesKeyBase64 = media.aes_key ?? "";
    const fullUrl = media.full_url;

    return {
      type: "file",
      name: file.file_name ?? "file",
      mimeType: "application/octet-stream",
      fetchData: async () => {
        const key = parseAesKey(aesKeyBase64);
        const encrypted = await downloadCdnBuffer(encryptQueryParam, cdnBaseUrl, fullUrl);
        return decryptAesEcb(encrypted, key);
      },
      fetchMetadata: { encryptQueryParam, aesKey: aesKeyBase64, fullUrl: fullUrl ?? "" },
    };
  }

  return null;
}