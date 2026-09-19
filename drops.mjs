/**
 * Theo doi drop tren OpenSea, bao Telegram cho cac giai doan GTD / WL.
 *
 *   node drops.mjs            -> chay mai, quet moi POLL_MINUTES phut
 *   node drops.mjs once       -> quet 1 lan roi thoat
 *   node drops.mjs check slug -> in cac giai doan cua 1 drop va thu quyen mint cua vi
 *
 * OpenSea KHONG cho biet truoc vi co trong GTD/WL hay khong. Nen bot:
 *   1. Nhac truoc REMIND_MINUTES phut khi 1 giai doan presale (GTD/WL) sap mo.
 *   2. Khi giai doan do mo, nho OpenSea dung thu giao dich mint cho WATCH_WALLET
 *      (khong gui giao dich, khong can private key). Dung duoc -> bao vi co quyen.
 *
 * Doc .env canh file nay: OPENSEA_API_KEY, WATCH_WALLET, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
 * NOTIFY_DRY_RUN=1 -> in tin nhan ra man hinh thay vi gui.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, 'drops-state.json');
const HTTP_TIMEOUT_MS = 15_000;
const LIST_TYPES = ['upcoming', 'featured', 'recently_minted'];
const MAX_PAGES = 5;
const KEEP_DAYS = 30;

const NATIVE = {
  ethereum: 'ETH', base: 'ETH', arbitrum: 'ETH', optimism: 'ETH', zora: 'ETH', blast: 'ETH',
  shape: 'ETH', abstract: 'ETH', robinhood: 'ETH', unichain: 'ETH', b3: 'ETH',
  polygon: 'POL', matic: 'POL', ape_chain: 'APE', avalanche: 'AVAX', bera_chain: 'BERA',
  sei: 'SEI', ronin: 'RON', flow: 'FLOW', soneium: 'ETH', gunzilla: 'GUN', monad: 'MON',
};

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

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { reminded: {}, checked: {} };
  }
}

function writeState(state) {
  // Bo cac muc qua cu de file khong phinh mai
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  for (const bucket of [state.reminded, state.checked]) {
    for (const [k, v] of Object.entries(bucket)) if ((v.at ?? 0) < cutoff) delete bucket[k];
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/** Nhan slug hoac link opensea.io/collection/<slug>/... */
function toSlug(s) {
  const m = s.match(/opensea\.io\/collection\/([^/?#\s]+)/i);
  return (m ? m[1] : s).trim().toLowerCase();
}

/** watch.txt: moi dong 1 link hoac slug, dong bat dau bang # la ghi chu */
function readWatchList() {
  let text = '';
  try {
    text = fs.readFileSync(path.join(__dirname, 'watch.txt'), 'utf8');
  } catch {
    return [];
  }
  const slugs = text.split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean).map(toSlug);
  return [...new Set(slugs)];
}

/** Drop chi tiet co ca `stages`, drop trong danh sach chi co active + next */
function stagesOf(drop) {
  return drop.stages?.length ? drop.stages : [drop.active_stage, drop.next_stage].filter(Boolean);
}

function isPresale(stage) {
  return stage && stage.stage_type !== 'public_sale';
}

function fmtPrice(stage, chain) {
  const zero = /^0x0{40}$/i.test(stage.price_currency_address || '0x' + '0'.repeat(40));
  const wei = BigInt(stage.price || '0');
  if (wei === 0n) return 'Free';
  if (!zero) return `${stage.price} (token ${stage.price_currency_address})`;
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '').slice(0, 6);
  return `${whole}${frac ? '.' + frac : ''} ${NATIVE[chain] || chain}`;
}

function fmtTime(iso) {
  return new Date(iso).toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh', hour12: false,
    hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit',
  });
}

function stageLine(drop, stage) {
  const wl = stage.allowlist_wallet_count ? ` | ${stage.allowlist_wallet_count} ví trong danh sách` : '';
  return [
    `${drop.collection_name} — ${stage.label}`,
    `Chain: ${drop.chain} | Giá: ${fmtPrice(stage, drop.chain)} | Tối đa ${stage.max_per_wallet}/ví${wl}`,
    `Mở: ${fmtTime(stage.start_time)} → ${fmtTime(stage.end_time)} (giờ VN)`,
    drop.opensea_url,
  ].join('\n');
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

/** Gom drop tu cac danh sach, moi slug giu 1 ban */
async function fetchDrops() {
  const bySlug = new Map();

  // Danh sach cong khai cua OpenSea khong co drop chua mo -> doc tung du an trong watch.txt
  for (const slug of readWatchList()) {
    const { status, data } = await opensea(`/api/v2/drops/${slug}`);
    if (status === 200) bySlug.set(slug, data);
    else log('[watch]', slug, `OpenSea tra ${status}: ${(data.errors || []).join('; ')}`);
  }

  for (const type of LIST_TYPES) {
    let cursor = '';
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams({ type, limit: '100' });
      if (cursor) q.set('next', cursor);
      const { status, data } = await opensea(`/api/v2/drops?${q}`);
      if (status !== 200) throw new Error(`OpenSea ${type} tra ${status}: ${JSON.stringify(data.errors || data)}`);
      for (const d of data.drops || []) if (!bySlug.has(d.collection_slug)) bySlug.set(d.collection_slug, d);
      cursor = data.next;
      if (!cursor) break;
    }
  }
  return [...bySlug.values()];
}

/**
 * Nho OpenSea dung giao dich mint cho vi (khong gui).
 * -> { verdict: 'yes' | 'no' | 'closed' | 'retry', note }
 */
async function checkEligible(slug, wallet) {
  const { status, data } = await opensea(`/api/v2/drops/${slug}/mint`, {
    method: 'POST',
    body: JSON.stringify({ minter: wallet, quantity: 1 }),
  });
  const note = (data.errors || []).join('; ');
  if (status === 200) return { verdict: 'yes', note: '' };
  // Qua duoc buoc kiem tra quyen, chi thieu tien
  if (/balance|insufficient funds/i.test(note)) return { verdict: 'yes', note: 'ví chưa đủ tiền' };
  if (status === 409) return { verdict: 'closed', note };
  if (status === 429 || status >= 500) return { verdict: 'retry', note: `HTTP ${status} ${note}` };
  return { verdict: 'no', note: `HTTP ${status} ${note}` };
}

// ---------- Telegram ----------

async function send(text) {
  if (process.env.NOTIFY_DRY_RUN === '1') {
    console.log(`---- TELEGRAM ----\n${text}\n------------------`);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram tu choi: ${data.description || res.status}`);
}

// ---------- 1 vong quet ----------

async function scan(state) {
  const wallet = process.env.WATCH_WALLET;
  const remindMs = Number(process.env.REMIND_MINUTES || 60) * 60_000;
  const now = Date.now();
  const drops = await fetchDrops();
  let presales = 0;

  for (const drop of drops) {
    const stages = stagesOf(drop).filter(isPresale);

    // 1. Giai doan presale sap mo trong REMIND_MINUTES -> nhac
    for (const next of stages) {
      if (state.reminded[next.uuid]) continue;
      const left = Date.parse(next.start_time) - now;
      if (left > 0 && left <= remindMs) {
        await send(`⏰ Còn ${Math.round(left / 60_000)} phút mở ${next.label}\n\n${stageLine(drop, next)}\n\nBot sẽ kiểm tra ví ngay khi giai đoạn này mở.`);
        state.reminded[next.uuid] = { at: now, slug: drop.collection_slug };
        log('nhac', drop.collection_slug, next.label);
      }
    }

    // 2. Giai doan presale dang mo -> thu quyen mint cua vi
    const active = stages.find((s) => Date.parse(s.start_time) <= now && now < Date.parse(s.end_time));
    if (!active) continue;
    presales++;
    if (state.checked[active.uuid]) continue;

    const r = await checkEligible(drop.collection_slug, wallet);
    log('kiem tra', drop.collection_slug, active.label, '->', r.verdict, r.note);
    if (r.verdict === 'retry') continue;
    state.checked[active.uuid] = { at: now, slug: drop.collection_slug, verdict: r.verdict, note: r.note };
    if (r.verdict === 'yes') {
      const extra = r.note ? `\n⚠️ ${r.note}` : '';
      await send(`✅ VÍ BẠN CÓ QUYỀN MINT: ${active.label}${extra}\n\n${stageLine(drop, active)}`);
    }
  }
  log(`quet xong: ${drops.length} drop, ${presales} presale dang mo`);
}

// ---------- chay ----------

async function checkOne(slug) {
  const { status, data } = await opensea(`/api/v2/drops/${slug}`);
  if (status !== 200) throw new Error(`OpenSea tra ${status}: ${JSON.stringify(data.errors || data)}`);
  for (const s of data.stages || []) {
    console.log(`${isPresale(s) ? '[presale]' : '[public] '} ${stageLine(data, s).replace(/\n/g, '\n           ')}\n`);
  }
  const r = await checkEligible(slug, process.env.WATCH_WALLET);
  console.log(`Vi ${process.env.WATCH_WALLET} voi giai doan dang mo: ${r.verdict}${r.note ? ` (${r.note})` : ''}`);
}

async function main() {
  loadEnv();
  for (const k of ['OPENSEA_API_KEY', 'WATCH_WALLET', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) {
    if (!process.env[k]) throw new Error(`Thieu ${k} trong .env`);
  }
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'check') return checkOne(toSlug(arg || ''));

  const state = readState();
  const pollMs = Number(process.env.POLL_MINUTES || 5) * 60_000;
  for (;;) {
    try {
      await scan(state);
    } catch (err) {
      log('[loi]', err.message);
      if (cmd === 'once') process.exitCode = 1; // GitHub Actions bao do
    }
    writeState(state);
    if (cmd === 'once') return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
