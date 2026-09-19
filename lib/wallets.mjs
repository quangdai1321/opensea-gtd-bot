/**
 * Nap vi da ma hoa, dung chung 1 mat khau:
 *   wallet.keystore.json          vi chinh (tao bang: node mintbot.mjs setup)
 *   wallets/<ten>/keystore.json   vi phu (cung dinh dang voi tool cu, chep sang la dung duoc)
 * Key chi nam trong RAM. Vi nao sai mat khau thi bo qua va bao lai.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';

export function keystoreFiles(rootDir) {
  const out = [];
  const main = path.join(rootDir, 'wallet.keystore.json');
  if (fs.existsSync(main)) out.push({ name: 'main', file: main });
  const dir = path.join(rootDir, 'wallets');
  if (fs.existsSync(dir)) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('.')) continue;
      const f = path.join(dir, e.name, 'keystore.json');
      if (fs.existsSync(f)) out.push({ name: e.name, file: f });
    }
  }
  return out.sort((a, b) => (a.name === 'main' ? -1 : b.name === 'main' ? 1 : a.name.localeCompare(b.name, 'en', { numeric: true })));
}

/** -> { wallets: [{ name, address, wallet }], failed: [name] } */
export async function loadWallets(rootDir, password) {
  const wallets = [];
  const failed = [];
  const seen = new Set();
  for (const { name, file } of keystoreFiles(rootDir)) {
    try {
      const wallet = await ethers.Wallet.fromEncryptedJson(fs.readFileSync(file, 'utf8'), password);
      if (seen.has(wallet.address)) continue;
      seen.add(wallet.address);
      wallets.push({ name, address: wallet.address, wallet });
    } catch {
      failed.push(name);
    }
  }
  return { wallets, failed };
}

export const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
