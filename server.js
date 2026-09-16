const http = require('http');
const fs = require('fs');
const path = require('path');

// Tiny .env loader (no npm dependency)
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

const PORT = Number(process.env.PORT || 8787);
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_GROUP_ID = process.env.TELEGRAM_GROUP_ID || '';
const TG_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const LIVECHAT_TOKEN = process.env.LIVECHAT_ACCESS_TOKEN || '';
const LIVECHAT_WEBHOOK_KEY = process.env.LIVECHAT_WEBHOOK_KEY || 'change-me';
const DEMO_MODE = String(process.env.DEMO_MODE || 'true').toLowerCase() !== 'false';
const DB_FILE = path.join(__dirname, 'data.json');

function loadDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { chats: {}, topics: {} }; }
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

async function lcSend(chatId, text) {
  if (!LIVECHAT_TOKEN) throw new Error('LIVECHAT_ACCESS_TOKEN belum diisi');
  const r = await fetch('https://api.livechatinc.com/v3.5/agent/action/send_event', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${LIVECHAT_TOKEN}` },
    body: JSON.stringify({ chat_id: chatId, event: { type: 'message', text, visibility: 'all' } })
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`LiveChat send_event ${r.status}: ${body}`);
  return body ? JSON.parse(body) : {};
}

function safeTopicName(name, issue, chatId) {
  const raw = `${name || 'Member'}${issue ? ' • ' + issue : ''}`.replace(/[\r\n\t]/g, ' ').trim();
  return (raw || `Chat ${chatId}`).slice(0, 120);
}

async function ensureTopic({ chatId, name, issue }) {
  const db = loadDb();
  if (db.chats[chatId]?.threadId) return db.chats[chatId].threadId;

  let threadId;
  if (TG_TOKEN && TG_GROUP_ID) {
    const topic = await tg('createForumTopic', { chat_id: TG_GROUP_ID, name: safeTopicName(name, issue, chatId) });
    threadId = topic.message_thread_id;
  } else {
    // Offline simulation so the bridge can still be tested without credentials.
    threadId = Date.now() % 1000000000;
  }

  db.chats[chatId] = { threadId, name: name || 'Member', issue: issue || '', createdAt: new Date().toISOString() };
  db.topics[String(threadId)] = { chatId };
  saveDb(db);
  return threadId;
}

async function forwardCustomerMessage({ chatId, name, issue, text }) {
  const threadId = await ensureTopic({ chatId, name, issue });
  if (TG_TOKEN && TG_GROUP_ID) {
    await tg('sendMessage', {
      chat_id: TG_GROUP_ID,
      message_thread_id: threadId,
      text: `👤 ${name || 'Member'}\n${text}`
    });
  }
  return { chatId, threadId, forwarded: Boolean(TG_TOKEN && TG_GROUP_ID) };
}

function json(res, status, data) {
  const b = JSON.stringify(data, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(b);
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

function extractLiveChatIncoming(body) {
  // Handles common webhook shapes: direct payload or wrapped under payload.
  const p = body.payload || body;
  const event = p.event || p.chat?.thread?.events?.[p.chat?.thread?.events?.length - 1] || null;
  const chatId = p.chat_id || p.chat?.id;
  if (!chatId || !event || event.type !== 'message' || !event.text) return null;

  // Avoid looping agent/bot messages back to Telegram when author type is known.
  const authorType = event.author?.type || event.author_type || event.user_type || '';
  if (String(authorType).toLowerCase().includes('agent')) return null;

  const users = p.chat?.users || [];
  const customer = users.find(u => String(u.type || '').toLowerCase().includes('customer')) || {};
  return {
    chatId,
    name: customer.name || customer.email || p.customer?.name || 'Member',
    issue: p.chat?.properties?.routing?.issue || '',
    text: event.text
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/') {
      return html(res, `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>LiveChat ↔ Telegram Test Bridge</title>
      <style>body{font-family:system-ui;max-width:780px;margin:40px auto;padding:0 18px;line-height:1.5}code,pre{background:#f4f4f4;padding:3px 6px;border-radius:6px}pre{padding:14px;overflow:auto}button,input{font:inherit;padding:10px;margin:4px 0;width:100%;box-sizing:border-box}.ok{color:green}</style>
      <h1>LiveChat ↔ Telegram Test Bridge</h1>
      <p class="ok">Server aktif.</p>
      <p>Mode: <b>${DEMO_MODE ? 'DEMO' : 'LIVE'}</b> · Telegram: <b>${TG_TOKEN && TG_GROUP_ID ? 'configured' : 'belum dikonfigurasi'}</b> · LiveChat token: <b>${LIVECHAT_TOKEN ? 'configured' : 'belum dikonfigurasi'}</b></p>
      <h2>Test pesan member</h2>
      <form id="f"><input name="name" value="Brow77" placeholder="Nama member"><input name="issue" value="Deposit" placeholder="Kendala"><input name="message" value="Halo kak, tolong cek deposit saya" placeholder="Pesan"><button>Kirim test</button></form>
      <pre id="o"></pre>
      <script>f.onsubmit=async e=>{e.preventDefault();let x=Object.fromEntries(new FormData(f));let r=await fetch('/demo/incoming',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(x)});o.textContent=await r.text()}</script>
      <h2>Endpoint</h2><pre>POST /demo/incoming\nPOST /telegram/webhook\nPOST /livechat/webhook/${LIVECHAT_WEBHOOK_KEY}\nGET /state</pre>`);
    }

    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, demo: DEMO_MODE });
    if (req.method === 'GET' && url.pathname === '/state') return json(res, 200, loadDb());

    if (req.method === 'POST' && url.pathname === '/demo/incoming') {
      const b = await readJson(req);
      const chatId = b.chatId || `DEMO-${Date.now()}`;
      const result = await forwardCustomerMessage({ chatId, name: b.name || 'Brow77', issue: b.issue || 'Deposit', text: b.message || 'Halo dari member' });
      return json(res, 200, { ok: true, ...result, note: TG_TOKEN ? 'Cek topic Telegram.' : 'Telegram belum dikonfigurasi; topic disimulasikan di data.json.' });
    }

    if (req.method === 'POST' && url.pathname === '/telegram/webhook') {
      if (TG_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== TG_SECRET) return json(res, 403, { ok: false, error: 'invalid telegram webhook secret' });
      const update = await readJson(req);
      const m = update.message || update.edited_message;
      if (!m || !m.message_thread_id || !m.text || m.from?.is_bot) return json(res, 200, { ok: true, ignored: true });
      if (String(m.chat?.id) !== String(TG_GROUP_ID)) return json(res, 200, { ok: true, ignored: 'wrong group' });

      const db = loadDb();
      const mapped = db.topics[String(m.message_thread_id)];
      if (!mapped) return json(res, 200, { ok: true, ignored: 'topic not mapped' });

      if (DEMO_MODE || !LIVECHAT_TOKEN) {
        await tg('sendMessage', { chat_id: TG_GROUP_ID, message_thread_id: m.message_thread_id, text: `🧪 DEMO → member\n${m.text}` });
      } else {
        await lcSend(mapped.chatId, m.text);
        await tg('sendMessage', { chat_id: TG_GROUP_ID, message_thread_id: m.message_thread_id, text: '✅ Sent to LiveChat' });
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === `/livechat/webhook/${LIVECHAT_WEBHOOK_KEY}`) {
      const b = await readJson(req);
      const incoming = extractLiveChatIncoming(b);
      if (!incoming) return json(res, 200, { ok: true, ignored: true });
      const result = await forwardCustomerMessage(incoming);
      return json(res, 200, { ok: true, ...result });
    }

    return json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, () => console.log(`Bridge running: http://localhost:${PORT}`));
