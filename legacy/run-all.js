/**
 * Chay mint tren nhieu vi, moi vi 1 folder.
 *
 * Cau truc thu muc:
 *   wallets/
 *     01/key.txt          <- private key, 1 dong duy nhat
 *     01/config.json      <- tuy chon: {"loops": 3, "valueEth": "0.0002"}
 *     02/key.txt
 *     ...
 *
 * Chay:
 *   node run-all.js --check     kiem tra so du + mo phong, KHONG gui gi
 *   node run-all.js             chay that
 *   node run-all.js --reset     xoa state, chay lai tu dau
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import os from 'node:os';
import { resolveChain } from './chains.js';
import { mintWithWallet, mintSeaDropWithWallet, sleepJitter } from './core.js';
import {
  getSeaDrop,
  getPublicDropSummary,
  waitForOpen,
  assertSeaDropDeployed,
  formatSummary,
  DEFAULT_SEADROP_ADDRESS,
  DEFAULT_FEE_RECIPIENT,
} from './seadrop.js';
import { loadWalletFromDir, hasKeystore, promptPassword } from './keystore.js';

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const RESET = args.includes('--reset');


/** Bao loi cau hinh thanh cau nhac viec, khong nem stack trace vao mat nguoi dung */
function resolveChainOrExit(env) {
  try {
    return resolveChain(env);
  } catch (err) {
    console.error('\nChua cau hinh chain: ' + err.message);
    console.error('Chay "node configure.js" de tao file .env.\n');
    process.exit(1);
  }
}
const { chainId: CHAIN_ID, rpc: RPC_URL, explorer: EXPLORER } = resolveChainOrExit(process.env);

const {
  WALLETS_DIR = './wallets',
  CONTRACT,
  CALLDATA,
  ORIGINAL_MINTER = '',
  VALUE_ETH = '0',
  LOOPS = '1',
  DELAY_MS = '2000',
  JITTER_MS = '3000',
  WALLET_DELAY_MS = '5000',
  WALLET_JITTER_MS = '10000',
  FAST = 'false',
  PAY_TOKEN = '',
  GAS_MULTIPLIER = '1.3',
  MINT_MODE = 'calldata',
  SEADROP_ADDRESS = DEFAULT_SEADROP_ADDRESS,
  SEADROP_FEE_RECIPIENT = DEFAULT_FEE_RECIPIENT,
  SEADROP_QUANTITY = '',
  NFT_CONTRACT = '',
  WAIT_FOR_OPEN = 'false',
  SEADROP_POLL_MS = '5000',
} = process.env;

const IS_SEADROP = MINT_MODE.toLowerCase() === 'seadrop';

const STATE_FILE = path.join(WALLETS_DIR, '_state.json');

function loadState() {
  if (RESET || !fs.existsSync(STATE_FILE)) return { done: {} };
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { done: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function readConfig(dir) {
  const p = path.join(dir, 'config.json');
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function listWalletDirs() {
  if (!fs.existsSync(WALLETS_DIR)) {
    throw new Error(`Khong tim thay thu muc ${WALLETS_DIR}. Chay "node setup-wallets.js 10" truoc.`);
  }
  return fs
    .readdirSync(WALLETS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

async function discoverWallets() {
  const names = listWalletDirs();

  // Chi hoi mat khau neu that su co keystore ma hoa
  const needsPassword = names.some((n) => hasKeystore(path.join(WALLETS_DIR, n)));
  let password = process.env.KEYSTORE_PASSWORD || '';
  if (needsPassword && !password) {
    password = await promptPassword('Mat khau keystore: ');
  }

  const wallets = [];
  let plaintextCount = 0;

  for (const name of names) {
    const dir = path.join(WALLETS_DIR, name);
    let loaded;
    try {
      loaded = await loadWalletFromDir(dir, password);
    } catch (err) {
      console.warn(`  [bo qua] ${name}: ${err.message}`);
      continue;
    }
    if (!loaded) {
      console.warn(`  [bo qua] ${name}: khong thay keystore.json hoac key.txt`);
      continue;
    }
    if (loaded.source === 'plaintext') plaintextCount++;
    wallets.push({
      name,
      dir,
      key: loaded.wallet.privateKey,
      address: loaded.wallet.address,
      source: loaded.source,
      config: readConfig(dir),
    });
  }

  if (plaintextCount > 0) {
    console.warn(`\n  Canh bao: ${plaintextCount} vi dang luu key dang text tho.`);
    console.warn('  Chay "node encrypt-keys.js" de ma hoa, nhat la khi de tren o NTFS dung chung.\n');
  }

  return wallets;
}

async function main() {
  if (IS_SEADROP) {
    if (!NFT_CONTRACT) throw new Error('Che do seadrop can NFT_CONTRACT trong .env (dia chi contract NFT)');
  } else if (!CONTRACT || !CALLDATA) {
    throw new Error('Thieu CONTRACT hoac CALLDATA trong .env');
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: `chain-${CHAIN_ID}` });

  console.log('Dang quet thu muc vi...');
  const wallets = await discoverWallets();
  if (wallets.length === 0) throw new Error('Khong tim thay vi nao.');

  const state = loadState();
  const defaultLoops = parseInt(LOOPS, 10);
  const defaultValue = ethers.parseEther(VALUE_ETH);

  console.log(`\nHe dieu hanh: ${os.platform()} | Thu muc vi: ${path.resolve(WALLETS_DIR)}`);
  console.log(`Tim thay ${wallets.length} vi | Chain ${CHAIN_ID}`);
  console.log(CHECK_ONLY ? 'CHE DO KIEM TRA - khong gui giao dich nao\n' : '');

  // --- Che do SeaDrop: doc thong tin drop MOT LAN cho ca 10 vi ---
  let seaDrop = null;
  let dropSummary = null;

  if (IS_SEADROP) {
    console.log(`Che do: SeaDrop | NFT contract: ${NFT_CONTRACT}`);
    await assertSeaDropDeployed(provider, SEADROP_ADDRESS);
    seaDrop = getSeaDrop(provider, SEADROP_ADDRESS);

    dropSummary = await getPublicDropSummary({ seaDrop, nftContract: NFT_CONTRACT, provider });
    console.log('\n' + formatSummary(dropSummary));

    if (!dropSummary.isOpen) {
      if (dropSummary.notStarted && WAIT_FOR_OPEN.toLowerCase() === 'true' && !CHECK_ONLY) {
        console.log('\nDang cho den gio mo mint...');
        dropSummary = await waitForOpen({
          seaDrop,
          nftContract: NFT_CONTRACT,
          provider,
          pollMs: parseInt(SEADROP_POLL_MS, 10),
          onWait: (s) => console.log(`  con ${s}s...`),
        });
        console.log('Stage da mo.');
      } else if (dropSummary.notStarted) {
        console.log('\nStage chua mo. Dat WAIT_FOR_OPEN=true de script tu cho.');
        if (!CHECK_ONLY) return;
      } else {
        console.log('\nStage da dong. Dung lai.');
        return;
      }
    }
    console.log('');
  }

  // --- Tien kiem tra so du toan bo ---
  console.log('So du:');
  let anyEmpty = false;
  for (const w of wallets) {
    const loops = w.config.loops ?? defaultLoops;
    const bal = await provider.getBalance(w.address);

    let need;
    if (IS_SEADROP) {
      const qty = BigInt(w.config.quantity || SEADROP_QUANTITY || loops || 1);
      need = dropSummary.mintPrice * qty;
    } else {
      const value = w.config.valueEth ? ethers.parseEther(String(w.config.valueEth)) : defaultValue;
      need = value * BigInt(loops);
    }
    const ok = bal > need;
    if (!ok) anyEmpty = true;
    const flag = state.done[w.name] ? ' [da xong]' : '';
    console.log(
      `  ${w.name}  ${w.address}  ${ethers.formatEther(bal)} ETH  ` +
        `${ok ? 'du' : 'THIEU (can ' + ethers.formatEther(need) + ')'}${flag}`
    );
  }
  if (anyEmpty) console.log('\nCo vi thieu tien. Nap them truoc khi chay that.');

  const pending = wallets.filter((w) => !state.done[w.name]);
  console.log(`\nCan xu ly: ${pending.length}/${wallets.length} vi\n`);

  const results = [];

  for (let idx = 0; idx < pending.length; idx++) {
    const w = pending[idx];
    const loops = w.config.loops ?? defaultLoops;
    const value = w.config.valueEth ? ethers.parseEther(String(w.config.valueEth)) : defaultValue;

    console.log(`===== [${idx + 1}/${pending.length}] ${w.name} - ${w.address} =====`);

    const res = IS_SEADROP
      ? await mintSeaDropWithWallet({
          privateKey: w.key,
          provider,
          seaDrop,
          nftContract: NFT_CONTRACT,
          feeRecipient: SEADROP_FEE_RECIPIENT,
          summary: dropSummary,
          desiredQuantity: w.config.quantity || SEADROP_QUANTITY || loops || 1,
          dryRun: CHECK_ONLY,
          gasMultiplier: parseFloat(GAS_MULTIPLIER),
          explorer: EXPLORER,
          log: (m) => console.log(`  ${m}`),
        })
      : await mintWithWallet({
          privateKey: w.key,
          provider,
          contract: CONTRACT,
          calldata: CALLDATA,
          originalMinter: ORIGINAL_MINTER,
          valueWei: value,
          loops,
          delayMs: parseInt(DELAY_MS, 10),
          jitterMs: parseInt(JITTER_MS, 10),
          fast: FAST.toLowerCase() === 'true',
          dryRun: CHECK_ONLY,
          payToken: PAY_TOKEN,
          gasMultiplier: parseFloat(GAS_MULTIPLIER),
          explorer: EXPLORER,
          log: (m) => console.log(`  ${m}`),
        });

    results.push({ name: w.name, ...res });

    // Ghi ket qua rieng cho tung vi
    fs.writeFileSync(
      path.join(w.dir, 'result.json'),
      JSON.stringify({ ...res, at: new Date().toISOString() }, null, 2)
    );

    // Danh dau xong de lan chay sau khong mint de len
    if (!CHECK_ONLY && !res.error && res.failed === 0) {
      state.done[w.name] = { at: new Date().toISOString(), confirmed: res.confirmed, sent: res.sent };
      saveState(state);
    }

    if (res.error) console.log(`  LOI: ${res.error}`);
    console.log(`  -> gui ${res.sent}, xac nhan ${res.confirmed}, that bai ${res.failed}\n`);

    // Nghi giua cac vi
    if (idx < pending.length - 1 && !CHECK_ONLY) {
      const min = parseInt(WALLET_DELAY_MS, 10);
      const max = min + parseInt(WALLET_JITTER_MS, 10);
      console.log(`  (nghi truoc khi sang vi tiep theo)\n`);
      await sleepJitter(min, max);
    }
  }

  // --- Tong ket ---
  console.log('\n========== TONG KET ==========');
  let totalConfirmed = 0;
  let totalFailed = 0;
  for (const r of results) {
    totalConfirmed += r.confirmed;
    totalFailed += r.failed;
    const mintedInfo = r.minted ? ` (${r.minted} NFT)` : '';
    const status = r.error ? `LOI: ${r.error}` : `${r.confirmed} xac nhan${mintedInfo}, ${r.failed} that bai`;
    console.log(`  ${r.name}  ${r.address.slice(0, 10)}...  ${status}`);
  }
  console.log(`\nTong: ${totalConfirmed} mint thanh cong, ${totalFailed} that bai`);
  if (!CHECK_ONLY) console.log(`State luu tai ${STATE_FILE} - chay lai se bo qua cac vi da xong.`);
  console.log('Dung --reset de chay lai tu dau.');
}

main().catch((err) => {
  console.error('\nLoi nghiem trong:', err.message);
  process.exit(1);
});
