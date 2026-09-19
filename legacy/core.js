/**
 * Logic mint dung chung. Duoc mint.js (1 vi) va run-all.js (nhieu vi) goi.
 */

import { ethers } from 'ethers';
import { getMintStats, resolveQuantity, decodeSeaDropError } from './seadrop.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Nghi ngau nhien trong khoang [min, max] ms */
export const sleepJitter = (min, max) => sleep(min + Math.floor(Math.random() * Math.max(0, max - min)));

/**
 * Thay dia chi vi cu bang vi hien tai trong calldata.
 * CHI thay dung dia chi ORIGINAL_MINTER - khong quet-va-thay moi dia chi,
 * vi calldata con chua dia chi contract NFT va vi nhan phi cua marketplace.
 */
export function patchRecipient(calldata, oldAddr, newAddr) {
  const pad = (a) => '0'.repeat(24) + a.toLowerCase().replace(/^0x/, '');
  const needle = pad(oldAddr);
  const replacement = pad(newAddr);
  const lower = calldata.toLowerCase();
  const count = lower.split(needle).length - 1;
  return { data: count > 0 ? lower.split(needle).join(replacement) : calldata, count };
}

/**
 * Chuan bi calldata cho 1 vi cu the.
 */
export function prepareCalldata({ calldata, originalMinter, walletAddress }) {
  if (!originalMinter) return { data: calldata, patched: 0 };
  if (originalMinter.toLowerCase() === walletAddress.toLowerCase()) {
    return { data: calldata, patched: 0 };
  }
  const res = patchRecipient(calldata, originalMinter, walletAddress);
  return { data: res.data, patched: res.count };
}

/**
 * Approve ERC20 neu mint tra bang token.
 */
export async function ensureAllowance({ wallet, token, spender, log }) {
  const erc20 = new ethers.Contract(
    token,
    [
      'function allowance(address,address) view returns (uint256)',
      'function approve(address,uint256) returns (bool)',
      'function balanceOf(address) view returns (uint256)',
      'function symbol() view returns (string)',
    ],
    wallet
  );
  const symbol = await erc20.symbol().catch(() => 'TOKEN');
  const bal = await erc20.balanceOf(wallet.address);
  const allowance = await erc20.allowance(wallet.address, spender);
  log(`${symbol}: so du ${bal}, allowance ${allowance}`);

  if (allowance < ethers.MaxUint256 / 2n) {
    log('Dang approve...');
    const tx = await erc20.approve(spender, ethers.MaxUint256);
    await tx.wait();
    log('Approve xong');
  }
  return { symbol, balance: bal };
}

/**
 * Mint cho 1 vi. Tra ve { address, sent, confirmed, failed, hashes, error }
 */
export async function mintWithWallet(opts) {
  const {
    privateKey,
    provider,
    contract,
    calldata,
    originalMinter,
    valueWei,
    loops,
    delayMs,
    jitterMs = 0,
    fast = false,
    dryRun = false,
    payToken = '',
    gasMultiplier = 1.3,
    explorer = '',
    log = console.log,
    onTx = () => {},
  } = opts;

  const wallet = new ethers.Wallet(privateKey, provider);
  const result = {
    address: wallet.address,
    sent: 0,
    confirmed: 0,
    failed: 0,
    hashes: [],
    error: null,
  };

  try {
    // Chuan bi calldata rieng cho vi nay
    const { data, patched } = prepareCalldata({
      calldata,
      originalMinter,
      walletAddress: wallet.address,
    });
    if (patched > 0) log(`Da va ${patched} vi tri dia chi nguoi nhan`);

    // Kiem tra so du native
    const balance = await provider.getBalance(wallet.address);
    const needed = valueWei * BigInt(loops);
    if (balance <= needed) {
      throw new Error(
        `So du khong du: co ${ethers.formatEther(balance)}, can it nhat ${ethers.formatEther(needed)} + gas`
      );
    }

    // Approve ERC20 neu can
    if (payToken && !dryRun) {
      await ensureAllowance({ wallet, token: payToken, spender: contract, log });
    }

    const txRequest = { from: wallet.address, to: contract, data, value: valueWei };

    // Mo phong truoc khi ton gas
    await provider.call(txRequest);

    // Uoc luong gas
    let gasLimit;
    try {
      const est = await provider.estimateGas(txRequest);
      gasLimit = (est * BigInt(Math.round(gasMultiplier * 100))) / 100n;
    } catch {
      gasLimit = 500000n;
    }

    if (dryRun) {
      log(`DRY RUN OK - se mint duoc ${loops} lan (gas limit ${gasLimit})`);
      return result;
    }

    let nonce = await provider.getTransactionCount(wallet.address, 'pending');

    for (let i = 1; i <= loops; i++) {
      try {
        const tx = await wallet.sendTransaction({
          to: contract,
          data,
          value: valueWei,
          gasLimit,
          nonce: nonce++,
        });
        result.sent++;
        result.hashes.push(tx.hash);
        onTx(tx.hash);
        log(`[${i}/${loops}] ${explorer}${tx.hash}`);

        if (!fast) {
          const receipt = await tx.wait();
          if (receipt.status === 1) {
            result.confirmed++;
          } else {
            result.failed++;
            log(`[${i}/${loops}] revert on-chain`);
          }
        }
      } catch (err) {
        result.failed++;
        const msg = err.shortMessage || err.message || '';
        log(`[${i}/${loops}] loi: ${msg}`);
        nonce = await provider.getTransactionCount(wallet.address, 'pending');

        const lower = msg.toLowerCase();
        if (lower.includes('exceed') || lower.includes('sold') || lower.includes('limit')) {
          log('Cham gioi han mint, dung vi nay.');
          break;
        }
        if (lower.includes('insufficient funds')) {
          log('Het tien, dung vi nay.');
          break;
        }
      }

      if (i < loops) await sleepJitter(delayMs, delayMs + jitterMs);
    }
  } catch (err) {
    result.error = err.shortMessage || err.message;
  }

  return result;
}

/**
 * Mint qua SeaDrop cho 1 vi. Doc gia + gioi han tu contract, mint 1 giao dich duy nhat.
 */
export async function mintSeaDropWithWallet(opts) {
  const {
    privateKey,
    provider,
    seaDrop,
    nftContract,
    feeRecipient,
    summary,
    desiredQuantity,
    dryRun = false,
    gasMultiplier = 1.3,
    explorer = '',
    log = console.log,
  } = opts;

  const wallet = new ethers.Wallet(privateKey, provider);
  const result = { address: wallet.address, sent: 0, confirmed: 0, failed: 0, hashes: [], minted: 0, error: null };

  try {
    // Vi nay da mint bao nhieu roi?
    const stats = await getMintStats({ nftContract, provider, address: wallet.address });
    if (stats) {
      log(`Da mint: ${stats.minted}/${summary.maxPerWallet || '?'} | Tong cung: ${stats.totalSupply}/${stats.maxSupply}`);
    }

    const { quantity, reason } = resolveQuantity({ desired: desiredQuantity, summary, stats });
    if (quantity === 0n) {
      log(`Bo qua: ${reason}`);
      return result;
    }
    if (reason) log(`So luong dieu chinh xuong ${quantity} (${reason})`);

    const value = summary.mintPrice * quantity;
    log(`Se mint ${quantity} cai, tra ${ethers.formatEther(value)} ETH`);

    // Kiem tra so du
    const balance = await provider.getBalance(wallet.address);
    if (balance <= value) {
      throw new Error(`So du khong du: co ${ethers.formatEther(balance)}, can ${ethers.formatEther(value)} + gas`);
    }

    const signer = seaDrop.connect(wallet);

    // Mo phong. minterIfNotPayer = address(0) => NFT ve dung vi dang ky.
    try {
      await signer.mintPublic.staticCall(nftContract, feeRecipient, ethers.ZeroAddress, quantity, {
        from: wallet.address,
        value,
      });
    } catch (err) {
      const decoded = decodeSeaDropError(err);
      throw new Error(decoded || err.shortMessage || err.message);
    }

    let gasLimit;
    try {
      const est = await signer.mintPublic.estimateGas(nftContract, feeRecipient, ethers.ZeroAddress, quantity, { value });
      gasLimit = (est * BigInt(Math.round(gasMultiplier * 100))) / 100n;
    } catch {
      gasLimit = 300000n + 30000n * quantity;
    }

    if (dryRun) {
      log(`DRY RUN OK - mint duoc ${quantity} cai (gas limit ${gasLimit})`);
      return result;
    }

    const tx = await signer.mintPublic(nftContract, feeRecipient, ethers.ZeroAddress, quantity, { value, gasLimit });
    result.sent = 1;
    result.hashes.push(tx.hash);
    log(`Da gui: ${explorer}${tx.hash}`);

    const receipt = await tx.wait();
    if (receipt.status === 1) {
      result.confirmed = 1;
      result.minted = Number(quantity);
      log(`Thanh cong - mint ${quantity} cai (block ${receipt.blockNumber})`);
    } else {
      result.failed = 1;
      log('Giao dich bi revert');
    }
  } catch (err) {
    result.error = decodeSeaDropError(err) || err.shortMessage || err.message;
  }

  return result;
}
