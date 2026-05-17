/**
 * WeChat (iLink) API types.
 * Mirrors the proto types from openclaw-weixin.
 */

// ---------------------------------------------------------------------------
// Media types
// ---------------------------------------------------------------------------

export const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const;

export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

export const MessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
} as const;

export const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

// ---------------------------------------------------------------------------
// Message item payloads
// ---------------------------------------------------------------------------

export interface TextItem {
  text?: string;
}

export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

export interface ImageItem {
  media?: CDNMedia;
  thumb_media?: CDNMedia;
  aeskey?: string;
  url?: string;
}

export interface VoiceItem {
  media?: CDNMedia;
  /** Encoding: 1=pcm 2=adpcm 3=feature 4=speex 5=amr 6=silk 7=mp3 8=ogg-speex */
  encode_type?: number;
  sample_rate?: number;
  playtime?: number;
  /** Voice-to-text transcript (if available). */
  text?: string;
}

export interface FileItem {
  media?: CDNMedia;
  file_name?: string;
  md5?: string;
  len?: string;
}

export interface VideoItem {
  media?: CDNMedia;
  video_size?: number;
  play_length?: number;
  thumb_media?: CDNMedia;
}

export interface MessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
}

// ---------------------------------------------------------------------------
// Unified message (WeixinMessage)
// ---------------------------------------------------------------------------

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  /** Per-message token; must be echoed back in all replies to this message. */
  context_token?: string;
}

// ---------------------------------------------------------------------------
// GetUpdates (long-poll)
// ---------------------------------------------------------------------------

export interface GetUpdatesReq {
  get_updates_buf?: string;
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  /** Server-suggested next long-poll timeout (ms). */
  longpolling_timeout_ms?: number;
}

// ---------------------------------------------------------------------------
// SendMessage
// ---------------------------------------------------------------------------

export interface SendMessageReq {
  msg?: WeixinMessage;
}

export interface SendMessageResp {
  ret?: number;
  errmsg?: string;
}

// ---------------------------------------------------------------------------
// SendTyping
// ---------------------------------------------------------------------------

export const TypingStatus = {
  TYPING: 1,
  CANCEL: 2,
} as const;

export interface SendTypingReq {
  ilink_user_id?: string;
  typing_ticket?: string;
  status?: number;
}

export interface SendTypingResp {
  ret?: number;
  errmsg?: string;
}

// ---------------------------------------------------------------------------
// GetUploadUrl
// ---------------------------------------------------------------------------

export interface GetUploadUrlReq {
  filekey?: string;
  media_type?: number;
  to_user_id?: string;
  rawsize?: number;
  rawfilemd5?: string;
  filesize?: number;
  thumb_rawsize?: number;
  thumb_rawfilemd5?: string;
  thumb_filesize?: number;
  no_need_thumb?: boolean;
  aeskey?: string;
}

export interface GetUploadUrlResp {
  upload_param?: string;
  thumb_upload_param?: string;
  upload_full_url?: string;
}

// ---------------------------------------------------------------------------
// GetConfig
// ---------------------------------------------------------------------------

export interface GetConfigResp {
  ret?: number;
  errmsg?: string;
  typing_ticket?: string;
}
