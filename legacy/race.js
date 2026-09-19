/**
 * Race mint - dung cho drop tranh nhau khoc liet, nguon cung it.
 *
 *   node race.js --check   chuan bi + do do tre tung endpoint, KHONG ban
 *   node race.js           canh va ban
 *
 * Khac watch-mint.js o 2 diem:
 *
 *   1. DO CHONG LAN: ban eth_call lien tiep khong cho lenh truoc tra ve.
 *      Do phan giai phat hien = PROBE_MS thay vi (PROBE_MS + do tre RPC).
 *
 *   2. PHAT DA DIEM: gui giao dich da ky ra TAT CA endpoint cung luc.
 *      Cung 1 nonce nen chain tu khu trung lap - khong ton them tien.
 *      Endpoint nao toi sequencer truoc thi thang.
 *
 * KHONG spam giao dich that: nonce bi xep thu tu tuyet doi, va giao dich
 * revert VAN TIEU NONCE. Mot vi = mot vien dan duy nhat.
 *
 * Bien trong .env:
 *   RPC_URLS    danh sach endpoint cach nhau bang dau phay (cang nhieu cang tot)
 *   PROBE_MS    nhip ban eth_call chong lan, mac dinh 60
 *   MAX_INFLIGHT so lenh dò toi da cung luc, mac dinh 8
 *   RACE_WINDOW_S bat dau dò chong lan khi con bao nhieu giay, mac dinh 20
 */

import 'dotenv/config';
import path from 'node:path';
import { ethers } from 'ethers';
import { resolveChain } from './chains.js';
import { loadWalletFromDir, hasKeystore, promptPassword } from './keystore.js';
import {
  getMintStats,
  resolveQuantity,
  decodeSeaDropError,
  SEADROP_ABI,
  DEFAULT_SEADROP_ADDRESS,
  DEFAULT_FEE_RECIPIENT,
} from './seadrop.js';

const CHECK_ONLY = process.argv.includes('--check');

const {
  WALLETS_DIR = './wallets',
  WALLET = '01',
  NFT_CONTRACT,
  SEADROP_QUANTITY = '1',
  SEADROP_ADDRESS = DEFAULT_SEADROP_ADDRESS,
  SEADROP_FEE_RECIPIENT = DEFAULT_FEE_RECIPIENT,
  GAS_BUMP = '2',
  BASE_MULT = '20',
  RPC_URLS = '',
  PROBE_MS = '60',
  MAX_INFLIGHT = '8',
  RACE_WINDOW_S = '20',
} = process.env;

const IFACE = new ethers.Interface(SEADROP_ABI);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toLocaleTimeString();

async function main() {
  if (!NFT_CONTRACT) throw new Error('Thieu NFT_CONTRACT trong .env');

  const { chainId, rpc, explorer } = resolveChain(process.env);
  const net = { chainId, name: `chain-${chainId}` };

  // Danh sach endpoint: RPC_URLS + endpoint mac dinh, bo trung lap
  const urls = [...new Set([...RPC_URLS.split(',').map((s) => s.trim()).filter(Boolean), rpc])];
  const providers = urls.map((u) => {
    const req = new ethers.FetchRequest(u);
    req.timeout = 10000;
    req.retryFunc = async () => false; // tu retry se lam lech nhip
    return new ethers.JsonRpcProvider(req, net, { staticNetwork: true });
  });
  const main0 = providers[0];

  console.log(`\n${urls.length} endpoint:`);
  urls.forEach((u, i) => console.log(`  [${i}] ${u}`));
  if (urls.length === 1) {
    console.log('\n  CHI CO 1 ENDPOINT. Them endpoint rieng vao RPC_URLS de tang co hoi dang ke.');
  }

  // ---------- Nap vi ----------
  const dir = path.join(WALLETS_DIR, WALLET);
  const pw =
    process.env.KEYSTORE_PASSWORD || (hasKeystore(dir) ? await promptPassword('\nMat khau keystore: ') : '');
  const loaded = await loadWalletFromDir(dir, pw);
  if (!loaded) throw new Error(`Khong nap duoc vi tu ${dir}`);
  const wallet = loaded.wallet;
  console.log(`\nVi: ${wallet.address}`);

  // ---------- Do do tre tung endpoint ----------
  console.log('\nDang do do tre tung endpoint...');
  const lat = [];
  for (let i = 0; i < providers.length; i++) {
    const samples = [];
    for (let k = 0; k < 5; k++) {
      const t = Date.now();
      try {
        await providers[i].getBlockNumber();
        samples.push(Date.now() - t);
      } catch {
        samples.push(9999);
      }
    }
    samples.sort((a, b) => a - b);
    lat.push(samples[2]); // trung vi
    console.log(`  [${i}] trung vi ${samples[2]}ms  (${samples.join(', ')})`);
  }
  const best = lat.indexOf(Math.min(...lat));
  console.log(`  => Nhanh nhat: [${best}] ${lat[best]}ms. Mot chieu ~${Math.round(lat[best] / 2)}ms.`);

  // ---------- Doc drop ----------
  const seaDrop = new ethers.Contract(SEADROP_ADDRESS, SEADROP_ABI, main0);
  const drop = await seaDrop.getPublicDrop(NFT_CONTRACT);
  const price = BigInt(drop.mintPrice);
  const startTime = BigInt(drop.startTime);
  const endTime = BigInt(drop.endTime);

  const stats = await getMintStats({ nftContract: NFT_CONTRACT, provider: main0, address: wallet.address });
  const { quantity, reason } = resolveQuantity({
    desired: SEADROP_QUANTITY,
    summary: { maxPerWallet: BigInt(drop.maxTotalMintableByWallet) },
    stats,
  });
  if (quantity === 0n) throw new Error(`Khong mint duoc: ${reason}`);

  const value = price * quantity;
  const data = IFACE.encodeFunctionData('mintPublic', [
    NFT_CONTRACT,
    SEADROP_FEE_RECIPIENT,
    ethers.ZeroAddress,
    quantity,
  ]);

  // ---------- Gas + ky san ----------
  const blk = await main0.getBlock('latest');
  const fee = await main0.getFeeData();
  const baseFee = blk?.baseFeePerGas ?? fee.gasPrice ?? 1000000000n;
  let prio = fee.maxPriorityFeePerGas ?? 0n;
  if (prio === 0n) prio = baseFee / 10n;
  if (prio === 0n) prio = 100000000n;
  const maxPrio = (prio * BigInt(Math.round(parseFloat(GAS_BUMP) * 100))) / 100n;
  const maxFee = baseFee * BigInt(parseInt(BASE_MULT, 10)) + maxPrio;
  const gasLimit = 200000n + 40000n * quantity;
  const nonce = await main0.getTransactionCount(wallet.address, 'pending');

  const raw = await wallet.signTransaction({
    type: 2,
    chainId,
    nonce,
    to: SEADROP_ADDRESS,
    data,
    value,
    gasLimit,
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: maxPrio,
  });

  const maxCost = value + gasLimit * maxFee;
  const balance = await main0.getBalance(wallet.address);
  if (balance < maxCost) {
    throw new Error(
      `So du khong du: co ${ethers.formatEther(balance)}, can toi da ${ethers.formatEther(maxCost)}`
    );
  }

  // Bay thu de bat loi cau hinh ngay
  let preflight;
  try {
    await main0.call({ from: wallet.address, to: SEADROP_ADDRESS, data, value });
    preflight = 'stage DANG MO';
  } catch (err) {
    const d = decodeSeaDropError(err) || err.shortMessage || err.message || '';
    if (/NotActive|chua mo|da dong/i.test(d)) preflight = 'OK - chi vuong "chua mo"';
    else throw new Error(`Kiem tra truoc THAT BAI: ${d}`);
  }

  const drift = Math.floor(Date.now() / 1000) - blk.timestamp;
  const remain = stats ? stats.maxSupply - stats.totalSupply : null;

  console.log('\n===== DA SAN SANG =====');
  console.log(`So luong    : ${quantity} NFT`);
  console.log(`Tra         : ${ethers.formatEther(value)}${value === 0n ? ' (mien phi)' : ''}`);
  console.log(`Nonce       : ${nonce}`);
  console.log(`Tran gas    : ${ethers.formatUnits(maxFee, 'gwei')} gwei (baseFee x${BASE_MULT})`);
  console.log(`So du       : ${ethers.formatEther(balance)} (can toi da ${ethers.formatEther(maxCost)})`);
  console.log(`Kiem tra som: ${preflight}`);
  if (remain !== null) console.log(`Con lai     : ${remain}/${stats.maxSupply}`);
  console.log(`Gio mo      : ${new Date(Number(startTime) * 1000).toLocaleString()}`);
  console.log(`Gio dong    : ${new Date(Number(endTime) * 1000).toLocaleString()}`);
  console.log(`Lech dong ho: ${drift >= 0 ? '+' : ''}${drift}s`);

  if (CHECK_ONLY) {
    console.log('\n--check: khong canh, khong ban. Thoat.');
    providers.forEach((p) => p.destroy());
    return;
  }

  /** Phat giao dich ra TAT CA endpoint cung luc. Cung nonce -> chain khu trung lap. */
  async function fireAll() {
    const t0 = Date.now();
    console.log(`\n[${ts()}] PHAT ra ${providers.length} endpoint cung luc...`);
    const jobs = providers.map(async (pv, i) => {
      const t = Date.now();
      try {
        const tx = await pv.broadcastTransaction(raw);
        return { i, ok: true, ms: Date.now() - t, hash: tx.hash };
      } catch (e) {
        return { i, ok: false, ms: Date.now() - t, err: decodeSeaDropError(e) || e.shortMessage || e.message };
      }
    });
    const res = await Promise.all(jobs);
    for (const r of res) {
      console.log(`  [${r.i}] ${r.ok ? 'nhan' : 'tu choi'} sau ${r.ms}ms  ${r.ok ? r.hash : r.err}`);
    }
    const win = res.find((r) => r.ok);
    if (!win) {
      console.log('\nKHONG endpoint nao nhan giao dich.');
      return;
    }
    console.log(`\nTong thoi gian phat: ${Date.now() - t0}ms`);
    console.log(`${explorer}${win.hash}`);
    try {
      const rec = await main0.waitForTransaction(win.hash, 1, 120000);
      if (rec && rec.status === 1) {
        console.log(`THANH CONG - mint ${quantity} NFT (block ${rec.blockNumber})`);
        console.log(`Phi gas: ${ethers.formatEther(rec.gasUsed * rec.gasPrice)}`);
      } else {
        console.log('Giao dich bi revert on-chain. Nonce da tieu, khong ban lai duoc.');
      }
    } catch (e) {
      console.log('Khong doi duoc bien lai:', e.shortMessage || e.message);
    }
  }

  // ---------- Vong canh ----------
  const probeMs = parseInt(PROBE_MS, 10);
  const maxInflight = parseInt(MAX_INFLIGHT, 10);
  const raceWindow = parseInt(RACE_WINDOW_S, 10);

  console.log('\n===== BAT DAU CANH (Ctrl+C de dung) =====');
  console.log(`Con xa: poll thua. Con <${raceWindow}s: do chong lan moi ${probeMs}ms.\n`);

  let opened = false;
  let probes = 0;
  let lastLog = 0;

  while (!opened) {
    const nowSec = Math.floor(Date.now() / 1000) - drift;
    const left = Number(startTime) - nowSec;

    if (left > raceWindow) {
      // Con xa: poll thua, chi de bat truong hop du an doi gio
      const d = await seaDrop.getPublicDrop(NFT_CONTRACT);
      if (BigInt(d.startTime) !== startTime) {
        console.log(`\n[${ts()}] !! DU AN DOI GIO MO -> ${new Date(Number(d.startTime) * 1000).toLocaleString()}`);
        console.log('   Khoi dong lai script de ky lai theo gio moi.');
      }
      if (Date.now() - lastLog > 30000) {
        console.log(`[${ts()}] con ${left}s`);
        lastLog = Date.now();
      }
      await sleep(3000);
      continue;
    }

    // Vao cua so tranh: ban eth_call CHONG LAN, khong cho lenh truoc tra ve
    const inflight = new Set();
    console.log(`[${ts()}] Vao cua so tranh. Do chong lan moi ${probeMs}ms tren ${providers.length} endpoint.`);

    while (!opened) {
      if (inflight.size < maxInflight) {
        const pv = providers[probes % providers.length];
        probes++;
        const job = pv
          .call({ from: wallet.address, to: SEADROP_ADDRESS, data, value })
          .then(() => {
            if (!opened) {
              opened = true;
              console.log(`\n[${ts()}] STAGE DA MO (sau ${probes} lan do)`);
            }
          })
          .catch(() => {})
          .finally(() => inflight.delete(job));
        inflight.add(job);
      }
      if (opened) break;
      await sleep(probeMs);
    }
  }

  await fireAll();
  providers.forEach((p) => p.destroy());
}

main().catch((err) => {
  console.error('\nLoi:', err.shortMessage || err.message);
  process.exit(1);
});
