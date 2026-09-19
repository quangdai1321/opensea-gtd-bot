/**
 * Bot Telegram hen gio auto mint drop OpenSea, goi thang contract SeaDrop (lib/engine.mjs).
 *
 *   node mintbot.mjs setup   -> nhap private key + mat khau, luu thanh wallet.keystore.json (da ma hoa)
 *   node mintbot.mjs         -> nhap mat khau, bot chay va nghe lenh Telegram
 *
 * Vi phu: chep thu muc wallets/<ten>/keystore.json (cung mat khau) canh file nay.
 *
 * Tren Telegram (chi nhan lenh tu TELEGRAM_CHAT_ID):
 *   <dan link opensea.io/collection/...>  -> lich cac giai doan + nut hen gio / mint ngay / chay thu
 *   /list      cac lan hen          /wallets  bat/tat vi tham gia mint
 *   /max 0.01  gioi han moi lan      /gas 2    he so tip gas (cao = uu tien hon)
 *   /bal       so du
 *
 * Private key chi nam trong RAM khi bot chay, tren dia chi co ban ma hoa.
 * MINT_PASSWORD trong bien moi truong -> khong hoi mat khau (tien cho tu chay, nhung kem an toan).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { chainCtx } from './lib/chains.mjs';
import { loadWallets, keystoreFiles, short } from './lib/wallets.mjs';
import { mintPublic, mintSigned } from './lib/engine.mjs';
import { fetchStats, statsText, parseAlert, alertLabel, evalAlert } from './lib/prices.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYSTORE_FILE = path.join(__dirname, 'wallet.keystore.json');
const JOBS_FILE = path.join(__dirname, 'mint-jobs.json');
const HTTP_TIMEOUT_MS = 15_000;
const TICK_MS = 500;
const PREP_PUBLIC_MS = 60_000; // chuan bi + ky san truoc gio mo public
const PREP_SIGNED_MS = 20_000;
const STALE_MESSAGE_S = 10 * 60;
const PRICE_POLL_MS = Number(process.env.PRICE_POLL_MINUTES || 2) * 60_000;
const AUTO_ALERT_PCT = 20; // mint xong tu canh floor lech 20% so voi gia mint

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

function log(...args) {
  console.log(new Date().toLocaleTimeString('vi-VN', { hour12: false }), ...args);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtTime(iso) {
  return new Date(iso).toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: '2-digit',
  });
}

function toSlug(s) {
  const m = s.match(/opensea\.io\/(?:[a-z-]+\/)?collection\/([^/?#\s]+)/i);
  return m ? m[1].toLowerCase() : null;
}

/** Link hoac slug tran (vd "reeveworld") */
function argSlug(s = '') {
  return toSlug(s) || (/^[a-z0-9][a-z0-9_-]*$/i.test(s) ? s.toLowerCase() : null);
}

/** Hoi tu ban phim, hidden = khong hien ky tu go */
function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    let s = '';
    const raw = hidden && stdin.isTTY;
    if (raw) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          if (raw) stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          if (raw) stdout.write('\n');
          return resolve(s.trim());
        }
        if (ch === '\u0003') process.exit(1); // Ctrl+C
        if (ch === '\u007f' || ch === '\b') { s = s.slice(0, -1); continue; }
        s += ch;
      }
    };
    stdin.on('data', onData);
  });
}

// ---------- luu hen ----------

function readJobs() {
  let d;
  try {
    d = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  } catch {
    d = {};
  }
  return { jobs: [], nextId: 1, alerts: [], nextAlertId: 1, ...d, settings: { max: null, gasBump: 2, disabled: [], ...d.settings } };
}

let db;
function saveJobs() {
  fs.writeFileSync(JOBS_FILE, JSON.stringify(db, null, 2));
}

// ---------- OpenSea ----------

async function opensea(pathname, init = {}) {
  const res = await fetch(`https://api.opensea.io${pathname}`, {
    ...init,
    headers: {
      'X-API-KEY': process.env.OPENSEA_API_KEY,
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function getDrop(slug) {
  const { status, data } = await opensea(`/api/v2/drops/${slug}`);
  if (status !== 200) throw new Error(`OpenSea: ${(data.errors || []).join('; ') || `HTTP ${status}`}`);
  return data;
}

/** OpenSea dung giao dich mint co chu ky -> { tx } hoac { status, error } */
async function buildMint(slug, minter, quantity) {
  const { status, data } = await opensea(`/api/v2/drops/${slug}/mint`, {
    method: 'POST',
    body: JSON.stringify({ minter, quantity: Number(quantity) }),
  });
  if (status === 200) {
    const t = data.transaction || data;
    const to = t.target || t.to;
    const calldata = t.calldata || t.data;
    if (!to || !calldata) return { status: 422, error: `OpenSea trả về dạng lạ: ${JSON.stringify(data).slice(0, 200)}` };
    return { tx: { to, data: calldata, value: BigInt(t.value ?? 0) } };
  }
  return { status, error: (data.errors || []).join('; ') || `HTTP ${status}` };
}

// ---------- Telegram ----------

async function tg(method, body, timeoutMs = HTTP_TIMEOUT_MS) {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
  return data.result;
}

function say(text, buttons) {
  return tg('sendMessage', {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    text,
    disable_web_page_preview: true,
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  }).catch((err) => log('[tg]', err.message));
}

// Nut bam chi mang ma ngan, du lieu that giu o day (mat khi khoi dong lai -> dan lai link)
const actions = new Map();
let actionSeq = 0;
function button(text, action) {
  const id = String(++actionSeq);
  actions.set(id, action);
  return { text, callback_data: id };
}

// ---------- vi ----------

let wallets = [];
const activeWallets = () => wallets.filter((w) => !db.settings.disabled.includes(w.address));

async function balanceText(chain, address) {
  try {
    const ctx = chainCtx(chain);
    return `${ethers.formatEther(await ctx.main.getBalance(address))} ${ctx.coin}`;
  } catch (err) {
    return `? (${err.shortMessage || err.message})`;
  }
}

// ---------- chay 1 lan hen ----------

const stopFlags = new Set();

/** Hen cu (ban truoc) thieu contract/stageType -> bo sung tu OpenSea */
async function completeJob(job) {
  if (job.contract && job.stageType) return;
  const drop = await getDrop(job.slug);
  const st = (drop.stages || []).find((s) => s.uuid === job.stageUuid);
  job.contract = drop.contract_address;
  job.stageType = st?.stage_type || 'signed_presale';
  job.price = st?.price || '0';
  saveJobs();
}

async function runJob(job, { dry = false } = {}) {
  await completeJob(job);
  const ctx = chainCtx(job.chain);
  job.results ??= {};
  const targets = activeWallets().filter((w) => !['done', 'sent'].includes(job.results[w.address]?.status));
  if (targets.length === 0) {
    await say(`#${job.id}: không có ví nào đang bật. Gõ /wallets`);
    return dry ? null : finish(job, 'failed');
  }
  const isPublic = job.stageType === 'public_sale';
  const tag = `${job.name} — ${job.label}`;
  log(dry ? 'thu' : 'mint', `#${job.id}`, job.slug, job.label, `x${job.qty}`, `${targets.length} vi`);

  const results = await Promise.all(targets.map(async (w) => {
    const opts = {
      w, nft: job.contract, qty: job.qty, settings: db.settings, dry,
      shouldStop: () => stopFlags.has(job.id),
      onEvent: (ev) => {
        if (ev.type === 'sent' && !dry) {
          job.results[w.address] = { status: 'sent', hash: ev.hash }; // luu ngay: tat giua chung khong gui lai
          saveJobs();
        }
        say(ev.text);
      },
    };
    let r;
    try {
      r = isPublic
        ? await mintPublic(ctx, opts)
        : await mintSigned(ctx, { ...opts, price: job.price, startTime: job.startTime, endTime: job.endTime, buildMint: (m, q) => buildMint(job.slug, m, q) });
    } catch (err) {
      r = { status: 'failed', note: err.shortMessage || err.message };
    }
    if (!dry) {
      job.results[w.address] = { ...r, at: new Date().toISOString() };
      saveJobs();
    }
    return { w, r };
  }));

  const icon = { done: '✅', failed: '❌', skipped: '⏭', dry: '🧪' };
  const lines = results.map(({ w, r }) => `${icon[r.status] || '•'} ${w.name} ${short(w.address)}: ${r.note || ''}${r.hash ? `\n   ${ctx.txUrl(r.hash)}` : ''}`);
  const head = dry ? `🧪 CHẠY THỬ (không gửi gì): ${tag} x${job.qty}` : `${results.some((x) => x.r.status === 'done') ? '✅ XONG' : '❌ KHÔNG MINT ĐƯỢC'}: ${tag} x${job.qty}`;
  await say(`${head}\n${isPublic ? 'Gọi thẳng contract (mintPublic)' : 'Chữ ký OpenSea → contract (mintSigned)'}\n\n${lines.join('\n')}`);
  if (dry) return null;
  const ok = results.some((x) => x.r.status === 'done');
  if (ok) autoPriceAlert(job);
  return finish(job, ok ? 'done' : 'failed');
}

/** Mint xong -> tu theo doi floor, moc = gia mint */
function autoPriceAlert(job) {
  if (db.alerts.some((a) => a.slug === job.slug && a.kind === 'move')) return;
  const mintPrice = Number(ethers.formatEther(BigInt(job.price || '0')));
  db.alerts.push({ id: db.nextAlertId++, slug: job.slug, name: job.name, kind: 'move', value: AUTO_ALERT_PCT, base: mintPrice || null, mintPrice });
  saveJobs();
  say(`📊 Đã tự theo dõi giá ${job.name}: báo khi floor lệch ±${AUTO_ALERT_PCT}% so với giá mint. /alerts để xem hoặc tắt.`);
}

function finish(job, status) {
  job.status = status;
  job.doneAt = new Date().toISOString();
  stopFlags.delete(job.id);
  saveJobs();
  return true;
}

// ---------- xu ly lenh ----------

async function showDrop(slug) {
  const drop = await getDrop(slug);
  const now = Date.now();
  const ctx = chainCtx(drop.chain);
  const act = activeWallets();
  const bals = await Promise.all(act.map(async (w) => `${w.name} ${short(w.address)}: ${await balanceText(drop.chain, w.address)}`));
  const lines = [
    `${drop.collection_name} — chain ${drop.chain}`,
    `Contract ${short(drop.contract_address)} (${drop.drop_type})`,
    `Ví đang bật (${act.length}):`, ...bals.map((b) => `  ${b}`), '',
  ];
  const rows = [];

  const stages = [...(drop.stages || [])].sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
  for (const s of stages) {
    const start = Date.parse(s.start_time);
    const end = Date.parse(s.end_time);
    const state = now >= end ? '⚫ đã đóng' : now >= start ? '🟢 đang mở' : '🕒 sắp mở';
    const kind = s.stage_type === 'public_sale' ? 'contract' : 'chữ ký OpenSea';
    lines.push(`${state} ${s.label} [${kind}]: ${fmtTime(s.start_time)} → ${fmtTime(s.end_time)} | ${ethers.formatEther(BigInt(s.price || '0'))} ${ctx.coin} | tối đa ${s.max_per_wallet}/ví`);
    if (now >= end) continue;

    const job = {
      slug, name: drop.collection_name, chain: drop.chain, contract: drop.contract_address,
      label: s.label, stageUuid: s.uuid, stageType: s.stage_type, price: s.price || '0',
      startTime: s.start_time, endTime: s.end_time,
    };
    const max = Math.max(1, Number(s.max_per_wallet) || 1);
    const qtys = [...new Set([1, Math.min(max, 10)])];
    const verb = now >= start ? '⚡ Mint ngay' : '⏰ Auto';
    rows.push([
      ...qtys.map((q) => button(`${verb} ${s.label} x${q}`, { type: now >= start ? 'now' : 'schedule', job: { ...job, qty: q } })),
      button('🧪 Thử', { type: 'dry', job: { ...job, qty: 1 } }),
    ]);
  }
  lines.push('', drop.opensea_url, `Giới hạn /max: ${db.settings.max ?? 'không'} | tip gas /gas: x${db.settings.gasBump}`);
  await say(lines.join('\n'), rows);
}

async function listJobs() {
  const pending = db.jobs.filter((j) => j.status === 'pending' || j.status === 'running');
  if (pending.length === 0) return say('Chưa có lần hẹn nào. Dán link OpenSea để hẹn.');
  const rows = pending.map((j) => [button(`❌ Hủy #${j.id} ${j.name} ${j.label}`, { type: 'cancel', id: j.id })]);
  const text = pending.map((j) => `#${j.id} ${j.name} — ${j.label} x${j.qty} lúc ${fmtTime(j.startTime)} (${j.status})`).join('\n');
  return say(`${text}\n\nVí tham gia: ${activeWallets().length}/${wallets.length}`, rows);
}

async function showWallets() {
  const rows = wallets.map((w) => {
    const on = !db.settings.disabled.includes(w.address);
    return [button(`${on ? '🟢' : '⚪'} ${w.name} ${short(w.address)}`, { type: 'toggle', address: w.address })];
  });
  return say(`Bấm để bật/tắt ví tham gia mint (🟢 = bật):`, rows);
}

async function showBalances() {
  const chains = [...new Set(['robinhood', 'base', 'ethereum', ...db.jobs.filter((j) => j.status === 'pending').map((j) => j.chain)])];
  const out = [];
  for (const w of activeWallets()) {
    const b = await Promise.all(chains.map(async (c) => `${c}: ${await balanceText(c, w.address)}`));
    out.push(`${w.name} ${w.address}\n  ${b.join('\n  ')}`);
  }
  return say(out.join('\n\n') || 'Không có ví nào đang bật.');
}

async function onText(text) {
  const [cmd, arg] = text.trim().split(/\s+/);
  if (cmd === '/start' || cmd === '/help') {
    return say([
      'Dán link OpenSea (opensea.io/collection/...) để xem lịch, hẹn auto mint, hoặc 🧪 chạy thử.',
      '/list — các lần hẹn',
      '/wallets — bật/tắt ví tham gia',
      '/max 0.01 — giới hạn giá + gas mỗi ví mỗi lần (/max off để bỏ)',
      '/gas 2 — hệ số tip gas, cao = được xếp trước (mặc định 2)',
      '/bal — số dư',
      '',
      '/price reeveworld — giá sàn, volume, so với giá mint',
      '/alert reeveworld < 0.001 — báo khi floor xuống (> để báo khi lên, 15% để báo mỗi lần lệch 15%)',
      '/alerts — xem / xóa cảnh báo giá',
    ].join('\n'));
  }
  if (cmd === '/price') {
    const slug = argSlug(arg);
    if (!slug) return say('Ví dụ: /price reeveworld hoặc /price <link OpenSea>');
    const mintJob = db.jobs.find((j) => j.slug === slug && j.status === 'done');
    const mintPrice = mintJob ? Number(ethers.formatEther(BigInt(mintJob.price || '0'))) : null;
    return say(statsText(await fetchStats(opensea, slug), mintPrice), [[
      button('🔔 Báo ±10%', { type: 'alert', slug, rule: { kind: 'move', value: 10 } }),
      button('🔔 Báo ±25%', { type: 'alert', slug, rule: { kind: 'move', value: 25 } }),
    ]]);
  }
  if (cmd === '/alert') {
    const parts = text.trim().split(/\s+/).slice(1);
    const slug = argSlug(parts[0]);
    const rule = parseAlert(parts.slice(1));
    if (!slug || !rule) {
      return say('Ví dụ:\n/alert reeveworld < 0.001  — báo khi floor xuống ≤ 0.001\n/alert reeveworld > 0.01  — báo khi floor lên ≥ 0.01\n/alert reeveworld 15%  — báo mỗi lần floor lệch ±15%');
    }
    return addAlert(slug, rule);
  }
  if (cmd === '/alerts') return listAlerts();
  if (cmd === '/list') return listJobs();
  if (cmd === '/bal') return showBalances();
  if (cmd === '/wallets') return showWallets();
  if (cmd === '/max') {
    if (!arg) return say(`Giới hạn hiện tại: ${db.settings.max ?? 'không giới hạn'}`);
    if (arg === 'off') db.settings.max = null;
    else if (/^\d+(\.\d+)?$/.test(arg)) db.settings.max = arg;
    else return say('Ví dụ: /max 0.01 hoặc /max off');
    saveJobs();
    return say(`Đã đặt giới hạn: ${db.settings.max ?? 'không giới hạn'}`);
  }
  if (cmd === '/gas') {
    const v = Number(arg);
    if (!arg) return say(`Tip gas hiện tại: x${db.settings.gasBump}`);
    if (!(v >= 1 && v <= 20)) return say('Ví dụ: /gas 2 (từ 1 đến 20)');
    db.settings.gasBump = v;
    saveJobs();
    return say(`Đã đặt tip gas x${v}`);
  }
  const slug = toSlug(text);
  if (slug) return showDrop(slug);
  return say('Không hiểu. Dán link opensea.io/collection/... hoặc gõ /help');
}

async function addAlert(slug, rule) {
  const s = await fetchStats(opensea, slug); // kiem tra slug ton tai + lay moc ban dau
  const a = { id: db.nextAlertId++, slug, name: s.name, ...rule, base: rule.kind === 'move' ? s.floor || null : undefined };
  db.alerts.push(a);
  saveJobs();
  return say(`🔔 Đã đặt #${a.id} ${s.name}: ${alertLabel(a)}\nFloor hiện tại: ${s.floor || 'chưa có'} ${s.symbol}. Kiểm tra mỗi ${PRICE_POLL_MS / 60_000} phút.`);
}

async function listAlerts() {
  if (db.alerts.length === 0) return say('Chưa có cảnh báo giá nào. Ví dụ: /alert reeveworld 15%');
  const rows = db.alerts.map((a) => [button(`❌ Xóa #${a.id} ${a.name}`, { type: 'unalert', id: a.id })]);
  return say(db.alerts.map((a) => `#${a.id} ${a.name}: ${alertLabel(a)}`).join('\n'), rows);
}

async function priceLoop() {
  for (;;) {
    await sleep(PRICE_POLL_MS);
    const slugs = [...new Set(db.alerts.map((a) => a.slug))];
    for (const slug of slugs) {
      let s;
      try {
        s = await fetchStats(opensea, slug);
      } catch (err) {
        log('[gia]', slug, err.message);
        continue;
      }
      for (const a of db.alerts.filter((x) => x.slug === slug)) {
        const { fire, remove } = evalAlert(a, s);
        if (fire) await say(`${fire}\n${s.url}`);
        if (remove) db.alerts = db.alerts.filter((x) => x !== a);
      }
    }
    if (slugs.length) saveJobs();
  }
}

async function onButton(id) {
  const act = actions.get(id);
  if (!act) return say('Nút này đã cũ (bot vừa khởi động lại). Dán lại link để có nút mới.');

  if (act.type === 'alert') return addAlert(act.slug, act.rule);
  if (act.type === 'unalert') {
    db.alerts = db.alerts.filter((a) => a.id !== act.id);
    saveJobs();
    return say(`Đã xóa cảnh báo #${act.id}`);
  }

  if (act.type === 'toggle') {
    const d = db.settings.disabled;
    const i = d.indexOf(act.address);
    if (i >= 0) d.splice(i, 1); else d.push(act.address);
    saveJobs();
    return showWallets();
  }

  if (act.type === 'cancel') {
    const job = db.jobs.find((j) => j.id === act.id);
    if (!job || !['pending', 'running'].includes(job.status)) return say(`#${act.id} không còn để hủy.`);
    if (job.status === 'running') stopFlags.add(job.id);
    else finish(job, 'cancelled');
    return say(`Đã hủy #${job.id} ${job.name} — ${job.label}`);
  }

  if (act.type === 'dry') {
    await say(`🧪 Đang chạy thử ${act.job.name} — ${act.job.label}...`);
    return runJob({ id: 0, ...act.job }, { dry: true });
  }

  const dup = db.jobs.find((j) => ['pending', 'running'].includes(j.status) && j.stageUuid === act.job.stageUuid);
  if (dup) return say(`Đã có hẹn #${dup.id} cho ${dup.name} — ${dup.label}. Gõ /list để hủy nếu muốn đổi số lượng.`);

  const job = { id: db.nextId++, ...act.job, status: 'pending', createdAt: new Date().toISOString() };
  if (act.type === 'now') job.runAt = new Date().toISOString();
  db.jobs.push(job);
  saveJobs();
  const n = activeWallets().length;
  if (act.type === 'now') return say(`⚡ Đang mint ${job.name} — ${job.label} x${job.qty} trên ${n} ví...`);
  return say(`⏰ Đã hẹn #${job.id}: ${job.name} — ${job.label} x${job.qty} mỗi ví, ${n} ví, lúc ${fmtTime(job.startTime)} (giờ VN)\nBot chuẩn bị + ký sẵn trước giờ mở. Giữ máy bật. /list để xem hoặc hủy.`);
}

// ---------- vong lap ----------

async function pollTelegram() {
  let offset = 0;
  for (;;) {
    try {
      const updates = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] }, 40_000);
      for (const u of updates) {
        offset = u.update_id + 1;
        const chatId = String(u.message?.chat.id ?? u.callback_query?.message?.chat.id ?? '');
        if (chatId !== String(process.env.TELEGRAM_CHAT_ID)) continue; // chi nghe chu bot
        // Tin don lai luc bot tat qua lau -> bo, khoi tra loi hang loat khi bat lai
        if (u.message && Date.now() / 1000 - u.message.date > STALE_MESSAGE_S) continue;
        // Khong await: 1 lenh cham (chay thu, mint ngay) khong duoc chan cac lenh khac
        (async () => {
          try {
            if (u.callback_query) {
              tg('answerCallbackQuery', { callback_query_id: u.callback_query.id }).catch(() => {});
              await onButton(u.callback_query.data);
            } else if (u.message?.text) {
              await onText(u.message.text);
            }
          } catch (err) {
            log('[lenh]', err.message);
            await say(`Lỗi: ${err.message}`);
          }
        })();
      }
    } catch (err) {
      log('[tg]', err.message);
      await sleep(3000);
    }
  }
}

async function scheduler() {
  for (;;) {
    const now = Date.now();
    for (const job of db.jobs) {
      if (job.status !== 'pending') continue;
      const lead = job.stageType === 'public_sale' ? PREP_PUBLIC_MS : PREP_SIGNED_MS;
      const at = job.runAt ? Date.parse(job.runAt) : Date.parse(job.startTime) - lead;
      if (at > now) continue;
      job.status = 'running';
      saveJobs();
      runJob(job).catch(async (err) => {
        log('[mint]', err.message);
        await say(`❌ Lỗi khi mint #${job.id} ${job.name}: ${err.message}`);
        finish(job, 'failed');
      });
    }
    await sleep(TICK_MS);
  }
}

// ---------- chay ----------

async function setup() {
  if (fs.existsSync(KEYSTORE_FILE) && (await ask('Da co wallet.keystore.json. Ghi de? (y/N): ')).toLowerCase() !== 'y') return;
  const key = await ask('Private key cua vi (se khong hien khi go): ', true);
  let w;
  try {
    w = new ethers.Wallet(key.startsWith('0x') ? key : `0x${key}`);
  } catch {
    throw new Error('Private key khong hop le.');
  }
  const pass = await ask('Dat mat khau cho keystore (it nhat 12 ky tu): ', true);
  if (pass.length < 12) throw new Error('Mat khau can it nhat 12 ky tu.');
  if ((await ask('Nhap lai mat khau: ', true)) !== pass) throw new Error('Hai mat khau khong khop.');
  console.log('Dang ma hoa (5-20 giay)...');
  // Chuan keystore Ethereum (scrypt + AES-128-CTR), N gap doi mac dinh -> do mat khau cham gap doi
  const json = await ethers.encryptKeystoreJson({ address: w.address, privateKey: w.privateKey }, pass, { scrypt: { N: 1 << 18 } });
  fs.writeFileSync(KEYSTORE_FILE, json, { mode: 0o600 });
  console.log(`Da luu ${KEYSTORE_FILE}\nDia chi vi: ${w.address}`);
}

async function main() {
  loadEnv();
  for (const k of ['OPENSEA_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) {
    if (!process.env[k]) throw new Error(`Thieu ${k} trong .env`);
  }
  if (process.argv[2] === 'setup') return setup();

  if (keystoreFiles(__dirname).length === 0) throw new Error('Chua co vi. Chay truoc: node mintbot.mjs setup');
  const pass = process.env.MINT_PASSWORD || (await ask('Mat khau keystore: ', true));
  console.log('Dang giai ma keystore...');
  const loaded = await loadWallets(__dirname, pass);
  if (loaded.wallets.length === 0) throw new Error('Sai mat khau.');
  wallets = loaded.wallets;
  if (loaded.failed.length) console.log(`CANH BAO: khong mo duoc vi ${loaded.failed.join(', ')} (khac mat khau?)`);

  db = readJobs();
  // Da gui tx roi thi khong mint lai vi do (runJob bo qua vi 'sent'), cac vi khac chay tiep
  for (const j of db.jobs) {
    if (j.status !== 'running') continue;
    j.status = 'pending';
    for (const [addr, r] of Object.entries(j.results || {})) {
      if (r.status === 'sent') await say(`⚠️ Bot bị tắt khi đang chờ giao dịch #${j.id} ${j.name} (${short(addr)}). Kiểm tra: ${chainCtx(j.chain).txUrl(r.hash)}`);
    }
  }
  saveJobs();

  const pending = db.jobs.filter((j) => j.status === 'pending').length;
  log(`Bot mint dang chay. ${wallets.length} vi: ${wallets.map((w) => `${w.name}=${w.address}`).join(', ')}. ${pending} lan hen. Ctrl+C de dung.`);
  const warn = loaded.failed.length ? `\n⚠️ Không mở được ví: ${loaded.failed.join(', ')}` : '';
  await say(`🤖 Bot mint (contract) đã bật. ${wallets.length} ví, ${activeWallets().length} đang bật, ${pending} lần hẹn.${warn}\nDán link OpenSea để hẹn, /help để xem lệnh.`);
  await Promise.all([pollTelegram(), scheduler(), priceLoop()]);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
