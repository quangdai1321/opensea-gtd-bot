/**
 * Canh drop va ban dung khoanh khac mo.
 *
 *   node watch-mint.js            canh that
 *   node watch-mint.js --check    chuan bi + canh, nhung KHONG ban
 *
 * Khac snipe.js: snipe.js tin vao startTime doc duoc luc khoi dong.
 * Script nay POLL LIEN TUC, nen bat duoc ca truong hop du an doi gio mo som hon
 * (ho goi updatePublicDrop) hoac doi gia giua chung.
 *
 * QUAN TRONG: script KHONG gui giao dich that truoc gio mo.
 * Giao dich revert VAN BI TRU GAS - spam la dot tien. Thay vao do no dung
 * eth_call (lenh doc, mien phi) de do, chi ban khi chac chan se thanh cong.
 *
 * Bien trong .env:
 *   POLL_MS        nhip poll khi con xa, mac dinh 3000
 *   POLL_FAST_MS   nhip poll khi sap toi, mac dinh 400 (RPC ~300ms nen thap hon vo nghia)
 *   FAST_WINDOW_S  chuyen sang nhip nhanh khi con bao nhieu giay, mac dinh 30
 *   GAS_BUMP       he so nhan tien tip, mac dinh 2
 */

import 'dotenv/config';
import path from 'node:path';
import { ethers } from 'ethers';
import { resolveChain } from './chains.js';
import { loadWalletFromDir, hasKeystore, promptPassword } from './keystore.js';
import {
  getSeaDrop,
  getMintStats,
  resolveQuantity,
  decodeSeaDropError,
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
  GAS_BUMP = '2',
  GAS_MULTIPLIER = '1.3',
  POLL_MS = '3000',
  POLL_FAST_MS = '400',
  FAST_WINDOW_S = '30',
} = process.env;

const IFACE = new ethers.Interface(SEADROP_ABI);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toLocaleTimeString();

async function main() {
  if (!NFT_CONTRACT) throw new Error('Thieu NFT_CONTRACT trong .env');

  const { chainId, rpc, explorer } = resolveChain(process.env);
  const provider = new ethers.JsonRpcProvider(
    rpc,
    { chainId, name: `chain-${chainId}` },
    { staticNetwork: true }
  );

  // ---------- 1. Nap vi ngay tu dau ----------
  const dir = path.join(WALLETS_DIR, WALLET);
  const pw =
    process.env.KEYSTORE_PASSWORD || (hasKeystore(dir) ? await promptPassword('Mat khau keystore: ') : '');
  const loaded = await loadWalletFromDir(dir, pw);
  if (!loaded) throw new Error(`Khong nap duoc vi tu ${dir}`);
  const wallet = loaded.wallet.connect(provider);
  console.log(`\nVi: ${wallet.address}`);

  await assertSeaDropDeployed(provider, SEADROP_ADDRESS);
  const seaDrop = getSeaDrop(provider, SEADROP_ADDRESS);

  // ---------- 2. Doc cau hinh ban dau ----------
  let drop = await seaDrop.getPublicDrop(NFT_CONTRACT);
  let price = BigInt(drop.mintPrice);
  let startTime = BigInt(drop.startTime);
  let endTime = BigInt(drop.endTime);

  const stats = await getMintStats({ nftContract: NFT_CONTRACT, provider, address: wallet.address });
  const summaryLike = { maxPerWallet: BigInt(drop.maxTotalMintableByWallet) };
  const { quantity, reason } = resolveQuantity({
    desired: SEADROP_QUANTITY,
    summary: summaryLike,
    stats,
  });
  if (quantity === 0n) throw new Error(`Khong mint duoc: ${reason}`);
  if (reason) console.log(`So luong ha xuong ${quantity} (${reason})`);

  const data = IFACE.encodeFunctionData('mintPublic', [
    NFT_CONTRACT,
    SEADROP_FEE_RECIPIENT,
    ethers.ZeroAddress,
    quantity,
  ]);

  // ---------- 3. Chuan bi tham so gas + nonce ----------
  const fee = await provider.getFeeData();
  const blk = await provider.getBlock('latest');
  const bump = BigInt(Math.round(parseFloat(GAS_BUMP) * 100));
  const baseFee = blk?.baseFeePerGas ?? fee.gasPrice ?? 1000000000n;
  let prio = fee.maxPriorityFeePerGas ?? 0n;
  if (prio === 0n) prio = baseFee / 10n;
  if (prio === 0n) prio = 100000000n;
  const maxPrio = (prio * bump) / 100n;
  // Giao dich ky san khoa cung maxFeePerGas. Drop hot lam base fee vot len,
  // cap thap => giao dich bi treo vi duoi gia san. Cap chi la TRAN, thuc te van
  // chi tra baseFee, nen dat rong khong ton them tien - chi can du so du de phu.
  const baseMult = BigInt(parseInt(process.env.BASE_MULT || '5', 10));
  const maxFee = baseFee * baseMult + maxPrio;
  const nonce = await provider.getTransactionCount(wallet.address, 'pending');
  const gasLimit = 200000n + 40000n * quantity;

  // Do lech dong ho may so voi dong ho chain
  const chainNow = BigInt(blk.timestamp);
  const localNow = BigInt(Math.floor(Date.now() / 1000));
  const drift = Number(localNow - chainNow);

  /** Ky lai giao dich. Chay cuc bo, ~1ms, khong ton RPC. */
  const sign = (v) =>
    wallet.signTransaction({
      type: 2,
      chainId,
      nonce,
      to: SEADROP_ADDRESS,
      data,
      value: v,
      gasLimit,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: maxPrio,
    });

  let raw = await sign(price * quantity);

  // ---------- Kiem tra truoc NGAY, dung de den phut chot moi phat hien sai ----------
  const need = price * quantity;
  const maxCost = need + gasLimit * maxFee;
  const balance = await provider.getBalance(wallet.address);
  if (balance < maxCost) {
    throw new Error(
      `So du khong du: co ${ethers.formatEther(balance)}, can toi da ${ethers.formatEther(maxCost)}\n` +
        '  => Nap them TRUOC khi canh.'
    );
  }

  // Bay thu 1 lan. "Chua mo" la binh thuong; loi khac nghia la cau hinh sai.
  let preflight;
  try {
    await provider.call({ from: wallet.address, to: SEADROP_ADDRESS, data, value: need });
    preflight = 'stage DANG MO - vao vong canh se ban ngay';
  } catch (err) {
    const d = decodeSeaDropError(err) || err.shortMessage || err.message || '';
    if (/NotActive|chua mo|da dong/i.test(d)) {
      preflight = 'OK - chi vuong "chua mo", moi thu con lai hop le';
    } else {
      throw new Error(
        `Kiem tra truoc THAT BAI: ${d}\n` +
          '  => Sua cau hinh bay gio, dung cho den gio mo moi phat hien.'
      );
    }
  }

  console.log('\n===== DA SAN SANG =====');
  console.log(`So luong    : ${quantity} NFT`);
  console.log(`Gia hien tai: ${ethers.formatEther(price)} /cai`);
  console.log(`Tra         : ${ethers.formatEther(price * quantity)}`);
  console.log(`Nonce       : ${nonce}`);
  console.log(`Tien tip    : ${ethers.formatUnits(maxPrio, 'gwei')} gwei (x${GAS_BUMP})`);
  console.log(`So du       : ${ethers.formatEther(balance)} (can toi da ${ethers.formatEther(maxCost)})`);
  console.log(`Kiem tra som: ${preflight}`);
  console.log(`Gio mo      : ${new Date(Number(startTime) * 1000).toLocaleString()}`);
  console.log(`Lech dong ho: ${drift >= 0 ? '+' : ''}${drift}s (may so voi chain)`);
  if (Math.abs(drift) > 5) {
    console.log('  CANH BAO: dong ho lech qua 5s. Vao Settings > Time > Sync now.');
  }

  if (CHECK_ONLY) {
    console.log('\n--check: khong ban. Thoat.');
    provider.destroy();
    return;
  }

  // ---------- 4. Vong canh ----------
  console.log('\n===== BAT DAU CANH (Ctrl+C de dung) =====');
  console.log('Dung eth_call de do - lenh doc, MIEN PHI, khong len chain.\n');

  const pollSlow = parseInt(POLL_MS, 10);
  const pollFast = parseInt(POLL_FAST_MS, 10);
  const fastWindow = parseInt(FAST_WINDOW_S, 10);

  let lastLog = 0;
  let checks = 0;

  // null = tat (mac dinh, an toan). So = ban thang tai startTime + so ms do.
  const BLIND_MS = process.env.BLIND_MS === undefined || process.env.BLIND_MS === ''
    ? null
    : parseInt(process.env.BLIND_MS, 10);

  /** Gui giao dich da ky san. Dung chung cho ca 2 che do. */
  async function fire() {
    const t0 = Date.now();
    try {
      const tx = await provider.broadcastTransaction(raw);
      console.log(`DA BAN sau ${Date.now() - t0}ms`);
      console.log(`${explorer}${tx.hash}`);
      const rec = await tx.wait();
      if (rec.status === 1) {
        console.log(`THANH CONG - mint ${quantity} NFT (block ${rec.blockNumber})`);
        console.log(`Phi gas: ${ethers.formatEther(rec.gasUsed * rec.gasPrice)}`);
      } else {
        console.log('Giao dich bi revert on-chain (nonce da bi tieu, khong ban lai duoc).');
      }
    } catch (err) {
      console.error('Ban that bai:', decodeSeaDropError(err) || err.shortMessage || err.message);
    }
  }

  if (BLIND_MS !== null) {
    console.log(`CHE DO BAN THANG: ban tai startTime +${BLIND_MS}ms, khong cho eth_call xac nhan.`);
    console.log('  Nhanh hon ~300ms. Nhung ban som la revert va MAT LUOT.\n');
  }

  for (;;) {
    const nowSec = BigInt(Math.floor(Date.now() / 1000)) - BigInt(drift);
    const left = Number(startTime - nowSec);

    // Con xa: poll cham, chi theo doi xem du an co doi cau hinh khong
    if (left > fastWindow) {
      const d = await seaDrop.getPublicDrop(NFT_CONTRACT);
      const np = BigInt(d.mintPrice);
      const ns = BigInt(d.startTime);
      const ne = BigInt(d.endTime);

      if (ns !== startTime) {
        console.log(`\n[${ts()}] !! DU AN DOI GIO MO !!`);
        console.log(`   ${new Date(Number(startTime) * 1000).toLocaleString()} -> ${new Date(Number(ns) * 1000).toLocaleString()}`);
        startTime = ns;
      }
      if (np !== price) {
        console.log(`\n[${ts()}] !! DU AN DOI GIA !! ${ethers.formatEther(price)} -> ${ethers.formatEther(np)}`);
        price = np;
        raw = await sign(price * quantity); // ky lai, cuc bo, khong ton RPC
        console.log('   Da ky lai giao dich voi gia moi.');
      }
      if (ne !== endTime) {
        console.log(`\n[${ts()}] Doi gio ket thuc -> ${new Date(Number(ne) * 1000).toLocaleString()}`);
        endTime = ne;
      }

      if (Date.now() - lastLog > 30000) {
        console.log(`[${ts()}] con ${Math.round(Number(startTime - nowSec))}s | gia ${ethers.formatEther(price)} | da do ${checks} lan`);
        lastLog = Date.now();
      }
      checks++;
      await sleep(pollSlow);
      continue;
    }

    // Che do BAN THANG: khong cho eth_call xac nhan, ban dung moc gio da hieu chinh
    // lech dong ho. Nhanh hon ~300ms (1 vong RPC) nhung neu ban som se revert va
    // MAT NONCE. Chi dung cho drop tranh nhau khoc liet.
    if (BLIND_MS !== null && left <= 0 && Number(nowSec - startTime) * 1000 >= BLIND_MS) {
      console.log(`\n[${ts()}] BAN THANG (khong cho xac nhan) - moc +${BLIND_MS}ms`);
      await fire();
      break;
    }

    // Sap toi: do bang eth_call. Khong revert = da mo = ban ngay.
    checks++;
    try {
      await provider.call({ from: wallet.address, to: SEADROP_ADDRESS, data, value: price * quantity });
    } catch (err) {
      const decoded = decodeSeaDropError(err) || '';
      if (/IncorrectPayment|Sai so tien/i.test(decoded)) {
        // Gia doi ngay truoc gio mo - doc lai va ky lai
        const d = await seaDrop.getPublicDrop(NFT_CONTRACT);
        price = BigInt(d.mintPrice);
        raw = await sign(price * quantity);
        console.log(`[${ts()}] Gia doi -> ${ethers.formatEther(price)}, da ky lai.`);
      } else if (/da mint du|Vuot gioi han|sold out/i.test(decoded)) {
        console.log(`[${ts()}] Dung lai: ${decoded}`);
        break;
      }
      if (Date.now() - lastLog > 5000) {
        console.log(`[${ts()}] chua mo (${decoded || 'NotActive'}) | do lan ${checks}`);
        lastLog = Date.now();
      }
      await sleep(pollFast);
      continue;
    }

    // eth_call khong revert => stage DA MO. Ban ngay.
    console.log(`\n[${ts()}] STAGE DA MO - BAN (sau ${checks} lan do)`);
    await fire();
    break;
  }

  provider.destroy();
}

main().catch((err) => {
  console.error('\nLoi:', err.shortMessage || err.message);
  process.exit(1);
});
