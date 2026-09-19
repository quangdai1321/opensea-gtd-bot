/**
 * Gui thong bao Telegram khi Codex / Claude Code xong viec.
 *
 *   node notify.mjs chatid   -> in ra chat id (nhan 1 tin cho bot truoc)
 *   node notify.mjs test     -> gui tin thu
 *
 *   Codex      : notify = ["node", "D:/Bot-Mint/Noti_tele/notify.mjs"]
 *                (Codex truyen JSON su kien vao argv)
 *   Claude Code: hook Stop / Notification chay "node D:/Bot-Mint/Noti_tele/notify.mjs"
 *                (Claude Code truyen JSON su kien vao stdin)
 *
 * Token va chat id doc tu .env canh file nay, bien moi truong duoc uu tien hon.
 * NOTIFY_DRY_RUN=1 -> in tin nhan ra man hinh thay vi gui.
 * Khi chay tu agent, loi gi cung chi ghi ra stderr va thoat 0, khong lam treo agent.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TG_TIMEOUT_MS = 10_000;
const MAX_TEXT = 3500; // Telegram gioi han 4096 ky tu / tin

// ---------- tien ich ----------

function loadEnv() {
  let text = '';
  try {
    text = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

function clip(s) {
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n...` : s;
}

function withBody(header, body) {
  if (!body || process.env.TELEGRAM_SEND_TEXT === '0') return header;
  return `${header}\n\n${clip(body)}`;
}

/** Doc stdin, co timeout de khong treo neu khong ai dong stdin */
function readStdin(ms = 3000) {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), ms);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
  });
}

/** Cau tra loi cuoi cua Claude, lay tu file transcript (JSONL) */
function lastAssistantText(transcriptPath) {
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (entry.type !== 'assistant') continue;
      const content = entry.message?.content;
      const text = Array.isArray(content)
        ? content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim()
        : typeof content === 'string' ? content.trim() : '';
      if (text) return text;
    }
  } catch {
    /* bo qua */
  }
  return '';
}

// ---------- dung tin nhan tu su kien ----------

function fromCodex(ev) {
  if (ev.type !== 'agent-turn-complete') return null;
  const project = path.basename(ev.cwd || process.cwd());
  return withBody(`[Codex] ${project} - xong viec`, ev['last-assistant-message'] || '');
}

function fromClaude(ev) {
  const project = path.basename(ev.cwd || process.cwd());
  if (ev.hook_event_name === 'Notification') {
    return withBody(`[Claude Code] ${project} - dang cho ban`, ev.message || '');
  }
  if (ev.hook_event_name === 'Stop') {
    return withBody(`[Claude Code] ${project} - xong viec`, lastAssistantText(ev.transcript_path));
  }
  return null;
}

// ---------- Telegram ----------

function credentials() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token) throw new Error('Thieu TELEGRAM_BOT_TOKEN trong .env');
  return { token, chatId };
}

async function send(text) {
  if (process.env.NOTIFY_DRY_RUN === '1') {
    console.log(text);
    return;
  }
  const { token, chatId } = credentials();
  if (!chatId) throw new Error('Thieu TELEGRAM_CHAT_ID trong .env (chay: node notify.mjs chatid)');

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(TG_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram tu choi: ${data.description || res.status}`);
}

async function printChatIds() {
  const { token } = credentials();
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
    signal: AbortSignal.timeout(TG_TIMEOUT_MS),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram tu choi: ${data.description}`);

  const chats = new Map();
  for (const u of data.result) {
    const chat = (u.message || u.channel_post || u.my_chat_member)?.chat;
    if (!chat) continue;
    const name = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username;
    chats.set(chat.id, name);
  }
  if (chats.size === 0) {
    console.log('Chua thay tin nao. Mo Telegram, nhan 1 tin bat ky cho bot roi chay lai.');
    return;
  }
  for (const [id, name] of chats) console.log(`${id}\t${name}`);
  console.log('\nChep so ben trai vao TELEGRAM_CHAT_ID trong .env');
}

// ---------- chay ----------

async function main() {
  loadEnv();
  const arg = process.argv[2];

  // Lenh tay: loi thi bao ro va thoat 1
  if (arg === 'chatid' || arg === 'test') {
    try {
      if (arg === 'chatid') await printChatIds();
      else {
        await send('Tin thu tu Noti_tele: ket noi Telegram OK');
        console.log('Da gui. Kiem tra Telegram.');
      }
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    return;
  }

  // Goi tu agent: khong bao gio lam agent loi theo
  try {
    const text = arg ? fromCodex(JSON.parse(arg)) : fromClaude(JSON.parse(await readStdin()));
    if (text) await send(text);
  } catch (err) {
    console.error('[notify]', err.message);
  }
  process.exit(0);
}

main();
