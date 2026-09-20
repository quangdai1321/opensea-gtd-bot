/**
 * Chain theo ten cua OpenSea -> chainId, danh sach RPC, explorer.
 * Nhieu RPC: doc tu cai dau, GUI ra tat ca cung luc (cung nonce nen chain tu khu trung).
 * Them RPC rieng (nhanh hon, khong bi rate limit): RPC_<CHAIN>=url1,url2 trong .env, dung truoc RPC cong khai.
 */

import { ethers } from 'ethers';

export const CHAINS = {
  ethereum: { chainId: 1, coin: 'ETH', explorer: 'https://etherscan.io', rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'] },
  base: { chainId: 8453, coin: 'ETH', explorer: 'https://basescan.org', rpcs: ['https://mainnet.base.org', 'https://base.drpc.org', 'https://base-rpc.publicnode.com'] },
  robinhood: { chainId: 4663, coin: 'ETH', explorer: 'https://robinhoodchain.blockscout.com', rpcs: ['https://robinhood.drpc.org', 'https://rpc.mainnet.chain.robinhood.com'] },
  arbitrum: { chainId: 42161, coin: 'ETH', explorer: 'https://arbiscan.io', rpcs: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum.drpc.org'] },
  optimism: { chainId: 10, coin: 'ETH', explorer: 'https://optimistic.etherscan.io', rpcs: ['https://mainnet.optimism.io', 'https://optimism.drpc.org'] },
  zora: { chainId: 7777777, coin: 'ETH', explorer: 'https://explorer.zora.energy', rpcs: ['https://rpc.zora.energy'] },
  abstract: { chainId: 2741, coin: 'ETH', explorer: 'https://abscan.org', rpcs: ['https://api.mainnet.abs.xyz', 'https://abstract.drpc.org'] },
  soneium: { chainId: 1868, coin: 'ETH', explorer: 'https://soneium.blockscout.com', rpcs: ['https://rpc.soneium.org'] },
  unichain: { chainId: 130, coin: 'ETH', explorer: 'https://uniscan.xyz', rpcs: ['https://mainnet.unichain.org'] },
  shape: { chainId: 360, coin: 'ETH', explorer: 'https://shapescan.xyz', rpcs: ['https://mainnet.shape.network'] },
  ape_chain: { chainId: 33139, coin: 'APE', explorer: 'https://apescan.io', rpcs: ['https://rpc.apechain.com', 'https://apechain.drpc.org'] },
  avalanche: { chainId: 43114, coin: 'AVAX', explorer: 'https://snowtrace.io', rpcs: ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche.drpc.org'] },
  bera_chain: { chainId: 80094, coin: 'BERA', explorer: 'https://berascan.com', rpcs: ['https://rpc.berachain.com'] },
  polygon: { chainId: 137, coin: 'POL', explorer: 'https://polygonscan.com', rpcs: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org'] },
};

const HTTP_TIMEOUT_MS = 10_000;
const cache = new Map();

/** { name, chainId, coin, explorer, urls, providers, main } - tai dung giua cac lan goi */
export function chainCtx(name) {
  if (cache.has(name)) return cache.get(name);
  const preset = CHAINS[name];
  const own = (process.env[`RPC_${name.toUpperCase()}`] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const urls = [...new Set([...own, ...(preset?.rpcs || [])])];
  if (!preset && !process.env[`CHAINID_${name.toUpperCase()}`]) {
    throw new Error(`Chưa hỗ trợ chain "${name}". Thêm RPC_${name.toUpperCase()}=... và CHAINID_${name.toUpperCase()}=... vào .env`);
  }
  if (urls.length === 0) throw new Error(`Chưa có RPC cho chain "${name}"`);
  const chainId = preset?.chainId ?? Number(process.env[`CHAINID_${name.toUpperCase()}`]);
  const net = new ethers.Network(`chain-${chainId}`, chainId);

  const providers = urls.map((u) => {
    const req = new ethers.FetchRequest(u);
    req.timeout = HTTP_TIMEOUT_MS;
    req.retryFunc = async () => false; // tu retry lam lech nhip ban
    return new ethers.JsonRpcProvider(req, net, { staticNetwork: net, batchMaxCount: 1 });
  });
  const ctx = {
    name, chainId, urls, providers,
    main: providers[0],
    coin: preset?.coin || 'ETH',
    explorer: preset?.explorer || '',
    txUrl: (h) => (preset?.explorer ? `${preset.explorer}/tx/${h}` : h),
  };
  cache.set(name, ctx);
  return ctx;
}

/** Gui giao dich da ky ra TAT CA RPC cung luc. Tra hash neu it nhat 1 RPC nhan, nem loi neu tat ca tu choi */
export async function broadcast(ctx, raw, stats) {
  const hash = ethers.keccak256(raw);
  const res = await Promise.all(
    ctx.providers.map((p, i) => {
      const t = performance.now();
      const done = (err) => {
        stats?.push({ url: ctx.urls?.[i] ?? String(i), ms: performance.now() - t, ok: !err, err: err?.shortMessage || err?.message });
        return err;
      };
      return p.send('eth_sendRawTransaction', [raw]).then(() => done(null), (e) => done(e));
    }),
  );
  const errs = res.filter(Boolean);
  // "already known" / "nonce too low" tu RPC cham = RPC khac da nhan truoc -> van tinh la thanh cong
  const accepted = errs.length < res.length || errs.some((e) => /already known|known transaction|nonce too low/i.test(e.message || ''));
  if (!accepted) throw errs[0];
  return hash;
}

/**
 * baseFee + tip cua mang: 2 lenh RPC tho chay song song
 * (getFeeData cua ethers goi tuan tu nhieu lan hon, cham hon)
 */
export async function gasMarket(ctx) {
  const [blk, tip] = await Promise.all([
    ctx.main.send('eth_getBlockByNumber', ['latest', false]),
    ctx.main.send('eth_maxPriorityFeePerGas', []).catch(() => null),
  ]);
  return {
    blk: { baseFeePerGas: blk?.baseFeePerGas ? BigInt(blk.baseFeePerGas) : null, timestamp: Number(blk?.timestamp ?? 0) },
    fee: { maxPriorityFeePerGas: tip ? BigInt(tip) : null, gasPrice: null },
  };
}

/**
 * Ke hoach gas: tip = tip mang x bump; tran = baseFee x mult + tip.
 * Tu ha mult cho vua so du (node tu choi neu so du < gasLimit x tran + value), giu 15% du phong.
 */
export async function planGas(ctx, { bump = 2, baseMult = 20n, gasLimit, value, balance, market }) {
  const { blk, fee } = market || (await gasMarket(ctx));
  const baseFee = blk?.baseFeePerGas ?? fee.gasPrice ?? 1_000_000_000n;
  let prio = fee.maxPriorityFeePerGas ?? 0n;
  if (prio === 0n) prio = baseFee / 10n || 100_000_000n;
  const maxPrio = (prio * BigInt(Math.round(bump * 100))) / 100n;

  const budgetPerGas = (((balance - value) * 85n) / 100n) / gasLimit;
  const fit = budgetPerGas > maxPrio && baseFee > 0n ? (budgetPerGas - maxPrio) / baseFee : 0n;
  const mult = fit < baseMult ? fit : baseMult;
  if (mult < 2n) throw new Error('Số dư không đủ trả tiền mint + gas');
  const maxFee = baseFee * mult + maxPrio;
  return {
    maxFee, maxPrio, gasLimit, mult,
    // Chi phi thuc te uoc tinh (baseFee co the tang gap doi) - dung de so voi /max
    expectedCost: value + gasLimit * (baseFee * 2n + maxPrio),
  };
}
