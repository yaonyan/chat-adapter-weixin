# @chat-adapter/weixin

WeChat (企业微信/iLink) adapter for the [chat](https://www.npmjs.com/package/chat) SDK.

## Installation

```bash
pnpm add @chat-adapter/weixin chat
```

## Usage

```typescript
import { Chat } from "chat";
import { createWeixinAdapter } from "@chat-adapter/weixin";
import { createMemoryState } from "@chat-adapter/state-memory";

const adapter = createWeixinAdapter({
  baseUrl: "https://ilink.weixin.qq.com/",
  token: process.env.WEIXIN_BOT_TOKEN,
  botUserId: process.env.WEIXIN_BOT_USER_ID,
});

const bot = new Chat({
  userName: "my-bot",
  adapters: { weixin: adapter },
  state: createMemoryState(),
});

bot.onNewMention(async (thread, message) => {
  await thread.post(`You said: ${message.text}`);
});
```

## Environment Variables

| Variable | Description |
|---|---|
| `WEIXIN_BASE_URL` | iLink API base URL (default: `https://ilink.weixin.qq.com/`) |
| `WEIXIN_BOT_TOKEN` | Bot bearer token |
| `WEIXIN_BOT_USER_ID` | Bot's own WeChat user ID (for `isMe` detection) |

## How It Works

- Uses **long-poll** (`POST /ilink/bot/getupdates`) to receive messages — no webhook server required.
- All WeChat conversations are DMs; every inbound message triggers `onNewMention`.
- Replies include the `context_token` from the triggering message (required by the WeChat API).
- Thread ID format: `weixin:{userId}` (e.g. `weixin:alice@im.wechat`).

## Limitations

- Text messages only in v0.1. Media (image/video/voice/file) attachment sending is not yet supported.
- No server-side message history API; message history is persisted locally via the `chat` SDK's `ThreadHistoryCache`.
