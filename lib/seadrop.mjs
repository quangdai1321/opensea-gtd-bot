/**
 * SeaDrop v1 cua OpenSea: ABI, doc drop tu contract, dich loi, kiem tra giao dich OpenSea dung san.
 * ABI lay tu github.com/ProjectOpenSea/seadrop (src/SeaDrop.sol, src/lib/SeaDropErrorsAndEvents.sol).
 */

import { ethers } from 'ethers';

// Dia chi chuan, giong nhau tren moi chain co SeaDrop
export const SEADROP_ADDRESS = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';
export const OPENSEA_FEE_RECIPIENT = '0x0000a26b00c1F0DF003000390027140000fAa719';

const MINT_PARAMS =
  'tuple(uint256 mintPrice,uint256 maxTotalMintableByWallet,uint256 startTime,uint256 endTime,uint256 dropStageIndex,uint256 maxTokenSupplyForStage,uint256 feeBps,bool restrictFeeRecipients)';

export const SEADROP_ABI = [
  'function getPublicDrop(address nftContract) view returns (tuple(uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBps,bool restrictFeeRecipients))',
  'function getAllowedFeeRecipients(address nftContract) view returns (address[])',
  'function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable',
  `function mintAllowList(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity,${MINT_PARAMS} mintParams,bytes32[] proof) payable`,
  `function mintSigned(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity,${MINT_PARAMS} mintParams,uint256 salt,bytes signature) payable`,
  'error NotActive(uint256 currentTimestamp,uint256 startTimestamp,uint256 endTimestamp)',
  'error MintQuantityCannotBeZero()',
  'error MintQuantityExceedsMaxMintedPerWallet(uint256 total,uint256 allowed)',
  'error MintQuantityExceedsMaxSupply(uint256 total,uint256 maxSupply)',
  'error MintQuantityExceedsMaxTokenSupplyForStage(uint256 total,uint256 maxTokenSupplyForStage)',
  'error FeeRecipientNotAllowed()',
  'error IncorrectPayment(uint256 got,uint256 want)',
  'error InvalidProof()',
  'error InvalidSignature(address recoveredSigner)',
  'error SignatureAlreadyUsed()',
  'error PayerNotAllowed()',
  'error InvalidSignedMintPrice(uint256 got,uint256 minimum)',
  'error InvalidSignedMaxTotalMintableByWallet(uint256 got,uint256 maximum)',
  'error InvalidSignedStartTime(uint256 got,uint256 minimum)',
  'error InvalidSignedEndTime(uint256 got,uint256 maximum)',
  'error InvalidSignedMaxTokenSupplyForStage(uint256 got,uint256 maximum)',
  'error InvalidSignedFeeBps(uint256 got,uint256 minimumOrMaximum)',
];

const TOKEN_ABI = [
  'function getMintStats(address minter) view returns (uint256 minterNumMinted,uint256 currentTotalSupply,uint256 maxSupply)',
];

export const IFACE = new ethers.Interface(SEADROP_ABI);
const fmt = (v) => ethers.formatEther(v);

/** Loi revert cua SeaDrop -> cau de hieu. null neu khong phai loi SeaDrop */
export function decodeSeaDropError(err) {
  const data = err?.data || err?.info?.error?.data || err?.error?.data;
  if (!data || typeof data !== 'string' || data.length < 10) return null;
  let parsed;
  try {
    parsed = IFACE.parseError(data);
  } catch {
    return null;
  }
  if (!parsed) return null;
  const a = parsed.args;
  switch (parsed.name) {
    case 'NotActive': return 'Stage chưa mở hoặc đã đóng';
    case 'IncorrectPayment': return `Sai số tiền: gửi ${fmt(a.got)}, cần ${fmt(a.want)}`;
    case 'MintQuantityExceedsMaxMintedPerWallet': return `Vượt giới hạn mỗi ví: tổng sẽ là ${a.total}, tối đa ${a.allowed}`;
    case 'MintQuantityExceedsMaxSupply': return `Hết hàng: ${a.total}/${a.maxSupply}`;
    case 'MintQuantityExceedsMaxTokenSupplyForStage': return `Hết suất của stage: ${a.total}/${a.maxTokenSupplyForStage}`;
    case 'InvalidSignature': return 'Chữ ký OpenSea không hợp lệ cho ví này';
    case 'SignatureAlreadyUsed': return 'Chữ ký đã được dùng (đã mint rồi)';
    case 'InvalidProof': return 'Ví không có trong allowlist';
    case 'FeeRecipientNotAllowed': return 'Fee recipient không được phép';
    case 'PayerNotAllowed': return 'Ví này không được trả hộ';
    case 'MintQuantityCannotBeZero': return 'Số lượng bằng 0';
    default: return parsed.name;
  }
}

/** Dich loi bat ky (SeaDrop hoac RPC) thanh 1 dong */
export function explain(err) {
  return decodeSeaDropError(err) || err?.shortMessage || err?.message || String(err);
}

export function isNotActive(err) {
  return /NotActive|chưa mở/i.test(explain(err));
}

export async function readPublicDrop(provider, nftContract) {
  const sd = new ethers.Contract(SEADROP_ADDRESS, SEADROP_ABI, provider);
  const d = await sd.getPublicDrop(nftContract);
  return {
    mintPrice: BigInt(d.mintPrice),
    startTime: Number(d.startTime),
    endTime: Number(d.endTime),
    maxPerWallet: BigInt(d.maxTotalMintableByWallet),
    restrictFeeRecipients: d.restrictFeeRecipients,
  };
}

/** Fee recipient hop le: uu tien cua OpenSea neu contract cho phep */
export async function pickFeeRecipient(provider, nftContract) {
  const sd = new ethers.Contract(SEADROP_ADDRESS, SEADROP_ABI, provider);
  const list = await sd.getAllowedFeeRecipients(nftContract).catch(() => []);
  const hit = list.find((a) => a.toLowerCase() === OPENSEA_FEE_RECIPIENT.toLowerCase());
  return hit || list[0] || OPENSEA_FEE_RECIPIENT;
}

export async function readMintStats(provider, nftContract, address) {
  try {
    const s = await new ethers.Contract(nftContract, TOKEN_ABI, provider).getMintStats(address);
    return { minted: BigInt(s.minterNumMinted), totalSupply: BigInt(s.currentTotalSupply), maxSupply: BigInt(s.maxSupply) };
  } catch {
    return null;
  }
}

/** So luong mint thuc te: ha theo gioi han vi, so da mint, hang con lai. quantity 0n = khong mint */
export function resolveQuantity(desired, maxPerWallet, stats) {
  let q = BigInt(desired);
  if (maxPerWallet > 0n) {
    const left = maxPerWallet - (stats?.minted ?? 0n);
    if (left <= 0n) return { quantity: 0n, reason: `đã mint đủ ${stats?.minted}/${maxPerWallet}` };
    if (q > left) q = left;
  }
  if (stats && stats.maxSupply > 0n) {
    const left = stats.maxSupply - stats.totalSupply;
    if (left <= 0n) return { quantity: 0n, reason: 'đã sold out' };
    if (q > left) q = left;
  }
  return { quantity: q, reason: q < BigInt(desired) ? `hạ còn ${q}` : '' };
}

export function encodeMintPublic(nftContract, feeRecipient, quantity) {
  return IFACE.encodeFunctionData('mintPublic', [nftContract, feeRecipient, ethers.ZeroAddress, quantity]);
}

/**
 * Kiem tra giao dich OpenSea dung san TRUOC khi ky: khong tin mu API.
 * Phai goi dung contract SeaDrop, dung NFT, NFT ve dung vi minh, dung so luong, tien khop gia trong mintParams.
 * Tra ve { fn, quantity, price } hoac nem loi.
 */
export function verifyOpenSeaTx(tx, { nftContract, minter, quantity }) {
  if (tx.to.toLowerCase() !== SEADROP_ADDRESS.toLowerCase()) {
    throw new Error(`OpenSea bảo gửi tới ${tx.to}, không phải contract SeaDrop. Từ chối.`);
  }
  let p;
  try {
    p = IFACE.parseTransaction({ data: tx.data, value: tx.value });
  } catch {
    throw new Error('Không đọc được calldata của OpenSea. Từ chối.');
  }
  if (!p || !['mintPublic', 'mintSigned', 'mintAllowList'].includes(p.name)) {
    throw new Error(`Hàm lạ trong calldata: ${p?.name}. Từ chối.`);
  }
  const a = p.args;
  if (a.nftContract.toLowerCase() !== nftContract.toLowerCase()) throw new Error(`Calldata mint NFT khác (${a.nftContract}). Từ chối.`);
  const recv = a.minterIfNotPayer.toLowerCase();
  if (recv !== ethers.ZeroAddress && recv !== minter.toLowerCase()) throw new Error(`NFT sẽ về ví khác (${a.minterIfNotPayer}). Từ chối.`);
  if (BigInt(a.quantity) !== BigInt(quantity)) throw new Error(`Số lượng ${a.quantity} khác yêu cầu ${quantity}. Từ chối.`);
  if (p.name !== 'mintPublic') {
    const want = BigInt(a.mintParams.mintPrice) * BigInt(a.quantity);
    if (BigInt(tx.value) !== want) throw new Error(`Tiền gửi ${fmt(tx.value)} khác giá ${fmt(want)}. Từ chối.`);
  }
  return { fn: p.name, quantity: BigInt(a.quantity) };
}
