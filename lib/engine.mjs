/**
 * Dong co mint cho 1 vi, goi thang contract SeaDrop.
 *
 * Public  (mintPublic): chuan bi + KY SAN truoc gio mo. Vai giay truoc gio mo, ban eth_call chong lan
 *         (mien phi) len moi RPC; lan dau tien thanh cong -> phat giao dich da ky ra tat ca RPC.
 *         Khong gui giao dich that truoc gio mo: revert van mat gas.
 * GTD/WL  (mintSigned): contract doi chu ky cua OpenSea, chi lay duoc khi stage mo.
 *         Do OpenSea lien tuc tu vai giay truoc gio mo, lay duoc -> KIEM TRA calldata -> ky -> phat ra tat ca RPC.
 *
 * Moi ham tra ve { status: 'done'|'failed'|'dry'|'skipped', hash?, note }.
 */

import { ethers } from 'ethers';
import { envNum } from './env.mjs'; // phai import truoc cac hang so doc .env ben duoi
import { broadcast, planGas, gasMarket } from './chains.mjs';
import { logMint, rpcLine } from './telemetry.mjs';
import { syncClock } from './clock.mjs';
import {
  SEADROP_ADDRESS, explain, isNotActive, readPublicDrop, readMintStats, resolveQuantity,
  pickFeeRecipient, encodeMintPublic, verifyOpenSeaTx,
} from './seadrop.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (v) => ethers.formatEther(v);

const RACE_WINDOW_MS = 4000;   // bat dau do chong lan truoc gio mo
const PROBE_MS = 60;           // nhip do
const MAX_INFLIGHT = 8;
const GIVE_UP_MS = 3 * 60_000; // sau gio mo van thu trong 3 phut
const RECEIPT_MS = 3 * 60_000;
const SLOW_PROBE_MS = 2000;    // nhip do thua khi con xa gio mo
// Nhip burst: chinh duoc qua .env vi moi chain mot nhip block khac nhau.
// Spacing nen xap xi thoi gian 1 block (node recon.mjs <chain> <nft> in ra so nay),
// de moi phat roi vao mot block khac nhau thay vi don ca loat vao cung mot block.
const BURST_BEFORE_MS = envNum('BURST_BEFORE_MS', 120);   // ban phat dau tien som hon khoanh khac mo bao nhieu
const BURST_SPACING_MS = envNum('BURST_SPACING_MS', 90);  // khoang cach giua cac phat
// Tran so phat. Chain 12 block/giay thi 5 phat chi phu ~0,4 giay quanh gio mo; do tre
// mang mot chieu da hon 1 block nen can nhieu phat hon de chac chan phu trung block mo.
// Moi phat la mot giao dich that: truot thi mat gas cua phat do -> tang co y thuc.
const BURST_MAX = envNum('BURST_MAX', 5);
const SYNC_AT_MS = 25_000;     // dong bo dong ho khi con bao nhieu ms toi gio mo
const FAST_WINDOW_MS = 5000;   // GTD/WL: hoi OpenSea day tu 5s truoc gio mo toi 15s sau
// OpenSea gioi han ~120 lan/phut: 55s x 1 lan/2s + 20s x 4 lan/s ~ 110 lan

/** Cho toi moc gio (ms, gio may), ngu dai roi ngu ngan cho chinh xac */
async function waitUntil(t, shouldStop) {
  while (Date.now() < t) {
    if (shouldStop?.()) return false;
    await sleep(Math.min(1000, Math.max(5, t - Date.now() - 5)));
  }
  return true;
}

async function sendAndWait(ctx, raw, { onEvent, label, openAt, timing }) {
  const stats = [];
  const t0 = Date.now();
  const hash = await broadcast(ctx, raw, stats);
  if (timing) {
    timing.sentAfterOpenMs = openAt ? Date.now() - openAt : null;
    timing.broadcastMs = Date.now() - t0;
    timing.rpc = stats;
  }
  // openAt: gio mo theo dong ho may (da chinh lech voi chain) -> do bot ban nhanh the nao
  const speed = openAt ? ` ${Date.now() - openAt}ms sau giờ mở` : '';
  onEvent?.({ type: 'sent', hash, text: `🚀 ${label}: đã gửi${speed} ra ${ctx.providers.length} RPC\n${ctx.txUrl(hash)}` });
  const rc = await ctx.main.waitForTransaction(hash, 1, RECEIPT_MS).catch(() => null);
  if (timing) timing.minedAfterOpenMs = openAt ? Date.now() - openAt : null;
  if (!rc) return { status: 'failed', hash, note: 'Chưa thấy xác nhận sau 3 phút, tự kiểm tra link' };
  if (rc.status !== 1) return { status: 'failed', hash, note: 'Giao dịch revert on-chain (hết suất / chậm chân?)' };
  const detail = timing ? `\n   ⏱ bắn${speed}, xác nhận +${timing.minedAfterOpenMs}ms | ${rpcLine(stats)}${timing.probes ? ` | dò ${timing.probes} lần, thấy mở +${timing.openDetectedMs}ms` : ''}` : (speed ? `\n   ⏱ bắn${speed}` : '');
  return { status: 'done', hash, note: `block ${rc.blockNumber}, phí ${fmt(rc.gasUsed * (rc.gasPrice ?? 0n))}${detail}` };
}

/** Ky giao dich EIP-1559 voi nonce + gas da tinh */
function sign(wallet, ctx, { nonce, to, data, value, gas }) {
  return wallet.signTransaction({
    type: 2, chainId: ctx.chainId, nonce, to, data, value,
    gasLimit: gas.gasLimit, maxFeePerGas: gas.maxFee, maxPriorityFeePerGas: gas.maxPrio,
  });
}

function overMax(settings, cost) {
  return settings.max && cost > ethers.parseEther(settings.max);
}

// Nhieu vi cung mint 1 drop -> chi MOT luong do "stage mo chua", ai cung doi ket qua do
const openWatchers = new Map();
// Dong bo dong ho dung chung cho moi vi (khoi moi vi tu do lai)
const clockSyncs = new Map();

/**
 * Lam nong ket noi toi moi RPC ngay truoc khi ban: mot lenh re tien de mo san
 * ket noi TCP/TLS. Luc drop mo, bat tay lai tu dau co the ton ca nua giay.
 */
function warmUp(ctx) {
  return Promise.all(ctx.providers.map((p) => p.send('eth_blockNumber', []).catch(() => null)));
}

function sharedSync(ctx, key) {
  if (!clockSyncs.has(key)) {
    clockSyncs.set(key, syncClock(ctx).catch(() => null));
    setTimeout(() => clockSyncs.delete(key), 120_000);
  }
  return clockSyncs.get(key);
}

/**
 * Ban loat `count` giao dich da ky (nonce lien tiep) quanh khoanh khac stage mo.
 * Cai toi som revert (ton it gas), cai dau tien toi sau khi mo se mint duoc.
 * -> { status, hash, note } neu co ket qua, hoac null neu khong cai nao duoc nhan.
 */
async function burstFire(ctx, { w, gas, nonce, data, value, startTime, count, label, onEvent, shouldStop, timing }) {
  // Dong bo dong ho ngay truoc gio mo cho chinh xac
  const waitTo = startTime * 1000 - SYNC_AT_MS;
  if (Date.now() < waitTo && !(await waitUntil(waitTo, shouldStop))) return null;
  const sync = await sharedSync(ctx, `${ctx.name}:${startTime}`);
  if (!sync) return null;

  // Luc chain buoc sang giay mo, theo dong ho MAY
  const openMachine = startTime * 1000 + sync.offsetMs;
  const oneWay = Math.round(sync.rttMs / 2);
  const first = openMachine - oneWay - BURST_BEFORE_MS;
  Object.assign(timing, {
    kind: 'burst', clockOffsetMs: sync.offsetMs, rttMs: sync.rttMs, burst: count, openAtFixed: openMachine,
  });
  onEvent?.({
    type: 'burst',
    text: `🎯 ${label}: bắn loạt ${count} phát từ ${new Date(first).toLocaleTimeString('vi-VN', { hour12: false })}.${String(first % 1000).padStart(3, '0')} (đồng hồ lệch ${sync.offsetMs}ms, mạng 1 chiều ~${oneWay}ms)`,
  });

  const raws = [];
  for (let i = 0; i < count; i++) {
    raws.push(await sign(w.wallet, ctx, { nonce: nonce + i, to: SEADROP_ADDRESS, data, value, gas }));
  }

  // Giu ket noi nong tu 3s truoc khi ban, nhac lai moi 800ms
  const warm = setInterval(() => warmUp(ctx), 800);
  await waitUntil(first - 3000, shouldStop);
  await warmUp(ctx);

  const shots = [];
  for (let i = 0; i < count; i++) {
    const at = first + i * BURST_SPACING_MS;
    if (!(await waitUntil(at, shouldStop))) break;
    const stats = [];
    const sentAt = Date.now();
    shots.push(
      broadcast(ctx, raws[i], stats).then(
        (hash) => ({ i, hash, sentAt, stats }),
        (err) => ({ i, err: explain(err), sentAt, stats }),
      ),
    );
  }
  clearInterval(warm);
  const sent = (await Promise.all(shots)).filter((s) => s.hash);
  timing.shots = sent.map((s) => ({ i: s.i, atOpenMs: s.sentAt - openMachine }));
  if (sent.length === 0) return null;

  // Cai nao vao block truoc thi thang; cac cai khac revert (NotActive) hoac bi bo qua
  const rcs = await Promise.all(sent.map((s) => ctx.main.waitForTransaction(s.hash, 1, 90_000).then((rc) => ({ s, rc }), () => ({ s, rc: null }))));
  const win = rcs.find((x) => x.rc?.status === 1);
  const spent = rcs.reduce((sum, x) => sum + (x.rc ? x.rc.gasUsed * (x.rc.gasPrice ?? 0n) : 0n), 0n);
  timing.burstSentAfterOpenMs = win ? win.s.sentAt - openMachine : null;
  if (win) {
    onEvent?.({ type: 'sent', hash: win.s.hash, text: `🚀 ${label}: BURST trúng phát ${win.s.i + 1}, gửi ${win.s.sentAt - openMachine}ms so với giờ mở\n${ctx.txUrl(win.s.hash)}` });
    return {
      status: 'done', hash: win.s.hash,
      note: `burst phát ${win.s.i + 1}/${count}, block ${win.rc.blockNumber}, phí cả loạt ${fmt(spent)}\n   ⏱ gửi ${win.s.sentAt - openMachine}ms so với giờ mở | ${rpcLine(win.s.stats)}`,
    };
  }
  onEvent?.({ type: 'burst-miss', text: `⚠️ ${label}: loạt ${sent.length} phát đều trượt (phí ${fmt(spent)}), chuyển sang dò và bắn tiếp` });
  return { status: 'failed', note: `burst trượt, phí ${fmt(spent)}` };
}


/** Do chong lan tren moi RPC toi khi stage mo. -> { open, probes, openDetectedMs, probeRpc, note } */
function watchOpen(ctx, key, call, openAt, shouldStop) {
  if (openWatchers.has(key)) return openWatchers.get(key);
  const p = (async () => {
    let open = false;
    let lastErr = '';
    let probes = 0;
    let probeRpc = null;
    const inflight = new Set();
    let i = 0;
    while (!open) {
      if (shouldStop?.()) return { open: false, probes, note: 'Đã hủy' };
      if (Date.now() > openAt + GIVE_UP_MS) return { open: false, probes, note: `Quá 3 phút vẫn không mint được: ${lastErr}` };
      if (inflight.size < MAX_INFLIGHT) {
        const idx = i++ % ctx.providers.length;
        probes++;
        const job = ctx.providers[idx].call(call).then(
          () => { if (!open) { open = true; probeRpc = ctx.urls?.[idx] ?? null; } },
          (e) => { lastErr = explain(e); },
        ).finally(() => inflight.delete(job));
        inflight.add(job);
      }
      // Loi khac "chua mo" (het hang, vuot gioi han...) -> dung, khong ban vo ich
      if (lastErr && !/chưa mở|timeout|rate|429|503|502|limit/i.test(lastErr) && Date.now() > openAt) {
        return { open: false, probes, note: lastErr };
      }
      if (!open) await sleep(PROBE_MS);
    }
    return { open: true, probes, openDetectedMs: Date.now() - openAt, probeRpc };
  })();
  openWatchers.set(key, p);
  p.finally(() => setTimeout(() => openWatchers.delete(key), 30_000));
  return p;
}

// ---------------------------------------------------------------- public

export async function mintPublic(ctx, { w, nft, qty, settings, dry, onEvent, shouldStop }) {
  const label = `${w.name} ${w.address.slice(0, 6)}`;
  const addr = w.address;
  const timing = { wallet: w.name, chain: ctx.name, nft, kind: 'public' };
  const tPrep = Date.now();

  // ---- chuan bi: doc het tu contract ----
  const [drop, stats, feeRecipient, balance, nonce, blk] = await Promise.all([
    readPublicDrop(ctx.main, nft),
    readMintStats(ctx.main, nft, addr),
    pickFeeRecipient(ctx.main, nft),
    ctx.main.getBalance(addr),
    ctx.main.getTransactionCount(addr, 'pending'),
    ctx.main.getBlock('latest'),
  ]);
  if (drop.startTime === 0) return { status: 'failed', note: 'Contract chưa cấu hình public drop' };
  // Mint FREE: tu lay toi da contract cho phep luc mo (du an hay doi gioi han sat gio).
  // Mint mat tien thi giu dung so da hen, khong tu tieu them tien cua nguoi dung.
  const want = drop.mintPrice === 0n && drop.maxPerWallet > BigInt(qty) ? drop.maxPerWallet : qty;
  const { quantity, reason } = resolveQuantity(want, drop.maxPerWallet, stats);
  if (quantity === 0n) return { status: 'skipped', note: reason };

  const value = drop.mintPrice * quantity;
  const data = encodeMintPublic(nft, feeRecipient, quantity);
  const gasLimit = 150_000n + 40_000n * quantity;
  // Burst: ky san K giao dich nonce lien tiep -> moi giao dich chi duoc dung 1/K so du lam coc gas.
  // Khong du gas cho K phat thi HA dan so phat, con hon la hong ca lan mint.
  let burst = Math.max(1, Math.min(Number(settings.burst || 1), BURST_MAX));
  let gas;
  for (;;) {
    try {
      gas = await planGas(ctx, { bump: settings.gasBump ?? 2, gasLimit, value, balance: balance / BigInt(burst) });
      break;
    } catch (e) {
      if (burst > 1) {
        burst--;
        continue;
      }
      return { status: 'failed', note: `${e.message}: có ${fmt(balance)} ${ctx.coin}, cần > ${fmt(value)} + gas` };
    }
  }
  if (burst < Number(settings.burst || 1)) {
    onEvent?.({ type: 'note', text: `⚠️ ${label}: số dư chỉ đủ ${burst} phát burst (đặt ${settings.burst}). /fund thêm nếu muốn đủ.` });
  }
  if (overMax(settings, gas.expectedCost)) {
    return { status: 'skipped', note: `~${fmt(gas.expectedCost)} ${ctx.coin} vượt /max ${settings.max}` };
  }

  // Bay thu: chi chap nhan OK hoac "chua mo"
  const call = { from: addr, to: SEADROP_ADDRESS, data, value };
  let open = false;
  try {
    await ctx.main.call(call);
    open = true;
  } catch (e) {
    if (!isNotActive(e)) return { status: 'failed', note: `Mô phỏng thất bại: ${explain(e)}` };
  }

  const drift = Date.now() - blk.timestamp * 1000; // may nhanh hon chain bao nhieu ms
  const summary = `x${quantity}${reason ? ` (${reason})` : ''}, trả ${fmt(value)} ${ctx.coin}, số dư ${fmt(balance)}, tip x${settings.gasBump ?? 2}, trần gas baseFee x${gas.mult}, ${ctx.providers.length} RPC`;
  if (dry) return { status: 'dry', note: `✅ Sẵn sàng: ${summary}. Stage ${open ? 'ĐANG MỞ' : 'chưa mở'}` };

  let raw = await sign(w.wallet, ctx, { nonce, to: SEADROP_ADDRESS, data, value, gas });
  timing.prepMs = Date.now() - tPrep;
  timing.clockDriftMs = drift;
  onEvent?.({ type: 'ready', text: `🔫 ${label}: đã ký sẵn ${summary} (chuẩn bị ${timing.prepMs}ms, lệch đồng hồ ${drift}ms)` });

  // ---- cho toi cua so tranh ----
  let openAt = drop.startTime * 1000 + Math.max(0, drift);

  // ---- BURST: dong bo dong ho roi ban loat giao dich ky san quanh khoanh khac mo ----
  if (!open && burst > 1) {
    const r = await burstFire(ctx, {
      w, gas, nonce, data, value, startTime: drop.startTime, count: burst, label, onEvent, shouldStop, timing,
    });
    if (r) {
      logMint({ ...timing, status: r.status, hash: r.hash, note: r.note });
      if (r.status === 'done') return r;
    }
    // Khong an -> tiep tuc dan do + ban bang nonce moi
    nonce += burst;
    raw = await sign(w.wallet, ctx, { nonce, to: SEADROP_ADDRESS, data, value, gas });
    if (timing.openAtFixed) openAt = timing.openAtFixed;
  }

  if (!open) {
    // Tu luc chuan bi toi cua so tranh: do thua moi 2s, bat truong hop du an mo som hon gio cong bo
    // (moi lan do cung la mot lan lam nong ket noi, nen khong can warmUp rieng o day)
    while (!open && Date.now() < openAt - RACE_WINDOW_MS) {
      if (shouldStop?.()) return { status: 'failed', note: 'Đã hủy' };
      await ctx.main.call(call).then(() => { open = true; }, () => {});
      if (!open) await sleep(Math.min(SLOW_PROBE_MS, Math.max(5, openAt - RACE_WINDOW_MS - Date.now())));
    }
    if (open) onEvent?.({ type: 'early', text: `⚡ ${label}: stage mở SỚM hơn giờ công bố, bắn ngay` });

    // ---- do chong lan, DUNG CHUNG cho moi vi cung drop (khoi dap RPC 5 lan) ----
    const r = await watchOpen(ctx, `${nft}:${drop.startTime}`, call, openAt, shouldStop);
    Object.assign(timing, { probes: r.probes, openDetectedMs: r.openDetectedMs, probeRpc: r.probeRpc });
    if (!r.open) return { status: 'failed', note: r.note };
  }

  // ---- ban ----
  try {
    const r = await sendAndWait(ctx, raw, { onEvent, label, openAt, timing });
    logMint({ ...timing, status: r.status, hash: r.hash, note: r.note });
    return r;
  } catch (e) {
    logMint({ ...timing, status: 'error', note: explain(e) });
    // Nonce lech (vi vua co giao dich khac) -> ky lai 1 lan voi nonce moi
    if (/nonce/i.test(e.message || '')) {
      const n = await ctx.main.getTransactionCount(addr, 'pending');
      raw = await sign(w.wallet, ctx, { nonce: n, to: SEADROP_ADDRESS, data, value, gas });
      return sendAndWait(ctx, raw, { onEvent, label });
    }
    return { status: 'failed', note: explain(e) };
  }
}

// ---------------------------------------------------------------- mint ngay (stage dang mo)

/**
 * Nhanh nhat co the cho stage DANG MO: moi thu chay song song ngay tu dau.
 *   - hoi OpenSea dung giao dich (ca GTD/WL lan Public) NGAY, cung luc doc drop
 *   - drop ve -> doc so du, nonce, gas tren chain (chong len luc cho OpenSea)
 *   - co giao dich -> kiem tra calldata -> ky -> phat ra moi RPC
 * dropP: Promise cua drop OpenSea (dung chung cho nhieu vi). getCtx(chain) -> chainCtx.
 * Tra ve them `chain` va `timing` (ms tu luc bat dau toi tung buoc).
 */
export async function mintNow({ w, qty, settings, dropP, buildMint, getCtx, onEvent }) {
  const t0 = Date.now();
  const T = {};
  const mark = (k) => { T[k] = Date.now() - t0; };
  const addr = w.address;
  const label = `${w.name} ${addr.slice(0, 6)}`;

  let buildP = buildMint(addr, qty).catch((e) => ({ status: 0, error: e.message }));
  const drop = await dropP;
  mark('drop');
  const ctx = getCtx(drop.chain);
  const chainP = Promise.all([
    ctx.main.getBalance(addr),
    ctx.main.getTransactionCount(addr, 'pending'),
    gasMarket(ctx),
  ]);
  chainP.catch(() => {}); // loi se bat o duoi, tranh unhandled rejection

  // Stage vua chuyen / OpenSea cham: thu lai toi 5s
  let built = await buildP;
  while (!built.tx) {
    const retry = built.status === 409 || built.status === 429 || built.status === 0 || built.status >= 500;
    if (!retry || Date.now() - t0 > 5000) return { status: 'failed', chain: drop.chain, note: `OpenSea: ${built.error}` };
    await sleep(250);
    built = await buildMint(addr, qty).catch((e) => ({ status: 0, error: e.message }));
  }
  mark('build');

  const tx = built.tx;
  let fn;
  try {
    ({ fn } = verifyOpenSeaTx(tx, { nftContract: drop.contract_address, minter: addr, quantity: qty }));
  } catch (e) {
    return { status: 'failed', chain: drop.chain, note: e.message };
  }

  const [balance, nonce, market] = await chainP;
  mark('chain');
  const gasLimit = (fn === 'mintPublic' ? 150_000n : 250_000n) + 40_000n * BigInt(qty);
  let gas;
  try {
    gas = await planGas(ctx, { bump: settings.gasBump ?? 2, gasLimit, value: tx.value, balance, market });
  } catch (e) {
    return { status: 'failed', chain: drop.chain, note: `${e.message}: có ${fmt(balance)} ${ctx.coin}, cần > ${fmt(tx.value)} + gas` };
  }
  if (overMax(settings, gas.expectedCost)) {
    return { status: 'skipped', chain: drop.chain, note: `~${fmt(gas.expectedCost)} ${ctx.coin} vượt /max ${settings.max}` };
  }
  // Ethereum gas dat: mo phong truoc. L2 re: bo qua cho nhanh
  if (ctx.chainId === 1) {
    try {
      await ctx.main.call({ from: addr, to: tx.to, data: tx.data, value: tx.value });
    } catch (e) {
      return { status: 'failed', chain: drop.chain, note: `Mô phỏng thất bại: ${explain(e)}` };
    }
  }

  const raw = await sign(w.wallet, ctx, { nonce, to: tx.to, data: tx.data, value: tx.value, gas });
  let hash;
  try {
    hash = await broadcast(ctx, raw);
  } catch (e) {
    return { status: 'failed', chain: drop.chain, note: explain(e) };
  }
  mark('sent');
  onEvent?.({ type: 'sent', hash, text: `🚀 ${label}: đã gửi sau ${T.sent}ms\n${ctx.txUrl(hash)}` });

  const rc = await ctx.main.waitForTransaction(hash, 1, RECEIPT_MS).catch(() => null);
  mark('mined');
  const timing = `OpenSea ${T.build}ms → gửi ${T.sent}ms → xác nhận ${T.mined}ms`;
  if (!rc) return { status: 'failed', chain: drop.chain, hash, note: `Chưa thấy xác nhận sau 3 phút (${timing})` };
  if (rc.status !== 1) return { status: 'failed', chain: drop.chain, hash, note: `Giao dịch revert on-chain (${timing})` };
  return { status: 'done', chain: drop.chain, hash, note: `${fn} x${qty}, phí ${fmt(rc.gasUsed * (rc.gasPrice ?? 0n))}\n   ⏱ ${timing}` };
}

// ---------------------------------------------------------------- GTD / WL

/**
 * buildMint(minter, qty) -> { tx } | { status, error } : goi OpenSea dung giao dich co chu ky.
 */
export async function mintSigned(ctx, { w, nft, qty, price, startTime, endTime, settings, dry, onEvent, shouldStop, buildMint }) {
  const label = `${w.name} ${w.address.slice(0, 6)}`;
  const addr = w.address;
  const [balance, nonce0] = await Promise.all([
    ctx.main.getBalance(addr),
    ctx.main.getTransactionCount(addr, 'pending'),
  ]);
  const value0 = BigInt(price) * BigInt(qty);
  const gasLimit = 250_000n + 40_000n * BigInt(qty);
  let gas;
  try {
    gas = await planGas(ctx, { bump: settings.gasBump ?? 2, gasLimit, value: value0, balance });
  } catch (e) {
    return { status: 'failed', note: `${e.message}: có ${fmt(balance)} ${ctx.coin}, cần > ${fmt(value0)} + gas` };
  }
  if (overMax(settings, gas.expectedCost)) {
    return { status: 'skipped', note: `~${fmt(gas.expectedCost)} ${ctx.coin} vượt /max ${settings.max}` };
  }

  const startMs = Date.parse(startTime);
  const summary = `x${qty}, giá ${fmt(value0)} ${ctx.coin}, số dư ${fmt(balance)}, tip x${settings.gasBump ?? 2}, ${ctx.providers.length} RPC`;
  if (dry && Date.now() < startMs) {
    return { status: 'dry', note: `✅ Đủ tiền (${summary}). Quyền GTD/WL chỉ kiểm tra được khi stage mở` };
  }
  if (!dry) onEvent?.({ type: 'ready', text: `🔫 ${label}: sẵn sàng ${summary}, đang hỏi chữ ký OpenSea tới khi mở` });

  // ---- hoi OpenSea toi khi co giao dich ----
  const deadline = Math.min(Date.parse(endTime) || Infinity, startMs + GIVE_UP_MS);
  let built;
  let lastErr = '';
  for (;;) {
    if (shouldStop?.()) return { status: 'failed', note: 'Đã hủy' };
    built = await buildMint(addr, qty).catch((e) => ({ status: 0, error: e.message }));
    if (built.tx) break;
    lastErr = built.error;
    const retry = built.status === 409 || built.status === 429 || built.status === 0 || built.status >= 500;
    // Truoc gio mo (va 20s dau): OpenSea tra loi theo GIAI DOAN DANG MO (vd GTD truoc FCFS),
    // "not eligible" luc nay khong phai cua giai doan minh hen -> hoi tiep
    const beforeOurStage = Date.now() < startMs + 20_000;
    if (!retry && !beforeOurStage) return { status: 'failed', note: `OpenSea: ${lastErr}` };
    if (Date.now() > deadline) return { status: 'failed', note: `Hết giờ chờ: ${lastErr}` };
    // Xa gio mo: 2s/lan. Quanh gio mo (-5s..+15s): 250ms/lan. Sau do 1s/lan. Giu duoi rate limit OpenSea
    const t = Date.now();
    const gap = t < startMs - FAST_WINDOW_MS ? SLOW_PROBE_MS : t < startMs + 15_000 ? 250 : 1000;
    await sleep(Math.max(5, Math.min(gap, t < startMs - FAST_WINDOW_MS ? startMs - FAST_WINDOW_MS - t : gap)));
  }

  // ---- khong tin mu: kiem tra calldata truoc khi ky ----
  const tx = built.tx;
  try {
    verifyOpenSeaTx(tx, { nftContract: nft, minter: addr, quantity: qty });
  } catch (e) {
    return { status: 'failed', note: e.message };
  }
  if (tx.value > value0 && overMax(settings, tx.value + gas.gasLimit * gas.maxPrio)) {
    return { status: 'skipped', note: `Giá thật ${fmt(tx.value)} vượt /max ${settings.max}` };
  }

  // Ethereum gas dat: mo phong truoc cho chac. L2 re: bo qua de nhanh hon
  if (dry || ctx.chainId === 1) {
    try {
      await ctx.main.call({ from: addr, to: tx.to, data: tx.data, value: tx.value });
    } catch (e) {
      return { status: 'failed', note: `Mô phỏng thất bại: ${explain(e)}` };
    }
    if (dry) return { status: 'dry', note: `✅ Ví CÓ QUYỀN, mô phỏng OK (${summary})` };
  }

  try {
    const raw = await sign(w.wallet, ctx, { nonce: nonce0, to: tx.to, data: tx.data, value: tx.value, gas });
    return await sendAndWait(ctx, raw, { onEvent, label });
  } catch (e) {
    if (/nonce/i.test(e.message || '')) {
      const n = await ctx.main.getTransactionCount(addr, 'pending');
      const raw = await sign(w.wallet, ctx, { nonce: n, to: tx.to, data: tx.data, value: tx.value, gas });
      return sendAndWait(ctx, raw, { onEvent, label });
    }
    return { status: 'failed', note: explain(e) };
  }
}
