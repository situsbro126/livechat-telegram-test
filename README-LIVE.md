# LiveChat ↔ Telegram — Live test

Render env:
- PUBLIC_BASE_URL=https://livechat-telegram-test.onrender.com
- TELEGRAM_BOT_TOKEN=<new bot token>
- TELEGRAM_GROUP_ID=<group id>
- TELEGRAM_WEBHOOK_SECRET=<random secret>
- LIVECHAT_ACCESS_TOKEN=<LiveChat PAT>
- LIVECHAT_AUTH_SCHEME=Basic
- LIVECHAT_WEBHOOK_SECRET=<random secret; same value in LiveChat webhook config>
- DEMO_MODE=false

LiveChat Developer Console:
1. Create a private app for LiveChat.
2. Add App Authorization / required chat scopes.
3. Add Chat Webhooks.
4. Webhook URL: https://livechat-telegram-test.onrender.com/livechat/webhook
5. Secret key: exactly the same value as LIVECHAT_WEBHOOK_SECRET.
6. Add license webhook triggers: incoming_chat and incoming_event.
7. Private-install the app on the LiveChat license.

For quick development sending from Telegram back into LiveChat, create a LiveChat Personal Access Token with chats--access:rw or chats--all:rw and put it in LIVECHAT_ACCESS_TOKEN. PAT authentication uses Basic.

Test:
1. Open your own website in incognito and start a LiveChat chat.
2. Customer message should create a Telegram topic and appear there.
3. Reply inside that Telegram topic.
4. Bridge calls Agent Chat API send_event and the reply should appear in the website chat.
