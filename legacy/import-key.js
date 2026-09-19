/**
 * Nhap private key THANG vao keystore da ma hoa.
 *
 *   node import-key.js
 *
 * Khac voi setup-wallets.js + encrypt-keys.js:
 *   - Key KHONG BAO GIO duoc ghi ra dia dang chu tho
 *   - Key khong hien tren man hinh khi go (raw mode, khong echo)
 *   - Key khong vao lich su lenh cua shell (khong phai tham so dong lenh)
 *   - Duong di duy nhat: ban phim -> RAM -> ma hoa scrypt -> keystore.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import { promptPassword } from './keystore.js';

const WALLETS_DIR = process.env.WALLETS_DIR || './wallets';
const SLOT = process.argv[2] || '01';
const EXPECT = (process.argv[3] || '').toLowerCase();
const SCRYPT_N = parseInt(process.env.SCRYPT_N || '262144', 10);

async function main() {
  const dir = path.join(WALLETS_DIR, SLOT);
  const ksPath = path.join(dir, 'keystore.json');

  if (fs.existsSync(ksPath)) {
    throw new Error(`${ksPath} da ton tai. Xoa no truoc neu muon nhap lai.`);
  }

  console.log('=================================');
  console.log('  Nhap key vao keystore ma hoa');
  console.log('=================================');
  console.log('Key se KHONG hien khi ban go, va KHONG bao gio duoc ghi ra dia dang tho.');
  console.log('Dan key roi bam Enter (chuot phai de dan neu Ctrl+V khong an).\n');

  const raw = (await promptPassword('Private key: ')).trim();
  if (!raw) throw new Error('Chua nhap gi.');

  const key = raw.startsWith('0x') ? raw : '0x' + raw;
  let wallet;
  try {
    wallet = new ethers.Wallet(key);
  } catch {
    throw new Error('Private key khong hop le (phai la 64 ky tu hex).');
  }

  console.log(`\nDia chi suy ra tu key: ${wallet.address}`);
  if (EXPECT) {
    if (wallet.address.toLowerCase() !== EXPECT) {
      throw new Error(`KHONG KHOP dia chi mong doi ${EXPECT}. Dung lai, khong ghi gi.`);
    }
    console.log('=> KHOP dia chi mong doi.\n');
  }

  const pw = await promptPassword('Dat mat khau keystore (it nhat 8 ky tu): ');
  if (pw.length < 8) throw new Error('Mat khau qua ngan.');
  const pw2 = await promptPassword('Nhap lai mat khau: ');
  if (pw !== pw2) throw new Error('Hai lan nhap khong khop.');

  console.log('\nDang ma hoa (scrypt cham la binh thuong, ~2-4 giay)...');
  const json = await ethers.encryptKeystoreJson(
    { address: wallet.address, privateKey: wallet.privateKey },
    pw,
    { scrypt: { N: SCRYPT_N } }
  );

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ksPath, json);

  // Kiem chung: giai ma lai ngay de chac chan keystore dung truoc khi ban tin no
  const check = await ethers.Wallet.fromEncryptedJson(fs.readFileSync(ksPath, 'utf8'), pw);
  if (check.address !== wallet.address) throw new Error('Kiem chung that bai. Keystore hong.');

  console.log(`\nDa ghi ${ksPath}`);
  console.log(`Kiem chung giai ma lai: OK -> ${check.address}`);
  console.log('\nKhong co file key tho nao duoc tao. Xong.');
}

main().catch((err) => {
  console.error('\nLoi:', err.message);
  process.exit(1);
});
