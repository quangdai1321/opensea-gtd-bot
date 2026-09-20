/**
 * Nhat ky do thoi gian moi lan mint -> mint-log.jsonl (moi dong 1 JSON).
 * Dung de tim cho cham: do tre tung RPC, bao lau moi phat hien stage mo, bao lau moi gui xong.
 *   node mintlog.mjs   -> xem tom tat
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mint-log.jsonl');

export function logMint(entry) {
  try {
    fs.appendFileSync(FILE, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch {
    /* khong ghi duoc thi thoi, khong lam hong lan mint */
  }
}

export function readLog() {
  try {
    return fs.readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** "drpc 120ms ✅ | official 300ms ✅" */
export function rpcLine(stats = []) {
  return stats.map((s) => `${String(s.url || 'rpc').replace(/^https?:\/\//, '').split('.')[0]} ${Math.round(s.ms)}ms ${s.ok ? '✅' : '❌'}`).join(' | ');
}
