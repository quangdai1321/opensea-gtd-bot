/**
 * Doc private key tu folder vi. Ho tro 2 dinh dang:
 *   1. keystore.json  - da ma hoa (Web3 Secret Storage chuan) <- NEN DUNG
 *   2. key.txt        - text tho, tien nhung khong an toan
 *
 * Ma hoa la cach duy nhat bao ve key khi de tren o NTFS dung chung
 * giua Linux va Windows, vi NTFS khong luu quyen POSIX (chmod vo tac dung).
 */

import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';

/** Nhap mat khau ma khong hien tren man hinh. Chay duoc ca Linux va Windows. */
export function promptPassword(question = 'Mat khau keystore: ') {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      return reject(
        new Error('Khong phai terminal tuong tac. Dat KEYSTORE_PASSWORD trong .env hoac chay truc tiep tu terminal.')
      );
    }
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let pw = '';
    const onData = (ch) => {
      switch (ch) {
        case '\r':
        case '\n':
        case '\u0004': // Ctrl-D
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(pw);
          break;
        case '\u0003': // Ctrl-C
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(1);
          break;
        case '\u0008':
        case '\u007f': // Backspace
          pw = pw.slice(0, -1);
          break;
        default:
          // Bo qua cac ky tu dieu khien khac
          if (ch >= ' ') pw += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/** Doc key tho tu file text, chiu duoc ca line ending Windows (CRLF) */
function readPlainKey(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const line = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'));
  if (!line) return null;
  return line.startsWith('0x') ? line : '0x' + line;
}

/**
 * Nap vi tu folder. Tra ve { wallet, source } hoac null.
 * Uu tien keystore.json neu co.
 */
export async function loadWalletFromDir(dir, password) {
  const keystorePath = path.join(dir, 'keystore.json');

  if (fs.existsSync(keystorePath)) {
    if (!password) throw new Error('Co keystore.json nhung chua co mat khau');
    const json = fs.readFileSync(keystorePath, 'utf8');
    const wallet = await ethers.Wallet.fromEncryptedJson(json, password);
    return { wallet, source: 'keystore' };
  }

  for (const name of ['key.txt', 'private_key.txt', 'pk.txt']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) {
      const key = readPlainKey(p);
      if (!key) continue;
      return { wallet: new ethers.Wallet(key), source: 'plaintext' };
    }
  }

  const envPath = path.join(dir, '.env');
  if (fs.existsSync(envPath)) {
    const m = fs.readFileSync(envPath, 'utf8').match(/PRIVATE_KEY\s*=\s*(\S+)/);
    if (m) {
      const key = m[1].startsWith('0x') ? m[1] : '0x' + m[1];
      return { wallet: new ethers.Wallet(key), source: 'plaintext' };
    }
  }

  return null;
}

/** Kiem tra folder co keystore da ma hoa hay khong (khong can mat khau) */
export function hasKeystore(dir) {
  return fs.existsSync(path.join(dir, 'keystore.json'));
}
