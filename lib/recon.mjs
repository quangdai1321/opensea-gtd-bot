/**
 * Soi mot drop tren chain: hang da di bao nhieu, di qua duong nao, ai gom.
 *
 * Dung chung cho recon.mjs (dong lenh) va lenh /soi tren Telegram.
 * Tra ve du lieu tho, khong in gi - phan trinh bay de cho noi goi.
 *
 * Hai cau hoi no tra loi:
 *   - Public CHUA mo  -> toi gio mo con lai khoang bao nhieu cai (co dang thuc canh khong)
 *   - Public DA mo    -> block mo bay bao nhieu, vao tay vi thuong hay contract gom nhieu vi
 */

import { ethers } from 'ethers';
import { readPublicDrop } from './seadrop.mjs';

const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const ZERO32 = '0x' + '0'.repeat(64);
const MAX_LOG_REQ = 400;   // RPC nao bat chia vun hon the thi bo, sang RPC khac
const RATE_WINDOW_MIN = 30; // do nhip tieu thu bang bao nhieu phut gan nhat

const TOKEN_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function maxSupply() view returns (uint256)',
];

const hex = (n) => '0x' + n.toString(16);

/** Provider rieng: timeout dai, vi quet log ca doi contract lau hon mot lenh mint */
function slowProvider(ctx, url, timeoutMs = 90_000) {
  const req = new ethers.FetchRequest(url);
  req.timeout = timeoutMs;
  const net = new ethers.Network(`chain-${ctx.chainId}`, ctx.chainId);
  return new ethers.JsonRpcProvider(req, net, { staticNetwork: net, batchMaxCount: 1 });
}

/**
 * Block dau tien contract da ton tai (nhi phan tren getCode).
 * Quet log tu day thay vi tu block 0: tren chain 67 trieu block thi day la khac biet
 * giua vai chuc lan goi va vai nghin lan goi.
 * Node cat bot lich su (khong tra loi getCode o block cu) -> tra ve 0, quet ca dai.
 */
export async function deployBlock(p, address, latest) {
  try {
    if ((await p.getCode(address, 0)) !== '0x') return 0;
  } catch {
    return 0; // node khong giu lich su xa -> chiu, quet tu dau
  }
  let lo = 0;
  let hi = latest;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    let code;
    for (let tries = 0; ; tries++) {
      try {
        code = await p.getCode(address, mid);
        break;
      } catch {
        if (tries >= 2) return 0; // RPC chap chon -> thoi, quet ca dai cho chac
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    if (code === '0x') lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Toan bo log cua contract, thu lan luot tung RPC.
 * Voi moi RPC: hoi ca doi truoc; neu no gioi han do rong khoang (goi free cua drpc
 * chi cho 10k block) thi chia doan va di TUAN TU, doan nao bi tu choi thi thu hep lai.
 * Khong chia doi de quy roi Promise.all: gap dai vai chuc trieu block, cach do de ra
 * hang nghin ket noi cung luc va lam nghen may (ENOBUFS).
 */
export async function allLogs(ctx, address, latest, onProgress) {
  let lastErr = new Error('khong co RPC nao dung duoc');
  const start = await deployBlock(ctx.main, address, latest).catch(() => 0);
  for (const url of ctx.urls) {
    const p = slowProvider(ctx, url);
    const get = (from, to) => p.send('eth_getLogs', [{ address, fromBlock: hex(from), toBlock: hex(to) }]);
    try {
      return await get(start, latest);
    } catch (e) {
      lastErr = e;
    }
    try {
      const out = [];
      let step = 5_000_000;
      let from = start;
      let reqs = 0;
      while (from <= latest) {
        if (++reqs > MAX_LOG_REQ) throw new Error(`can hon ${MAX_LOG_REQ} lan goi`);
        const to = Math.min(latest, from + step - 1);
        let chunk;
        try {
          chunk = await get(from, to);
        } catch (e) {
          lastErr = e;
          if (step <= 10_000) throw e;
          step = Math.floor(step / 4);
          continue;
        }
        out.push(...chunk);
        from = to + 1;
        onProgress?.(from - start, latest - start); // % tinh tu block deploy, khong tu block 0
      }
      return out;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** Vi tri block dau tien co timestamp >= ts trong danh sach block da sap xep (-1 = khong co) */
async function indexAtOrAfter(p, blocks, ts) {
  const cache = new Map();
  const at = async (i) => {
    if (!cache.has(i)) cache.set(i, Number((await p.getBlock(blocks[i])).timestamp));
    return cache.get(i);
  };
  let lo = 0;
  let hi = blocks.length - 1;
  if ((await at(hi)) < ts) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((await at(mid)) >= ts) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Giay moi block, do bang 2 diem cach nhau span block */
async function blockTime(p, latest, span = 2000) {
  const from = Math.max(1, latest - span);
  const [a, b] = await Promise.all([p.getBlock(from), p.getBlock(latest)]);
  return (Number(b.timestamp) - Number(a.timestamp)) / (latest - from);
}

/**
 * Du bao so hang con lai vao luc public mo, theo nhip tieu thu gan nhat.
 * Tach rieng khoi analyze() de kiem chung duoc bang so, khong can drop that dang chay.
 * perMin = 0 (khong ai mint trong cua so do) -> coi nhu dung yen, giu nguyen so con lai.
 */
export function forecastLeft({ left, minsToOpen, recent, windowMin = RATE_WINDOW_MIN }) {
  const perMin = recent / windowMin;
  return {
    left, minsToOpen, windowMin, recent, perMin,
    forecast: perMin > 0 ? Math.max(0, left - perMin * minsToOpen) : left,
  };
}

/** [gia tri, so lan] sap xep giam dan */
function tally(list, key) {
  const m = new Map();
  for (const x of list) {
    const k = key(x);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * @param {object} ctx  chainCtx(chain)
 * @param {string} nft  dia chi contract NFT
 * @param {{ onProgress?: (done:number, all:number)=>void, topN?: number }} opts
 */
export async function analyze(ctx, nft, { onProgress, topN = 5 } = {}) {
  const p = ctx.main;
  const token = new ethers.Contract(nft, TOKEN_ABI, p);
  const latest = await p.getBlockNumber();

  const [name, symbol, supply, max] = await Promise.all(
    ['name', 'symbol', 'totalSupply', 'maxSupply'].map((f) => token[f]().catch(() => null)),
  );
  const secPerBlock = await blockTime(p, latest).catch(() => null);
  const drop = await readPublicDrop(p, nft).catch(() => null);

  const out = {
    address: nft, chain: ctx.name, chainId: ctx.chainId, coin: ctx.coin, latest,
    name, symbol, supply, max, secPerBlock,
    drop: drop?.startTime ? drop : null,
    mints: 0, upcoming: null, opening: null,
  };

  const logs = await allLogs(ctx, nft, latest, onProgress);
  const mints = logs
    .filter((l) => l.topics[0] === TRANSFER && l.topics[1] === ZERO32)
    .map((l) => ({
      block: parseInt(l.blockNumber, 16),
      tx: l.transactionHash,
      to: ethers.getAddress('0x' + l.topics[2].slice(26)),
    }))
    .sort((a, b) => a.block - b.block);
  out.mints = mints.length;
  if (mints.length === 0) return out;

  // tx -> so vi nhan khac nhau. >1 = mot giao dich rai NFT ra nhieu vi (contract gom)
  const recipientsPerTx = new Map();
  for (const m of mints) {
    if (!recipientsPerTx.has(m.tx)) recipientsPerTx.set(m.tx, new Set());
    recipientsPerTx.get(m.tx).add(m.to);
  }

  const blocks = [...new Set(mints.map((m) => m.block))];
  const [fb, lb] = await Promise.all([p.getBlock(blocks[0]), p.getBlock(blocks[blocks.length - 1])]);
  Object.assign(out, {
    firstBlock: blocks[0],
    lastBlock: blocks[blocks.length - 1],
    firstTs: Number(fb.timestamp),
    lastTs: Number(lb.timestamp),
    durationMin: (Number(lb.timestamp) - Number(fb.timestamp)) / 60,
    blockCount: blocks.length,
    txCount: recipientsPerTx.size,
    walletCount: new Set(mints.map((m) => m.to)).size,
  });

  // Public CHUA mo -> du bao con bao nhieu cho toi luc mo
  const now = Math.floor(Date.now() / 1000);
  if (out.drop && out.drop.startTime > now && supply != null && max != null) {
    const cut = await indexAtOrAfter(p, blocks, now - RATE_WINDOW_MIN * 60);
    out.upcoming = forecastLeft({
      left: Number(max - supply),
      minsToOpen: (out.drop.startTime - now) / 60,
      recent: cut < 0 ? 0 : mints.filter((m) => m.block >= blocks[cut]).length,
    });
    return out;
  }

  // Public DA mo -> hang di truoc gio mo, va hang di ngay block mo
  if (out.drop) {
    const idx = await indexAtOrAfter(p, blocks, out.drop.startTime);
    if (idx < 0) {
      out.opening = { soldOutBeforeOpen: true, before: mints.length };
    } else {
      const openBlock = blocks[idx];
      const list = mints.filter((m) => m.block === openBlock);
      const batched = list.filter((m) => recipientsPerTx.get(m.tx).size > 1).length;
      out.opening = {
        soldOutBeforeOpen: false,
        openBlock,
        before: mints.filter((m) => m.block < openBlock).length,
        count: list.length,
        batched,
        pct: Math.round((batched / list.length) * 100),
        after: mints.filter((m) => m.block > openBlock).length,
      };
    }
  }

  out.topBlocks = tally(mints, (m) => m.block).slice(0, topN);
  out.topRecipients = tally(mints, (m) => m.to).slice(0, topN + 3);
  out.topTxs = [];
  for (const [h, n] of tally(mints, (m) => m.tx).slice(0, topN)) {
    const [tx, rc] = await Promise.all([p.getTransaction(h), p.getTransactionReceipt(h)]);
    out.topTxs.push({
      hash: h, count: n,
      recipients: recipientsPerTx.get(h).size,
      from: tx?.from, to: tx?.to, block: rc?.blockNumber,
      gasUsed: rc?.gasUsed ?? null,
      gwei: rc?.gasPrice ? Number(ethers.formatUnits(rc.gasPrice, 'gwei')) : null,
      tipGwei: tx?.maxPriorityFeePerGas ? Number(ethers.formatUnits(tx.maxPriorityFeePerGas, 'gwei')) : null,
      paid: rc ? rc.gasUsed * (rc.gasPrice ?? 0n) : null,
    });
  }
  return out;
}
