'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT || 10000);
const TG_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TG_GROUP_ID = String(process.env.TELEGRAM_GROUP_ID || '').trim();
const TG_SECRET = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const LC_TOKEN = String(process.env.LIVECHAT_ACCESS_TOKEN || '').trim();
const BASE_POLL_MS = Math.max(1000, Math.min(10000, Number(process.env.LIVECHAT_POLL_SECONDS || 2) * 1000));
let currentPollMs = BASE_POLL_MS;
const MAX_NEW_TOPICS_PER_POLL = Math.max(1, Number(process.env.MAX_NEW_TOPICS_PER_POLL || 3));
const BOOTSTRAP_SCAN_PAGES = Math.max(1, Math.min(10, Number(process.env.BOOTSTRAP_SCAN_PAGES || 5)));

const CANNED_RAW = String(process.env.CANNED_RESPONSES_JSON || '').trim();
const CANNED_FILE = String(process.env.CANNED_FILE || '').trim() ||
  (fs.existsSync('/etc/secrets/canned.json') ? '/etc/secrets/canned.json' : path.join(__dirname, 'canned.json'));

function normalizeCannedCode(value) {
  return String(value || '')
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function addCanned(target, code, text) {
  const key = normalizeCannedCode(code);
  const value = String(text ?? '').trim();
  if (key && value) target[key] = value;
}

function ingestCanned(target, parsed) {
  if (!parsed) return;
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const text = String(item?.text ?? item?.response ?? '').trim();
      const tags = Array.isArray(item?.tags) ? item.tags : [item?.tag ?? item?.shortcut ?? item?.code];
      for (const tag of tags) addCanned(target, tag, text);
    }
    return;
  }
  if (typeof parsed === 'object') {
    if (Array.isArray(parsed.responses)) return ingestCanned(target, parsed.responses);
    for (const [key, value] of Object.entries(parsed)) addCanned(target, key, value);
  }
}

function loadCannedResponses() {
  const result = {};
  try {
    if (fs.existsSync(CANNED_FILE)) {
      ingestCanned(result, JSON.parse(fs.readFileSync(CANNED_FILE, 'utf8')));
      console.log(`[bridge] canned file loaded: ${Object.keys(result).length} shortcut(s) from ${CANNED_FILE}`);
    }
  } catch (err) {
    console.warn('[bridge] canned file invalid:', err.message);
  }
  try {
    if (CANNED_RAW) ingestCanned(result, JSON.parse(CANNED_RAW));
  } catch (err) {
    console.warn('[bridge] CANNED_RESPONSES_JSON invalid JSON:', err.message);
  }
  return result;
}

const CANNED_RESPONSES = loadCannedResponses();

const LC_BASE = 'https://api.livechatinc.com/v3.5/agent/action';
const TG_BASE = TG_TOKEN ? `https://api.telegram.org/bot${TG_TOKEN}` : '';
const BRIDGE_PREFIX = 'TG2:';
const SERVICE_STARTED_MS = Date.now();

// Runtime cache only. Durable mapping is stored on each LiveChat chat in
// the built-in public test.string_property, so Render restarts don't cause spam.
const topicToActiveChat = new Map(); // String(topicId) -> chatId
const historicalByCustomer = new Map(); // customerId -> marker from newest known chat
const chatNameCache = new Map(); // chatId -> customer name

const stats = {
  startedAt: new Date().toISOString(),
  lastPollAt: null,
  lastPollError: null,
  lastTelegramError: null,
  visibleChats: 0,
  activeChats: 0,
  forwardedEvents: 0,
  telegramRepliesSent: 0,
  topicsCreated: 0,
  topicsReopened: 0,
  topicsClosed: 0,
  bootstrapMappings: 0,
  cannedSent: 0,
};

let pollRunning = false;

function configured() {
  return Boolean(TG_TOKEN && TG_GROUP_ID && TG_SECRET && PUBLIC_BASE_URL && LC_TOKEN);
}

function compactError(err) {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  if (!res.ok) {
    const body = data ? JSON.stringify(data) : text;
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 700)}`);
  }
  return data;
}

async function lcCall(action, payload = {}) {
  if (!LC_TOKEN) throw new Error('LIVECHAT_ACCESS_TOKEN belum diisi');
  try {
    return await fetchJson(`${LC_BASE}/${action}`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${LC_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new Error(`LiveChat ${action}: ${compactError(err)}`);
  }
}

async function tgCall(method, payload = {}) {
  if (!TG_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN belum diisi');
  try {
    const data = await fetchJson(`${TG_BASE}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!data?.ok) throw new Error(JSON.stringify(data));
    return data.result;
  } catch (err) {
    stats.lastTelegramError = `${new Date().toISOString()} ${method}: ${compactError(err)}`;
    throw new Error(`Telegram ${method}: ${compactError(err)}`);
  }
}

function encodeMarker(marker) {
  const json = JSON.stringify(marker);
  return BRIDGE_PREFIX + Buffer.from(json, 'utf8').toString('base64url');
}

function decodeMarker(summaryOrChat) {
  const raw = summaryOrChat?.properties?.test?.string_property;
  if (typeof raw !== 'string' || !raw.startsWith(BRIDGE_PREFIX)) return null;
  try {
    const json = Buffer.from(raw.slice(BRIDGE_PREFIX.length), 'base64url').toString('utf8');
    const m = JSON.parse(json);
    if (!m || m.v !== 2 || !Number.isInteger(Number(m.t)) || !m.c) return null;
    m.t = Number(m.t);
    m.s = m.s === 'c' ? 'c' : 'o';
    m.seen = Array.isArray(m.seen) ? m.seen.slice(-10) : [];
    return m;
  } catch {
    return null;
  }
}

async function saveMarker(chatId, marker) {
  const clean = {
    v: 2,
    t: Number(marker.t),                 // Telegram topic id
    c: String(marker.c),                 // LiveChat customer id
    s: marker.s === 'c' ? 'c' : 'o',    // open / closed
    a: marker.a || null,                 // last forwarded created_at
    i: marker.i || null,                 // last forwarded event id
    seen: Array.isArray(marker.seen) ? marker.seen.slice(-10) : [],
  };
  await lcCall('update_chat_properties', {
    id: chatId,
    properties: {
      test: {
        string_property: encodeMarker(clean),
      },
    },
  });
  return clean;
}

function customerFrom(chat) {
  return Array.isArray(chat?.users) ? chat.users.find(u => u?.type === 'customer') || null : null;
}

function customerName(customer) {
  const name = String(customer?.name || '').trim();
  if (name) return name;
  const email = String(customer?.email || '').trim();
  if (email) return email.split('@')[0];
  return `Member ${String(customer?.id || 'unknown').slice(0, 8)}`;
}

function cleanOneLine(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function answerText(field) {
  if (!field) return '';
  const answer = field.answer;
  if (typeof answer === 'string' || typeof answer === 'number') return cleanOneLine(answer);
  if (answer && typeof answer === 'object') {
    if (answer.label != null) return cleanOneLine(answer.label);
    if (answer.value != null) return cleanOneLine(answer.value);
  }
  if (Array.isArray(field.answers)) {
    return field.answers.map(a => cleanOneLine(a?.label ?? a?.value ?? a)).filter(Boolean).join(', ');
  }
  return '';
}

function isPrechatFilledForm(event) {
  if (!event || event.type !== 'filled_form') return false;
  const formType = String(event.form_type || '').toLowerCase().replace(/[_-]/g, '');
  if (formType === 'prechat') return true;
  const labels = (event.fields || []).map(f => String(f?.label || '').toLowerCase());
  return labels.some(l => /nama|name/.test(l)) && labels.some(l => /kendala|purpose|subject|issue/.test(l));
}

function prechatDataFromThread(thread) {
  const forms = (thread?.events || []).filter(isPrechatFilledForm);
  const event = forms.sort((a, b) => Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0)).at(-1) || null;
  if (!event) return { event: null, name: '', issue: '', fields: [] };

  const fields = (event.fields || []).map(f => ({
    label: cleanOneLine(f?.label || f?.type || 'Field'),
    type: String(f?.type || ''),
    value: answerText(f),
  })).filter(f => f.value);

  let name = '';
  let issue = '';
  for (const f of fields) {
    const label = f.label.toLowerCase();
    if (!name && (f.type === 'name' || /(^|\b)(nama|name)(\b|:)/i.test(f.label))) name = f.value;
    if (!issue && (/kendala|purpose|subject|issue/i.test(f.label) || ['radio', 'select', 'subject'].includes(f.type))) issue = f.value;
  }
  return { event, name, issue, fields };
}

function topicName(name, open = true, issue = '') {
  const clean = cleanOneLine(name || 'Member');
  const suffix = cleanOneLine(issue) ? ` • ${cleanOneLine(issue)}` : '';
  return `${open ? '🟢' : '🔴'} ${clean}${suffix}`.slice(0, 128);
}

function eventAfterCursor(event, marker) {
  if (!event?.created_at) return false;
  if (Array.isArray(marker.seen) && marker.seen.includes(event.id)) return false;
  if (!marker.a) return true;
  const e = Date.parse(event.created_at);
  const c = Date.parse(marker.a);
  if (Number.isNaN(e) || Number.isNaN(c)) return event.created_at > marker.a;
  return e >= c;
}

function eligibleCustomerEvents(thread, customerId, marker) {
  return (thread?.events || [])
    .filter(e => e && e.author_id === customerId && e.visibility !== 'agents' && ['message', 'file'].includes(e.type))
    .filter(e => eventAfterCursor(e, marker))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

function freshTriggerEventsSinceStart(thread, customerId) {
  return (thread?.events || [])
    .filter(e => e && e.visibility !== 'agents')
    .filter(e => {
      if (['message', 'file'].includes(e.type)) return e.author_id === customerId;
      if (isPrechatFilledForm(e)) return !e.author_id || e.author_id === customerId;
      return false;
    })
    .filter(e => Date.parse(e.created_at) >= SERVICE_STARTED_MS)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

async function listChatsPages(maxPages) {
  const all = [];
  let pageId = null;
  for (let page = 0; page < maxPages; page++) {
    const payload = pageId
      ? { page_id: pageId }
      : {
          limit: 100,
          sort_order: 'desc',
          filters: { include_active: true, include_chats_without_threads: false },
        };
    const data = await lcCall('list_chats', payload);
    const batch = Array.isArray(data?.chats_summary) ? data.chats_summary : [];
    all.push(...batch);
    pageId = data?.next_page_id || null;
    if (!pageId || batch.length === 0) break;
  }
  return all;
}

function rememberHistorical(summary) {
  const marker = decodeMarker(summary);
  const customer = customerFrom(summary);
  if (!marker || !customer?.id) return;
  if (!historicalByCustomer.has(customer.id)) {
    historicalByCustomer.set(customer.id, marker);
  }
}

async function bootstrapHistory() {
  if (!LC_TOKEN) return;
  try {
    const chats = await listChatsPages(BOOTSTRAP_SCAN_PAGES);
    for (const chat of chats) rememberHistorical(chat);
    stats.bootstrapMappings = historicalByCustomer.size;
    console.log(`[bridge] bootstrap mappings: ${historicalByCustomer.size}`);
  } catch (err) {
    console.error('[bridge] bootstrap failed:', compactError(err));
  }
}

async function sendOpenBanner(topicId, chatId, name, reopened, issue = '') {
  const issueLine = cleanOneLine(issue) ? `\n🏷 Kendala: ${cleanOneLine(issue)}` : '';
  const text = reopened
    ? `🟢 Chat dibuka kembali\n👤 Nama: ${name}${issueLine}`
    : `🟢 LiveChat baru\n👤 Nama: ${name}${issueLine}`;
  await tgCall('sendMessage', {
    chat_id: TG_GROUP_ID,
    message_thread_id: topicId,
    text,
    reply_markup: {
      inline_keyboard: [[{ text: '✅ End Chat', callback_data: `close:${chatId}` }]],
    },
  });
}

async function createTopic(name, chatId, customerId, cursorAt, issue = '') {
  const topic = await tgCall('createForumTopic', {
    chat_id: TG_GROUP_ID,
    name: topicName(name, true, issue),
  });
  const marker = {
    v: 2,
    t: Number(topic.message_thread_id),
    c: customerId,
    s: 'o',
    a: cursorAt || new Date(SERVICE_STARTED_MS).toISOString(),
    i: null,
    seen: [],
  };
  await saveMarker(chatId, marker);
  historicalByCustomer.set(customerId, marker);
  topicToActiveChat.set(String(marker.t), chatId);
  stats.topicsCreated += 1;
  await sendOpenBanner(marker.t, chatId, name, false, issue);
  return marker;
}

function isMissingTopicError(err) {
  const msg = compactError(err).toLowerCase();
  return msg.includes('message thread not found') ||
    msg.includes('topic not found') ||
    msg.includes('forum topic not found') ||
    msg.includes('thread not found') ||
    msg.includes('topic_deleted') ||
    msg.includes('topic_id_invalid');
}

async function recoverDeletedTopic(marker, chatId, name, issue = '') {
  const oldTopicId = Number(marker.t);
  const topic = await tgCall('createForumTopic', {
    chat_id: TG_GROUP_ID,
    name: topicName(name, true, issue),
  });
  marker.t = Number(topic.message_thread_id);
  if (oldTopicId && oldTopicId !== marker.t) {
    topicToActiveChat.delete(String(oldTopicId));
  }
  marker.s = 'o';
  await saveMarker(chatId, marker);
  historicalByCustomer.set(marker.c, marker);
  topicToActiveChat.set(String(marker.t), chatId);
  stats.topicsCreated += 1;
  await tgCall('sendMessage', {
    chat_id: TG_GROUP_ID,
    message_thread_id: marker.t,
    text: `♻️ Topic Telegram lama terhapus. Topic baru dibuat untuk melanjutkan LiveChat.
👤 Nama: ${name}${cleanOneLine(issue) ? `
🏷 Kendala: ${cleanOneLine(issue)}` : ''}`,
    reply_markup: {
      inline_keyboard: [[{ text: '✅ End Chat', callback_data: `close:${chatId}` }]],
    },
  });
  return marker;
}

async function reopenTopic(marker, chatId, name, issue = '') {
  try {
    await tgCall('reopenForumTopic', {
      chat_id: TG_GROUP_ID,
      message_thread_id: marker.t,
    });
  } catch (err) {
    if (isMissingTopicError(err)) {
      return recoverDeletedTopic(marker, chatId, name, issue);
    }
    // Reopening an already-open topic is harmless for our workflow.
    console.warn('[bridge] reopen warning:', compactError(err));
  }
  try {
    await tgCall('editForumTopic', {
      chat_id: TG_GROUP_ID,
      message_thread_id: marker.t,
      name: topicName(name, true, issue),
    });
  } catch (err) {
    if (isMissingTopicError(err)) {
      return recoverDeletedTopic(marker, chatId, name, issue);
    }
    throw err;
  }
  marker.s = 'o';
  await saveMarker(chatId, marker);
  historicalByCustomer.set(marker.c, marker);
  topicToActiveChat.set(String(marker.t), chatId);
  stats.topicsReopened += 1;
  await sendOpenBanner(marker.t, chatId, name, true, issue);
  return marker;
}

async function closeTopic(marker, chatId, name, reason = 'LiveChat ditutup', issue = '') {
  if (!marker || marker.s === 'c') return;
  try {
    await tgCall('sendMessage', {
      chat_id: TG_GROUP_ID,
      message_thread_id: marker.t,
      text: `🔴 ${reason}`,
    });
  } catch (err) {
    console.warn('[bridge] close banner warning:', compactError(err));
  }
  try {
    await tgCall('editForumTopic', {
      chat_id: TG_GROUP_ID,
      message_thread_id: marker.t,
      name: topicName(name, false, issue),
    });
  } catch (err) {
    console.warn('[bridge] rename closed warning:', compactError(err));
  }
  try {
    await tgCall('closeForumTopic', {
      chat_id: TG_GROUP_ID,
      message_thread_id: marker.t,
    });
  } catch (err) {
    console.warn('[bridge] close topic warning:', compactError(err));
  }
  marker.s = 'c';
  await saveMarker(chatId, marker);
  historicalByCustomer.set(marker.c, marker);
  topicToActiveChat.delete(String(marker.t));
  stats.topicsClosed += 1;
}

async function forwardEventToTelegram(topicId, name, event) {
  if (event.type === 'message') {
    await tgCall('sendMessage', {
      chat_id: TG_GROUP_ID,
      message_thread_id: topicId,
      text: `👤 ${name}\n${event.text || ''}`,
    });
    return;
  }
  if (event.type === 'file') {
    const fileLabel = event.name || event.alternative_text || 'File';
    await tgCall('sendMessage', {
      chat_id: TG_GROUP_ID,
      message_thread_id: topicId,
      text: `👤 ${name}\n📎 ${fileLabel}\n${event.url || ''}`,
      disable_web_page_preview: false,
    });
  }
}

async function processActiveChat(summary, topicBudget) {
  const latest = summary?.last_thread_summary;
  if (!latest?.active) return { usedTopic: 0 };

  const full = await lcCall('get_chat', { chat_id: summary.id });
  const thread = full?.thread;
  if (!thread?.active) return { usedTopic: 0 };

  const customer = customerFrom(full) || customerFrom(summary);
  if (!customer?.id) return { usedTopic: 0 };

  const prechat = prechatDataFromThread(thread);
  const name = prechat.name || customerName(customer);
  const issue = prechat.issue || '';
  chatNameCache.set(summary.id, name);

  let marker = decodeMarker(full) || decodeMarker(summary);
  let usedTopic = 0;

  if (!marker) {
    const fresh = freshTriggerEventsSinceStart(thread, customer.id);
    if (fresh.length === 0) {
      // Anti-spam: chats that already existed before this deploy remain silent.
      // A new pre-chat submission (filled_form) counts as a fresh customer event,
      // so a Telegram topic can be created before the customer types a message.
      return { usedTopic: 0 };
    }

    const old = historicalByCustomer.get(customer.id);
    if (old) {
      marker = {
        ...old,
        c: customer.id,
        a: new Date(SERVICE_STARTED_MS).toISOString(),
        i: null,
        seen: [],
      };
      await saveMarker(summary.id, marker);
      if (marker.s === 'c') {
        marker = await reopenTopic(marker, summary.id, name, issue);
      } else {
        topicToActiveChat.set(String(marker.t), summary.id);
        try {
          await tgCall('editForumTopic', {
            chat_id: TG_GROUP_ID,
            message_thread_id: marker.t,
            name: topicName(name, true, issue),
          });
        } catch (err) {
          if (isMissingTopicError(err)) {
            marker = await recoverDeletedTopic(marker, summary.id, name, issue);
          } else {
            throw err;
          }
        }
        await sendOpenBanner(marker.t, summary.id, name, true, issue);
      }
    } else {
      if (topicBudget <= 0) {
        console.warn(`[bridge] safety limit: topic creation skipped for ${name}`);
        return { usedTopic: 0 };
      }
      marker = await createTopic(name, summary.id, customer.id, new Date(SERVICE_STARTED_MS).toISOString(), issue);
      usedTopic = 1;
    }

    // The pre-chat form itself is already represented by the topic title/open banner.
    // Mark it as consumed so it can never be replayed as history.
    const triggerForm = fresh.find(isPrechatFilledForm);
    if (triggerForm?.created_at) {
      marker.a = triggerForm.created_at;
      marker.i = triggerForm.id || null;
      marker.seen = [...(marker.seen || []), triggerForm.id].filter(Boolean).slice(-10);
      marker = await saveMarker(summary.id, marker);
      historicalByCustomer.set(customer.id, marker);
    }
  } else {
    historicalByCustomer.set(customer.id, marker);
    if (marker.s === 'c') {
      marker = await reopenTopic(marker, summary.id, name, issue);
    } else {
      topicToActiveChat.set(String(marker.t), summary.id);
      // Keep title synchronized with the latest pre-chat selection.
      if (issue) {
        try {
          await tgCall('editForumTopic', {
            chat_id: TG_GROUP_ID,
            message_thread_id: marker.t,
            name: topicName(name, true, issue),
          });
        } catch (err) {
          if (isMissingTopicError(err)) {
            marker = await recoverDeletedTopic(marker, summary.id, name, issue);
          } else {
            console.warn('[bridge] topic title update warning:', compactError(err));
          }
        }
      }
    }
  }

  const events = eligibleCustomerEvents(thread, customer.id, marker);
  let changed = false;
  for (const event of events) {
    try {
      await forwardEventToTelegram(marker.t, name, event);
    } catch (err) {
      if (!isMissingTopicError(err)) throw err;
      marker = await recoverDeletedTopic(marker, summary.id, name, issue);
      await forwardEventToTelegram(marker.t, name, event);
    }
    marker.a = event.created_at;
    marker.i = event.id || null;
    marker.seen = [...(marker.seen || []), event.id].filter(Boolean).slice(-10);
    stats.forwardedEvents += 1;
    changed = true;
  }
  if (changed) {
    marker = await saveMarker(summary.id, marker);
    historicalByCustomer.set(customer.id, marker);
  }

  return { usedTopic };
}

async function syncClosedChats(chats) {
  for (const summary of chats) {
    const marker = decodeMarker(summary);
    if (!marker || marker.s === 'c') continue;
    if (summary?.last_thread_summary?.active === false) {
      const customer = customerFrom(summary);
      const name = customerName(customer);
      chatNameCache.set(summary.id, name);
      try {
        await closeTopic(marker, summary.id, name, 'LiveChat telah di-End Chat');
      } catch (err) {
        applyRateLimitBackoff(err);
        console.error(`[bridge] close sync ${summary.id}:`, compactError(err));
      }
    }
  }
}

function isRateLimitError(err) {
  const msg = compactError(err).toLowerCase();
  return msg.includes('http 429') || msg.includes('too_many_requests') || msg.includes('rate limit');
}

function applyRateLimitBackoff(err) {
  if (!isRateLimitError(err)) return false;
  currentPollMs = Math.min(15000, Math.max(BASE_POLL_MS * 2, currentPollMs * 2));
  console.warn(`[bridge] LiveChat rate limit; backoff ke ${currentPollMs / 1000}s`);
  return true;
}

async function pollOnce() {
  if (!configured() || pollRunning) return;
  pollRunning = true;
  stats.lastPollAt = new Date().toISOString();
  stats.lastPollError = null;
  try {
    // One newest page per normal poll. Historical topic mappings are loaded at startup.
    const chats = await listChatsPages(1);
    stats.visibleChats = chats.length;
    stats.activeChats = chats.filter(c => c?.last_thread_summary?.active === true).length;

    // Build historical cache before active processing so new chat_ids can reuse topics.
    for (const chat of chats) rememberHistorical(chat);

    // Keep the previous routing map alive while polling. Clearing it here caused
    // a race where the first Telegram reply could arrive during a poll and see
    // an empty map. We only remove stale routes after the active chats finish.
    const activeChatIds = new Set(
      chats
        .filter(c => c?.last_thread_summary?.active === true)
        .map(c => String(c.id))
    );
    let topicBudget = MAX_NEW_TOPICS_PER_POLL;

    for (const summary of chats) {
      if (summary?.last_thread_summary?.active !== true) continue;
      try {
        const result = await processActiveChat(summary, topicBudget);
        topicBudget -= result.usedTopic || 0;
      } catch (err) {
        applyRateLimitBackoff(err);
        console.error(`[bridge] active chat ${summary?.id}:`, compactError(err));
      }
    }

    await syncClosedChats(chats);

    // Remove routes whose LiveChat is no longer active, but only after the new
    // routes have been built. This keeps replies working continuously during polls.
    for (const [topicId, chatId] of topicToActiveChat.entries()) {
      if (!activeChatIds.has(String(chatId))) {
        topicToActiveChat.delete(topicId);
      }
    }

    // Kembali ke interval cepat setelah polling sukses.
    currentPollMs = BASE_POLL_MS;
  } catch (err) {
    stats.lastPollError = `${new Date().toISOString()} ${compactError(err)}`;
    applyRateLimitBackoff(err);
    console.error('[bridge] poll failed:', compactError(err));
  } finally {
    pollRunning = false;
  }
}

async function waitForPollToFinish(maxMs = 3500) {
  const started = Date.now();
  while (pollRunning && Date.now() - started < maxMs) {
    await sleep(75);
  }
}

async function resolveActiveChatForTopic(topicId) {
  const key = String(topicId);
  let chatId = topicToActiveChat.get(key);
  if (chatId) return chatId;

  // If a scheduled poll is currently rebuilding mappings, wait for it instead
  // of immediately failing the first Telegram reply.
  if (pollRunning) {
    await waitForPollToFinish();
    chatId = topicToActiveChat.get(key);
    if (chatId) return chatId;
  }

  // Durable fallback: find the topic id in LiveChat chat properties. This makes
  // replies work immediately after deploy/restart even before the normal poll
  // has populated the runtime cache.
  const chats = await listChatsPages(1);
  for (const summary of chats) {
    if (summary?.last_thread_summary?.active !== true) continue;
    const marker = decodeMarker(summary);
    if (marker && String(marker.t) === key) {
      topicToActiveChat.set(key, summary.id);
      return summary.id;
    }
  }

  // One normal refresh as a last attempt.
  await pollOnce();
  return topicToActiveChat.get(key) || null;
}


function cannedCodes() {
  return Object.keys(CANNED_RESPONSES).sort((a, b) => a.localeCompare(b));
}

function cannedButtons(codes, max = 20) {
  const selected = codes.slice(0, max);
  const rows = [];
  for (let i = 0; i < selected.length; i += 2) {
    rows.push(selected.slice(i, i + 2).map(code => ({
      text: `#${code}`,
      callback_data: `canned:${code}`,
    })));
  }
  return rows;
}

async function showCannedMenu(topicId, query = '') {
  const q = normalizeCannedCode(query);
  const all = cannedCodes();
  const matches = q ? all.filter(code => code.includes(q) || CANNED_RESPONSES[code].toLowerCase().includes(q.replace(/_/g, ' '))) : all;
  if (matches.length === 0) {
    await tgCall('sendMessage', {
      chat_id: TG_GROUP_ID,
      message_thread_id: topicId,
      text: q
        ? `Tidak ada canned response yang cocok dengan #${q}.`
        : 'Canned response belum dikonfigurasi.',
    });
    return;
  }
  const visible = matches.slice(0, 20);
  const more = matches.length > visible.length ? `\n…dan ${matches.length - visible.length} lainnya.` : '';
  await tgCall('sendMessage', {
    chat_id: TG_GROUP_ID,
    message_thread_id: topicId,
    text: `⚡ Quick Replies\n${visible.map(code => `#${code}`).join('  ')}${more}`,
    reply_markup: { inline_keyboard: cannedButtons(visible) },
  });
}

async function sendCannedToLiveChat(topicId, code) {
  const key = normalizeCannedCode(code);
  const text = CANNED_RESPONSES[key];
  if (!text) return false;
  await sendTelegramReplyToLiveChat(topicId, text);
  stats.cannedSent += 1;
  await tgCall('sendMessage', {
    chat_id: TG_GROUP_ID,
    message_thread_id: topicId,
    text: `⚡ #${key}\n${text}`,
  });
  return true;
}

async function sendTelegramReplyToLiveChat(topicId, text) {
  const chatId = await resolveActiveChatForTopic(topicId);
  if (!chatId) {
    throw new Error('Topic ini tidak sedang terhubung ke LiveChat aktif. Tunggu member chat lagi.');
  }
  await lcCall('send_event', {
    chat_id: chatId,
    event: { type: 'message', text, visibility: 'all' },
  });
  stats.telegramRepliesSent += 1;
}

async function endChatFromTelegram(topicId, requestedChatId = null) {
  const chatId = requestedChatId || await resolveActiveChatForTopic(topicId);
  if (!chatId) throw new Error('Tidak menemukan LiveChat aktif untuk topic ini.');

  await lcCall('deactivate_chat', {
    id: chatId,
    ignore_requester_presence: true,
  });

  // Close immediately instead of waiting for the next poll.
  const chats = await listChatsPages(1);
  const summary = chats.find(c => c.id === chatId);
  const marker = summary ? decodeMarker(summary) : null;
  const name = chatNameCache.get(chatId) || customerName(customerFrom(summary));
  if (marker) {
    await closeTopic(marker, chatId, name, 'Chat ditutup dari Telegram');
  }
}

async function configureTelegramWebhook() {
  if (!TG_TOKEN || !PUBLIC_BASE_URL || !TG_SECRET) return;
  const url = `${PUBLIC_BASE_URL}/telegram/webhook`;
  await tgCall('setWebhook', {
    url,
    secret_token: TG_SECRET,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  console.log(`[bridge] Telegram webhook: ${url}`);
}

app.post('/telegram/webhook', async (req, res) => {
  if (TG_SECRET) {
    const got = req.get('x-telegram-bot-api-secret-token') || '';
    if (got !== TG_SECRET) return res.status(403).json({ ok: false });
  }

  // Ack quickly; work continues asynchronously.
  res.json({ ok: true });
  const update = req.body || {};

  try {
    if (update.callback_query) {
      const q = update.callback_query;
      const msg = q.message;
      if (String(msg?.chat?.id) !== TG_GROUP_ID) return;
      const topicId = msg?.message_thread_id;
      const data = String(q.data || '');
      if (data.startsWith('close:')) {
        await tgCall('answerCallbackQuery', { callback_query_id: q.id, text: 'Menutup LiveChat…' });
        try {
          await endChatFromTelegram(topicId, data.slice(6) || null);
        } catch (err) {
          await tgCall('sendMessage', {
            chat_id: TG_GROUP_ID,
            message_thread_id: topicId,
            text: `⚠️ Gagal End Chat: ${compactError(err)}`,
          });
        }
      } else if (data.startsWith('canned:')) {
        const code = data.slice(7);
        try {
          const sent = await sendCannedToLiveChat(topicId, code);
          await tgCall('answerCallbackQuery', {
            callback_query_id: q.id,
            text: sent ? `#${code} dikirim` : `#${code} tidak ditemukan`,
          });
        } catch (err) {
          await tgCall('answerCallbackQuery', { callback_query_id: q.id, text: 'Gagal mengirim' });
          await tgCall('sendMessage', {
            chat_id: TG_GROUP_ID,
            message_thread_id: topicId,
            text: `⚠️ Canned response gagal: ${compactError(err)}`,
          });
        }
      }
      return;
    }

    const msg = update.message;
    if (!msg || msg.from?.is_bot) return;
    if (String(msg.chat?.id) !== TG_GROUP_ID) return;
    if (!msg.message_thread_id) return;

    const text = String(msg.text || msg.caption || '').trim();
    if (!text) return;

    if (text === '/close' || text === '/end') {
      try {
        await endChatFromTelegram(msg.message_thread_id);
      } catch (err) {
        await tgCall('sendMessage', {
          chat_id: TG_GROUP_ID,
          message_thread_id: msg.message_thread_id,
          text: `⚠️ ${compactError(err)}`,
        });
      }
      return;
    }

    if (text === '/canned' || text === '#') {
      await showCannedMenu(msg.message_thread_id);
      return;
    }

    if (text.toLowerCase().startsWith('#cari ') || text.toLowerCase().startsWith('/cari ')) {
      const query = text.replace(/^#cari\s+|^\/cari\s+/i, '');
      await showCannedMenu(msg.message_thread_id, query);
      return;
    }

    if (text.startsWith('#')) {
      const code = normalizeCannedCode(text.slice(1));
      if (!code) {
        await showCannedMenu(msg.message_thread_id);
        return;
      }
      if (CANNED_RESPONSES[code]) {
        try {
          await sendCannedToLiveChat(msg.message_thread_id, code);
        } catch (err) {
          await tgCall('sendMessage', {
            chat_id: TG_GROUP_ID,
            message_thread_id: msg.message_thread_id,
            text: `⚠️ Canned response gagal: ${compactError(err)}`,
          });
        }
      } else {
        await showCannedMenu(msg.message_thread_id, code);
      }
      return;
    }

    if (text.startsWith('/')) return;

    try {
      await sendTelegramReplyToLiveChat(msg.message_thread_id, text);
    } catch (err) {
      await tgCall('sendMessage', {
        chat_id: TG_GROUP_ID,
        message_thread_id: msg.message_thread_id,
        text: `⚠️ Balasan tidak terkirim: ${compactError(err)}`,
      });
    }
  } catch (err) {
    console.error('[bridge] telegram update:', compactError(err));
  }
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    configured: configured(),
    telegram: Boolean(TG_TOKEN && TG_GROUP_ID && TG_SECRET),
    livechat: Boolean(LC_TOKEN),
    poll_seconds: BASE_POLL_MS / 1000,
    current_poll_seconds: currentPollMs / 1000,
    active_topic_routes: topicToActiveChat.size,
    historical_customer_topics: historicalByCustomer.size,
    canned_responses: cannedCodes().length,
    canned_codes: cannedCodes(),
    canned_file: CANNED_FILE,
    stats,
  });
});

app.get('/', (req, res) => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  const good = configured();
  res.type('html').send(`<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LiveChat ↔ Telegram Bridge v2.5 Canned File</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:850px;margin:40px auto;padding:0 18px;background:#0f1115;color:#e9edf1} .card{background:#181c23;border:1px solid #2b313b;border-radius:16px;padding:22px;margin:14px 0} .ok{color:#75e69b}.bad{color:#ff8d8d} code{background:#0b0d10;padding:2px 7px;border-radius:6px} h1{font-size:25px} table{width:100%;border-collapse:collapse}td{padding:7px 0;border-bottom:1px solid #252a32}td:first-child{color:#9fa9b6}</style></head>
<body><h1>LiveChat ↔ Telegram Bridge v2.5 Canned File</h1>
<div class="card"><b class="${good ? 'ok' : 'bad'}">${good ? '● READY' : '● BELUM LENGKAP'}</b><p>Workflow: selesai isi pre-chat form → topic Telegram langsung dibuat (Nama + Kendala) → pesan baru dipantau cepat → reply Telegram → LiveChat → End Chat menutup topic → member kembali membuka topic lama.</p></div>
<div class="card"><table>
<tr><td>Telegram</td><td>${TG_TOKEN && TG_GROUP_ID ? 'configured' : 'missing'}</td></tr>
<tr><td>LiveChat PAT</td><td>${LC_TOKEN ? 'configured' : 'missing'}</td></tr>
<tr><td>Polling dasar</td><td>${BASE_POLL_MS / 1000} detik</td></tr>
<tr><td>Polling saat ini</td><td>${currentPollMs / 1000} detik</td></tr>
<tr><td>Chat terlihat</td><td>${stats.visibleChats}</td></tr>
<tr><td>Chat aktif</td><td>${stats.activeChats}</td></tr>
<tr><td>Topic aktif</td><td>${topicToActiveChat.size}</td></tr>
<tr><td>Mapping customer</td><td>${historicalByCustomer.size}</td></tr>
<tr><td>Pesan member diteruskan</td><td>${stats.forwardedEvents}</td></tr>
<tr><td>Balasan Telegram → LiveChat</td><td>${stats.telegramRepliesSent}</td></tr>
<tr><td>Canned responses</td><td>${cannedCodes().length}</td></tr>
<tr><td>Canned terkirim</td><td>${stats.cannedSent}</td></tr>
<tr><td>Topic dibuat / reopen / close</td><td>${stats.topicsCreated} / ${stats.topicsReopened} / ${stats.topicsClosed}</td></tr>
<tr><td>Last poll</td><td>${esc(stats.lastPollAt || '-')}</td></tr>
<tr><td>Error poll</td><td>${esc(stats.lastPollError || '-')}</td></tr>
</table></div>
<div class="card"><b>Anti-spam aktif</b><p>Chat lama/End Chat tidak membuat topic. Pre-chat form baru (Nama + Kendala) sudah cukup untuk membuat topic, jadi member tidak perlu mengetik pesan dulu. Saat server baru deploy, history lama tetap diabaikan. Maksimal ${MAX_NEW_TOPICS_PER_POLL} topic baru per polling. Polling default ${BASE_POLL_MS / 1000} detik dan otomatis melambat sementara jika LiveChat memberi rate-limit.</p><p>Command Telegram: <code>/close</code> atau <code>/end</code> untuk End Chat. Ketik <code>#</code> atau <code>/canned</code> untuk daftar quick reply; ketik <code>#kode</code> untuk langsung mengirim canned response, atau <code>#cari bonus</code> untuk mencari shortcut.</p></div>
</body></html>`);
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[bridge] listening on 0.0.0.0:${PORT}`);
  if (!configured()) {
    console.warn('[bridge] environment variables belum lengkap; buka /health');
    return;
  }
  try {
    await configureTelegramWebhook();
  } catch (err) {
    console.error('[bridge] webhook setup failed:', compactError(err));
  }
  await bootstrapHistory();
  await pollOnce();

  const scheduleNextPoll = () => {
    setTimeout(async () => {
      try {
        await pollOnce();
      } catch (err) {
        console.error('[bridge] scheduled poll:', compactError(err));
      } finally {
        scheduleNextPoll();
      }
    }, currentPollMs);
  };
  scheduleNextPoll();
});
