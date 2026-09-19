/**
 * Ma hoa tat ca key.txt thanh keystore.json.
 * Chay MOT LAN sau khi da dan het private key vao cac file key.txt.
 *
 *   node encrypt-keys.js
 *
 * Sau khi ma hoa xong, script se hoi co xoa key.txt goc khong.
 */

import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { ethers } from 'ethers';
import { promptPassword } from './keystore.js';

const WALLETS_DIR = process.env.WALLETS_DIR || './wallets';

// scrypt mac dinh cua ethers rat cham (~1s/vi). Ha xuong cho 10 vi de do sot ruot.
// Van an toan hon nhieu so voi de key tho tren o NTFS.
const SCRYPT_N = parseInt(process.env.SCRYPT_N || '131072', 10);

/** Ghi de file bang du lieu ngau nhien roi moi xoa */
function shredFile(file) {
  try {
    const size = fs.statSync(file).size;
    for (let i = 0; i < 2; i++) {
      fs.writeFileSync(file, Buffer.from(crypto.randomBytes(Math.max(size, 64))));
    }
  } catch {
    /* co gang thoi */
  }
  fs.unlinkSync(file);
}

async function main() {
  if (!fs.existsSync(WALLETS_DIR)) {
    throw new Error(`Khong thay ${WALLETS_DIR}. Chay "node setup-wallets.js 10" truoc.`);
  }

  const dirs = fs
    .readdirSync(WALLETS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();

  // Tim cac folder co key tho chua ma hoa
  const targets = [];
  for (const name of dirs) {
    const dir = path.join(WALLETS_DIR, name);
    if (fs.existsSync(path.join(dir, 'keystore.json'))) {
      console.log(`  ${name}: da co keystore.json, bo qua`);
      continue;
    }
    const plainFile = ['key.txt', 'private_key.txt', 'pk.txt']
      .map((f) => path.join(dir, f))
      .find((f) => fs.existsSync(f));
    if (!plainFile) {
      console.log(`  ${name}: khong thay key tho, bo qua`);
      continue;
    }
    const raw = fs.readFileSync(plainFile, 'utf8');
    const line = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'));
    if (!line) {
      console.log(`  ${name}: file rong hoac chua dan key, bo qua`);
      continue;
    }
    const key = line.startsWith('0x') ? line : '0x' + line;
    try {
      const wallet = new ethers.Wallet(key);
      targets.push({ name, dir, plainFile, wallet });
    } catch {
      console.log(`  ${name}: private key khong hop le, bo qua`);
    }
  }

  if (targets.length === 0) {
    console.log('\nKhong co gi de ma hoa.');
    return;
  }

  console.log(`\nSe ma hoa ${targets.length} vi:`);
  for (const t of targets) console.log(`  ${t.name}  ${t.wallet.address}`);

  const pw = process.env.KEYSTORE_PASSWORD || (await promptPassword('\nDat mat khau (dung 1 mat khau cho tat ca): '));
  if (!process.env.KEYSTORE_PASSWORD) {
    const pw2 = await promptPassword('Nhap lai mat khau: ');
    if (pw !== pw2) throw new Error('Hai lan nhap khong khop.');
  }
  if (pw.length < 8) throw new Error('Mat khau qua ngan, dat it nhat 8 ky tu.');

  console.log('\nDang ma hoa (scrypt cham la binh thuong)...');
  for (const t of targets) {
    const json = await ethers.encryptKeystoreJson(
      { address: t.wallet.address, privateKey: t.wallet.privateKey },
      pw,
      { scrypt: { N: SCRYPT_N } }
    );
    fs.writeFileSync(path.join(t.dir, 'keystore.json'), json);
    console.log(`  ${t.name} xong`);
  }

  // Hoi truoc khi xoa ban goc
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question('\nXoa cac file key tho? Nen xoa. (y/N): ')).trim().toLowerCase();
  rl.close();

  if (ans === 'y') {
    for (const t of targets) {
      shredFile(t.plainFile);
      console.log(`  da xoa ${path.relative('.', t.plainFile)}`);
    }
    console.log('\nLuu y: dam bao ban da backup private key o cho khac truoc khi xoa.');
  } else {
    console.log('\nGiu lai key tho. Nho xoa thu cong sau khi da chac chan keystore hoat dong.');
  }

  console.log('\nXong. Tu gio chay "node run-all.js" se hoi mat khau.');
}

main().catch((err) => {
  console.error('\nLoi:', err.message);
  process.exit(1);
});
