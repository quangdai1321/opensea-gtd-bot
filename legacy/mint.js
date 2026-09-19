/**
 * Auto-mint NFT tren bat ky chain EVM nao.
 * Nguyen ly: "replay calldata" - ban mint tay 1 lan, copy raw input tu explorer,
 * script gui lai giao dich do nhieu lan. Khong can biet ABI cua contract.
 *
 * Chay: node mint.js
 */

import 'dotenv/config';
import { ethers } from 'ethers';
import { resolveChain } from './chains.js';


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
const { chainId: CHAIN_ID, rpc: RPC_URL, explorer: EXPLORER } = resolveChainOrExit(process.env);

const {
  PRIVATE_KEY,
  CONTRACT,
  CALLDATA,
  VALUE_ETH = '0',
  LOOPS = '1',
  DELAY_MS = '2000',
  FAST = 'false',
  DRY_RUN = 'false',
  GAS_MULTIPLIER = '1.3',
  PAY_TOKEN = '',
  ORIGINAL_MINTER = '',
} = process.env;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Thay dia chi vi cu bang vi hien tai trong calldata.
 * Chi thay dung dia chi vi da mint tay - KHONG dung tim-thay-dia-chi-nao-thay-dia-chi-do,
 * vi calldata thuong con chua dia chi contract va vi nhan phi cua marketplace.
 */
function patchRecipient(calldata, oldAddr, newAddr) {
  const pad = (a) => '0'.repeat(24) + a.toLowerCase().replace(/^0x/, '');
  const needle = pad(oldAddr);
  const replacement = pad(newAddr);
  const lower = calldata.toLowerCase();
  const count = lower.split(needle).length - 1;
  return { data: count > 0 ? lower.split(needle).join(replacement) : calldata, count };
}

function requireEnv(name, value) {
  if (!value) throw new Error(`Thieu ${name} trong file .env`);
  return value;
}

async function main() {
  requireEnv('PRIVATE_KEY', PRIVATE_KEY);
  requireEnv('CONTRACT', CONTRACT);
  requireEnv('CALLDATA', CALLDATA);

  if (!ethers.isAddress(CONTRACT)) throw new Error(`CONTRACT khong hop le: ${CONTRACT}`);
  if (!/^0x[0-9a-fA-F]*$/.test(CALLDATA)) throw new Error('CALLDATA phai la chuoi hex bat dau bang 0x');

  const loops = parseInt(LOOPS, 10);
  const delay = parseInt(DELAY_MS, 10);
  const fast = FAST.toLowerCase() === 'true';
  const dryRun = DRY_RUN.toLowerCase() === 'true';
  const value = ethers.parseEther(VALUE_ETH);

  // Khai bao network san de ethers khong phai goi them RPC
  const provider = new ethers.JsonRpcProvider(RPC_URL, {
    chainId: CHAIN_ID,
    name: `chain-${CHAIN_ID}`,
  });
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  // Va dia chi nguoi nhan neu calldata ghi cung vi da mint tay
  let data = CALLDATA;
  if (ORIGINAL_MINTER) {
    if (!ethers.isAddress(ORIGINAL_MINTER)) {
      throw new Error(`ORIGINAL_MINTER khong hop le: ${ORIGINAL_MINTER}`);
    }
    if (ORIGINAL_MINTER.toLowerCase() !== wallet.address.toLowerCase()) {
      const res = patchRecipient(CALLDATA, ORIGINAL_MINTER, wallet.address);
      data = res.data;
      if (res.count > 0) {
        console.log(`Da va ${res.count} vi tri dia chi trong calldata: ${ORIGINAL_MINTER} -> ${wallet.address}\n`);
      } else {
        console.log('Khong thay dia chi vi cu trong calldata.');
        console.log('=> Contract nhieu kha nang dung msg.sender, NFT se ve dung vi dang ky. OK.\n');
      }
    }
  } else {
    console.log('Chua dien ORIGINAL_MINTER. Chay "node inspect.js" de kiem tra');
    console.log('calldata co ghi cung dia chi nguoi nhan hay khong.\n');
  }

  console.log('--- Cau hinh ---');
  console.log('Chain ID  :', CHAIN_ID);
  console.log('RPC       :', RPC_URL);
  console.log('Vi ky/nhan:', wallet.address);
  console.log('Contract  :', CONTRACT);
  console.log('Value/tx  :', ethers.formatEther(value), 'ETH');
  console.log('So lan    :', loops, fast ? '(fast mode - khong doi confirm)' : '');
  console.log('----------------\n');

  // 1. Kiem tra so du
  const balance = await provider.getBalance(wallet.address);
  const needed = value * BigInt(loops);
  console.log(`So du: ${ethers.formatEther(balance)} ETH | Can it nhat: ${ethers.formatEther(needed)} ETH (chua tinh gas)`);
  if (balance <= needed) {
    throw new Error('So du khong du de mint het so lan yeu cau. Bridge them ETH sang Robinhood Chain.');
  }

  // 1b. Neu mint tra bang ERC20 (USDC, WETH...) thi phai approve truoc
  if (PAY_TOKEN) {
    const erc20 = new ethers.Contract(
      PAY_TOKEN,
      [
        'function allowance(address,address) view returns (uint256)',
        'function approve(address,uint256) returns (bool)',
        'function balanceOf(address) view returns (uint256)',
        'function symbol() view returns (string)',
      ],
      wallet
    );
    const symbol = await erc20.symbol().catch(() => 'TOKEN');
    const tokenBal = await erc20.balanceOf(wallet.address);
    const allowance = await erc20.allowance(wallet.address, CONTRACT);
    console.log(`\nToken thanh toan: ${symbol} | So du: ${tokenBal} | Allowance: ${allowance}`);

    if (allowance < ethers.MaxUint256 / 2n) {
      console.log('Dang approve...');
      const approveTx = await erc20.approve(CONTRACT, ethers.MaxUint256);
      await approveTx.wait();
      console.log('Approve xong:', EXPLORER + approveTx.hash);
    }
  }

  const txRequest = { from: wallet.address, to: CONTRACT, data, value };

  // 2. Mo phong truoc (eth_call) - bat revert ma khong ton gas
  console.log('\nDang mo phong giao dich...');
  try {
    await provider.call(txRequest);
    console.log('Mo phong OK - giao dich se thanh cong.');
  } catch (err) {
    console.error('Mo phong THAT BAI. Ly do:', err.shortMessage || err.message);
    console.error('\nNguyen nhan thuong gap:');
    console.error('  - Da mint du 100 cai/vi (het limit)');
    console.error('  - VALUE_ETH sai (khong khop gia mint)');
    console.error('  - Calldata chua chu ky co han su dung, da het han -> phai mint tay lai va copy calldata moi');
    console.error('  - Mint stage da dong hoac da sold out');
    return;
  }

  // 3. Uoc luong gas
  let gasLimit;
  try {
    const est = await provider.estimateGas(txRequest);
    gasLimit = (est * BigInt(Math.round(parseFloat(GAS_MULTIPLIER) * 100))) / 100n;
    console.log(`Gas limit: ${gasLimit} (uoc luong ${est} + buffer)`);
  } catch {
    gasLimit = 500000n;
    console.log('Khong uoc luong duoc gas, dung mac dinh 500000');
  }

  if (dryRun) {
    console.log('\nDRY_RUN=true -> dung lai o day, khong gui giao dich that.');
    return;
  }

  // 4. Vong lap mint
  let nonce = await provider.getTransactionCount(wallet.address, 'pending');
  let success = 0;
  let failed = 0;

  for (let i = 1; i <= loops; i++) {
    try {
      const tx = await wallet.sendTransaction({
        to: CONTRACT,
        data,
        value,
        gasLimit,
        nonce: nonce++,
      });
      console.log(`[${i}/${loops}] Da gui: ${EXPLORER}${tx.hash}`);

      if (!fast) {
        const receipt = await tx.wait();
        if (receipt.status === 1) {
          success++;
          console.log(`[${i}/${loops}] Thanh cong (block ${receipt.blockNumber})`);
        } else {
          failed++;
          console.log(`[${i}/${loops}] Giao dich bi revert on-chain`);
        }
      } else {
        success++;
      }
    } catch (err) {
      failed++;
      console.error(`[${i}/${loops}] Loi:`, err.shortMessage || err.message);
      // Dong bo lai nonce phong khi bi lech
      nonce = await provider.getTransactionCount(wallet.address, 'pending');
      // Neu loi lien quan den limit hoac sold out thi dung han
      const msg = (err.shortMessage || err.message || '').toLowerCase();
      if (msg.includes('exceed') || msg.includes('sold') || msg.includes('limit')) {
        console.error('Co ve da cham gioi han mint. Dung lai.');
        break;
      }
    }

    if (i < loops) await sleep(delay);
  }

  console.log(`\n=== Ket qua: ${success} thanh cong / ${failed} that bai ===`);
}

main().catch((err) => {
  console.error('\nLoi nghiem trong:', err.message);
  process.exit(1);
});
