# LiveChat ↔ Telegram Bridge v2

Versi ini dibuat ulang dari nol untuk workflow yang aman dari spam.

## Workflow

1. **Chat lama / End Chat tidak pernah membuat topic baru.**
2. Saat Render baru restart/deploy, chat yang sudah aktif tidak diimpor otomatis. Topic baru/reopen hanya terjadi setelah ada **pesan customer baru setelah server hidup**.
3. Satu customer memakai topic Telegram yang sama selama mapping historinya masih ditemukan.
4. Kalau LiveChat ditutup, topic Telegram diubah menjadi `🔴 Nama` lalu ditutup.
5. Kalau customer kembali dan chat aktif lagi, topic lama dibuka kembali menjadi `🟢 Nama`; history Telegram tetap ada.
6. Balasan teks operator dari Telegram dikirim kembali ke LiveChat.
7. Di Telegram tersedia tombol **✅ End Chat**, juga command `/close` atau `/end`.
8. Ada safety limit agar bug tidak bisa membuat puluhan topic sekaligus.

## Kenapa mapping tidak pakai `data.json`?

Render Free bisa restart dan filesystem runtime tidak cocok dijadikan database permanen. Bridge menyimpan mapping Telegram Topic pada properti chat LiveChat `test.string_property` (property test bawaan LiveChat yang read/write), sehingga mapping bisa dipulihkan lagi setelah restart tanpa `data.json`.

> Untuk penggunaan produksi jangka panjang, nanti property test ini sebaiknya diganti dengan property milik aplikasi sendiri atau database. Untuk testing sekarang ini menghindari setup tambahan.

## File yang diperlukan di GitHub

Hanya:

- `server.js`
- `package.json`
- `README.md`
- `env.example`
- `.gitignore`

Tidak ada `data.json`, setup script, atau file versi lama.

## Render Environment

Wajib:

```text
TELEGRAM_BOT_TOKEN=...
TELEGRAM_GROUP_ID=-100...
TELEGRAM_WEBHOOK_SECRET=...
PUBLIC_BASE_URL=https://livechat-telegram-test.onrender.com
LIVECHAT_ACCESS_TOKEN=...
```

`LIVECHAT_ACCESS_TOKEN` adalah **Base64 Encoded Token** dari PAT LiveChat dengan scope:

```text
chats--access:rw
```

Opsional:

```text
LIVECHAT_POLL_SECONDS=4
MAX_NEW_TOPICS_PER_POLL=3
BOOTSTRAP_SCAN_PAGES=5
```

## Izin bot Telegram

Bot harus menjadi admin pada Supergroup/Forum dan punya hak **Manage Topics**.

## Test yang benar

Setelah deploy baru:

1. Tunggu halaman Render menunjukkan `READY`.
2. Jangan berharap chat lama muncul; memang sengaja diabaikan.
3. Buka website sebagai customer dan mulai/kirim **pesan baru**.
4. Telegram membuat atau membuka kembali satu topic.
5. Balas dari Telegram; teks harus muncul di widget LiveChat.
6. Klik **✅ End Chat** dari Telegram, atau End Chat dari LiveChat.
7. Topic Telegram harus menjadi merah dan tertutup.
8. Customer chat lagi → topic lama harus reopen dengan history lama tetap ada.

## Catatan

- Versi ini meneruskan pesan teks customer dan link file dari LiveChat ke Telegram.
- Balasan dari Telegram ke LiveChat saat ini fokus pada teks.
- Semua operator Telegram akan terlihat di LiveChat sebagai agent pemilik PAT yang digunakan.
