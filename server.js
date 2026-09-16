const http = require('http');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}

const PORT = Number(process.env.PORT || 10000);
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_GROUP_ID = process.env.TELEGRAM_GROUP_ID || '';
const TG_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const LIVECHAT_TOKEN = process.env.LIVECHAT_ACCESS_TOKEN || '';
const POLL_SECONDS = Math.max(3, Number(process.env.LIVECHAT_POLL_SECONDS || 5));
const DB_FILE = path.join(__dirname, 'data.json');

// Never replay historical messages after a deploy/restart.
// A 5-second grace period avoids missing a message sent exactly while Render is booting.
const BRIDGE_STARTED_MS = Date.now() - 5000;

function loadDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { chats: {}, topics: {}, seenEvents: {} }; }
}
function saveDb(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

async function tg(method, body = {}) {
  if (!TG_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN belum diisi');
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description || 'unknown error'}`);
  return j.result;
}

async function lc(action, body = {}) {
  if (!LIVECHAT_TOKEN) throw new Error('LIVECHAT_ACCESS_TOKEN belum diisi');
  const r = await fetch(`https://api.livechatinc.com/v3.5/agent/action/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Basic ${LIVECHAT_TOKEN}` },
    body: JSON.stringify(body)
  });
  const raw = await r.text();
  let parsed = {};
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { raw }; }
  if (!r.ok) throw new Error(`LiveChat ${action} ${r.status}: ${raw}`);
  return parsed;
}

async function lcSend(chatId, text) {
  return lc('send_event', { chat_id: chatId, event: { type: 'message', text, visibility: 'all' } });
}

function safeTopicName(name, chatId) {
  return String(name || `Chat ${chatId}`).replace(/[\r\n\t]/g, ' ').trim().slice(0, 120);
}

async function ensureTopic(chatId, name) {
  let db = loadDb();
  const existing = db.chats?.[chatId];
  if (existing?.threadId) {
    if (existing.closed) {
      try { await tg('reopenForumTopic', { chat_id: TG_GROUP_ID, message_thread_id: existing.threadId }); } catch {}
      db = loadDb();
      if (db.chats?.[chatId]) db.chats[chatId].closed = false;
      saveDb(db);
    }
    return existing.threadId;
  }
  const topic = await tg('createForumTopic', { chat_id: TG_GROUP_ID, name: safeTopicName(name, chatId) });
  const threadId = topic.message_thread_id;
  db.chats ||= {}; db.topics ||= {}; db.seenEvents ||= {};
  db.chats[chatId] = { threadId, name, createdAt: new Date().toISOString(), closed: false };
  db.topics[String(threadId)] = { chatId };
  saveDb(db);
  return threadId;
}

function customerFromChat(chat) {
  return (chat.users || []).find(u => String(u.type || '').toLowerCase() === 'customer') || null;
}
function eventKey(chatId, event, index) {
  return String(event.id || `${chatId}:${event.created_at || ''}:${event.author_id || ''}:${index}:${event.text || ''}`);
}
function createdMs(event) {
  const n = Date.parse(event?.created_at || '');
  return Number.isFinite(n) ? n : 0;
}

async function forwardEvent(chat, customer, event, index) {
  if (!event || event.type !== 'message' || !event.text) return false;
  if (customer?.id && event.author_id && event.author_id !== customer.id) return false;

  const key = eventKey(chat.id, event, index);
  let db = loadDb();
  db.seenEvents ||= {};
  if (db.seenEvents[key]) return false;

  // Important: old messages are marked as seen, but never forwarded.
  if (createdMs(event) && createdMs(event) < BRIDGE_STARTED_MS) {
    db.seenEvents[key] = 'historical';
    saveDb(db);
    return false;
  }

  const name = customer?.name || customer?.email || 'Member';
  const threadId = await ensureTopic(chat.id, name);
  db = loadDb();
  db.seenEvents ||= {};
  if (db.seenEvents[key]) return false;

  await tg('sendMessage', {
    chat_id: TG_GROUP_ID,
    message_thread_id: threadId,
    text: `👤 ${name}\n${event.text}`
  });

  db.seenEvents[key] = new Date().toISOString();
  db.chats ||= {}; db.topics ||= {};
  db.chats[chat.id] = { ...(db.chats[chat.id] || {}), threadId, name, customerId: customer?.id || '', lastSeenAt: new Date().toISOString(), closed: false };
  db.topics[String(threadId)] = { chatId: chat.id };
  saveDb(db);
  return true;
}

async function closeMissingTopics(activeChatIds) {
  const db = loadDb();
  let changed = false;
  for (const [chatId, info] of Object.entries(db.chats || {})) {
    if (!info?.threadId || info.closed || activeChatIds.has(chatId)) continue;
    try {
      await tg('closeForumTopic', { chat_id: TG_GROUP_ID, message_thread_id: info.threadId });
      info.closed = true;
      info.closedAt = new Date().toISOString();
      changed = true;
    } catch (e) {
      console.error(`Could not close Telegram topic for ${chatId}:`, e.message);
    }
  }
  if (changed) saveDb(db);
}

let polling = false;
let lastPoll = null;
let lastPollError = null;
let forwardedCount = 0;
let visibleChatsCount = 0;
let activeChatsCount = 0;
let skippedInactiveCount = 0;

async function pollLiveChat() {
  if (polling || !LIVECHAT_TOKEN || !TG_TOKEN || !TG_GROUP_ID) return;
  polling = true;
  try {
    // In API v3.5 include_active=true means "include active"; it does NOT mean "only active".
    // Therefore we verify the newest thread below and process it only when thread.active === true.
    const data = await lc('list_chats', { filters: { include_active: true }, sort_order: 'desc', limit: 100 });
    const chats = Array.isArray(data.chats_summary) ? data.chats_summary : [];
    visibleChatsCount = chats.length;
    activeChatsCount = 0;
    skippedInactiveCount = 0;
    const activeChatIds = new Set();

    for (const chat of chats) {
      if (!chat?.id) continue;

      // Only ask for the newest thread. Never walk old threads/history.
      const threadsData = await lc('list_threads', { chat_id: chat.id, sort_order: 'desc', limit: 1 });
      const newest = Array.isArray(threadsData.threads) ? threadsData.threads[0] : null;
      if (!newest || newest.active !== true) {
        skippedInactiveCount++;
        continue;
      }

      activeChatsCount++;
      activeChatIds.add(chat.id);
      const customer = customerFromChat(chat);
      const events = Array.isArray(newest.events) ? newest.events : [];
      let idx = 0;
      for (const event of events) {
        if (await forwardEvent(chat, customer, event, idx++)) forwardedCount++;
      }
    }

    await closeMissingTopics(activeChatIds);
    lastPoll = new Date().toISOString();
    lastPollError = null;
    console.log(`Poll OK: ${activeChatsCount} active, ${skippedInactiveCount} inactive skipped, ${forwardedCount} forwarded total`);
  } catch (e) {
    lastPollError = e.message;
    console.error('LiveChat polling failed:', e.message);
  } finally {
    polling = false;
  }
}

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, body) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}
async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1024 * 1024) throw new Error('Payload terlalu besar');
  }
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/') {
      return html(res, `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>LiveChat ↔ Telegram Active Only</title>
      <style>body{font-family:system-ui;max-width:760px;margin:40px auto;padding:0 18px;line-height:1.5}.ok{color:green}.err{color:#b00}code,pre{background:#f4f4f4;padding:3px 6px;border-radius:6px}pre{padding:14px;overflow:auto}</style>
      <h1>LiveChat ↔ Telegram — Active Only</h1>
      <p class="ok">Server aktif.</p>
      <p>Telegram: <b>${TG_TOKEN && TG_GROUP_ID ? 'configured' : 'belum lengkap'}</b><br>LiveChat PAT: <b>${LIVECHAT_TOKEN ? 'configured' : 'belum diisi'}</b><br>Polling: <b>setiap ${POLL_SECONDS} detik</b></p>
      <p>Last poll: <b>${lastPoll || '-'}</b></p>
      ${lastPollError ? `<p class="err">Error terakhir: ${String(lastPollError).replace(/[<>&]/g, '')}</p>` : ''}
      <p>Chat terlihat API: <b>${visibleChatsCount}</b><br><b>Chat aktif diproses: ${activeChatsCount}</b><br>Chat lama/end di-skip: <b>${skippedInactiveCount}</b><br>Pesan baru diteruskan: <b>${forwardedCount}</b></p>
      <p><b>Proteksi:</b> hanya thread terbaru yang masih aktif, pesan sebelum server start tidak diteruskan, dan topic akan ditutup saat chat selesai.</p>`);
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, lastPoll, lastPollError, visibleChatsCount, activeChatsCount, skippedInactiveCount, forwardedCount, bridgeStartedAt: new Date(BRIDGE_STARTED_MS).toISOString() });
    }

    if (req.method === 'POST' && url.pathname === '/telegram/webhook') {
      if (TG_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== TG_SECRET) {
        return json(res, 403, { ok: false, error: 'invalid telegram webhook secret' });
      }
      const update = await readJson(req);
      const m = update.message || update.edited_message;
      if (!m || !m.message_thread_id || !m.text || m.from?.is_bot) return json(res, 200, { ok: true, ignored: true });
      if (String(m.chat?.id) !== String(TG_GROUP_ID)) return json(res, 200, { ok: true, ignored: 'wrong group' });

      const db = loadDb();
      const mapped = db.topics?.[String(m.message_thread_id)];
      if (!mapped?.chatId) return json(res, 200, { ok: true, ignored: 'topic not mapped' });
      const chatInfo = db.chats?.[mapped.chatId];
      if (chatInfo?.closed) return json(res, 200, { ok: false, error: 'Chat LiveChat sudah selesai; topic ini sudah ditutup.' });

      await lcSend(mapped.chatId, m.text);
      await tg('sendMessage', { chat_id: TG_GROUP_ID, message_thread_id: m.message_thread_id, text: '✅ Terkirim ke LiveChat' });
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/poll-now') {
      await pollLiveChat();
      return json(res, 200, { ok: true, lastPoll, lastPollError, visibleChatsCount, activeChatsCount, skippedInactiveCount, forwardedCount });
    }

    return json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, error: e.message });
  }
});

async function startup() {
  if (TG_TOKEN && PUBLIC_BASE_URL) {
    try {
      await tg('setWebhook', {
        url: `${PUBLIC_BASE_URL}/telegram/webhook`,
        secret_token: TG_SECRET || undefined,
        allowed_updates: ['message', 'edited_message']
      });
      console.log('Telegram webhook configured:', `${PUBLIC_BASE_URL}/telegram/webhook`);
    } catch (e) {
      console.error('Telegram webhook setup failed:', e.message);
    }
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Bridge running: http://0.0.0.0:${PORT}`);
    console.log(`Historical cutoff: ${new Date(BRIDGE_STARTED_MS).toISOString()}`);
    pollLiveChat();
    setInterval(pollLiveChat, POLL_SECONDS * 1000);
  });
}
startup();
