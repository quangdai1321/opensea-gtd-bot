/**
 * Chuyen tien / NFT giua cac vi cua minh.
 *   fund      : vi quy gui cung 1 so tien cho moi vi phu (nonce lien tiep, gui 1 loat)
 *   withdraw  : moi vi phu gui het so du (tru gas) ve vi nhan
 *   NFT       : moi vi phu chuyen het NFT cua 1 collection ve vi nhan
 * Vi nhan do .env quyet dinh (WITHDRAW_TO hoac vi chinh), KHONG nhan dia chi tu Telegram.
 */

import { ethers } from 'ethers';
import { broadcast, gasMarket } from './chains.mjs';

const RECEIPT_MS = 3 * 60_000;
// Chain OP-stack tinh them phi L1 NGOAI gasLimit x gia -> de lai chut du phong khi rut het
const OP_STACK = new Set(['base', 'optimism', 'zora', 'soneium', 'unichain', 'shape']);
const OP_RESERVE = ethers.parseEther('0.00002');

const ERC721 = new ethers.Interface(['function safeTransferFrom(address from,address to,uint256 tokenId)']);

/** Phi hien tai: tran = baseFee x2 + tip (du cho vai block) */
export async function feeNow(ctx) {
  const { blk, fee } = await gasMarket(ctx);
  const base = blk.baseFeePerGas ?? 1_000_000_000n;
  const tip = fee.maxPriorityFeePerGas ?? (base / 10n || 1_000_000n);
  return { maxFee: base * 2n + tip, tip };
}

function signTx(wallet, ctx, { nonce, to, value = 0n, data = '0x', gasLimit, fee }) {
  return wallet.signTransaction({
    type: 2, chainId: ctx.chainId, nonce, to, value, data,
    gasLimit, maxFeePerGas: fee.maxFee, maxPriorityFeePerGas: fee.tip,
  });
}

async function waitAll(ctx, hashes) {
  return Promise.all(hashes.map((h) => ctx.main.waitForTransaction(h, 1, RECEIPT_MS).then(
    (rc) => (rc?.status === 1 ? 'ok' : rc ? 'revert' : 'timeout'),
    () => 'timeout',
  )));
}

// ---------------------------------------------------------------- fund

/** -> { gasLimit, fee, perTx, total, balance, enough } */
export async function planFund(ctx, from, targets, amount) {
  const [balance, fee, gas] = await Promise.all([
    ctx.main.getBalance(from),
    feeNow(ctx),
    ctx.main.estimateGas({ from, to: targets[0], value: amount }).catch(() => 100_000n), // vi quy thieu tien -> uoc luong rong tay
  ]);
  const gasLimit = (gas * 12n) / 10n;
  const perTx = amount + gasLimit * fee.maxFee;
  const total = perTx * BigInt(targets.length);
  return { gasLimit, fee, perTx, total, balance, enough: balance >= total };
}

/** Gui tu vi quy toi tung vi, nonce lien tiep, roi cho xac nhan. -> [{ to, hash, status }] */
export async function sendFund(ctx, fromWallet, targets, amount, plan) {
  let nonce = await ctx.main.getTransactionCount(fromWallet.address, 'pending');
  const sent = [];
  for (const to of targets) {
    const raw = await signTx(fromWallet, ctx, { nonce: nonce++, to, value: amount, gasLimit: plan.gasLimit, fee: plan.fee });
    try {
      sent.push({ to, hash: await broadcast(ctx, raw) });
    } catch (e) {
      sent.push({ to, error: e.shortMessage || e.message });
      break; // nonce sau se ket -> dung
    }
  }
  const ok = sent.filter((s) => s.hash);
  const st = await waitAll(ctx, ok.map((s) => s.hash));
  ok.forEach((s, i) => { s.status = st[i]; });
  return sent;
}

// ---------------------------------------------------------------- withdraw

/** Rut het so du cua 1 vi ve `to`. dry = chi tinh. -> { status, amount, hash?, note } */
export async function withdrawAll(ctx, w, to, { dry = false } = {}) {
  const [balance, fee] = await Promise.all([ctx.main.getBalance(w.address), feeNow(ctx)]);
  if (balance === 0n) return { status: 'skipped', amount: 0n, note: 'số dư 0' };
  const gas = await ctx.main.estimateGas({ from: w.address, to, value: 1n }).catch(() => 21_000n);
  const gasLimit = (gas * 12n) / 10n;
  const reserve = OP_STACK.has(ctx.name) ? OP_RESERVE : 0n;
  const amount = balance - gasLimit * fee.maxFee - reserve;
  if (amount <= 0n) return { status: 'skipped', amount: 0n, note: `số dư ${ethers.formatEther(balance)} không đủ trả gas` };
  if (dry) return { status: 'dry', amount };
  const nonce = await ctx.main.getTransactionCount(w.address, 'pending');
  const hash = await broadcast(ctx, await signTx(w.wallet, ctx, { nonce, to, value: amount, gasLimit, fee }));
  const [st] = await waitAll(ctx, [hash]);
  return { status: st === 'ok' ? 'done' : 'failed', amount, hash, note: st === 'ok' ? '' : st };
}

// ---------------------------------------------------------------- NFT

/** Token id cua 1 collection trong vi (OpenSea API). -> [{ id, contract, standard }] */
export async function nftsOf(opensea, chain, address, slug) {
  const out = [];
  let next = '';
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({ collection: slug, limit: '200' });
    if (next) q.set('next', next);
    const { status, data } = await opensea(`/api/v2/chain/${chain}/account/${address}/nfts?${q}`);
    if (status !== 200) throw new Error(`OpenSea: ${(data.errors || []).join('; ') || `HTTP ${status}`}`);
    for (const n of data.nfts || []) out.push({ id: n.identifier, contract: n.contract, standard: n.token_standard });
    next = data.next;
    if (!next) break;
  }
  return out;
}

/** Chuyen cac NFT ERC-721 tu vi w ve `to`. -> { done, failed, skipped, hashes } */
export async function transferNfts(ctx, w, to, nfts) {
  const list = nfts.filter((n) => n.standard === 'erc721');
  const skipped = nfts.length - list.length;
  if (list.length === 0) return { done: 0, failed: 0, skipped, hashes: [] };
  const fee = await feeNow(ctx);
  let nonce = await ctx.main.getTransactionCount(w.address, 'pending');
  const hashes = [];
  let failed = 0;
  for (const n of list) {
    const data = ERC721.encodeFunctionData('safeTransferFrom', [w.address, to, n.id]);
    try {
      const gas = await ctx.main.estimateGas({ from: w.address, to: n.contract, data });
      hashes.push(await broadcast(ctx, await signTx(w.wallet, ctx, { nonce: nonce++, to: n.contract, data, gasLimit: (gas * 12n) / 10n, fee })));
    } catch {
      failed++;
    }
  }
  const st = await waitAll(ctx, hashes);
  const done = st.filter((s) => s === 'ok').length;
  return { done, failed: failed + st.length - done, skipped, hashes };
}
