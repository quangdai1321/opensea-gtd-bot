/**
 * Che do SeaDrop: goi thang contract SeaDrop cua OpenSea thay vi replay calldata.
 *
 * Uu diem so voi replay:
 *   - Doc gia truc tiep tu contract, khong phai tu dien VALUE_ETH
 *   - Biet truoc vi da mint bao nhieu / con duoc mint bao nhieu
 *   - Mint N cai trong 1 giao dich thay vi N giao dich (re gas hon nhieu)
 *   - minterIfNotPayer = address(0) => NFT luon ve dung vi ky. Khong can va dia chi.
 *   - Cho duoc den gio mo mint
 */

import { ethers } from 'ethers';

// Dia chi chuan cua OpenSea, giong nhau tren hau het cac chain
export const DEFAULT_SEADROP_ADDRESS = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';
export const DEFAULT_FEE_RECIPIENT = '0x0000a26b00c1F0DF003000390027140000fAa719';

export const SEADROP_ABI = [
  'function getPublicDrop(address nftContract) view returns ((uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBps,bool restrictFeeRecipients))',
  'function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable',
  // Custom error - de dich loi revert thanh tieng nguoi
  'error FeeRecipientNotAllowed(address feeRecipient)',
  'error IncorrectPayment(uint256 got,uint256 want)',
  'error MintQuantityCannotBeZero()',
  'error MintQuantityExceedsMaxMintedPerWallet(uint256 total,uint256 allowed)',
  'error MintQuantityExceedsMaxSupply(uint256 total,uint256 maxSupply)',
  'error MintQuantityExceedsMaxTokenSupplyForStage(uint256 total,uint256 maxTokenSupplyForStage)',
  'error NotActive(uint256 currentTimestamp,uint256 startTimestamp,uint256 endTimestamp)',
  'error PayerNotAllowed(address payer)',
];

export const TOKEN_ABI = [
  'function getMintStats(address minter) view returns (uint256 minterNumMinted,uint256 currentTotalSupply,uint256 maxSupply)',
];

const IFACE = new ethers.Interface(SEADROP_ABI);

/** Dich loi revert cua SeaDrop thanh tieng nguoi */
export function decodeSeaDropError(err) {
  const data = err?.data || err?.info?.error?.data || err?.error?.data;
  if (!data || typeof data !== 'string') return null;
  try {
    const parsed = IFACE.parseError(data);
    if (!parsed) return null;
    const a = parsed.args;
    switch (parsed.name) {
      case 'IncorrectPayment':
        return `Sai so tien: gui ${ethers.formatEther(a.got)}, can ${ethers.formatEther(a.want)}`;
      case 'MintQuantityExceedsMaxMintedPerWallet':
        return `Vuot gioi han moi vi: tong se la ${a.total}, toi da ${a.allowed}`;
      case 'MintQuantityExceedsMaxSupply':
        return `Vuot tong cung: ${a.total}/${a.maxSupply}`;
      case 'MintQuantityExceedsMaxTokenSupplyForStage':
        return `Vuot han muc cua stage nay: ${a.total}/${a.maxTokenSupplyForStage}`;
      case 'NotActive':
        return `Stage chua mo hoac da dong (now=${a.currentTimestamp}, start=${a.startTimestamp}, end=${a.endTimestamp})`;
      case 'FeeRecipientNotAllowed':
        return `Fee recipient khong hop le: ${a.feeRecipient}. Sua SEADROP_FEE_RECIPIENT trong .env`;
      case 'PayerNotAllowed':
        return `Vi nay khong duoc phep tra ho: ${a.payer}`;
      case 'MintQuantityCannotBeZero':
        return 'So luong mint bang 0';
      default:
        return parsed.name;
    }
  } catch {
    return null;
  }
}

/** Kiem tra contract SeaDrop co ton tai tren chain nay khong */
export async function assertSeaDropDeployed(provider, address) {
  const code = await provider.getCode(address);
  if (!code || code === '0x') {
    throw new Error(
      `Khong co contract SeaDrop tai ${address} tren chain nay.\n` +
        '  => Chain nay khong dung SeaDrop chuan. Chuyen sang MINT_MODE=calldata.'
    );
  }
}

export function getSeaDrop(provider, address = DEFAULT_SEADROP_ADDRESS) {
  return new ethers.Contract(address, SEADROP_ABI, provider);
}

/** Doc thong tin public stage tu contract */
export async function getPublicDropSummary({ seaDrop, nftContract, provider }) {
  const drop = await seaDrop.getPublicDrop(nftContract);
  const block = await provider.getBlock('latest');
  const now = BigInt(block.timestamp);
  const startTime = BigInt(drop.startTime);
  const endTime = BigInt(drop.endTime);

  return {
    mintPrice: BigInt(drop.mintPrice),
    startTime,
    endTime,
    maxPerWallet: BigInt(drop.maxTotalMintableByWallet),
    feeBps: BigInt(drop.feeBps),
    restrictFeeRecipients: drop.restrictFeeRecipients,
    now,
    isOpen: now >= startTime && (endTime === 0n || now <= endTime),
    notStarted: now < startTime,
  };
}

/** Doc vi da mint bao nhieu. Tra null neu contract khong ho tro getMintStats. */
export async function getMintStats({ nftContract, provider, address }) {
  try {
    const token = new ethers.Contract(nftContract, TOKEN_ABI, provider);
    const s = await token.getMintStats(address);
    return {
      minted: BigInt(s.minterNumMinted),
      totalSupply: BigInt(s.currentTotalSupply),
      maxSupply: BigInt(s.maxSupply),
    };
  } catch {
    return null;
  }
}

/** Cho den khi stage mo. Tra ve summary moi nhat. */
export async function waitForOpen({ seaDrop, nftContract, provider, pollMs = 5000, onWait }) {
  let s = await getPublicDropSummary({ seaDrop, nftContract, provider });

  while (!s.isOpen && s.notStarted) {
    const secondsLeft = Number(s.startTime - s.now);
    if (onWait) onWait(secondsLeft);
    const waitMs = Math.max(Math.min(secondsLeft * 1000, pollMs), 1000);
    await new Promise((r) => setTimeout(r, waitMs));
    s = await getPublicDropSummary({ seaDrop, nftContract, provider });
  }

  return s;
}

/**
 * Tinh so luong thuc te mint duoc cho 1 vi.
 * Ket hop: mong muon cua nguoi dung, gioi han moi vi, so da mint, tong cung con lai.
 */
export function resolveQuantity({ desired, summary, stats }) {
  let q = BigInt(desired);
  const reasons = [];

  if (summary.maxPerWallet > 0n && stats) {
    const remaining = summary.maxPerWallet - stats.minted;
    if (remaining <= 0n) {
      return { quantity: 0n, reason: `da mint du ${stats.minted}/${summary.maxPerWallet}` };
    }
    if (q > remaining) {
      q = remaining;
      reasons.push(`gioi han vi con ${remaining}`);
    }
  } else if (summary.maxPerWallet > 0n && q > summary.maxPerWallet) {
    q = summary.maxPerWallet;
    reasons.push(`gioi han vi ${summary.maxPerWallet}`);
  }

  if (stats && stats.maxSupply > 0n) {
    const supplyLeft = stats.maxSupply - stats.totalSupply;
    if (supplyLeft <= 0n) return { quantity: 0n, reason: 'da sold out' };
    if (q > supplyLeft) {
      q = supplyLeft;
      reasons.push(`tong cung con ${supplyLeft}`);
    }
  }

  return { quantity: q, reason: reasons.join(', ') };
}

export function formatSummary(summary, symbol = 'ETH') {
  const t = (v) => (v === 0n ? 'khong gioi han' : new Date(Number(v) * 1000).toISOString());
  return [
    `Gia mint      : ${ethers.formatEther(summary.mintPrice)} ${symbol}`,
    `Gioi han/vi   : ${summary.maxPerWallet === 0n ? 'khong gioi han' : summary.maxPerWallet}`,
    `Bat dau       : ${t(summary.startTime)}`,
    `Ket thuc      : ${t(summary.endTime)}`,
    `Trang thai    : ${summary.isOpen ? 'DANG MO' : summary.notStarted ? 'CHUA MO' : 'DA DONG'}`,
  ].join('\n');
}
