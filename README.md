# LiveChat ↔ Telegram — Active Only

Perbaikan utama:

- Hanya memproses **thread terbaru yang masih active=true**.
- Tidak membaca seluruh riwayat thread.
- Pesan yang dibuat sebelum service Render start dianggap historical dan tidak diteruskan.
- Topic Telegram yang mapping-nya diketahui akan ditutup saat chat sudah tidak aktif.
- Reply Telegram ke topic yang sudah ditutup tidak akan dikirim ke LiveChat.

Upload/replace `server.js` dan `data.json`, lalu deploy latest commit di Render.
Environment variable tetap sama; tidak perlu token baru.
