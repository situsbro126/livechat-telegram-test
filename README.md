# LiveChat ↔ Telegram Bridge v2.5 — Canned File

V2.5 keeps the V2.4 race/recovery fixes and adds canned responses from a JSON file.

## Canned response commands in Telegram

- `#` or `/canned` — show quick-reply menu (first 20 matches)
- `#depo` — immediately send canned response `depo` to the active LiveChat
- `#cari bonus` — search canned shortcuts/text containing `bonus`
- LiveChat shortcuts containing spaces are normalized with underscores, e.g. `share fb` → `#share_fb`

## Recommended setup on Render

Do **not** put your real canned responses in a public GitHub repo.

1. Render → your Web Service → **Environment**.
2. Under **Secret Files**, add a file named `canned.json`.
3. Paste the contents of the generated `canned.json` into that secret file.
4. Save/redeploy.

Render exposes the file at `/etc/secrets/canned.json`. The bridge detects that path automatically.

## Required Environment Variables

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_GROUP_ID`
- `TELEGRAM_WEBHOOK_SECRET`
- `PUBLIC_BASE_URL`
- `LIVECHAT_ACCESS_TOKEN`

Recommended:

- `LIVECHAT_POLL_SECONDS=2`
- `MAX_NEW_TOPICS_PER_POLL=3`
- `BOOTSTRAP_SCAN_PAGES=5`

No `CANNED_RESPONSES_JSON` is needed when the secret file exists.

## Supported canned.json shapes

The bridge accepts either:

```json
{
  "depo": "Deposit kakak sudah kami proses ya."
}
```

or a LiveChat-style array:

```json
[
  {"text":"Deposit kakak sudah kami proses ya.","tags":["depo","dpo"]}
]
```

## Existing workflow retained

- Pre-chat Nama + Kendala can create/reopen the Telegram topic.
- Only active chats are routed.
- Old/closed chat history is not replayed as new topics.
- Telegram reply → LiveChat.
- End Chat closes the Telegram topic.
- Returning member reopens prior topic when mapping is available.
- Deleted/invalid Telegram topic can recover to a new topic.
- Reply race during polling is handled.
