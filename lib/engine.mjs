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
import { broadcast, planGas } from './chains.mjs';
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
const SIGNED_LEAD_MS = 3000;   // bat dau hoi OpenSea truoc gio mo

/** Cho toi moc gio (ms, gio may), ngu dai roi ngu ngan cho chinh xac */
async function waitUntil(t, shouldStop) {
  while (Date.now() < t) {
    if (shouldStop?.()) return false;
    await sleep(Math.min(1000, Math.max(5, t - Date.now() - 5)));
  }
  return true;
}

async function sendAndWait(ctx, raw, { onEvent, label }) {
  const hash = await broadcast(ctx, raw);
  onEvent?.({ type: 'sent', hash, text: `🚀 ${label}: đã gửi ra ${ctx.providers.length} RPC\n${ctx.txUrl(hash)}` });
  const rc = await ctx.main.waitForTransaction(hash, 1, RECEIPT_MS).catch(() => null);
  if (!rc) return { status: 'failed', hash, note: 'Chưa thấy xác nhận sau 3 phút, tự kiểm tra link' };
  if (rc.status !== 1) return { status: 'failed', hash, note: 'Giao dịch revert on-chain (hết suất / chậm chân?)' };
  return { status: 'done', hash, note: `block ${rc.blockNumber}, phí ${fmt(rc.gasUsed * (rc.gasPrice ?? 0n))}` };
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

// ---------------------------------------------------------------- public

export async function mintPublic(ctx, { w, nft, qty, settings, dry, onEvent, shouldStop }) {
  const label = `${w.name} ${w.address.slice(0, 6)}`;
  const addr = w.address;

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
  const { quantity, reason } = resolveQuantity(qty, drop.maxPerWallet, stats);
  if (quantity === 0n) return { status: 'skipped', note: reason };

  const value = drop.mintPrice * quantity;
  const data = encodeMintPublic(nft, feeRecipient, quantity);
  const gasLimit = 150_000n + 40_000n * quantity;
  let gas;
  try {
    gas = await planGas(ctx, { bump: settings.gasBump ?? 2, gasLimit, value, balance });
  } catch (e) {
    return { status: 'failed', note: `${e.message}: có ${fmt(balance)} ${ctx.coin}, cần > ${fmt(value)} + gas` };
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
  onEvent?.({ type: 'ready', text: `🔫 ${label}: đã ký sẵn ${summary}` });

  // ---- cho toi cua so tranh ----
  const openAt = drop.startTime * 1000 + Math.max(0, drift);
  if (!open) {
    const ok = await waitUntil(openAt - RACE_WINDOW_MS, shouldStop);
    if (!ok) return { status: 'failed', note: 'Đã hủy' };

    // ---- do chong lan: eth_call lien tuc, khong cho lenh truoc ----
    let lastErr = '';
    const inflight = new Set();
    let i = 0;
    while (!open) {
      if (shouldStop?.()) return { status: 'failed', note: 'Đã hủy' };
      if (Date.now() > openAt + GIVE_UP_MS) return { status: 'failed', note: `Quá 3 phút vẫn không mint được: ${lastErr}` };
      if (inflight.size < MAX_INFLIGHT) {
        const p = ctx.providers[i++ % ctx.providers.length];
        const job = p.call(call).then(
          () => { open = true; },
          (e) => { lastErr = explain(e); },
        ).finally(() => inflight.delete(job));
        inflight.add(job);
      }
      // Loi khac "chua mo" (het hang, vuot gioi han...) -> dung, khong ban vo ich
      if (lastErr && !/chưa mở|timeout|rate|429|503|502/i.test(lastErr) && Date.now() > openAt) {
        return { status: 'failed', note: lastErr };
      }
      await sleep(PROBE_MS);
    }
  }

  // ---- ban ----
  try {
    return await sendAndWait(ctx, raw, { onEvent, label });
  } catch (e) {
    // Nonce lech (vi vua co giao dich khac) -> ky lai 1 lan voi nonce moi
    if (/nonce/i.test(e.message || '')) {
      const n = await ctx.main.getTransactionCount(addr, 'pending');
      raw = await sign(w.wallet, ctx, { nonce: n, to: SEADROP_ADDRESS, data, value, gas });
      return sendAndWait(ctx, raw, { onEvent, label });
    }
    return { status: 'failed', note: explain(e) };
  }
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
  if (!dry) onEvent?.({ type: 'ready', text: `🔫 ${label}: sẵn sàng ${summary}, sẽ hỏi chữ ký OpenSea từ ${SIGNED_LEAD_MS / 1000}s trước giờ mở` });

  if (!(await waitUntil(startMs - SIGNED_LEAD_MS, shouldStop))) return { status: 'failed', note: 'Đã hủy' };

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
    if (!retry) return { status: 'failed', note: `OpenSea: ${lastErr}` };
    if (Date.now() > deadline) return { status: 'failed', note: `Hết giờ chờ: ${lastErr}` };
    // 30s dau hoi nhanh, sau do cham lai cho khoi bi rate limit
    await sleep(Date.now() < startMs + 30_000 ? 250 : 1000);
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
