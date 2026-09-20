/**
 * Xem nhat ky do thoi gian cac lan mint: node mintlog.mjs
 * Cho biet cho nao cham de toi uu (RPC nao nhanh, do bao lau moi thay stage mo...).
 */
import { readLog, rpcLine } from './lib/telemetry.mjs';

const rows = readLog();
if (rows.length === 0) {
  console.log('Chua co lan mint nao duoc ghi (mint-log.jsonl trong).');
  process.exit(0);
}
const t = (v) => (v === null || v === undefined ? '  -  ' : `${String(Math.round(v)).padStart(5)}`);
console.log('gio      vi     kieu    chuan bi  do  thay mo   gui  xac nhan  ket qua  RPC');
for (const r of rows.slice(-25)) {
  const time = new Date(r.at).toLocaleTimeString('vi-VN', { hour12: false, timeZone: 'Asia/Ho_Chi_Minh' });
  console.log(
    `${time} ${String(r.wallet).padEnd(6)} ${String(r.kind).padEnd(7)}`,
    `${t(r.prepMs)}ms`, `${String(r.probes ?? '-').padStart(4)}`, `${t(r.openDetectedMs)}ms`,
    `${t(r.sentAfterOpenMs)}ms`, `${t(r.minedAfterOpenMs)}ms`, ` ${String(r.status).padEnd(7)}`, rpcLine(r.rpc),
  );
}
const done = rows.filter((r) => r.status === 'done' && r.sentAfterOpenMs != null);
if (done.length) {
  const v = done.map((r) => r.sentAfterOpenMs).sort((a, b) => a - b);
  console.log(`\n${done.length} lan ban thanh cong: nhanh nhat ${Math.round(v[0])}ms | trung vi ${Math.round(v[Math.floor(v.length / 2)])}ms | cham nhat ${Math.round(v.at(-1))}ms sau gio mo`);
}
