/**
 * Giao dien web chay local.
 *
 *   node server.js
 *   -> mo http://127.0.0.1:8787
 *
 * CHI lang nghe tren 127.0.0.1, khong mo ra mang LAN.
 * Mat khau keystore chi ton tai trong RAM cua tien trinh, khong ghi ra dia.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { CHAINS, resolveChain } from './chains.js';
import { loadWalletFromDir, hasKeystore } from './keystore.js';
import { mintWithWallet, mintSeaDropWithWallet } from './core.js';
import {
  getSeaDrop,
  getPublicDropSummary,
  getMintStats,
  DEFAULT_SEADROP_ADDRESS,
  DEFAULT_FEE_RECIPIENT,
  SEADROP_ABI,
  TOKEN_ABI,
} from './seadrop.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = '127.0.0.1';
const WALLETS_DIR = process.env.WALLETS_DIR || './wallets';
const RPC_TIMEOUT_MS = parseInt(process.env.RPC_TIMEOUT_MS || '15000', 10);
const STATE_FILE = path.join(WALLETS_DIR, '_state.json');

// ---------- tien ich ----------

function makeProvider(chainKey, custom = {}) {
  const env = chainKey === '__custom__' ? custom : { CHAIN: chainKey };
  const { chainId, rpc, explorer } = resolveChain(env);
  // Timeout ro rang: RPC chet thi bao loi, khong de giao dien treo vo han
  const req = new ethers.FetchRequest(rpc);
  req.timeout = RPC_TIMEOUT_MS;
  req.retryFunc = async () => false;

  // staticNetwork: khong de ethers tu do network ngam roi nem loi khong ai bat
  const provider = new ethers.JsonRpcProvider(
    req,
    { chainId, name: `chain-${chainId}` },
    { staticNetwork: true }
  );
  return { provider, chainId, explorer: explorer || '' };
}

/** Chan mot promise treo qua lau, doi thanh loi doc duoc */
function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      timer = setTimeout(
        () => rej(new Error(`${what} qua ${Math.round(ms / 1000)}s khong phan hoi. Kiem tra RPC va mang.`)),
        ms
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Tao provider, chay fn, roi dong lai du thanh cong hay that bai */
async function withProvider(chainKey, custom, fn) {
  const ctx = makeProvider(chainKey, custom);
  try {
    return await fn(ctx);
  } finally {
    try { ctx.provider.destroy(); } catch { /* bo qua */ }
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { done: {} };
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(WALLETS_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    /* bo qua */
  }
}

function listWalletDirs() {
  if (!fs.existsSync(WALLETS_DIR)) return [];
  return fs
    .readdirSync(WALLETS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

async function loadWallets(password) {
  const out = [];
  for (const name of listWalletDirs()) {
    const dir = path.join(WALLETS_DIR, name);
    try {
      const loaded = await loadWalletFromDir(dir, password);
      if (!loaded) continue;
      out.push({
        name,
        dir,
        key: loaded.wallet.privateKey,
        address: loaded.wallet.address,
        encrypted: loaded.source === 'keystore',
      });
    } catch (err) {
      const raw = err.message || '';
      const friendly = /incorrect password/i.test(raw)
        ? 'Sai mat khau keystore'
        : raw.split('(')[0].trim() || 'Khong doc duoc vi';
      out.push({ name, dir, error: friendly });
    }
  }
  return out;
}

async function tryCall(provider, address, abi, fn, args = []) {
  try {
    return await new ethers.Contract(address, abi, provider)[fn](...args);
  } catch {
    return null;
  }
}

// ---------- xu ly API ----------

async function apiChains() {
  return Object.entries(CHAINS).map(([key, v]) => ({ key, chainId: v.chainId, rpc: v.rpc }));
}

async function apiProbe(body) {
  const { chain, contract, custom } = body;
  if (!ethers.isAddress(contract)) throw new Error('Dia chi contract khong hop le');

  return withProvider(chain, custom, async ({ provider, chainId, explorer }) => {
  const addr = ethers.getAddress(contract);
  const res = { address: addr, chainId, explorer, checks: [] };

  const code = await provider.getCode(addr);
  if (!code || code === '0x') {
    res.checks.push({ ok: false, label: 'Contract', detail: 'Khong co contract tai dia chi nay' });
    res.mode = null;
    res.reason = 'Dia chi khong phai contract tren chain nay. Kiem tra lai dia chi va chain.';
    return res;
  }
  res.checks.push({ ok: true, label: 'Contract', detail: `${(code.length - 2) / 2} byte bytecode` });

  const erc721 = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function totalSupply() view returns (uint256)',
    'function supportsInterface(bytes4) view returns (bool)',
  ];
  const name = await tryCall(provider, addr, erc721, 'name');
  const symbol = await tryCall(provider, addr, erc721, 'symbol');
  const total = await tryCall(provider, addr, erc721, 'totalSupply');
  res.name = name || null;
  res.symbol = symbol || null;
  res.checks.push({
    ok: Boolean(name),
    label: 'Ten bo suu tap',
    detail: name ? `${name}${symbol ? ` (${symbol})` : ''}` : 'name() khong doc duoc',
  });
  if (total !== null) res.checks.push({ ok: true, label: 'Da mint', detail: String(total) });

  const stats = await getMintStats({
    nftContract: addr,
    provider,
    address: '0x000000000000000000000000000000000000dEaD',
  });
  res.checks.push({
    ok: Boolean(stats),
    label: 'getMintStats()',
    detail: stats ? `co - toi da ${stats.maxSupply}` : 'khong co (dau hieu khong phai SeaDrop)',
  });

  const sdAddr = DEFAULT_SEADROP_ADDRESS;
  const sdCode = await provider.getCode(sdAddr);
  if (!sdCode || sdCode === '0x') {
    res.checks.push({ ok: false, label: 'SeaDrop', detail: `khong ton tai tai ${sdAddr}` });
    res.mode = 'calldata';
    res.reason = 'Chain nay khong co contract SeaDrop chuan cua OpenSea.';
    return res;
  }
  res.checks.push({ ok: true, label: 'SeaDrop', detail: 'ton tai tren chain nay' });

  const drop = await tryCall(provider, sdAddr, SEADROP_ABI, 'getPublicDrop', [addr]);
  if (!drop) {
    res.checks.push({ ok: false, label: 'getPublicDrop()', detail: 'that bai cho contract nay' });
    res.mode = 'calldata';
    res.reason = 'Contract khong dang ky voi SeaDrop chuan.';
    return res;
  }

  const price = BigInt(drop.mintPrice);
  const block = await provider.getBlock('latest');
  const now = BigInt(block.timestamp);
  const startTime = BigInt(drop.startTime);
  const endTime = BigInt(drop.endTime);

  res.drop = {
    mintPriceWei: price.toString(),
    mintPrice: ethers.formatEther(price),
    maxPerWallet: String(drop.maxTotalMintableByWallet),
    startTime: String(startTime),
    endTime: String(endTime),
    isOpen: now >= startTime && (endTime === 0n || now <= endTime),
    notStarted: now < startTime,
  };

  res.checks.push({
    ok: price > 0n,
    label: 'Gia mint',
    detail: price > 0n ? `${ethers.formatEther(price)} (coin native)` : '0 - khong tra bang coin native',
  });
  res.checks.push({
    ok: res.drop.isOpen,
    label: 'Trang thai',
    detail: res.drop.isOpen ? 'dang mo' : res.drop.notStarted ? 'chua mo' : 'da dong',
  });

  if (price === 0n) {
    res.mode = 'calldata';
    res.reason = 'Gia native bang 0, nhieu kha nang mint tra bang ERC-20 (vi du USDG).';
  } else {
    res.mode = 'seadrop';
    res.reason = 'Contract dung SeaDrop chuan va tra bang coin native.';
  }
  return res;
  });
}

async function apiWallets(body) {
  const { chain, password, custom } = body;
  return withProvider(chain, custom, async ({ provider, explorer }) => {
  const wallets = await loadWallets(password);
  const state = readState();

  const out = [];
  for (const w of wallets) {
    if (w.error) {
      out.push({ name: w.name, error: w.error });
      continue;
    }
    let balance = null;
    try {
      balance = ethers.formatEther(await provider.getBalance(w.address));
    } catch {
      /* bo qua */
    }
    out.push({
      name: w.name,
      address: w.address,
      encrypted: w.encrypted,
      balance,
      done: Boolean(state.done?.[w.name]),
    });
  }
  return { wallets: out, explorer, walletsDir: path.resolve(WALLETS_DIR) };
  });
}

/** Chay mint, day log ra client theo dang NDJSON */
async function apiRun(body, send) {
  const { chain, custom, password, mode, dryRun, quantity, params = {}, skipDone = true } = body;

  return withProvider(chain, custom, async ({ provider, explorer }) => {
  const wallets = (await loadWallets(password)).filter((w) => !w.error);
  if (wallets.length === 0) throw new Error('Khong nap duoc vi nao. Kiem tra mat khau va thu muc wallets/.');

  const state = readState();
  const targets = skipDone && !dryRun ? wallets.filter((w) => !state.done?.[w.name]) : wallets;

  send({ type: 'start', total: targets.length, dryRun: Boolean(dryRun) });
  if (targets.length === 0) {
    send({ type: 'log', text: 'Tat ca vi da xong o lan chay truoc. Bo chon "Bo qua vi da xong" de chay lai.' });
    send({ type: 'done', results: [] });
    return;
  }

  let seaDrop = null;
  let summary = null;
  if (mode === 'seadrop') {
    seaDrop = getSeaDrop(provider, DEFAULT_SEADROP_ADDRESS);
    summary = await getPublicDropSummary({ seaDrop, nftContract: params.nftContract, provider });
    send({
      type: 'log',
      text: `Gia mint ${ethers.formatEther(summary.mintPrice)} | gioi han/vi ${summary.maxPerWallet} | ${summary.isOpen ? 'dang mo' : 'chua mo/da dong'}`,
    });
    if (!summary.isOpen) throw new Error('Stage chua mo hoac da dong.');
  }

  const results = [];
  for (let i = 0; i < targets.length; i++) {
    const w = targets[i];
    send({ type: 'wallet', index: i + 1, total: targets.length, name: w.name, address: w.address });
    const log = (text) => send({ type: 'log', text, wallet: w.name });

    let res;
    if (mode === 'seadrop') {
      res = await mintSeaDropWithWallet({
        privateKey: w.key,
        provider,
        seaDrop,
        nftContract: params.nftContract,
        feeRecipient: params.feeRecipient || DEFAULT_FEE_RECIPIENT,
        summary,
        desiredQuantity: quantity || 1,
        dryRun,
        explorer,
        log,
      });
    } else {
      res = await mintWithWallet({
        privateKey: w.key,
        provider,
        contract: params.contract,
        calldata: params.calldata,
        originalMinter: params.originalMinter || '',
        valueWei: ethers.parseEther(String(params.valueEth || '0')),
        loops: quantity || 1,
        delayMs: 2000,
        jitterMs: 3000,
        dryRun,
        payToken: params.payToken || '',
        explorer,
        log,
      });
    }

    results.push({ name: w.name, ...res });
    send({ type: 'result', name: w.name, result: res });

    if (!dryRun && !res.error && res.failed === 0) {
      state.done = state.done || {};
      state.done[w.name] = { at: new Date().toISOString(), confirmed: res.confirmed };
      writeState(state);
    }

    if (i < targets.length - 1 && !dryRun) {
      const wait = 5000 + Math.floor(Math.random() * 10000);
      send({ type: 'log', text: `Nghi ${Math.round(wait / 1000)}s truoc khi sang vi tiep theo` });
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  send({ type: 'done', results });
  });
}

async function apiResetState() {
  writeState({ done: {} });
  return { ok: true };
}

// ---------- HTTP ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2_000_000) reject(new Error('Body qua lon'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error('JSON khong hop le'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (req.method === 'GET' && url.pathname === '/api/chains') {
      const data = await apiChains();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    }

    if (req.method === 'POST' && url.pathname === '/api/run') {
      const body = await readBody(req);
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      });
      const send = (obj) => res.write(JSON.stringify(obj) + '\n');
      try {
        await apiRun(body, send);
      } catch (err) {
        send({ type: 'error', message: err.shortMessage || err.message });
      }
      return res.end();
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      let data;
      if (url.pathname === '/api/probe') data = await withTimeout(apiProbe(body), RPC_TIMEOUT_MS + 5000, 'Kiem tra contract');
      else if (url.pathname === '/api/wallets') data = await withTimeout(apiWallets(body), RPC_TIMEOUT_MS + 5000, 'Nap vi');
      else if (url.pathname === '/api/reset-state') data = await apiResetState();
      else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Khong tim thay' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Khong tim thay');
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.shortMessage || err.message }));
  }
});

// Loi nen ghi vao log chu khong duoc giet server dang chay dang do
process.on('uncaughtException', (e) => console.error('[canh bao]', e?.message || e));
process.on('unhandledRejection', (e) => console.error('[canh bao]', e?.message || e));

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Bot-Mint dang chay');
  console.log(`  Mo trinh duyet: http://${HOST}:${PORT}`);
  console.log('');
  console.log(`  Thu muc vi : ${path.resolve(WALLETS_DIR)}`);
  console.log('  Chi lang nghe tren 127.0.0.1, khong mo ra mang LAN.');
  console.log('  Ctrl+C de dung.');
  console.log('');
});
