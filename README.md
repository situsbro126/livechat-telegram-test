# LiveChat ↔ Telegram — SIMPLE

Versi ini sengaja tidak memakai LiveChat Developer Console, Client ID, atau LiveChat Webhooks.

Cara kerja:
1. Server mengecek chat aktif LiveChat lewat Agent Chat API setiap beberapa detik.
2. Pesan customer baru dibuatkan/dikirim ke Telegram Topic.
3. Balasan operator di Topic Telegram dikirim ke chat LiveChat yang sama melalui `send_event`.

Environment Render yang diperlukan:
- TELEGRAM_BOT_TOKEN
- TELEGRAM_GROUP_ID
- PUBLIC_BASE_URL
- TELEGRAM_WEBHOOK_SECRET
- LIVECHAT_ACCESS_TOKEN (Base64 Encoded Token dari PAT, scope chats--access:rw)
- LIVECHAT_POLL_SECONDS=5 (opsional)

Tidak perlu:
- LIVECHAT_CLIENT_ID
- LIVECHAT_WEBHOOK_SECRET
- setup webhook LiveChat
- Build App

Catatan: Render Free dapat sleep saat tidak ada traffic inbound, jadi untuk tes buka halaman service agar instance tetap bangun.
