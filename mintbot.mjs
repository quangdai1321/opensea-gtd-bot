/**
 * Bot Telegram hen gio auto mint drop OpenSea, goi thang contract SeaDrop (lib/engine.mjs).
 *
 *   node mintbot.mjs setup   -> nhap private key + mat khau, luu thanh wallet.keystore.json (da ma hoa)
 *   node mintbot.mjs         -> nhap mat khau, bot chay va nghe lenh Telegram
 *
 * Vi phu: node mintbot.mjs addwallet <ten> (tao burner hoac nhap key, cung mat khau), luu o wallets/<ten>/.
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
import { chainCtx, CHAINS } from './lib/chains.mjs';
import { readPublicDrop } from './lib/seadrop.mjs';
import { loadWallets, keystoreFiles, short } from './lib/wallets.mjs';
import { mintPublic, mintSigned, mintNow } from './lib/engine.mjs';
import { fetchStats, statsText, parseAlert, alertLabel, evalAlert } from './lib/prices.mjs';
import { hasAuth, jwtExpiry, fetchEligibility, eligIcon } from './lib/eligibility.mjs';
import { planFund, sendFund, withdrawAll, nftsOf, transferNfts } from './lib/funds.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYSTORE_FILE = path.join(__dirname, 'wallet.keystore.json');
const JOBS_FILE = path.join(__dirname, 'mint-jobs.json');
const HTTP_TIMEOUT_MS = 15_000;
const TICK_MS = 500;
// Bat dau chay truoc gio mo bao lau (mac dinh 60s: mint 19:00 thi 18:59 chay). Doi bang MINT_LEAD_SECONDS
const LEAD_MS = Number(process.env.MINT_LEAD_SECONDS || 60) * 1000;
const STALE_MESSAGE_S = 10 * 60;
const PRICE_POLL_MS = Number(process.env.PRICE_POLL_MINUTES || 2) * 60_000;
const AUTO_ALERT_PCT = 20; // mint xong tu canh floor lech 20% so voi gia mint
const ELIG_POLL_MS = Number(process.env.ELIG_POLL_MINUTES || 5) * 60_000;

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
  const m = s.match(/opensea\.io\/(?:[a-z-]+\/)?collection\/([a-z0-9_-]+)/i);
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
  return { jobs: [], nextId: 1, alerts: [], nextAlertId: 1, watch: [], eligSeen: {}, stageInfo: {}, reminded: {}, ...d, settings: { max: null, gasBump: 2, disabled: [], ...d.settings } };
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

/** Gui tin, mang chap chon thi thu lai toi 3 lan */
async function say(text, buttons) {
  const body = {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    text,
    disable_web_page_preview: true,
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  };
  for (let i = 1; i <= 3; i++) {
    try {
      return await tg('sendMessage', body);
    } catch (err) {
      const network = !/^Telegram /.test(err.message) || /Too Many Requests|502|503|504/.test(err.message);
      log('[tg]', err.message, network && i < 3 ? `(thu lai ${i})` : '');
      if (!network || i === 3) return null;
      await sleep(1500 * i);
    }
  }
  return null;
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
  // Mint ngay stage dang mo: duong nhanh, khong cho doc drop truoc
  const fast = !dry && Boolean(job.runAt && job.slug);
  let dropP;
  if (fast) {
    dropP = getDrop(job.slug);
    dropP.catch(() => {});
  } else {
    await completeJob(job);
  }
  job.results ??= {};
  const targets = activeWallets().filter((w) => !['done', 'sent'].includes(job.results[w.address]?.status));
  if (targets.length === 0) {
    await say(`#${job.id}: không có ví nào đang bật. Gõ /wallets`);
    return dry ? null : finish(job, 'failed');
  }
  const isPublic = job.stageType === 'public_sale';
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
      const build = (m, q) => buildMint(job.slug, m, q);
      if (fast) r = await mintNow({ ...opts, dropP, buildMint: build, getCtx: chainCtx });
      else if (isPublic) r = await mintPublic(chainCtx(job.chain), opts);
      else r = await mintSigned(chainCtx(job.chain), { ...opts, price: job.price, startTime: job.startTime, endTime: job.endTime, buildMint: build });
    } catch (err) {
      r = { status: 'failed', note: err.shortMessage || err.message };
    }
    if (!dry) {
      job.results[w.address] = { ...r, at: new Date().toISOString() };
      saveJobs();
    }
    return { w, r };
  }));

  if (fast) {
    // Bo sung thong tin that tu drop (lenh /mint chi co slug)
    const drop = await dropP.catch(() => null);
    if (drop) {
      const st = drop.active_stage;
      Object.assign(job, {
        name: drop.collection_name, chain: drop.chain, contract: drop.contract_address,
        label: st?.label || job.label, stageType: st?.stage_type || job.stageType, price: st?.price || job.price || '0',
      });
    }
  }
  const txUrl = (h) => (job.chain ? chainCtx(job.chain).txUrl(h) : h);
  const icon = { done: '✅', failed: '❌', skipped: '⏭', dry: '🧪' };
  const lines = results.map(({ w, r }) => `${icon[r.status] || '•'} ${w.name} ${short(w.address)}: ${r.note || ''}${r.hash ? `\n   ${txUrl(r.hash)}` : ''}`);
  const done = `${job.name || job.slug} — ${job.label || 'stage đang mở'}`;
  const head = dry ? `🧪 CHẠY THỬ (không gửi gì): ${done} x${job.qty}` : `${results.some((x) => x.r.status === 'done') ? '✅ XONG' : '❌ KHÔNG MINT ĐƯỢC'}: ${done} x${job.qty}`;
  const how = fast ? 'Mint ngay (song song)' : isPublic ? 'Gọi thẳng contract (mintPublic)' : 'Chữ ký OpenSea → contract (mintSigned)';
  await say(`${head}\n${how}\n\n${lines.join('\n')}`);
  if (dry) return null;
  const ok = results.some((x) => x.r.status === 'done');
  if (ok) autoPriceAlert(job);
  return finish(job, ok ? 'done' : 'failed');
}

/** Mint xong -> tu theo doi floor, moc = gia mint */
function autoPriceAlert(job) {
  if (!job.slug) return; // mint bang contract, OpenSea chua biet collection
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
  const elig = await eligibilityByWallet(slug, act);

  const stages = [...(drop.stages || [])].sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
  for (const s of stages) {
    const start = Date.parse(s.start_time);
    const end = Date.parse(s.end_time);
    const state = now >= end ? '⚫ đã đóng' : now >= start ? '🟢 đang mở' : '🕒 sắp mở';
    const kind = s.stage_type === 'public_sale' ? 'contract' : 'chữ ký OpenSea';
    lines.push(`${state} ${s.label} [${kind}]: ${fmtTime(s.start_time)} → ${fmtTime(s.end_time)} | ${ethers.formatEther(BigInt(s.price || '0'))} ${ctx.coin} | tối đa ${s.max_per_wallet}/ví`);
    if (elig.ok && s.stage_type !== 'public_sale') {
      const parts = act.map((w) => `${act.length > 1 ? w.name : 'Ví'}:${eligIcon(elig.byWallet[w.address]?.get(s.uuid)) || ' ❔'}`);
      lines.push(`    ${parts.join(' | ')}`);
    }
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
  if (!elig.ok) lines.push('', `Quyền GTD/WL: ${elig.note}`);
  lines.push('', drop.opensea_url, `Giới hạn /max: ${db.settings.max ?? 'không'} | tip gas /gas: x${db.settings.gasBump}`);
  await say(lines.join('\n'), rows);
}

// ---------- quyen GTD/WL truoc gio mo (token dang nhap OpenSea cua ban) ----------

let authBroken = false; // token hong -> bao 1 lan, ngung hoi cho toi khi khoi dong lai

/** -> { ok, note, byWallet: { address: Map<uuid, elig> } } */
async function eligibilityByWallet(slug, list) {
  if (!hasAuth()) return { ok: false, note: 'chưa có OPENSEA_JWT trong .env (chỉ biết khi stage mở)', byWallet: {} };
  if (authBroken) return { ok: false, note: 'token OpenSea hết hạn, lấy token mới rồi khởi động lại bot', byWallet: {} };
  const byWallet = {};
  try {
    for (const w of list) byWallet[w.address] = (await fetchEligibility(slug, w.address)).stages;
    return { ok: true, byWallet };
  } catch (err) {
    if (err.auth && !authBroken) {
      authBroken = true;
      await say(`⚠️ ${err.message}\nVào opensea.io → F12 → Network → graphql → chép lại authorization vào OPENSEA_JWT trong .env, rồi khởi động lại bot.`);
    }
    return { ok: false, note: err.message, byWallet: {} };
  }
}

/** Tat ca link opensea.io/collection/... trong 1 tin (dan hoac chuyen tiep tu Discord/Twitter) */
function allSlugs(text) {
  return [...new Set([...text.matchAll(/opensea\.io\/(?:[a-z-]+\/)?collection\/([a-z0-9_-]+)/gi)].map((m) => m[1].toLowerCase()))];
}

function watchTxt() {
  try {
    return fs.readFileSync(path.join(__dirname, 'watch.txt'), 'utf8').split(/\r?\n/)
      .map((l) => argSlug(l.replace(/#.*/, '').trim())).filter(Boolean);
  } catch {
    return [];
  }
}

function watchSlugs() {
  return [...new Set([...db.watch, ...watchTxt()])];
}

/** Drop OpenSea tu liet ke cong khai (it, nhung khong can them tay) */
async function publicDropSlugs() {
  const out = new Set();
  for (const type of ['upcoming', 'featured']) {
    const { status, data } = await opensea(`/api/v2/drops?type=${type}&limit=100`).catch(() => ({}));
    if (status === 200) for (const d of data.drops || []) out.add(d.collection_slug);
  }
  return [...out];
}

function jobFromStage(drop, s) {
  return {
    slug: drop.collection_slug, name: drop.collection_name, chain: drop.chain, contract: drop.contract_address,
    label: s.label, stageUuid: s.uuid, stageType: s.stage_type, price: s.price || '0',
    startTime: s.start_time, endTime: s.end_time,
  };
}

/** Theo doi them du an: tu dan link / /watch. Tra ve drop hoac null neu khong phai drop */
async function addWatch(slug) {
  const drop = await getDrop(slug).catch(() => null);
  if (!drop) return null;
  if (!db.watch.includes(slug)) {
    db.watch.push(slug);
    saveJobs();
  }
  return drop;
}

/**
 * Quet moi du an dang theo doi + drop cong khai:
 *   - bao ngay khi 1 vi CO QUYEN moi o giai doan GTD/WL
 *   - ghi lai giai doan de reminderLoop nhac truoc 60 phut
 *   - du an da xong het -> tu bo theo doi
 */
async function eligibilityScan() {
  const exp = jwtExpiry();
  if (hasAuth() && exp && exp - Date.now() < 3 * 3600_000 && db.eligSeen._expWarned !== exp) {
    db.eligSeen._expWarned = exp;
    await say(`⏳ Token OpenSea hết hạn lúc ${fmtTime(new Date(exp).toISOString())}. Lấy token mới (F12 → Application → Cookies → access_token) để không lỡ báo WL.`);
  }
  const watched = watchSlugs();
  const slugs = [...new Set([...watched, ...(await publicDropSlugs())])];
  const now = Date.now();

  for (const slug of slugs) {
    let drop;
    try {
      drop = await getDrop(slug);
    } catch (err) {
      log('[wl]', slug, err.message);
      continue;
    }
    const future = (drop.stages || []).filter((s) => Date.parse(s.end_time) > now);
    if (future.length === 0) {
      if (db.watch.includes(slug)) {
        db.watch = db.watch.filter((x) => x !== slug);
        log('[wl] bo theo doi (da xong)', slug);
      }
      continue;
    }
    // Du an doi lich (vd Reeveworld doi Public 20:00 -> 19:34): cap nhat hen + bao
    for (const s of drop.stages || []) {
      for (const j of db.jobs.filter((x) => x.status === 'pending' && x.stageUuid === s.uuid)) {
        if (Date.parse(j.startTime) === Date.parse(s.start_time)) continue;
        await say(`🔄 ${drop.collection_name} đổi giờ ${s.label}: ${fmtTime(j.startTime)} → ${fmtTime(s.start_time)}. Đã cập nhật hẹn #${j.id}.`);
        Object.assign(j, { startTime: s.start_time, endTime: s.end_time, price: s.price || j.price });
      }
      const info = db.stageInfo[s.uuid];
      if (info && Date.parse(info.startTime) !== Date.parse(s.start_time)) delete db.reminded[s.uuid]; // nhac lai theo gio moi
    }
    const presale = future.filter((s) => s.stage_type !== 'public_sale');
    const elig = presale.length ? await eligibilityByWallet(slug, wallets) : { ok: false, byWallet: {} };

    for (const s of future) {
      // Ghi lai de nhac. Public (moi ai deu mint duoc) chi nhac du an minh tu theo doi,
      // drop cong khai khac chi nhac khi vi co GTD/WL that
      const isPublic = s.stage_type === 'public_sale';
      const eligible = {};
      for (const w of wallets) {
        const e = elig.byWallet[w.address]?.get(s.uuid);
        if (isPublic || e?.status === 'ELIGIBLE') eligible[w.address] = e?.maxMintable ?? Number(s.max_per_wallet);
      }
      const known = isPublic || elig.ok;
      if (watched.includes(slug) || (!isPublic && Object.keys(eligible).length)) {
        db.stageInfo[s.uuid] = { ...jobFromStage(drop, s), url: drop.opensea_url, maxPerWallet: Number(s.max_per_wallet), eligible, known };
      }

      // Bao ngay khi co quyen moi
      if (s.stage_type === 'public_sale' || !elig.ok) continue;
      for (const w of wallets) {
        const e = elig.byWallet[w.address]?.get(s.uuid);
        if (!e || e.status === 'UNKNOWN') continue;
        const key = `${slug}:${s.uuid}:${w.address}`;
        const before = db.eligSeen[key];
        db.eligSeen[key] = e.status;
        if (e.status !== 'ELIGIBLE' || before === 'ELIGIBLE') continue;
        const q = Math.max(1, Number(e.maxMintable || s.max_per_wallet) || 1);
        await say(
          `🎉 ${w.name} ${short(w.address)} CÓ ${s.label} ở ${drop.collection_name}!\n` +
            `Mở ${fmtTime(s.start_time)} (giờ VN) | ${ethers.formatEther(BigInt(s.price || '0'))} ${chainCtx(drop.chain).coin} | được mint ${q}\n${drop.opensea_url}`,
          [[button(`⏰ Hẹn auto mint x${q}`, { type: 'schedule', job: { ...jobFromStage(drop, s), qty: q } })]],
        );
      }
    }
  }
  // Don giai doan da qua
  for (const [uuid, info] of Object.entries(db.stageInfo)) if (Date.parse(info.endTime) < now) delete db.stageInfo[uuid];
  saveJobs();
}

async function eligibilityLoop() {
  for (;;) {
    try {
      await eligibilityScan();
    } catch (err) {
      log('[wl]', err.message);
    }
    await sleep(ELIG_POLL_MS);
  }
}

/** Nhac REMIND_MINUTES truoc moi giai doan vi co quyen (hoac chua biet quyen) */
async function reminderLoop() {
  const remindMs = Number(process.env.REMIND_MINUTES || 60) * 60_000;
  for (;;) {
    await sleep(30_000);
    const now = Date.now();
    for (const [uuid, s] of Object.entries(db.stageInfo)) {
      const left = Date.parse(s.startTime) - now;
      if (left <= 0 || left > remindMs || db.reminded[uuid]) continue;
      const names = wallets.filter((w) => s.eligible[w.address] !== undefined).map((w) => `${w.name} ${short(w.address)}`);
      if (s.known && names.length === 0) continue; // biet chac khong vi nao co quyen -> khoi nhac
      db.reminded[uuid] = now;
      saveJobs();
      const job = db.jobs.find((j) => j.stageUuid === uuid && ['pending', 'running'].includes(j.status));
      const who = s.known ? `Ví có quyền: ${names.join(', ')}` : 'Chưa biết ví có quyền không (thiếu OPENSEA_JWT)';
      const q = Math.max(1, Math.min(...Object.values(s.eligible).map(Number).filter(Boolean), s.maxPerWallet || 1));
      await say(
        `⏰ Còn ${Math.round(left / 60_000)} phút mở ${s.label} — ${s.name}\n${fmtTime(s.startTime)} (giờ VN) | ${ethers.formatEther(BigInt(s.price || '0'))} ${chainCtx(s.chain).coin}\n${who}\n` +
          (job ? `✅ Đã hẹn auto mint #${job.id} x${job.qty}` : '⚠️ Chưa hẹn auto mint') + `\n${s.url}`,
        job ? undefined : [[button(`⏰ Hẹn auto mint x${q}`, { type: 'schedule', job: { ...s, qty: q } })]],
      );
    }
    for (const uuid of Object.keys(db.reminded)) if (!db.stageInfo[uuid]) delete db.reminded[uuid];
  }
}

async function listWatch() {
  const slugs = watchSlugs();
  if (slugs.length === 0) return say('Chưa theo dõi dự án nào. /watch <link OpenSea>');
  const rows = db.watch.map((s) => [button(`❌ Bỏ ${s}`, { type: 'unwatch', slug: s })]);
  const note = hasAuth() ? `Kiểm tra quyền GTD/WL mỗi ${ELIG_POLL_MS / 60_000} phút.` : '⚠️ Chưa có OPENSEA_JWT: chưa báo được quyền GTD/WL trước giờ mở.';
  return say(`Đang theo dõi:\n${slugs.map((s) => `• ${s}${db.watch.includes(s) ? '' : ' (watch.txt)'}`).join('\n')}\n\n${note}`, rows);
}

// ---------- mint bang dia chi contract ----------

/**
 * Tim contract tren cac chain (hoac chain chi dinh), chay song song:
 *   OpenSea biet contract -> { chain, slug }; khong biet nhung co SeaDrop public drop -> { chain, slug: null }
 */
async function findContract(address, chainHint) {
  const chains = chainHint ? [chainHint] : Object.keys(CHAINS);
  const found = await Promise.all(chains.map(async (chain) => {
    const { status, data } = await opensea(`/api/v2/chain/${chain}/contract/${address}`).catch(() => ({}));
    // Chi tinh khi OpenSea co lich drop that (OpenSea co du lieu rac cho nhieu dia chi)
    if (status === 200 && data.collection && (await getDrop(data.collection).catch(() => null))) {
      return { chain, slug: data.collection, name: data.name };
    }
    try {
      const ctx = chainCtx(chain);
      if ((await ctx.main.getCode(address)) === '0x') return null;
      const drop = await readPublicDrop(ctx.main, address);
      return drop.startTime ? { chain, slug: null, name: null, drop } : null;
    } catch {
      return null;
    }
  }));
  return found.filter(Boolean);
}

async function showContract(address, chainHint) {
  await say(`🔎 Đang tìm contract ${short(address)} ${chainHint ? `trên ${chainHint}` : 'trên mọi chain'}...`);
  const hits = await findContract(address, chainHint);
  if (hits.length === 0) {
    return say(`Không thấy drop SeaDrop nào ở ${address}${chainHint ? ` trên ${chainHint}` : ''}.\nKiểm tra lại địa chỉ, hoặc ghi kèm tên chain: ${Object.keys(CHAINS).join(', ')}`);
  }
  if (hits.length > 1 && !chainHint) {
    return say(`Contract có trên nhiều chain: ${hits.map((h) => h.chain).join(', ')}.\nGửi lại kèm tên chain, ví dụ: ${address} ${hits[0].chain}`);
  }
  const hit = hits[0];

  // OpenSea biet du an va co lich drop -> dung the day du (ca GTD/WL)
  if (hit.slug) {
    const drop = await addWatch(hit.slug);
    if (drop) {
      await showDrop(hit.slug);
      return eligibilityScan();
    }
  }

  // Chi co tren chain: doc public drop tu contract
  const ctx = chainCtx(hit.chain);
  const d = hit.drop || (await readPublicDrop(ctx.main, address));
  if (!d.startTime) return say(`${hit.name || short(address)} trên ${hit.chain}: contract chưa cấu hình public drop trên SeaDrop.`);
  const start = new Date(d.startTime * 1000).toISOString();
  const end = new Date((d.endTime || d.startTime + 30 * 86400) * 1000).toISOString();
  const now = Date.now();
  const state = now >= Date.parse(end) ? '⚫ đã đóng' : now >= Date.parse(start) ? '🟢 đang mở' : '🕒 sắp mở';
  const job = {
    slug: hit.slug, name: hit.name || `Contract ${short(address)}`, chain: hit.chain, contract: address,
    label: 'Public', stageUuid: `pub:${hit.chain}:${address.toLowerCase()}`, stageType: 'public_sale',
    price: d.mintPrice.toString(), startTime: start, endTime: end,
  };
  const max = Math.max(1, Math.min(Number(d.maxPerWallet) || 1, 10));
  const lines = [
    `${job.name} — chain ${hit.chain} (đọc từ contract)`,
    `Contract ${address}`,
    `${state} Public: ${fmtTime(start)} → ${fmtTime(end)} | ${ethers.formatEther(d.mintPrice)} ${ctx.coin} | tối đa ${d.maxPerWallet}/ví`,
    '',
    'GTD/WL chỉ hẹn được qua link OpenSea (cần chữ ký OpenSea).',
  ];
  if (now >= Date.parse(end)) return say(lines.join('\n'));
  const verb = now >= Date.parse(start) ? '⚡ Mint ngay' : '⏰ Auto';
  const type = now >= Date.parse(start) ? 'now' : 'schedule';
  return say(lines.join('\n'), [[
    ...[...new Set([1, max])].map((q) => button(`${verb} Public x${q}`, { type, job: { ...job, qty: q } })),
    button('🧪 Thử', { type: 'dry', job: { ...job, qty: 1 } }),
  ]]);
}

// ---------- nap / rut tien, gom NFT ----------

const CONFIRM_MS = 2 * 60_000; // nut xac nhan het han sau 2 phut
const fmtE = (v) => ethers.formatEther(v);

function mainWallet() {
  return wallets.find((w) => w.name === 'main') || wallets[0];
}

/** Vi nhan khi rut: WITHDRAW_TO trong .env (chi sua duoc tren may), mac dinh vi chinh */
function withdrawTarget() {
  const t = (process.env.WITHDRAW_TO || '').trim();
  if (!t) return mainWallet().address;
  if (!ethers.isAddress(t)) throw new Error('WITHDRAW_TO trong .env không phải địa chỉ ví hợp lệ');
  return ethers.getAddress(t);
}

/** Vi phu dang bat (khong tinh vi nhan) */
function sideWallets(exclude) {
  return activeWallets().filter((w) => w.address.toLowerCase() !== exclude.toLowerCase());
}

function confirmButtons(action) {
  return [[
    button('✅ Xác nhận', { type: 'confirm', exp: Date.now() + CONFIRM_MS, ...action }),
    button('❌ Hủy', { type: 'noop' }),
  ]];
}

async function cmdFund(chain, amountStr) {
  if (!CHAINS[chain] || !/^\d+(\.\d+)?$/.test(amountStr || '')) {
    return say(`Ví dụ: /fund robinhood 0.001 — ví chính gửi 0.001 cho MỖI ví phụ đang bật.\nChain: ${Object.keys(CHAINS).join(', ')}`);
  }
  const from = mainWallet();
  const targets = sideWallets(from.address);
  if (targets.length === 0) return say('Không có ví phụ nào đang bật. Thêm ví: node mintbot.mjs addwallet <tên>');
  const ctx = chainCtx(chain);
  const amount = ethers.parseEther(amountStr);
  const plan = await planFund(ctx, from.address, targets.map((w) => w.address), amount);
  const lines = [
    `💸 NẠP ${chain}: ${from.name} ${short(from.address)} → ${targets.length} ví, mỗi ví ${amountStr} ${ctx.coin}`,
    ...targets.map((w) => `  • ${w.name} ${short(w.address)}`),
    '',
    `Tổng tối đa (cả gas): ${fmtE(plan.total)} ${ctx.coin}`,
    `Số dư ví chính: ${fmtE(plan.balance)} ${ctx.coin}`,
  ];
  if (!plan.enough) return say([...lines, '', '❌ Ví chính không đủ tiền.'].join('\n'));
  return say([...lines, '', 'Bấm xác nhận trong 2 phút.'].join('\n'),
    confirmButtons({ kind: 'fund', chain, amountStr, targets: targets.map((w) => w.address) }));
}

async function cmdWithdraw(chain) {
  if (!CHAINS[chain]) return say(`Ví dụ: /withdraw robinhood — mọi ví phụ gửi hết tiền về ví nhận.\nChain: ${Object.keys(CHAINS).join(', ')}`);
  const to = withdrawTarget();
  const sources = sideWallets(to);
  if (sources.length === 0) return say('Không có ví phụ nào để rút.');
  const ctx = chainCtx(chain);
  const plans = await Promise.all(sources.map(async (w) => ({ w, r: await withdrawAll(ctx, w, to, { dry: true }).catch((e) => ({ status: 'skipped', note: e.shortMessage || e.message })) })));
  const ok = plans.filter((p) => p.r.status === 'dry');
  const total = ok.reduce((s, p) => s + p.r.amount, 0n);
  const lines = [
    `🏦 RÚT ${chain} về ${short(to)}${process.env.WITHDRAW_TO ? ' (WITHDRAW_TO)' : ' (ví chính)'}`,
    ...plans.map(({ w, r }) => `  ${r.status === 'dry' ? '•' : '⏭'} ${w.name} ${short(w.address)}: ${r.status === 'dry' ? `${fmtE(r.amount)} ${ctx.coin}` : r.note}`),
    '',
    `Tổng về: ~${fmtE(total)} ${ctx.coin}`,
  ];
  if (ok.length === 0) return say(lines.join('\n'));
  return say([...lines, 'Bấm xác nhận trong 2 phút.'].join('\n'),
    confirmButtons({ kind: 'withdraw', chain, to, sources: ok.map((p) => p.w.address) }));
}

async function cmdWithdrawNft(arg) {
  const slug = argSlug(arg);
  if (!slug) return say('Ví dụ: /withdrawnft reeveworld — mọi ví phụ chuyển hết NFT collection đó về ví nhận.');
  const { status, data } = await opensea(`/api/v2/collections/${slug}`);
  const c = data.contracts?.[0];
  if (status !== 200 || !c) return say(`Không tìm thấy collection ${slug} trên OpenSea.`);
  const to = withdrawTarget();
  const sources = sideWallets(to);
  if (sources.length === 0) return say('Không có ví phụ nào để gom NFT.');
  const held = await Promise.all(sources.map(async (w) => ({ w, nfts: await nftsOf(opensea, c.chain, w.address, slug).catch(() => []) })));
  const has = held.filter((h) => h.nfts.length);
  const lines = [
    `🖼 GOM NFT ${data.name || slug} (${c.chain}) về ${short(to)}`,
    ...held.map(({ w, nfts }) => `  ${nfts.length ? '•' : '⏭'} ${w.name} ${short(w.address)}: ${nfts.length} NFT${nfts.length ? ` (#${nfts.slice(0, 5).map((n) => n.id).join(', #')}${nfts.length > 5 ? '…' : ''})` : ''}`),
  ];
  if (has.length === 0) return say([...lines, '', 'Không ví phụ nào giữ NFT này.'].join('\n'));
  return say([...lines, '', 'Mỗi NFT tốn 1 giao dịch gas. Bấm xác nhận trong 2 phút.'].join('\n'),
    confirmButtons({ kind: 'nft', chain: c.chain, slug, to, sources: has.map((h) => h.w.address) }));
}

/** Chay sau khi bam xac nhan. Doc lai so du / NFT luc chay, khong dung so lieu cu */
async function runConfirmed(act) {
  const ctx = chainCtx(act.chain);
  const byAddr = (a) => wallets.find((w) => w.address === a);

  if (act.kind === 'fund') {
    const from = mainWallet();
    const amount = ethers.parseEther(act.amountStr);
    const plan = await planFund(ctx, from.address, act.targets, amount);
    if (!plan.enough) return say('❌ Ví chính không còn đủ tiền, đã hủy.');
    await say(`💸 Đang nạp ${act.amountStr} ${ctx.coin} cho ${act.targets.length} ví...`);
    const res = await sendFund(ctx, from.wallet, act.targets, amount, plan);
    const ok = res.filter((r) => r.status === 'ok').length;
    return say([`${ok === act.targets.length ? '✅' : '⚠️'} Nạp xong ${ok}/${act.targets.length} ví`,
      ...res.map((r) => `  ${r.status === 'ok' ? '✅' : '❌'} ${short(r.to)}: ${r.hash ? ctx.txUrl(r.hash) : r.error}`)].join('\n'));
  }

  if (act.kind === 'withdraw') {
    await say(`🏦 Đang rút ${act.sources.length} ví về ${short(act.to)}...`);
    const res = await Promise.all(act.sources.map(async (a) => {
      const w = byAddr(a);
      const r = await withdrawAll(ctx, w, act.to).catch((e) => ({ status: 'failed', note: e.shortMessage || e.message }));
      return { w, r };
    }));
    const total = res.filter((x) => x.r.status === 'done').reduce((s, x) => s + x.r.amount, 0n);
    return say([`✅ Đã rút ~${fmtE(total)} ${ctx.coin} về ${short(act.to)}`,
      ...res.map(({ w, r }) => `  ${r.status === 'done' ? '✅' : r.status === 'skipped' ? '⏭' : '❌'} ${w.name}: ${r.status === 'done' ? `${fmtE(r.amount)} ${ctx.txUrl(r.hash)}` : r.note}`)].join('\n'));
  }

  if (act.kind === 'nft') {
    await say(`🖼 Đang gom NFT ${act.slug} về ${short(act.to)}...`);
    const res = await Promise.all(act.sources.map(async (a) => {
      const w = byAddr(a);
      const nfts = await nftsOf(opensea, act.chain, w.address, act.slug).catch(() => []);
      const r = await transferNfts(ctx, w, act.to, nfts).catch((e) => ({ done: 0, failed: nfts.length, skipped: 0, note: e.shortMessage || e.message }));
      return { w, r };
    }));
    const done = res.reduce((s, x) => s + x.r.done, 0);
    return say([`✅ Đã chuyển ${done} NFT về ${short(act.to)}`,
      ...res.map(({ w, r }) => `  ${w.name}: ${r.done} xong${r.failed ? `, ${r.failed} lỗi` : ''}${r.skipped ? `, ${r.skipped} bỏ qua (không phải ERC-721)` : ''}${r.note ? ` (${r.note})` : ''}`)].join('\n'));
  }
  return null;
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
      'Dán địa chỉ contract 0x... (kèm tên chain nếu biết, vd: 0xabc... base) → bot tự tìm chain, hẹn mint Public thẳng contract.',
      'Dán / chuyển tiếp tin có nhiều link (Discord, Twitter...) → bot tự theo dõi hết, báo khi ví có GTD/WL, nhắc 60 phút trước giờ mở, tự bỏ khi dự án mint xong.',
      '/mint <link> 2 — mint NGAY stage đang mở (nhanh nhất), x2 mỗi ví',
      '/list — các lần hẹn',
      '/wallets — bật/tắt ví tham gia',
      '/max 0.01 — giới hạn giá + gas mỗi ví mỗi lần (/max off để bỏ)',
      '/gas 2 — hệ số tip gas, cao = được xếp trước (mặc định 2)',
      '/bal — số dư',
      '/fund robinhood 0.001 — ví chính nạp 0.001 cho MỖI ví phụ đang bật (có nút xác nhận)',
      '/withdraw robinhood — mọi ví phụ gửi hết tiền về ví chính / WITHDRAW_TO',
      '/withdrawnft reeveworld — mọi ví phụ chuyển hết NFT collection đó về ví chính / WITHDRAW_TO',
      '',
      '/price reeveworld — giá sàn, volume, so với giá mint',
      '/alert reeveworld < 0.001 — báo khi floor xuống (> để báo khi lên, 15% để báo mỗi lần lệch 15%)',
      '/alerts — xem / xóa cảnh báo giá',
      '',
      '/watch — danh sách dự án đang theo dõi (bỏ theo dõi bằng nút)',
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
  if (cmd === '/fund') return cmdFund((arg || '').toLowerCase(), text.trim().split(/\s+/)[2]);
  if (cmd === '/withdraw') return cmdWithdraw((arg || '').toLowerCase());
  if (cmd === '/withdrawnft') return cmdWithdrawNft(arg);
  if (cmd === '/mint') {
    const parts = text.trim().split(/\s+/).slice(1);
    const slug = argSlug(parts[0]);
    const qty = Number(parts[1] || 1);
    if (!slug || !(qty >= 1 && qty <= 100)) return say('Ví dụ: /mint <link OpenSea> 2 — mint NGAY stage đang mở, x2 mỗi ví');
    return startNow({ slug, name: slug, label: 'stage đang mở', stageUuid: `now:${slug}:${Date.now()}`, qty });
  }
  if (cmd === '/watch') {
    const slug = argSlug(arg);
    if (!slug) return listWatch();
    if (!(await addWatch(slug))) return say(`${slug} không phải drop trên OpenSea.`);
    await say(`👀 Đã theo dõi ${slug}. Bot báo ngay khi ví có GTD/WL và nhắc trước giờ mở.`);
    return eligibilityScan();
  }
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
  // Dan / chuyen tiep tin co link OpenSea -> tu theo doi tat ca
  const slugs = allSlugs(text);
  if (slugs.length === 1) {
    const drop = await addWatch(slugs[0]);
    if (!drop) return say(`${slugs[0]} không phải drop (chưa có lịch mint trên OpenSea). /price ${slugs[0]} để xem giá.`);
    await showDrop(slugs[0]);
    return eligibilityScan();
  }
  if (slugs.length > 1) {
    const res = await Promise.all(slugs.map(async (s) => [s, await addWatch(s)]));
    const ok = res.filter(([, d]) => d).map(([s, d]) => `👀 ${d.collection_name} (${s})`);
    const bad = res.filter(([, d]) => !d).map(([s]) => `• ${s} (không phải drop)`);
    await say([`Đã tự theo dõi ${ok.length}/${slugs.length} dự án:`, ...ok, ...bad, '', 'Bot sẽ báo khi ví có GTD/WL và nhắc trước giờ mở.'].join('\n'));
    return eligibilityScan();
  }
  // Dia chi contract 0x... (kem ten chain neu biet, vd "0xabc... base")
  const addr = text.match(/\b0x[a-fA-F0-9]{40}\b/);
  if (addr) {
    const chain = Object.keys(CHAINS).find((c) => new RegExp(`\\b${c}\\b`, 'i').test(text));
    return showContract(ethers.getAddress(addr[0].toLowerCase()), chain);
  }
  return say('Không hiểu. Dán link opensea.io/collection/..., địa chỉ contract 0x..., hoặc gõ /help');
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

/** Mint ngay: chay LUON, khong cho vong hen gio, khong cho gui tin xong */
function startNow(partial) {
  const now = new Date().toISOString();
  const job = { id: db.nextId++, ...partial, status: 'running', runAt: now, createdAt: now };
  db.jobs.push(job);
  saveJobs();
  runJob(job).catch(async (err) => {
    log('[mint]', err.message);
    await say(`❌ Lỗi khi mint #${job.id}: ${err.message}`);
    finish(job, 'failed');
  });
  return say(`⚡ Đang mint ${job.name || job.slug} x${job.qty} trên ${activeWallets().length} ví...`);
}

async function onButton(id) {
  const act = actions.get(id);
  if (!act) return say('Nút này đã cũ (bot vừa khởi động lại). Dán lại link để có nút mới.');

  if (act.type === 'noop') return say('Đã hủy.');
  if (act.type === 'confirm') {
    actions.delete(id); // bam 1 lan duy nhat, bam lai khong gui lan 2
    if (Date.now() > act.exp) return say('Nút xác nhận đã hết hạn (2 phút). Gõ lại lệnh.');
    return runConfirmed(act);
  }
  if (act.type === 'alert') return addAlert(act.slug, act.rule);
  if (act.type === 'unwatch') {
    db.watch = db.watch.filter((s) => s !== act.slug);
    saveJobs();
    return say(`Đã bỏ theo dõi ${act.slug}`);
  }
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

  if (act.type === 'now') return startNow({ ...act.job });

  const dup = db.jobs.find((j) => ['pending', 'running'].includes(j.status) && j.stageUuid === act.job.stageUuid);
  if (dup) return say(`Đã có hẹn #${dup.id} cho ${dup.name} — ${dup.label}. Gõ /list để hủy nếu muốn đổi số lượng.`);

  const job = { id: db.nextId++, ...act.job, status: 'pending', createdAt: new Date().toISOString() };
  db.jobs.push(job);
  saveJobs();
  const n = activeWallets().length;
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
      const lead = LEAD_MS;
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

/**
 * node mintbot.mjs addwallet <ten>  -> them vi phu vao wallets/<ten>/keystore.json, CUNG mat khau voi vi chinh.
 * Dan private key de nhap vi co san, hoac Enter de tao burner moi.
 */
async function addWallet(name) {
  if (!name || !/^[a-z0-9_-]{1,20}$/i.test(name)) throw new Error('Cach dung: node mintbot.mjs addwallet <ten>  (vd: burner1)');
  const file = path.join(__dirname, 'wallets', name, 'keystore.json');
  if (fs.existsSync(file)) throw new Error(`Da co vi ${name}. Chon ten khac.`);
  if (keystoreFiles(__dirname).length === 0) throw new Error('Chua co vi chinh. Chay truoc: node mintbot.mjs setup');

  const pass = await ask('Mat khau keystore (giong vi chinh): ', true);
  console.log('Kiem tra mat khau...');
  if ((await loadWallets(__dirname, pass)).wallets.length === 0) throw new Error('Sai mat khau.');

  const key = await ask('Private key de nhap vi co san (Enter = tao burner moi): ', true);
  let w;
  try {
    w = key ? new ethers.Wallet(key.startsWith('0x') ? key : `0x${key}`) : ethers.Wallet.createRandom();
  } catch {
    throw new Error('Private key khong hop le.');
  }
  console.log('Dang ma hoa (5-20 giay)...');
  const json = await ethers.encryptKeystoreJson({ address: w.address, privateKey: w.privateKey }, pass, { scrypt: { N: 1 << 18 } });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, json, { mode: 0o600 });
  console.log(`\nDa them vi "${name}": ${w.address}`);
  console.log(key ? '' : 'Burner moi: key chi nam trong file keystore da ma hoa. Chi nap vua du tien mint + gas.');
  console.log('Khoi dong lai bot de dung vi nay. /wallets tren Telegram de bat/tat.');
}

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
  if (process.argv[2] === 'addwallet') return addWallet(process.argv[3]);

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
  await Promise.all([pollTelegram(), scheduler(), priceLoop(), eligibilityLoop(), reminderLoop()]);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
