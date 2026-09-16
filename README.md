# LiveChat ↔ Telegram Bridge V2 FAST

Versi ini adalah build terbaru untuk workflow berikut:

- Pre-chat form `Nama + Kendala` langsung membuat Topic Telegram tanpa menunggu member mengetik.
- Hanya chat/thread LiveChat yang aktif yang diproses.
- History lama dan End Chat tidak dibuat ulang menjadi topic.
- 1 customer memakai topic lamanya kembali bila mapping historis tersedia.
- End Chat menutup Topic Telegram, bukan menghapus history.
- Saat member kembali, Topic lama dibuka kembali.
- Jika Topic dihapus manual, bridge mencoba membuat Topic pengganti saat member aktif lagi.
- Balasan operator dari Telegram dikirim ke LiveChat.
- Tombol `End Chat`, `/close`, dan `/end` menutup LiveChat dari Telegram.
- Polling default 2 detik agar pesan terasa lebih live.
- Bila LiveChat memberi rate-limit, bridge melakukan backoff otomatis sementara hingga maksimal 15 detik.
- Anti-spam membatasi pembuatan topic baru per polling.

## File yang diupload ke GitHub

Upload hanya:

- `server.js`
- `package.json`
- `README.md`
- `env.example`
- `.gitignore`

Jangan upload `.env` atau token asli.

## Render Environment Variables

Wajib:

```text
TELEGRAM_BOT_TOKEN=...
TELEGRAM_GROUP_ID=-100...
TELEGRAM_WEBHOOK_SECRET=...
PUBLIC_BASE_URL=https://livechat-telegram-test.onrender.com
LIVECHAT_ACCESS_TOKEN=...
```

Disarankan:

```text
LIVECHAT_POLL_SECONDS=2
MAX_NEW_TOPICS_PER_POLL=3
BOOTSTRAP_SCAN_PAGES=5
```

Untuk `LIVECHAT_ACCESS_TOKEN`, gunakan Base64 Encoded Token dari PAT LiveChat dengan scope `chats--access:rw`.

## Test

1. Deploy dan tunggu Render `Live`.
2. Buka URL service. Status harus `READY`.
3. Isi pre-chat form sebagai member baru.
4. Setelah klik Mulai Obrolan, Topic Telegram harus muncul kira-kira dalam 1–3 detik saat service sedang aktif.
5. Kirim pesan member. Pesan masuk ke topic yang sama.
6. Balas di Telegram. Balasan muncul di LiveChat.
7. Tekan `End Chat`. Topic ditutup dan history tetap ada.
8. Saat member kembali, topic lama akan dicoba dibuka kembali.

## Catatan Render Free

Render Free dapat spin down bila tidak menerima traffic masuk selama periode idle. Saat service sedang tidur, pesan tidak akan diproses sampai service bangun kembali. Untuk operasional CS yang harus selalu responsif, gunakan instance Render yang always-on setelah testing selesai.
