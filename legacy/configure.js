/**
 * Wizard cau hinh tuong tac. Chay: node configure.js
 * Hoi tung cau, kiem tra du lieu, roi ghi ra file .env.
 * Giu nguyen cac dong khac trong .env neu da co.
 */

import fs from 'node:fs';
import readline from 'node:readline/promises';
import { ethers } from 'ethers';
import { CHAINS } from './chains.js';

const ENV_FILE = '.env';
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

/** Doc .env hien co thanh object de lam gia tri mac dinh */
function readEnv() {
  if (!fs.existsSync(ENV_FILE)) return {};
  const out = {};
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** Hoi 1 cau, co gia tri mac dinh, lap lai neu khong hop le */
async function ask(question, { def = '', validate = null, hint = '' } = {}) {
  for (;;) {
    if (hint) console.log(`  ${hint}`);
    const suffix = def ? ` [${def}]` : '';
    const raw = (await rl.question(`${question}${suffix}: `)).trim();
    const val = raw || def;

    if (!val) {
      console.log('  -> Bat buoc phai nhap.\n');
      continue;
    }
    if (validate) {
      const err = validate(val);
      if (err) {
        console.log(`  -> ${err}\n`);
        continue;
      }
    }
    console.log('');
    return val;
  }
}

async function askChoice(question, choices, def) {
  console.log(`\n${question}`);
  choices.forEach((c, i) => console.log(`  ${i + 1}) ${c.label}`));
  for (;;) {
    const raw = (await rl.question(`Chon [${def}]: `)).trim() || String(def);
    const idx = parseInt(raw, 10);
    if (idx >= 1 && idx <= choices.length) {
      console.log('');
      return choices[idx - 1].value;
    }
    console.log('  -> Nhap so trong danh sach.');
  }
}

const isAddress = (v) => (ethers.isAddress(v) ? null : 'Dia chi khong hop le (phai la 0x + 40 ky tu hex)');
const isPositiveInt = (v) => (/^\d+$/.test(v) && parseInt(v, 10) > 0 ? null : 'Phai la so nguyen duong');
const isHex = (v) => (/^0x[0-9a-fA-F]+$/.test(v) ? null : 'Phai la chuoi hex bat dau bang 0x');
const isNumber = (v) => (!isNaN(parseFloat(v)) && parseFloat(v) >= 0 ? null : 'Phai la so');

async function main() {
  console.log('=================================');
  console.log('  Cau hinh Bot-Mint');
  console.log('=================================');
  console.log('Enter de giu gia tri trong ngoac vuong.\n');

  const cur = readEnv();
  const env = { ...cur };

  // --- Chain ---
  const chainNames = Object.keys(CHAINS);
  const chainChoices = [
    ...chainNames.map((n) => ({ label: `${n} (chain ID ${CHAINS[n].chainId})`, value: n })),
    { label: 'Khac - tu nhap chain ID va RPC', value: '__custom__' },
  ];
  const defChainIdx = Math.max(1, chainNames.indexOf(cur.CHAIN || 'robinhood') + 1);
  const chain = await askChoice('Chon chain:', chainChoices, defChainIdx);

  if (chain === '__custom__') {
    delete env.CHAIN;
    env.CHAIN_ID = await ask('Chain ID', { def: cur.CHAIN_ID, validate: isPositiveInt, hint: 'Tra tai https://chainlist.org' });
    env.RPC_URL = await ask('RPC URL', { def: cur.RPC_URL });
    env.EXPLORER = await ask('Explorer (dang .../tx/)', { def: cur.EXPLORER || '' });
  } else {
    env.CHAIN = chain;
    delete env.CHAIN_ID;
    delete env.RPC_URL;
    delete env.EXPLORER;
  }

  // --- Che do mint ---
  const mode = await askChoice(
    'Che do mint:',
    [
      { label: 'seadrop  - drop cua OpenSea. Doc gia tu contract. NEN DUNG.', value: 'seadrop' },
      { label: 'calldata - replay calldata copy tu explorer. Dung khi khong phai SeaDrop.', value: 'calldata' },
    ],
    cur.MINT_MODE === 'calldata' ? 2 : 1
  );
  env.MINT_MODE = mode;

  if (mode === 'seadrop') {
    env.NFT_CONTRACT = await ask('Dia chi contract NFT', {
      def: cur.NFT_CONTRACT && ethers.isAddress(cur.NFT_CONTRACT) ? cur.NFT_CONTRACT : '',
      validate: isAddress,
      hint: 'Tren trang OpenSea, keo xuong muc Details -> Contract Address.\n  Day KHONG phai dia chi SeaDrop 0x00005EA0...',
    });
    env.SEADROP_QUANTITY = await ask('So luong mint moi vi', {
      def: cur.SEADROP_QUANTITY || '1',
      validate: isPositiveInt,
      hint: 'Lan dau nen de 1 de thu. Script tu ha xuong neu vuot gioi han.',
    });
    const wait = await askChoice(
      'Neu stage chua mo thi sao?',
      [
        { label: 'Thoat luon', value: 'false' },
        { label: 'Cho den gio mo roi ban', value: 'true' },
      ],
      cur.WAIT_FOR_OPEN === 'true' ? 2 : 1
    );
    env.WAIT_FOR_OPEN = wait;
  } else {
    env.CONTRACT = await ask('Dia chi contract nhan giao dich', {
      def: cur.CONTRACT && ethers.isAddress(cur.CONTRACT) ? cur.CONTRACT : '',
      validate: isAddress,
      hint: 'Truong "To" cua giao dich mint thu cong tren explorer',
    });
    env.CALLDATA = await ask('Calldata', {
      def: cur.CALLDATA && cur.CALLDATA.startsWith('0x') ? cur.CALLDATA : '',
      validate: isHex,
      hint: 'Tab "Raw input" cua giao dich mint thu cong',
    });
    env.VALUE_ETH = await ask('So ETH moi giao dich', {
      def: cur.VALUE_ETH || '0',
      validate: isNumber,
      hint: 'Truong "Value" cua giao dich mint thu cong',
    });
    const om = (
      await rl.question('Dia chi vi da mint thu cong (Enter de bo qua): ')
    ).trim();
    if (om) {
      if (!ethers.isAddress(om)) console.log('  -> Dia chi khong hop le, bo qua.');
      else env.ORIGINAL_MINTER = om;
    }
    env.LOOPS = await ask('\nSo giao dich moi vi', { def: cur.LOOPS || '1', validate: isPositiveInt });
  }

  // --- Cac gia tri mac dinh khac ---
  env.WALLETS_DIR = cur.WALLETS_DIR || './wallets';
  env.DELAY_MS = cur.DELAY_MS || '2000';
  env.JITTER_MS = cur.JITTER_MS || '3000';
  env.WALLET_DELAY_MS = cur.WALLET_DELAY_MS || '5000';
  env.WALLET_JITTER_MS = cur.WALLET_JITTER_MS || '10000';
  env.GAS_MULTIPLIER = cur.GAS_MULTIPLIER || '1.3';

  // --- Xac nhan ---
  console.log('=================================');
  console.log('  Xem lai cau hinh');
  console.log('=================================');
  const show = ['CHAIN', 'CHAIN_ID', 'RPC_URL', 'MINT_MODE', 'NFT_CONTRACT', 'SEADROP_QUANTITY', 'WAIT_FOR_OPEN', 'CONTRACT', 'CALLDATA', 'VALUE_ETH', 'ORIGINAL_MINTER', 'LOOPS'];
  for (const k of show) {
    if (env[k]) {
      const v = env[k].length > 50 ? env[k].slice(0, 47) + '...' : env[k];
      console.log(`  ${k.padEnd(18)} = ${v}`);
    }
  }

  const ok = (await rl.question('\nLuu vao .env? (Y/n): ')).trim().toLowerCase();
  if (ok === 'n') {
    console.log('Da huy, khong ghi gi.');
    rl.close();
    return;
  }

  // Sao luu ban cu
  if (fs.existsSync(ENV_FILE)) {
    fs.copyFileSync(ENV_FILE, ENV_FILE + '.bak');
    console.log(`\nDa sao luu ban cu -> ${ENV_FILE}.bak`);
  }

  const lines = [
    '# Tao boi configure.js - ' + new Date().toISOString(),
    '# Chay lai "node configure.js" de sua.',
    '',
  ];
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && v !== '') lines.push(`${k}=${v}`);
  }
  fs.writeFileSync(ENV_FILE, lines.join('\n') + '\n');

  console.log(`Da ghi ${ENV_FILE}\n`);
  console.log('Buoc tiep theo:');
  console.log('  node run-all.js --check     kiem tra, khong gui giao dich nao');
  rl.close();
}

main().catch((err) => {
  console.error('\nLoi:', err.message);
  rl.close();
  process.exit(1);
});
