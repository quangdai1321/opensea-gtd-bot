/**
 * Do contract NFT de biet nen dung MINT_MODE nao.
 * Chi doc, khong gui giao dich, khong can private key.
 *
 * Chay:  node probe.js 0xDIA_CHI_CONTRACT
 * Hoac:  node probe.js          (lay NFT_CONTRACT tu .env)
 */

import 'dotenv/config';
import { ethers } from 'ethers';
import { resolveChain } from './chains.js';
import { DEFAULT_SEADROP_ADDRESS, SEADROP_ABI, TOKEN_ABI } from './seadrop.js';

const target = process.argv[2] || process.env.NFT_CONTRACT || process.env.CONTRACT;
if (!target || !ethers.isAddress(target)) {
  console.error('Dung: node probe.js 0xDIA_CHI_CONTRACT');
  process.exit(1);
}


/** Bao loi cau hinh thanh cau nhac viec, khong nem stack trace vao mat nguoi dung */
function resolveChainOrExit(env) {
  try {
    return resolveChain(env);
  } catch (err) {
    console.error('\nChua cau hinh chain: ' + err.message);
    console.error('Chay "node configure.js" de tao file .env.\n');
    process.exit(1);
  }
}
const { chainId, rpc, explorer } = resolveChainOrExit(process.env);
const provider = new ethers.JsonRpcProvider(rpc, { chainId, name: `chain-${chainId}` });

const ok = (s) => `  [OK]   ${s}`;
const no = (s) => `  [--]   ${s}`;

/** Goi thu 1 ham view, tra ve null neu that bai */
async function tryCall(address, abi, fn, args = []) {
  try {
    const c = new ethers.Contract(address, abi, provider);
    return await c[fn](...args);
  } catch {
    return null;
  }
}

async function main() {
  const addr = ethers.getAddress(target);
  console.log('=================================');
  console.log('  Do contract NFT');
  console.log('=================================');
  console.log(`Contract : ${addr}`);
  console.log(`Chain    : ${chainId}`);
  console.log(`Explorer : ${explorer}${''}`);
  console.log('');

  // --- 1. Contract co ton tai khong ---
  const code = await provider.getCode(addr);
  if (!code || code === '0x') {
    console.log('  [!!]   Khong co contract tai dia chi nay. Kiem tra lai dia chi va chain.');
    return;
  }
  console.log(ok(`Contract ton tai (${(code.length - 2) / 2} byte bytecode)`));

  // --- 2. Thong tin ERC721 co ban ---
  console.log('\n--- Thong tin co ban ---');
  const erc721 = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function totalSupply() view returns (uint256)',
    'function maxSupply() view returns (uint256)',
    'function supportsInterface(bytes4) view returns (bool)',
  ];
  const name = await tryCall(addr, erc721, 'name');
  const symbol = await tryCall(addr, erc721, 'symbol');
  const totalSupply = await tryCall(addr, erc721, 'totalSupply');
  const maxSupply = await tryCall(addr, erc721, 'maxSupply');

  console.log(name ? ok(`name()        = ${name}`) : no('name() khong doc duoc'));
  console.log(symbol ? ok(`symbol()      = ${symbol}`) : no('symbol() khong doc duoc'));
  console.log(totalSupply !== null ? ok(`totalSupply() = ${totalSupply}`) : no('totalSupply() khong co'));
  console.log(maxSupply !== null ? ok(`maxSupply()   = ${maxSupply}`) : no('maxSupply() khong co'));

  const isERC721 = await tryCall(addr, erc721, 'supportsInterface', ['0x80ac58cd']);
  console.log(isERC721 ? ok('La ERC-721') : no('supportsInterface(ERC721) khong tra ve true'));

  // --- 3. getMintStats (dac trung cua SeaDrop) ---
  console.log('\n--- getMintStats (dac trung SeaDrop) ---');
  const probe = '0x000000000000000000000000000000000000dEaD';
  const stats = await tryCall(addr, TOKEN_ABI, 'getMintStats', [probe]);
  if (stats) {
    console.log(ok(`getMintStats() co - totalSupply=${stats[1]}, maxSupply=${stats[2]}`));
  } else {
    console.log(no('getMintStats() khong co -> nhieu kha nang KHONG phai SeaDrop chuan'));
  }

  // --- 4. SeaDrop tren chain nay ---
  console.log('\n--- Contract SeaDrop ---');
  const sdAddr = process.env.SEADROP_ADDRESS || DEFAULT_SEADROP_ADDRESS;
  const sdCode = await provider.getCode(sdAddr);
  let dropOk = false;

  if (!sdCode || sdCode === '0x') {
    console.log(no(`Khong co SeaDrop tai ${sdAddr} tren chain nay`));
  } else {
    console.log(ok(`SeaDrop ton tai tai ${sdAddr}`));
    const drop = await tryCall(sdAddr, SEADROP_ABI, 'getPublicDrop', [addr]);
    if (drop) {
      const price = BigInt(drop.mintPrice);
      dropOk = price > 0n;
      console.log(ok('getPublicDrop() doc duoc:'));
      console.log(`         mintPrice           = ${ethers.formatEther(price)} (native)`);
      console.log(`         maxPerWallet        = ${drop.maxTotalMintableByWallet}`);
      console.log(`         startTime           = ${drop.startTime}`);
      console.log(`         endTime             = ${drop.endTime}`);
      console.log(`         feeBps              = ${drop.feeBps}`);
      if (price === 0n) {
        console.log('  [!!]   mintPrice = 0 -> mint KHONG tra bang coin native.');
        console.log('         Rat co the tra bang ERC-20 (USDG). Che do seadrop se khong dung.');
      }
    } else {
      console.log(no('getPublicDrop() cho contract nay that bai -> khong dang ky voi SeaDrop chuan'));
    }
  }

  // --- 5. Ket luan ---
  console.log('\n=================================');
  console.log('  Ket luan');
  console.log('=================================');
  if (dropOk) {
    console.log('  Dung MINT_MODE=seadrop');
    console.log(`  NFT_CONTRACT=${addr}`);
  } else {
    console.log('  Dung MINT_MODE=calldata');
    console.log('  Ly do: contract khong dung SeaDrop chuan, hoac mint tra bang ERC-20.');
    console.log('');
    console.log('  Cac buoc:');
    console.log('   1. Mint tay 1 cai tren OpenSea');
    console.log('   2. Mo giao dich do tren explorer, xem truong "Value":');
    console.log('        Value > 0     -> tra bang coin native');
    console.log('        Value = 0     -> tra bang ERC-20, xem "Tokens Transferred"');
    console.log('                         lay dia chi token do dien vao PAY_TOKEN');
    console.log('   3. Copy "To", "Raw input", "Value" vao .env (node configure.js)');
    console.log('   4. node inspect.js   de xem calldata co ghi cung dia chi vi khong');
  }
}

main().catch((err) => {
  console.error('\nLoi:', err.shortMessage || err.message);
  process.exit(1);
});
