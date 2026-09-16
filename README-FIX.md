# FIX

Perbaikan: Agent Chat API `list_chats` mengembalikan array pada field `chats_summary`, bukan `chats`. Versi sebelumnya membaca field yang salah sehingga polling selalu terlihat kosong.
