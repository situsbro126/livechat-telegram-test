# LiveChat.com ↔ Telegram Topics — Test MVP

This is a small proof-of-concept for the workflow:

**Website member → LiveChat → bridge → Telegram topic → CS reply → bridge → LiveChat → member**

## What works in this test

- Simulate a new website chat from the browser.
- Create one Telegram forum topic per LiveChat chat ID.
- Forward customer text into the topic.
- Let CS type a normal reply inside that Telegram topic.
- In `DEMO_MODE=true`, the bot echoes what would be sent to the member.
- In `DEMO_MODE=false`, Telegram replies are sent to LiveChat Agent Chat API `send_event`.
- A generic LiveChat webhook receiver is included for `incoming_event`-style payloads.

## 1. Create the Telegram side

1. Create a bot using **@BotFather** and copy its token.
2. Create a Telegram **Supergroup**.
3. Enable **Topics / Forum** for the group.
4. Add the bot as an administrator and allow it to **Manage Topics** and send messages.
5. Get the numeric group ID (`-100...`).

Telegram's Bot API supports `createForumTopic`, and the bot needs the manage-topics admin permission in a forum supergroup.

## 2. Configure

Copy `.env.example` to `.env` and fill at least:

```env
DEMO_MODE=true
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_GROUP_ID=-1001234567890
TELEGRAM_WEBHOOK_SECRET=some-long-random-secret
```

For the easiest first test, keep `DEMO_MODE=true`.

## 3. Run

Requires Node.js 18+.

```bash
npm start
```

Open:

```text
http://localhost:8787
```

Use the form to simulate a member called `Brow77` with issue `Deposit`. A Telegram topic should be created.

## 4. Make Telegram replies reach this server

Telegram webhooks need a public **HTTPS** address. Deploy this folder to a small Node host (Render/Railway/etc.) or expose it temporarily with a tunnel.

Set:

```env
PUBLIC_BASE_URL=https://your-public-host.example
```

Then run:

```bash
npm run setup:telegram
```

Now type inside the generated Telegram topic. In demo mode, the bot responds with:

```text
🧪 DEMO → member
<your reply>
```

That verifies **topic mapping + reply routing** before touching the real LiveChat account.

## 5. Connect actual LiveChat sending

The bridge uses:

```text
POST https://api.livechatinc.com/v3.5/agent/action/send_event
```

with a message event and `visibility: "all"`.

Your LiveChat app/token needs a suitable read/write chats scope such as `chats--all:rw` or `chats--access:rw`, depending on your setup.

Set:

```env
DEMO_MODE=false
LIVECHAT_ACCESS_TOKEN=your_access_token
```

Then a Telegram topic reply will be sent to the mapped LiveChat chat ID.

## 6. Receive actual customer messages from LiveChat

This test receiver exposes:

```text
POST /livechat/webhook/<LIVECHAT_WEBHOOK_KEY>
```

Example:

```text
https://your-public-host.example/livechat/webhook/a-long-random-key
```

Configure your LiveChat app's relevant incoming-message webhook to point there. The code accepts common payload forms for an `incoming_event` message and also a wrapped `payload` form.

**Important:** LiveChat app webhook configuration/authorization should be verified in your Developer Console before production use. The exact payload and author metadata should be logged once during the first real test, then the normalizer in `server.js` can be tightened to your account's actual event shape.

## Safety / production notes

This is a testing bridge, not yet a hardened production service. Before production:

- Replace `data.json` with SQLite/Postgres/Redis.
- Verify LiveChat webhook authenticity using the mechanism provided for your app configuration.
- Add deduplication by event/update ID.
- Add agent allowlists for Telegram user IDs.
- Add retry queues and audit logs.
- Avoid relaying passwords, OTPs, tokens, PINs, or unnecessary customer data.
- Add attachment handling separately after text routing is proven stable.

## Useful test order

1. Local browser form → mapping created.
2. Browser form → Telegram topic created.
3. Telegram topic reply → demo echo.
4. Real LiveChat token → Telegram reply reaches a test LiveChat conversation.
5. Real LiveChat incoming webhook → customer message creates/updates the correct Telegram topic.
6. Only after that: attachments, Take/Close/Transfer, canned responses, agent assignment.
