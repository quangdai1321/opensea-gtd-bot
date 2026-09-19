/**
 * Snipe mint SeaDrop - toi uu cho toc do.
 *
 *   node snipe.js            ban that
 *   node snipe.js --check    chuan bi + ky san, KHONG gui gi len chain
 *
 * Khac run-all.js o cho: MOI thu nang ve truoc gio mo.
 * Giao dich duoc KY SAN offline, luc ban chi con 1 lenh RPC duy nhat
 * (eth_sendRawTransaction) thay vi 6-7 luot goi tuan tu.
 *
 * Bien trong .env:
 *   NFT_CONTRACT      dia chi contract NFT
 *   SEADROP_QUANTITY  so luong mint
 *   WALLET            ten folder vi, mac dinh "01"
 *   WAIT_UNTIL        "HH:MM" / "HH:MM:SS" / ISO. Bo trong = dung startTime cua contract
 *   GAS_BUMP          he so nhan phi gas de tranh mua, mac dinh 2
 *   LEAD_MS           ban som truoc bao nhieu ms, mac dinh 0
 */

import 'dotenv/config';
import path from 'node:path';
import { ethers } from 'ethers';
import { resolveChain } from './chains.js';
import { loadWalletFromDir, hasKeystore, promptPassword } from './keystore.js';
import {
  getSeaDrop,
  getPublicDropSummary,
  getMintStats,
  resolveQuantity,
  decodeSeaDropError,
  formatSummary,
  assertSeaDropDeployed,
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
  WAIT_UNTIL = '',
  GAS_BUMP = '2',
  LEAD_MS = '0',
  GAS_MULTIPLIER = '1.3',
} = process.env;

const IFACE = new ethers.Interface(SEADROP_ABI);

/** Doc moc gio: "HH:MM" / "HH:MM:SS" (hom nay, qua roi thi mai) hoac ISO day du */
function parseWaitUntil(raw) {
  const t = String(raw).trim();
  const hm = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (hm) {
    const h = +hm[1];
    const m = +hm[2];
    const s = hm[3] ? +hm[3] : 0;
    if (h > 23 || m > 59 || s > 59) throw new Error(`WAIT_UNTIL sai gio: "${t}"`);
    const d = new Date();
    d.setHours(h, m, s, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); // da qua -> hen sang mai
    return d;
  }
  const d = new Date(t);
  if (isNaN(d.getTime())) {
    throw new Error(`WAIT_UNTIL khong hop le: "${t}". Dung "HH:MM" hoac "2026-09-10T10:00:00".`);
  }
  return d;
}

async function main() {
  if (!NFT_CONTRACT) throw new Error('Thieu NFT_CONTRACT trong .env');

  const { chainId, rpc, explorer } = resolveChain(process.env);
  const provider = new ethers.JsonRpcProvider(
    rpc,
    { chainId, name: `chain-${chainId}` },
    { staticNetwork: true }
  );

  // ---------- 1. Nap vi. Hoi mat khau NGAY de sau do khong can nguoi ngoi cho ----------
  const dir = path.join(WALLETS_DIR, WALLET);
  const pw =
    process.env.KEYSTORE_PASSWORD || (hasKeystore(dir) ? await promptPassword('Mat khau keystore: ') : '');
  const loaded = await loadWalletFromDir(dir, pw);
  if (!loaded) throw new Error(`Khong nap duoc vi tu ${dir}`);
  const wallet = loaded.wallet.connect(provider);
  console.log(`\nVi: ${wallet.address} (${loaded.source})`);

  // ---------- 2. Nang toan bo du lieu TRUOC gio mo ----------
  console.log('Dang chuan bi truoc...');
  await assertSeaDropDeployed(provider, SEADROP_ADDRESS);
  const seaDrop = getSeaDrop(provider, SEADROP_ADDRESS);

  const summary = await getPublicDropSummary({ seaDrop, nftContract: NFT_CONTRACT, provider });
  console.log('\n' + formatSummary(summary));

  const stats = await getMintStats({ nftContract: NFT_CONTRACT, provider, address: wallet.address });
  const { quantity, reason } = resolveQuantity({ desired: SEADROP_QUANTITY, summary, stats });
  if (quantity === 0n) throw new Error(`Khong mint duoc: ${reason}`);
  if (reason) console.log(`\nSo luong ha xuong ${quantity} (${reason})`);

  const value = summary.mintPrice * quantity;
  const data = IFACE.encodeFunctionData('mintPublic', [
    NFT_CONTRACT,
    SEADROP_FEE_RECIPIENT,
    ethers.ZeroAddress,
    quantity,
  ]);

  const balance = await provider.getBalance(wallet.address);
  if (balance <= value) {
    throw new Error(
      `So du khong du: co ${ethers.formatEther(balance)}, can ${ethers.formatEther(value)} + gas`
    );
  }

  // Mo phong 1 lan TRUOC. Stage chua mo se bao NotActive - binh thuong, khong phai loi.
  let gasLimit;
  try {
    const est = await provider.estimateGas({ from: wallet.address, to: SEADROP_ADDRESS, data, value });
    gasLimit = (est * BigInt(Math.round(parseFloat(GAS_MULTIPLIER) * 100))) / 100n;
    console.log(`\nMo phong OK. Gas limit ${gasLimit} (uoc luong ${est})`);
  } catch (err) {
    const decoded = decodeSeaDropError(err);
    gasLimit = 200000n + 40000n * quantity;
    console.log(`\nChua mo phong duoc: ${decoded || err.shortMessage || err.message}`);
    console.log(`=> Dung gas limit du phong ${gasLimit}`);
  }

  // Phi gas. Thu quyet dinh thu tu trong block la PRIORITY FEE (tien tip validator),
  // khong phai maxFeePerGas - cai do chi la tran.
  const fee = await provider.getFeeData();
  const blk = await provider.getBlock('latest');
  const bump = BigInt(Math.round(parseFloat(GAS_BUMP) * 100));

  const baseFee = blk?.baseFeePerGas ?? fee.gasPrice ?? 1000000000n;

  // Nhieu RPC tra ve maxPriorityFeePerGas = 0. Dung "??" se KHONG bat duoc 0n,
  // lam GAS_BUMP mat tac dung hoan toan. Phai kiem tra bang 0 tuong minh.
  let prio = fee.maxPriorityFeePerGas ?? 0n;
  if (prio === 0n) prio = baseFee / 10n; // san: 10% base fee
  if (prio === 0n) prio = 100000000n; // chain gas gan 0 -> lay 0.1 gwei

  const maxPrio = (prio * bump) / 100n;
  // Tran = 2x base (de phong base fee tang giua chung) + tien tip
  const maxFee = baseFee * 2n + maxPrio;
  const nonce = await provider.getTransactionCount(wallet.address, 'pending');

  // ---------- 3. KY SAN offline. Tu day tro di khong can RPC nua ----------
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

  console.log('\n===== DA KY SAN, SAN SANG BAN =====');
  console.log(`So luong    : ${quantity} NFT`);
  console.log(`Tra         : ${ethers.formatEther(value)}`);
  console.log(`Nonce       : ${nonce}`);
  console.log(`Gas limit   : ${gasLimit}`);
  console.log(`Base fee    : ${ethers.formatUnits(baseFee, 'gwei')} gwei (hien tai)`);
  console.log(`Tien tip    : ${ethers.formatUnits(maxPrio, 'gwei')} gwei (x${GAS_BUMP}) <- quyet dinh thu tu trong block`);
  console.log(`Max fee     : ${ethers.formatUnits(maxFee, 'gwei')} gwei (tran)`);
  // Thuc te tru tien theo baseFee + tip, khong phai theo tran
  const likely = baseFee + maxPrio;
  console.log(`Du kien tra : ~${ethers.formatEther(gasLimit * likely)} gas (${ethers.formatUnits(likely, 'gwei')} gwei)`);
  console.log(`TONG du kien: ~${ethers.formatEther(value + gasLimit * likely)}`);
  console.log(`TONG toi da : ${ethers.formatEther(value + gasLimit * maxFee)} (truong hop xau nhat)`);

  // ---------- 4. Xac dinh moc ban ----------
  const lead = parseInt(LEAD_MS, 10) || 0;
  let fireAt;
  if (WAIT_UNTIL) {
    fireAt = parseWaitUntil(WAIT_UNTIL);
    console.log(`\nMoc ban: ${fireAt.toLocaleString()} (dong ho may)`);
  } else if (summary.notStarted) {
    fireAt = new Date(Number(summary.startTime) * 1000);
    console.log(`\nMoc ban: ${fireAt.toLocaleString()} (startTime cua contract)`);
  } else {
    fireAt = new Date();
    console.log('\nStage DANG MO - ban ngay.');
  }

  if (CHECK_ONLY) {
    console.log('\n--check: dung lai o day, KHONG gui gi len chain.');
    provider.destroy();
    return;
  }

  // ---------- 5. Cho, roi ban ----------
  const target = fireAt.getTime() - lead;
  if (target - Date.now() > 0) {
    console.log(`Con ${Math.round((target - Date.now()) / 1000)}s. Ctrl+C de huy.`);
    // Ngu dai cho den 3 giay cuoi
    while (target - Date.now() > 3000) {
      const left = target - Date.now();
      await new Promise((r) => setTimeout(r, Math.min(left - 3000, 20000)));
      const s = Math.round((target - Date.now()) / 1000);
      if (s > 3) console.log(`  con ${s}s...`);
    }
    // 3 giay cuoi: vong lap chat, khong goi RPC, chi nhin dong ho
    while (target - Date.now() > 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  const t0 = Date.now();
  try {
    const tx = await provider.broadcastTransaction(raw);
    console.log(`\nDA BAN sau ${Date.now() - t0}ms`);
    console.log(`${explorer}${tx.hash}`);
    const rec = await tx.wait();
    if (rec.status === 1) {
      console.log(`THANH CONG - mint ${quantity} NFT (block ${rec.blockNumber})`);
      console.log(`Gas thuc dung: ${rec.gasUsed} | Phi: ${ethers.formatEther(rec.gasUsed * rec.gasPrice)}`);
    } else {
      console.log('Giao dich bi revert on-chain.');
    }
  } catch (err) {
    console.error('\nBan that bai:', decodeSeaDropError(err) || err.shortMessage || err.message);
  }

  provider.destroy();
}

main().catch((err) => {
  console.error('\nLoi:', err.shortMessage || err.message);
  process.exit(1);
});
