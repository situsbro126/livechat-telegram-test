# LiveChat ↔ Telegram Bridge v2 — Pre-chat Trigger

Versi ini membuat Telegram Topic **segera setelah member mengisi pre-chat form**, walaupun member belum mengetik pesan pertama.

## Alur

1. Member mengisi `Nama` + `Kendala` di form LiveChat.
2. LiveChat membuat event `filled_form` untuk pre-chat survey.
3. Bridge mendeteksi event baru tersebut.
4. Telegram Topic langsung dibuat, contoh:
   - `🟢 reni • Deposit`
5. Di dalam topic muncul:
   - `🟢 LiveChat baru`
   - `👤 Nama: reni`
   - `🏷 Kendala: Deposit`
6. Pesan member berikutnya masuk ke topic yang sama.
7. Balasan CS dari Telegram dikirim kembali ke LiveChat.
8. End Chat menutup topic. Jika member kembali, topic lama dibuka lagi dan history Telegram tetap ada.

## Anti-spam

- Chat lama / closed tidak dibuatkan topic.
- History pre-chat lama tidak diputar ulang setelah deploy.
- Topic hanya dibuat dari pre-chat form / pesan customer yang benar-benar baru sejak service start.
- Maksimum topic baru per polling tetap dibatasi oleh `MAX_NEW_TOPICS_PER_POLL`.

## Environment Render

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_GROUP_ID`
- `TELEGRAM_WEBHOOK_SECRET`
- `PUBLIC_BASE_URL`
- `LIVECHAT_ACCESS_TOKEN`

Opsional:
- `LIVECHAT_POLL_SECONDS=4`
- `MAX_NEW_TOPICS_PER_POLL=3`
- `BOOTSTRAP_SCAN_PAGES=5`

## Deploy

Upload file berikut ke root repo GitHub:
- `server.js`
- `package.json`
- `README.md`
- `env.example`
- `.gitignore`

Lalu Render → Deploy latest commit.
