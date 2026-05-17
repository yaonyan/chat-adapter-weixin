export { createWeixinAdapter, WeixinAdapter } from "./adapter.js";
export type { WeixinAdapterConfig, WeixinThreadId } from "./adapter.js";
export type { WeixinApiOptions } from "./api.js";
export { getUpdates, sendMessage, getConfig, sendTyping, getUploadUrl } from "./api.js";
export { PersistenceStore, defaultStateFilePath } from "./persistence.js";
export {
  login,
  startLogin,
  waitForLogin,
} from "./login.js";
export type {
  LoginOptions,
  LoginCallbacks,
  LoginResult,
  StartLoginResult,
  WaitLoginResult,
  QRStatus,
} from "./login.js";
export type * from "./types.js";
export {
  uploadFileToWeixin,
  uploadVideoToWeixin,
  uploadFileAttachmentToWeixin,
} from "./media/upload.js";
export type { UploadedFileInfo } from "./media/upload.js";
export {
  downloadMediaFromItem,
} from "./media/download.js";
export type { DownloadedMediaInfo } from "./media/download.js";
export {
  getCdnBaseUrl,
} from "./media/cdn.js";
export {
  encryptAesEcb,
  decryptAesEcb,
  parseAesKey,
} from "./media/aes-ecb.js";
export {
  getMimeFromFilename,
  getExtensionFromMime,
} from "./media/mime.js";
export {
  buildAttachmentForMediaItem,
  buildMediaItemFromAttachment,
  buildMediaItemFromFileUpload,
  extractAttachments,
  extractFileUploads,
} from "./media/helpers.js";
