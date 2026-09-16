# No-spam fix

Fixes duplicate Telegram topics/messages caused by an old database snapshot overwriting the topic mapping after each poll.

Replace `server.js` and `data.json`, deploy latest commit, then test with one fresh LiveChat message.
