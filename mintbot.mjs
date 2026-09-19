/**
 * Bot Telegram hen gio auto mint drop OpenSea.
 *
 *   node mintbot.mjs setup   -> nhap private key + mat khau, luu thanh wallet.keystore.json (da ma hoa)
 *   node mintbot.mjs         -> nhap mat khau, bot chay va nghe lenh Telegram
 *
 * Tren Telegram (chi nhan lenh tu TELEGRAM_CHAT_ID):
 *   <dan link opensea.io/collection/...>  -> lich cac giai doan + nut hen gio / mint ngay
 *   /list        -> cac lan hen
 *   /max 0.01    -> tu choi mint neu gia + phi gas vuot 0.01 (ETH/coin cua chain); /max off de bo
 *   /bal         -> so du vi tren cac chain
 *
 * Den gio mo, bot nho OpenSea dung giao dich mint cho vi, roi ky va gui bang key trong keystore.
 * Private key chi nam trong RAM khi bot chay, tren dia chi co ban ma hoa.
 * MINT_PASSWORD trong bien moi truong -> khong hoi mat khau (tien cho tu chay, nhung kem an toan).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYSTORE_FILE = path.join(__dirname, 'wallet.keystore.json');
const JOBS_FILE = path.join(__dirname, 'mint-jobs.json');
const HTTP_TIMEOUT_MS = 15_000;
const TICK_MS = 1000;
const RETRY_WINDOW_MS = 3 * 60_000; // sau gio mo van thu lai trong 3 phut (OpenSea/RPC cham)
const RECEIPT_TIMEOUT_MS = 5 * 60_000;

// chain cua OpenSea -> RPC cong khai + explorer. Doi RPC bang RPC_<CHAIN> trong .env, vd RPC_ROBINHOOD=...
const CHAINS = {
  ethereum: { rpc: 'https://ethereum-rpc.publicnode.com', explorer: 'https://etherscan.io', coin: 'ETH' },
  base: { rpc: 'https://mainnet.base.org', explorer: 'https://basescan.org', coin: 'ETH' },
  robinhood: { rpc: 'https://rpc.mainnet.chain.robinhood.com', explorer: 'https://robinhoodchain.blockscout.com', coin: 'ETH' },
  arbitrum: { rpc: 'https://arb1.arbitrum.io/rpc', explorer: 'https://arbiscan.io', coin: 'ETH' },
  optimism: { rpc: 'https://mainnet.optimism.io', explorer: 'https://optimistic.etherscan.io', coin: 'ETH' },
  zora: { rpc: 'https://rpc.zora.energy', explorer: 'https://explorer.zora.energy', coin: 'ETH' },
  abstract: { rpc: 'https://api.mainnet.abs.xyz', explorer: 'https://abscan.org', coin: 'ETH' },
  soneium: { rpc: 'https://rpc.soneium.org', explorer: 'https://soneium.blockscout.com', coin: 'ETH' },
  unichain: { rpc: 'https://mainnet.unichain.org', explorer: 'https://uniscan.xyz', coin: 'ETH' },
  shape: { rpc: 'https://mainnet.shape.network', explorer: 'https://shapescan.xyz', coin: 'ETH' },
  ape_chain: { rpc: 'https://rpc.apechain.com', explorer: 'https://apescan.io', coin: 'APE' },
  avalanche: { rpc: 'https://api.avax.network/ext/bc/C/rpc', explorer: 'https://snowtrace.io', coin: 'AVAX' },
  bera_chain: { rpc: 'https://rpc.berachain.com', explorer: 'https://berascan.com', coin: 'BERA' },
  polygon: { rpc: 'https://polygon-bor-rpc.publicnode.com', explorer: 'https://polygonscan.com', coin: 'POL' },
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtTime(iso) {
  return new Date(iso).toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh', hour12: false,
    hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit',
  });
}

function toSlug(s) {
  const m = s.match(/opensea\.io\/(?:[a-z-]+\/)?collection\/([^/?#\s]+)/i);
  return m ? m[1].toLowerCase() : null;
}

function chainInfo(chain) {
  const base = CHAINS[chain];
  const rpc = process.env[`RPC_${chain.toUpperCase()}`] || base?.rpc;
  if (!rpc) throw new Error(`Chua co RPC cho chain "${chain}". Them RPC_${chain.toUpperCase()}=... vao .env`);
  return { rpc, explorer: base?.explorer || '', coin: base?.coin || chain };
}

const providers = new Map();
function providerFor(chain) {
  if (!providers.has(chain)) {
    const req = new ethers.FetchRequest(chainInfo(chain).rpc);
    req.timeout = HTTP_TIMEOUT_MS;
    providers.set(chain, new ethers.JsonRpcProvider(req, undefined, { batchMaxCount: 1 }));
  }
  return providers.get(chain);
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
  try {
    return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  } catch {
    return { settings: { max: null }, jobs: [], nextId: 1 };
  }
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

/** OpenSea dung giao dich mint -> { tx } hoac { status, error } */
async function buildMint(slug, minter, quantity) {
  const { status, data } = await opensea(`/api/v2/drops/${slug}/mint`, {
    method: 'POST',
    body: JSON.stringify({ minter, quantity }),
  });
  if (status === 200) {
    const t = data.transaction || data;
    const to = t.target || t.to;
    const calldata = t.calldata || t.data;
    if (!to || !calldata) return { status, error: `OpenSea tra ve dang la: ${JSON.stringify(data).slice(0, 300)}` };
    return { tx: { to, data: calldata, value: BigInt(t.value ?? 0) } };
  }
  return { status, error: (data.errors || []).join('; ') || `HTTP ${status}` };
}

// ---------- Telegram ----------

const TG = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

async function tg(method, body, timeoutMs = HTTP_TIMEOUT_MS) {
  const res = await fetch(`${TG()}/${method}`, {
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

// ---------- mint ----------

let wallet;

async function balanceText(chain) {
  try {
    const bal = await providerFor(chain).getBalance(wallet.address);
    return `${ethers.formatEther(bal)} ${chainInfo(chain).coin}`;
  } catch (err) {
    return `khong doc duoc (${err.shortMessage || err.message})`;
  }
}

/** Mint 1 lan hen. Tra ve true neu da xong (thanh cong hoac that bai han), false neu can thu lai */
async function runJob(job) {
  const deadline = Math.min(Date.parse(job.endTime || job.startTime) || Infinity, Date.parse(job.startTime) + RETRY_WINDOW_MS);
  const signer = wallet.connect(providerFor(job.chain));
  const { explorer, coin } = chainInfo(job.chain);
  let lastErr = '';

  for (;;) {
    const built = await buildMint(job.slug, wallet.address, job.qty).catch((err) => ({ status: 0, error: err.message }));
    if (built.tx) {
      try {
        const { tx } = built;
        const provider = signer.provider;
        const [gas, fee] = await Promise.all([
          provider.estimateGas({ from: wallet.address, ...tx }),
          provider.getFeeData(),
        ]);
        const perGas = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
        const cost = tx.value + gas * perGas;
        if (db.settings.max && cost > ethers.parseEther(db.settings.max)) {
          await say(`⛔ ${job.name} — ${job.label}: bỏ qua vì tốn ~${ethers.formatEther(cost)} ${coin}, vượt giới hạn /max ${db.settings.max}`);
          return finish(job, 'over-max');
        }
        const sent = await signer.sendTransaction({ ...tx, gasLimit: (gas * 12n) / 10n });
        job.hash = sent.hash; // luu ngay: tat giua chung thi khong gui lai lan 2
        saveJobs();
        log('gui tx', job.slug, sent.hash);
        await say(`🚀 Đã gửi giao dịch mint ${job.name} x${job.qty}\n${explorer}/tx/${sent.hash}`);
        const rc = await sent.wait(1, RECEIPT_TIMEOUT_MS);
        if (rc?.status === 1) {
          await say(`✅ MINT THÀNH CÔNG: ${job.name} — ${job.label} x${job.qty}\n${explorer}/tx/${sent.hash}\nSố dư còn: ${await balanceText(job.chain)}`);
          return finish(job, 'done', sent.hash);
        }
        await say(`❌ Giao dịch thất bại (revert): ${job.name}\n${explorer}/tx/${sent.hash}`);
        return finish(job, 'failed', sent.hash);
      } catch (err) {
        lastErr = err.shortMessage || err.message;
        // Het suat / khong du dieu kien -> estimateGas revert, thu lai vo ich
        if (/insufficient funds|revert|exceeds/i.test(lastErr)) break;
      }
    } else {
      lastErr = built.error;
      const retry = built.status === 409 || built.status === 429 || built.status === 0 || built.status >= 500;
      if (!retry) break; // khong co quyen, het suat, thieu tien...
    }
    if (Date.now() >= deadline) break;
    await sleep(TICK_MS);
  }

  await say(`❌ Không mint được ${job.name} — ${job.label}\nLý do: ${lastErr || 'hết thời gian thử'}\nSố dư: ${await balanceText(job.chain)}`);
  return finish(job, 'failed');
}

function finish(job, status, hash) {
  job.status = status;
  if (hash) job.hash = hash;
  job.doneAt = new Date().toISOString();
  saveJobs();
  return true;
}

// ---------- xu ly lenh ----------

async function showDrop(slug) {
  const drop = await getDrop(slug);
  const now = Date.now();
  const { coin } = chainInfo(drop.chain);
  const lines = [`${drop.collection_name} — chain ${drop.chain}`, `Ví ${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}: ${await balanceText(drop.chain)}`, ''];
  const rows = [];

  const stages = [...(drop.stages || [])].sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
  for (const s of stages) {
    const start = Date.parse(s.start_time);
    const end = Date.parse(s.end_time);
    const state = now >= end ? '⚫ đã đóng' : now >= start ? '🟢 đang mở' : '🕒 sắp mở';
    const price = ethers.formatEther(BigInt(s.price || '0'));
    lines.push(`${state} ${s.label}: ${fmtTime(s.start_time)} → ${fmtTime(s.end_time)} | ${price} ${coin} | tối đa ${s.max_per_wallet}/ví`);
    if (now >= end) continue;

    const job = { slug, name: drop.collection_name, chain: drop.chain, label: s.label, stageUuid: s.uuid, startTime: s.start_time, endTime: s.end_time };
    const max = Math.max(1, Number(s.max_per_wallet) || 1);
    const qtys = [...new Set([1, Math.min(max, 10)])];
    if (now >= start) {
      rows.push(qtys.map((q) => button(`⚡ Mint ngay ${s.label} x${q}`, { type: 'now', job: { ...job, qty: q } })));
    } else {
      rows.push(qtys.map((q) => button(`⏰ Auto ${s.label} x${q}`, { type: 'schedule', job: { ...job, qty: q } })));
    }
  }
  lines.push('', drop.opensea_url);
  if (db.settings.max) lines.push(`Giới hạn /max: ${db.settings.max} ${coin}`);
  await say(lines.join('\n'), rows);
}

async function listJobs() {
  const pending = db.jobs.filter((j) => j.status === 'pending' || j.status === 'running');
  if (pending.length === 0) return say('Chưa có lần hẹn nào. Dán link OpenSea để hẹn.');
  const rows = pending.map((j) => [button(`❌ Hủy #${j.id} ${j.name} ${j.label}`, { type: 'cancel', id: j.id })]);
  const text = pending.map((j) => `#${j.id} ${j.name} — ${j.label} x${j.qty} lúc ${fmtTime(j.startTime)} (${j.status})`).join('\n');
  return say(text, rows);
}

async function showBalances() {
  const chains = [...new Set(['ethereum', 'base', 'robinhood', ...db.jobs.filter((j) => j.status === 'pending').map((j) => j.chain)])];
  const lines = await Promise.all(chains.map(async (c) => `${c}: ${await balanceText(c)}`));
  return say(`Ví ${wallet.address}\n${lines.join('\n')}`);
}

async function onText(text) {
  const [cmd, arg] = text.trim().split(/\s+/);
  if (cmd === '/start' || cmd === '/help') {
    return say('Dán link OpenSea (opensea.io/collection/...) để xem lịch và hẹn auto mint.\n/list — các lần hẹn\n/max 0.01 — giới hạn giá + gas mỗi lần mint (/max off để bỏ)\n/bal — số dư ví');
  }
  if (cmd === '/list') return listJobs();
  if (cmd === '/bal') return showBalances();
  if (cmd === '/max') {
    if (!arg) return say(`Giới hạn hiện tại: ${db.settings.max ?? 'không giới hạn'}`);
    if (arg === 'off') db.settings.max = null;
    else if (/^\d+(\.\d+)?$/.test(arg)) db.settings.max = arg;
    else return say('Ví dụ: /max 0.01 hoặc /max off');
    saveJobs();
    return say(`Đã đặt giới hạn: ${db.settings.max ?? 'không giới hạn'}`);
  }
  const slug = toSlug(text);
  if (slug) return showDrop(slug);
  return say('Không hiểu. Dán link opensea.io/collection/... hoặc gõ /help');
}

async function onButton(id) {
  const act = actions.get(id);
  if (!act) return say('Nút này đã cũ (bot vừa khởi động lại). Dán lại link để có nút mới.');

  if (act.type === 'cancel') {
    const job = db.jobs.find((j) => j.id === act.id);
    if (!job || job.status !== 'pending') return say(`#${act.id} không còn để hủy.`);
    finish(job, 'cancelled');
    return say(`Đã hủy #${job.id} ${job.name} — ${job.label}`);
  }

  const dup = db.jobs.find((j) => j.status === 'pending' && j.stageUuid === act.job.stageUuid);
  if (dup) return say(`Đã có hẹn #${dup.id} cho ${dup.name} — ${dup.label}. Gõ /list để hủy nếu muốn đổi số lượng.`);

  const job = { id: db.nextId++, ...act.job, status: 'pending', createdAt: new Date().toISOString() };
  if (act.type === 'now') job.startTime = new Date().toISOString();
  db.jobs.push(job);
  saveJobs();
  if (act.type === 'now') return say(`⚡ Đang mint ${job.name} — ${job.label} x${job.qty}...`);
  return say(`⏰ Đã hẹn #${job.id}: auto mint ${job.name} — ${job.label} x${job.qty} lúc ${fmtTime(job.startTime)} (giờ VN)\nGiữ máy bật và bot chạy tới lúc đó. /list để xem hoặc hủy.`);
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
      if (job.status !== 'pending' || Date.parse(job.startTime) > now) continue;
      job.status = 'running';
      saveJobs();
      log('mint', `#${job.id}`, job.slug, job.label, `x${job.qty}`);
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
  const key = await ask('Private key cua vi (se khong hien khi go): ', true);
  let w;
  try {
    w = new ethers.Wallet(key.startsWith('0x') ? key : `0x${key}`);
  } catch {
    throw new Error('Private key khong hop le.');
  }
  const pass = await ask('Dat mat khau cho keystore: ', true);
  if (pass.length < 8) throw new Error('Mat khau can it nhat 8 ky tu.');
  if ((await ask('Nhap lai mat khau: ', true)) !== pass) throw new Error('Hai mat khau khong khop.');
  console.log('Dang ma hoa (vai giay)...');
  fs.writeFileSync(KEYSTORE_FILE, await w.encrypt(pass));
  console.log(`Da luu ${KEYSTORE_FILE}\nDia chi vi: ${w.address}`);
  if (process.env.WATCH_WALLET && process.env.WATCH_WALLET.toLowerCase() !== w.address.toLowerCase()) {
    console.log(`CANH BAO: khac WATCH_WALLET (${process.env.WATCH_WALLET}) trong .env`);
  }
}

async function main() {
  loadEnv();
  for (const k of ['OPENSEA_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) {
    if (!process.env[k]) throw new Error(`Thieu ${k} trong .env`);
  }
  if (process.argv[2] === 'setup') return setup();

  if (!fs.existsSync(KEYSTORE_FILE)) throw new Error('Chua co keystore. Chay truoc: node mintbot.mjs setup');
  const pass = process.env.MINT_PASSWORD || (await ask('Mat khau keystore: ', true));
  console.log('Dang giai ma keystore...');
  try {
    wallet = await ethers.Wallet.fromEncryptedJson(fs.readFileSync(KEYSTORE_FILE, 'utf8'), pass);
  } catch {
    throw new Error('Sai mat khau.');
  }

  db = readJobs();
  // Lan truoc bi tat giua chung -> cho chay lai neu con trong thoi gian mo
  // Da gui tx roi thi khong mint lai, chi bao de tu kiem tra
  for (const j of db.jobs) {
    if (j.status !== 'running') continue;
    j.status = j.hash ? 'unknown' : 'pending';
    if (j.hash) await say(`⚠️ Bot bị tắt khi đang chờ giao dịch #${j.id} ${j.name}. Kiểm tra: ${chainInfo(j.chain).explorer}/tx/${j.hash}`);
  }
  saveJobs();

  const pending = db.jobs.filter((j) => j.status === 'pending').length;
  log(`Bot mint dang chay. Vi ${wallet.address}, ${pending} lan hen. Ctrl+C de dung.`);
  await say(`🤖 Bot mint đã bật. Ví ${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}, ${pending} lần hẹn.\nDán link OpenSea để hẹn auto mint, /help để xem lệnh.`);
  await Promise.all([pollTelegram(), scheduler()]);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
