/**
 * Soi calldata: tach thanh cac word 32 byte, danh dau cai nao trong giong dia chi vi.
 * Muc dich: biet contract co ghi cung dia chi nguoi nhan vao calldata hay khong.
 *
 * Chay: node inspect.js
 */

import 'dotenv/config';
import { ethers } from 'ethers';

const { CALLDATA, ORIGINAL_MINTER = '', PRIVATE_KEY = '' } = process.env;

if (!CALLDATA) {
  console.error('Thieu CALLDATA trong .env');
  process.exit(1);
}

const hex = CALLDATA.toLowerCase().replace(/^0x/, '');
const selector = hex.slice(0, 8);
const body = hex.slice(8);

// Dia chi cua vi da mint tay. Neu khong dien ORIGINAL_MINTER thi suy tu PRIVATE_KEY.
let me = ORIGINAL_MINTER.toLowerCase();
if (!me && PRIVATE_KEY) {
  try {
    me = new ethers.Wallet(PRIVATE_KEY).address.toLowerCase();
  } catch {
    /* bo qua */
  }
}

console.log('Selector (4 byte dau):', '0x' + selector);
console.log('Tra cuu selector nay tai: https://www.4byte.directory/signatures/?bytes4_sig=0x' + selector);
console.log(`Do dai calldata: ${hex.length / 2} byte | ${Math.floor(body.length / 64)} word\n`);

if (body.length % 64 !== 0) {
  console.log('Luu y: do dai khong chia het cho 32 byte -> calldata co the chua mang hoac bytes dong.\n');
}

const ADDR_PREFIX = '0'.repeat(24);
const found = [];

for (let i = 0; i < Math.floor(body.length / 64); i++) {
  const word = body.slice(i * 64, i * 64 + 64);
  const asNum = BigInt('0x' + word);

  let note = '';
  if (word.startsWith(ADDR_PREFIX) && asNum !== 0n) {
    const addr = ethers.getAddress('0x' + word.slice(24));
    note = `  <-- DIA CHI: ${addr}`;
    if (me && word.slice(24) === me.replace(/^0x/, '')) {
      note += '  *** DAY LA VI CUA BAN ***';
      found.push(i);
    }
  } else if (asNum === 0n) {
    note = '  <-- so 0 / address(0) (thuong nghia la "dung msg.sender")';
  } else if (asNum < 1000000n) {
    note = `  <-- so nho: ${asNum} (co the la so luong mint)`;
  } else if (asNum < 10n ** 24n) {
    note = `  <-- so lon: ${asNum} (co the la gia tinh bang wei)`;
  }

  console.log(`word[${String(i).padStart(2)}] ${word}${note}`);
}

console.log('\n--- Ket luan ---');
if (!me) {
  console.log('Chua biet dia chi vi cua ban. Dien ORIGINAL_MINTER vao .env roi chay lai.');
} else if (found.length > 0) {
  console.log(`Dia chi vi cua ban xuat hien ${found.length} lan trong calldata (word ${found.join(', ')}).`);
  console.log('=> Contract ghi cung nguoi nhan. Neu replay bang vi khac ma khong va,');
  console.log('   NFT se ve vi cu con vi moi mat tien.');
  console.log('=> Dien ORIGINAL_MINTER vao .env, mint.js se tu va dia chi cho ban.');
} else {
  console.log('Khong thay dia chi vi cua ban trong calldata.');
  console.log('=> Contract nhieu kha nang dung msg.sender. Vi nao ky thi vi do nhan NFT.');
  console.log('=> Cu doi PRIVATE_KEY la xong, khong can va gi ca.');
}
