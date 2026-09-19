/**
 * Tao san khung thu muc vi. Chay: node setup-wallets.js 10
 * KHONG tao private key ho ban - ban tu dan key vao tung file key.txt.
 */
import fs from 'node:fs';
import path from 'node:path';

const n = parseInt(process.argv[2] || '10', 10);
const base = process.env.WALLETS_DIR || './wallets';

fs.mkdirSync(base, { recursive: true });

for (let i = 1; i <= n; i++) {
  const name = String(i).padStart(2, '0');
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });

  const keyFile = path.join(dir, 'key.txt');
  if (!fs.existsSync(keyFile)) {
    fs.writeFileSync(keyFile, '# dan private key vao day, thay ca dong nay\n');
  }
}

console.log(`Da tao ${n} folder trong ${base}`);
console.log('Buoc tiep: mo tung file key.txt va dan private key vao (thay ca dong comment).');
console.log('Sau do chay: node run-all.js --check');
