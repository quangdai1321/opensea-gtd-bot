/**
 * Nap .env vao process.env NGAY KHI import.
 *
 * Phai la module rieng va duoc import DAU TIEN: JavaScript chay het cac import truoc than file,
 * nen neu goi loadEnv() trong main() thi cac hang so doc process.env o dau cac module khac
 * (BURST_SPACING_MS, MINT_LEAD_SECONDS...) da bi tinh xong bang gia tri mac dinh.
 * Bien moi truong that cua he dieu hanh van duoc uu tien hon .env.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let loaded = false;

export function loadEnv() {
  if (loaded) return;
  loaded = true;
  let text = '';
  try {
    text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

/** So tu .env, khong hop le thi dung mac dinh */
export function envNum(key, def) {
  const v = Number(process.env[key]);
  return process.env[key] !== undefined && process.env[key] !== '' && Number.isFinite(v) ? v : def;
}

loadEnv();
