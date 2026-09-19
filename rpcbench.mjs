/**
 * Do toc do cac RPC cua 1 chain tu may nay (RPC rieng trong .env + RPC cong khai).
 *
 *   node rpcbench.mjs robinhood
 *
 * RPC rieng: them vao .env, vd RPC_ROBINHOOD=https://robinhood-mainnet.g.alchemy.com/v2/<key>
 * Key trong URL duoc che khi in ra. RPC nhanh nhat nen dat DAU TIEN trong RPC_<CHAIN>.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAINS } from './lib/chains.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUNDS = 10;

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

/** Che key: giu host, thay phan duong dan dai / query bang *** */
function mask(url) {
  try {
    const u = new URL(url);
    const p = u.pathname.replace(/[A-Za-z0-9_-]{16,}/g, '***');
    return `${u.host}${p}${u.search ? '?***' : ''}`;
  } catch {
    return '(URL loi)';
  }
}

async function rpc(url, method) {
  const t = performance.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
    signal: AbortSignal.timeout(8000),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return { ms: performance.now() - t, result: j.result };
}

async function main() {
  loadEnv();
  const chain = (process.argv[2] || '').toLowerCase();
  if (!CHAINS[chain]) {
    console.log(`Cach dung: node rpcbench.mjs <chain>\nChain: ${Object.keys(CHAINS).join(', ')}`);
    process.exit(1);
  }
  const own = (process.env[`RPC_${chain.toUpperCase()}`] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const urls = [...new Set([...own, ...CHAINS[chain].rpcs])];
  console.log(`Do ${urls.length} RPC cua ${chain}, moi cai ${ROUNDS} lan (bo lan dau vi mo ket noi)...\n`);

  const rows = [];
  for (const url of urls) {
    const times = [];
    let fail = 0;
    let lastErr = '';
    let chainId = null;
    for (let i = 0; i <= ROUNDS; i++) {
      try {
        const r = await rpc(url, i === 0 ? 'eth_chainId' : 'eth_blockNumber');
        if (i === 0) chainId = parseInt(r.result, 16);
        else times.push(r.ms);
      } catch (e) {
        fail++;
        lastErr = e.message;
      }
    }
    times.sort((a, b) => a - b);
    const wrongChain = chainId !== null && chainId !== CHAINS[chain].chainId;
    rows.push({
      name: `${own.includes(url) ? '[rieng] ' : ''}${mask(url)}`,
      median: times.length ? times[Math.floor(times.length / 2)] : Infinity,
      best: times[0] ?? Infinity,
      fail,
      note: wrongChain ? `SAI CHAIN (chainId ${chainId})` : fail ? lastErr.slice(0, 60) : '',
    });
  }

  rows.sort((a, b) => a.median - b.median);
  for (const r of rows) {
    const ms = (v) => (Number.isFinite(v) ? `${Math.round(v)}ms`.padStart(6) : '     -');
    console.log(`${r.name.padEnd(55)} trung vi ${ms(r.median)} | nhanh nhat ${ms(r.best)} | loi ${r.fail}/${ROUNDS + 1} ${r.note}`);
  }
  const best = rows.find((r) => Number.isFinite(r.median) && !r.note.startsWith('SAI'));
  if (best) console.log(`\n=> Nhanh nhat: ${best.name}. Dat RPC nay DAU TIEN trong RPC_${chain.toUpperCase()} (.env).`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
