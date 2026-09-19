/**
 * Burst mint - cach nhanh nhat da do duoc tren Robinhood Chain.
 *
 *   node burst.js --check   dong bo dong ho voi sequencer, in lich ban, KHONG gui gi
 *   node burst.js --test    ban 4 giao dich CHAC CHAN revert (stage chua mo) dung nhip ban that.
 *                           Kiem tra nonce lien tiep co duoc nhan het + do do tre that.
 *                           Ton khoang 0.00001 ETH. CHAY TRUOC khi dung that.
 *   node burst.js           ban that
 *
 * Feed gioi han ket noi theo IP: go cua lien tuc se bi chan 1 tieng. Dung chay --check/--test
 * lien tuc nhieu lan sat nhau.
 *
 * Tai sao nhanh nhat:
 *   - Robinhood Chain = Arbitrum Orbit, xep FCFS, KHONG bat Timeboost (da kiem tra).
 *     Khong ai mua duoc uu tien - chi co toc do.
 *   - Dong ho: nghe thang sequencer feed, bat khoanh khac timestamp nhay sang giay moi.
 *     Biet gio sequencer sai so vai chuc ms, thay vi +-1s khi doc timestamp qua RPC.
 *   - KHONG cho xac nhan "da mo" (ton ~300ms). Ky san K giao dich nonce lien tiep,
 *     ban dan tran quanh khoanh khac mo. Cai den som revert (re, chi tieu nonce),
 *     cai dau tien den sau khi mo se mint, cac cai sau revert vi vuot gioi han/vi.
 *
 * Bien trong .env:
 *   BURST_COUNT        so giao dich ky san, mac dinh 10
 *   BURST_SPACING_MS   khoang cach giua 2 lan ban, mac dinh 35
 *   BURST_BEFORE_MS    bat dau ban som hon tam uoc tinh bao nhieu, mac dinh 80
 *   SEND_LATENCY_MS    do tre tu luc gui toi khi len feed. Lay tu --test. Mac dinh 300
 *   RPC_URLS           endpoint phu, phat kem (tuy chon)
 *   FEED_URL           mac dinh wss://feed.mainnet.chain.robinhood.com
 */

import 'dotenv/config';
import https from 'node:https';
import path from 'node:path';
import WS from 'ws';
import { ethers } from 'ethers';
import { resolveChain } from './chains.js';
import { loadWalletFromDir, hasKeystore, promptPassword } from './keystore.js';
import {
  getMintStats,
  resolveQuantity,
  decodeSeaDropError,
  SEADROP_ABI,
  DEFAULT_SEADROP_ADDRESS,
  DEFAULT_FEE_RECIPIENT,
} from './seadrop.js';

const MODE = process.argv.includes('--check') ? 'check' : process.argv.includes('--test') ? 'test' : 'real';

const {
  WALLETS_DIR = './wallets',
  WALLET = '01',
  NFT_CONTRACT,
  SEADROP_QUANTITY = '1',
  SEADROP_ADDRESS = DEFAULT_SEADROP_ADDRESS,
  SEADROP_FEE_RECIPIENT = DEFAULT_FEE_RECIPIENT,
  GAS_BUMP = '2',
  BASE_MULT = '20',
  RPC_URLS = '',
  FEED_URL = 'wss://feed.mainnet.chain.robinhood.com',
  BURST_COUNT = '10',
  BURST_SPACING_MS = '35',
  BURST_BEFORE_MS = '80',
  SEND_LATENCY_MS = '300',
} = process.env;

const IFACE = new ethers.Interface(SEADROP_ABI);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));
const clock = (t) => {
  const d = new Date(t);
  return d.toLocaleTimeString() + '.' + String(d.getMilliseconds()).padStart(3, '0');
};

// ---------- Gui JSON-RPC tho, giu ket noi am ----------
const agent = new https.Agent({ keepAlive: true, maxSockets: 32 });

function post(url, method, params = []) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = https.request(
      url,
      {
        method: 'POST',
        agent,
        timeout: 10000,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          let j = null;
          try {
            j = JSON.parse(d);
          } catch {
            /* bo qua */
          }
          resolve({ ms: Date.now() - t0, j, err: j?.error?.message || (j ? null : `HTTP ${res.statusCode}`) });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ms: Date.now() - t0, j: null, err: 'timeout' });
    });
    req.on('error', (e) => resolve({ ms: Date.now() - t0, j: null, err: e.code || e.message }));
    req.end(body);
  });
}

// ---------- Nghe sequencer feed: dong ho + nhan dien giao dich cua minh ----------
function startFeed(url) {
  const st = {
    edges: [],
    lastSec: null,
    live: false,
    blocks: 0,
    stopped: false,
    blocked: null,
    retries: 0,
    watch: new Map(),
    ws: null,
  };

  const connect = () => {
    if (st.stopped || st.blocked) return;
    const ws = new WS(url);
    st.ws = ws;

    // Feed bi tu choi (403/429): KHONG ket noi lai. Go cua lien tuc se bi chan 1 tieng
    // ("Blocked for 1 hour after sustained feed connection rejections") - da gap thuc te.
    ws.on('unexpected-response', (_req, res) => {
      // Danh dau chan NGAY de khong ket noi lai, doc ly do xong moi dong
      st.blocked = `HTTP ${res.statusCode}`;
      let body = '';
      const done = () => {
        st.blocked = `HTTP ${res.statusCode} ${body.replace(/\s+/g, ' ').slice(0, 120)}`.trim();
        console.log(`\n[feed] Bi tu choi, NGUNG ket noi lai: ${st.blocked}`);
        ws.terminate();
      };
      res.on('data', (c) => (body += c));
      res.once('end', done);
      setTimeout(() => res.readableEnded || done(), 1500);
    });
    ws.on('open', () => {
      st.retries = 0;
    });
    ws.on('message', (buf) => {
      const arrival = Date.now();
      let j;
      try {
        j = JSON.parse(buf.toString());
      } catch {
        return;
      }
      for (const m of j.messages || []) {
        const inner = m?.message?.message;
        const ts = inner?.header?.timestamp;
        if (typeof ts !== 'number') continue;
        // Luc moi ket noi, feed day ~2 phut lich su cu. Bo qua cho toi khi bat kip.
        if (!st.live) {
          if (arrival - ts * 1000 < 1000) st.live = true;
          else continue;
        }
        st.blocks++;
        if (st.lastSec !== null && ts > st.lastSec) {
          st.edges.push({ at: arrival, v: arrival - ts * 1000 });
          if (st.edges.length > 200) st.edges.shift();
        }
        st.lastSec = ts;

        // Tim giao dich dang theo doi trong block nay (byte giao dich nam nguyen trong l2Msg)
        if (st.watch.size && inner.l2Msg) {
          const l2 = Buffer.from(inner.l2Msg, 'base64');
          for (const [hash, w] of st.watch) {
            if (!w.seenAt && l2.includes(w.bytes)) {
              w.seenAt = arrival;
              w.blockTs = ts;
            }
          }
        }
      }
    });
    ws.on('close', () => {
      st.live = false;
      st.lastSec = null;
      if (st.stopped || st.blocked) return;
      // Ngat vi ly do khac: cho tang dan 2s, 4s, 8s... toi da 5 lan
      if (st.retries >= 5) {
        console.log('\n[feed] Mat ket noi qua 5 lan, dung lai. Dung dong ho da dong bo truoc do.');
        return;
      }
      const wait = 2000 * 2 ** st.retries;
      st.retries++;
      setTimeout(connect, wait);
    });
    ws.on('error', () => {});
  };
  connect();

  /** Nho nhat cua (luc nhan - moc giay) trong 90s gan day = lech dong ho + tre feed */
  st.offset = () => {
    const now = Date.now();
    const v = st.edges.filter((e) => now - e.at < 90000).map((e) => e.v);
    return v.length >= 5 ? Math.min(...v) : null;
  };
  st.syncCount = () => st.edges.filter((e) => Date.now() - e.at < 90000).length;
  st.stop = () => {
    st.stopped = true;
    try {
      st.ws?.close();
    } catch {
      /* bo qua */
    }
  };
  return st;
}

/**
 * Du phong khi feed tu choi ket noi: dong bo dong ho bang cach doc block moi nhat qua RPC.
 * Voi moi giay S, lay luc SOM NHAT ma mot phan hoi bao timestamp = S. Min cua cac gia tri do
 * gom ca do tre doc RPC, nen lich ban lech ve phia MUON hon - an toan, cham hon mot chut.
 */
async function rpcClockSync(url, durationMs = 12000, gapMs = 60) {
  const firstSeen = new Map(); // giay -> luc nhan som nhat
  const jobs = [];
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    jobs.push(
      post(url, 'eth_getBlockByNumber', ['latest', false]).then((r) => {
        const arrival = Date.now();
        const hex = r.j?.result?.timestamp;
        if (!hex) return;
        const s = parseInt(hex, 16);
        if (!firstSeen.has(s) || arrival < firstSeen.get(s)) firstSeen.set(s, arrival);
      })
    );
    await sleep(gapMs);
  }
  await Promise.all(jobs);
  const secs = [...firstSeen.keys()].sort((a, b) => a - b);
  // Bo giay dau tien: co the bat dau nghe giua chung giay do nen khong phai moc that
  const vals = secs.slice(1).map((s) => firstSeen.get(s) - s * 1000);
  return vals.length >= 5 ? { offset: Math.min(...vals), samples: vals.length } : null;
}

async function main() {
  if (!NFT_CONTRACT) throw new Error('Thieu NFT_CONTRACT trong .env');

  const { chainId, rpc, explorer } = resolveChain(process.env);
  const provider = new ethers.JsonRpcProvider(rpc, { chainId, name: `chain-${chainId}` }, { staticNetwork: true });
  const sendUrls = [...new Set([rpc, ...RPC_URLS.split(',').map((s) => s.trim()).filter(Boolean)])];

  // ---------- Nap vi ----------
  const dir = path.join(WALLETS_DIR, WALLET);
  const pw =
    process.env.KEYSTORE_PASSWORD || (hasKeystore(dir) ? await promptPassword('Mat khau keystore: ') : '');
  const loaded = await loadWalletFromDir(dir, pw);
  if (!loaded) throw new Error(`Khong nap duoc vi tu ${dir}`);
  const wallet = loaded.wallet;
  console.log(`\nVi: ${wallet.address}  | che do: ${MODE}`);

  // ---------- Bat dau nghe feed ngay de co thoi gian dong bo ----------
  const feed = startFeed(FEED_URL);

  // ---------- Doc drop ----------
  const seaDrop = new ethers.Contract(SEADROP_ADDRESS, SEADROP_ABI, provider);
  let drop = await seaDrop.getPublicDrop(NFT_CONTRACT);
  let price = BigInt(drop.mintPrice);
  let startTime = Number(drop.startTime);
  const endTime = Number(drop.endTime);

  const stats = await getMintStats({ nftContract: NFT_CONTRACT, provider, address: wallet.address });
  const { quantity, reason } = resolveQuantity({
    desired: SEADROP_QUANTITY,
    summary: { maxPerWallet: BigInt(drop.maxTotalMintableByWallet) },
    stats,
  });
  if (quantity === 0n) throw new Error(`Khong mint duoc: ${reason}`);

  const data = IFACE.encodeFunctionData('mintPublic', [
    NFT_CONTRACT,
    SEADROP_FEE_RECIPIENT,
    ethers.ZeroAddress,
    quantity,
  ]);

  // ---------- Gas ----------
  const blk = await provider.getBlock('latest');
  const fee = await provider.getFeeData();
  const baseFee = blk?.baseFeePerGas ?? fee.gasPrice ?? 1000000000n;
  let prio = fee.maxPriorityFeePerGas ?? 0n;
  if (prio === 0n) prio = baseFee / 10n;
  if (prio === 0n) prio = 100000000n;
  const maxPrio = (prio * BigInt(Math.round(parseFloat(GAS_BUMP) * 100))) / 100n;
  const gasLimit = 200000n + 40000n * quantity;

  const nonce0 = await provider.getTransactionCount(wallet.address, 'pending');
  const balance = await provider.getBalance(wallet.address);

  // Moi giao dich phai du so du de DAT COC gasLimit x tran gas, khong thi node tu choi.
  // So du mong + tran cao = script dung lai dung phut chot (da tinh: x20 chi chiu baseFee tang 1.5x).
  // Nen tu ha he so cho vua so du, giu lai 15% cho phi cac lan revert.
  const wantMult = BigInt(parseInt(BASE_MULT, 10));
  const budgetPerGas = (((balance - price * quantity) * 85n) / 100n) / gasLimit;
  const fitMult = budgetPerGas > maxPrio ? (budgetPerGas - maxPrio) / baseFee : 0n;
  const mult = fitMult < wantMult ? fitMult : wantMult;
  if (mult < 2n) {
    throw new Error(
      `So du ${ethers.formatEther(balance)} qua it: khong du dat coc ngay ca voi tran gas x2 baseFee. Nap them.`
    );
  }
  const maxFee = baseFee * mult + maxPrio;
  const perTxCap = price * quantity + gasLimit * maxFee;

  const signAt = (nonce) =>
    wallet.signTransaction({
      type: 2,
      chainId,
      nonce,
      to: SEADROP_ADDRESS,
      data,
      value: price * quantity,
      gasLimit,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: maxPrio,
    });

  // ---------- Bay thu: stage dang o trang thai nao ----------
  let isOpen = false;
  try {
    await provider.call({ from: wallet.address, to: SEADROP_ADDRESS, data, value: price * quantity });
    isOpen = true;
  } catch (err) {
    const d = decodeSeaDropError(err) || err.shortMessage || err.message || '';
    if (!/NotActive|chua mo|da dong/i.test(d)) throw new Error(`Kiem tra truoc THAT BAI: ${d}`);
  }

  // ---------- Cho feed dong bo, khong duoc thi dung RPC ----------
  process.stdout.write('\nDang dong bo dong ho voi sequencer qua feed');
  for (let i = 0; i < 30 && feed.syncCount() < 8 && !feed.blocked; i++) {
    await sleep(500);
    process.stdout.write('.');
  }
  let off0 = feed.offset();
  let clockSource = 'feed';
  // Da do: dRPC lech so voi feed +86ms, RPC chinh thuc lech +632ms (qua cham de dong bo)
  const readUrl = process.env.READ_URL || (chainId === 4663 ? 'https://robinhood.drpc.org' : rpc);
  if (off0 !== null) {
    console.log(` xong (${feed.syncCount()} moc giay).`);
  } else {
    console.log(' KHONG vao duoc feed.');
    console.log(`Chuyen sang dong bo qua RPC (${readUrl}), mat ~12 giay...`);
    const r = await rpcClockSync(readUrl);
    if (r) {
      off0 = r.offset;
      clockSource = 'rpc';
      console.log(`  xong (${r.samples} moc giay). Lich se lech ve phia muon hon mot chut - an toan.`);
    } else {
      console.log('  RPC cung khong dong bo duoc.');
    }
  }

  const count = parseInt(BURST_COUNT, 10);
  const spacing = parseInt(BURST_SPACING_MS, 10);
  const before = parseInt(BURST_BEFORE_MS, 10);
  const lat = parseInt(SEND_LATENCY_MS, 10);

  /** Tinh lich ban dua tren offset moi nhat */
  const schedule = (off) => {
    // Gui luc: startTime + offset - do_tre_gui + ~40ms cho block ke tiep duoc tao
    const center = startTime * 1000 + off - lat + 40;
    const first = center - before;
    return { center, first, last: first + (count - 1) * spacing };
  };

  const revertGas = 60000n; // uoc luong rong tay cho 1 giao dich revert som
  console.log('\n===== THONG SO =====');
  console.log(`So luong/lan : ${quantity} NFT | gia ${ethers.formatEther(price)}${price === 0n ? ' (mien phi)' : ''}`);
  console.log(`Nonce bat dau: ${nonce0}`);
  console.log(`So du        : ${ethers.formatEther(balance)} (moi giao dich dat coc ${ethers.formatEther(perTxCap)})`);
  console.log(
    `Tran gas     : baseFee x${mult} = ${ethers.formatUnits(maxFee, 'gwei')} gwei` +
      (mult < wantMult ? `  <- CANH BAO: muon x${wantMult} nhung so du chi du x${mult}. Nap them cho chac.` : '')
  );
  console.log(`Stage        : ${isOpen ? 'DANG MO' : 'chua mo / da dong'}`);
  console.log(`Gio mo       : ${new Date(startTime * 1000).toLocaleString()}`);
  console.log(`Gio dong     : ${new Date(endTime * 1000).toLocaleString()}`);
  if (off0 !== null) {
    console.log(
      `Lech dong ho : may ban ${off0 < 0 ? 'CHAM' : 'NHANH'} hon sequencer ~${Math.abs(off0)}ms ` +
        `(nguon: ${clockSource}${clockSource === 'rpc' ? ' - kem chinh xac hon feed' : ''})`
    );
  }
  console.log(`Do tre gui   : ${lat}ms ${process.env.SEND_LATENCY_MS ? '(tu .env)' : '(mac dinh - chay --test de do that)'}`);

  // =====================================================================
  if (MODE === 'test') {
    if (isOpen) {
      throw new Error('Stage DANG MO - --test se mint that. Chi chay --test khi stage chua mo hoac da dong.');
    }
    const N = 4;
    const haveFeed = clockSource === 'feed';
    console.log(`\n===== BAN THU ${N} giao dich DUNG NHIP ${spacing}ms (stage chua mo -> tat ca se revert) =====`);
    console.log('Kiem tra 2 dieu:');
    console.log('  1. Nonce lien tiep ban sat nhau co duoc nhan HET khong (neu khong, ban dan se hong)');
    console.log(`  2. Do tre that tu luc gui toi luc len sequencer ${haveFeed ? '' : '(BO QUA - feed khong vao duoc)'}`);
    console.log(`Chi phi uoc tinh: ~${ethers.formatEther(BigInt(N) * revertGas * baseFee)} ETH\n`);

    const raws = [];
    for (let i = 0; i < N; i++) raws.push(await signAt(nonce0 + i));
    if (haveFeed) {
      for (const raw of raws) {
        feed.watch.set(ethers.keccak256(raw), { bytes: Buffer.from(raw.slice(2), 'hex'), seenAt: null, blockTs: null });
      }
    }
    await Promise.all(Array.from({ length: N }, () => post(sendUrls[0], 'eth_chainId'))); // lam am socket

    // Ban y het cach ban that: khong cho lenh truoc tra loi
    const jobs = [];
    const t0 = Date.now() + 50;
    for (let i = 0; i < N; i++) {
      const at = t0 + i * spacing;
      while (at - Date.now() > 20) await sleep(Math.max(1, at - Date.now() - 18));
      while (Date.now() < at) await tick();
      const sentAt = Date.now();
      jobs.push(post(sendUrls[0], 'eth_sendRawTransaction', [raws[i]]).then((r) => ({ i, sentAt, ...r })));
    }
    const sent = await Promise.all(jobs);
    for (const s of sent) {
      console.log(`  [${s.i}] nonce ${nonce0 + s.i} gui ${clock(s.sentAt)} | RPC ${s.ms}ms | ${s.err ? 'LOI: ' + s.err : 'nhan'}`);
    }

    console.log('\nDang cho bien lai...');
    const lats = [];
    let included = 0;
    for (let i = 0; i < N; i++) {
      const hash = ethers.keccak256(raws[i]);
      const rec = await provider.waitForTransaction(hash, 1, 20000).catch(() => null);
      if (rec) included++;
      const w = haveFeed ? feed.watch.get(hash) : null;
      const onFeed = w?.seenAt ? w.seenAt - sent[i].sentAt : null;
      if (onFeed !== null) lats.push(onFeed);
      console.log(
        `  [${i}] ${rec ? `vao block ${rec.blockNumber} | ${rec.status === 0 ? 'revert (dung du kien)' : 'THANH CONG?!'} | gas ${rec.gasUsed}` : 'KHONG VAO CHAIN'}` +
          `${haveFeed ? ` | len feed sau ${onFeed === null ? '??' : onFeed + 'ms'}` : ''}`
      );
    }

    console.log('\n===== KET LUAN =====');
    if (included === N) {
      console.log(`OK: ca ${N}/${N} giao dich nonce lien tiep deu vao chain. Ban dan AN TOAN.`);
    } else {
      console.log(`CANH BAO: chi ${included}/${N} vao chain. Nonce lien tiep bi rot -> KHONG dung ban dan.`);
      console.log('  Dung watch-mint.js / race.js thay the.');
    }
    if (lats.length) {
      lats.sort((a, b) => a - b);
      console.log(`Do tre gui -> len feed: [${lats.join(', ')}] ms`);
      console.log(`=> Dat vao .env:  SEND_LATENCY_MS=${lats[Math.floor(lats.length / 2)]}`);
    }
    console.log(`\nNonce da dung: ${nonce0}..${nonce0 + N - 1}. Lan chay sau tu lay nonce moi.`);
    feed.stop();
    agent.destroy();
    provider.destroy();
    return;
  }

  // =====================================================================
  if (isOpen) {
    console.log('\nStage DANG MO - khong can ban dan, gui 1 giao dich ngay.');
    if (MODE === 'check') {
      feed.stop();
      agent.destroy();
      provider.destroy();
      return;
    }
    const raw = await signAt(nonce0);
    const hash = ethers.keccak256(raw);
    const r = await post(sendUrls[0], 'eth_sendRawTransaction', [raw]);
    for (const u of sendUrls.slice(1)) post(u, 'eth_sendRawTransaction', [raw]);
    console.log(`Da gui sau ${r.ms}ms ${r.err ? '| ' + r.err : ''}\n${explorer}${hash}`);
    const rec = await provider.waitForTransaction(hash, 1, 60000).catch(() => null);
    console.log(rec?.status === 1 ? `THANH CONG (block ${rec.blockNumber})` : 'Khong thanh cong - xem explorer.');
    feed.stop();
    agent.destroy();
    provider.destroy();
    return;
  }

  if (off0 === null) {
    throw new Error('Feed chua dong bo duoc. Khong the ban dan chinh xac. Kiem tra mang roi chay lai.');
  }

  const sch0 = schedule(off0);
  console.log(`\n===== LICH BAN (gio may ban) =====`);
  console.log(`Giao dich    : ${count} cai, cach nhau ${spacing}ms, nonce ${nonce0}..${nonce0 + count - 1}`);
  console.log(`Cai dau      : ${clock(sch0.first)}`);
  console.log(`Tam uoc tinh : ${clock(sch0.center)}`);
  console.log(`Cai cuoi     : ${clock(sch0.last)}`);
  console.log(`Chi phi xau nhat: ~${ethers.formatEther(BigInt(count) * revertGas * baseFee + price * quantity)} ETH`);
  console.log('  (mint thanh cong 1 cai + cac cai con lai revert)');

  if (MODE === 'check') {
    console.log('\n--check: khong gui gi. Thoat.');
    feed.stop();
    agent.destroy();
    provider.destroy();
    return;
  }

  // ---------- Ky san ca loat ----------
  let raws = [];
  for (let i = 0; i < count; i++) raws.push(await signAt(nonce0 + i));
  console.log(`\nDa ky san ${count} giao dich.`);

  // ---------- Cho, theo doi du an doi gio/gia ----------
  console.log('\n===== CHO (Ctrl+C de dung) =====');
  let lastLog = 0;
  let lastPoll = 0;
  let resynced = false;
  for (;;) {
    const off = feed.offset() ?? off0;
    const sch = schedule(off);
    const left = sch.first - Date.now();
    if (left <= 1500) break;

    // Feed khong song: so do dong ho luc khoi dong co the da cu (dong ho Windows troi dan).
    // Do lai qua RPC khi con ~1 phut. Mat ~12s nen phai bat dau truoc 20s.
    if (!resynced && feed.offset() === null && left < 60000 && left > 20000) {
      resynced = true;
      console.log(`[${clock(Date.now())}] Feed khong song - do lai dong ho qua RPC truoc khi ban...`);
      const r = await rpcClockSync(readUrl);
      if (r) {
        console.log(`  lech ${off0}ms -> ${r.offset}ms (${r.samples} moc giay)`);
        off0 = r.offset;
      } else {
        console.log(`  khong do lai duoc, giu ${off0}ms`);
      }
      continue;
    }

    // Con xa thi kiem tra thua (60s), gan gio moi kiem tra day (5s)
    const pollEvery = left > 600000 ? 60000 : 5000;
    if (Date.now() - lastPoll > pollEvery && left > 8000) {
      lastPoll = Date.now();
      try {
        drop = await seaDrop.getPublicDrop(NFT_CONTRACT);
        if (Number(drop.startTime) !== startTime) {
          console.log(`!! DU AN DOI GIO MO -> ${new Date(Number(drop.startTime) * 1000).toLocaleString()}`);
          startTime = Number(drop.startTime);
        }
        if (BigInt(drop.mintPrice) !== price) {
          console.log(`!! DU AN DOI GIA -> ${ethers.formatEther(drop.mintPrice)}. Ky lai.`);
          price = BigInt(drop.mintPrice);
          raws = [];
          for (let i = 0; i < count; i++) raws.push(await signAt(nonce0 + i));
        }
      } catch {
        /* RPC chap chon - dung gia tri cu */
      }
    }
    if (Date.now() - lastLog > 30000) {
      lastLog = Date.now();
      console.log(
        `[${clock(Date.now())}] con ${Math.round(left / 1000)}s | lech ${off}ms | feed ${feed.live ? 'song' : 'MAT'}`
      );
    }
    await sleep(Math.min(1000, left - 1500));
  }

  // Lam am san nhieu socket de luc ban khong phai bat tay TLS
  await Promise.all(Array.from({ length: Math.min(count, 12) }, () => post(sendUrls[0], 'eth_chainId')));
  for (const u of sendUrls.slice(1)) post(u, 'eth_chainId');

  const off = feed.offset() ?? off0;
  const sch = schedule(off);
  console.log(`\n[${clock(Date.now())}] Chot lich. Lech ${off}ms. Cai dau luc ${clock(sch.first)}`);

  // ---------- BAN DAN ----------
  const jobs = [];
  for (let i = 0; i < count; i++) {
    const at = sch.first + i * spacing;
    while (at - Date.now() > 20) await sleep(Math.max(1, at - Date.now() - 18));
    while (Date.now() < at) await tick();
    const sentAt = Date.now();
    const raw = raws[i];
    jobs.push(post(sendUrls[0], 'eth_sendRawTransaction', [raw]).then((r) => ({ i, sentAt, ...r })));
    for (const u of sendUrls.slice(1)) post(u, 'eth_sendRawTransaction', [raw]);
  }
  const sent = await Promise.all(jobs);

  console.log(`\n===== DA BAN ${count} GIAO DICH =====`);
  for (const s of sent) {
    console.log(`  [${s.i}] ${clock(s.sentAt)} | RPC ${s.ms}ms ${s.err ? '| ' + s.err : '| nhan'}`);
  }

  // ---------- Ket qua ----------
  console.log('\nDang lay bien lai...');
  let winner = null;
  for (let i = 0; i < count; i++) {
    const hash = ethers.keccak256(raws[i]);
    const rec = await provider.waitForTransaction(hash, 1, 30000).catch(() => null);
    let why = '';
    if (rec && rec.status === 0) why = 'revert';
    console.log(
      `  [${i}] nonce ${nonce0 + i} ${rec ? (rec.status === 1 ? 'MINT THANH CONG' : why) : 'khong co bien lai'}` +
        `${rec ? ` | block ${rec.blockNumber}` : ''}`
    );
    if (rec?.status === 1 && !winner) winner = { i, hash, rec };
  }

  if (winner) {
    console.log(`\nTHANH CONG o giao dich thu ${winner.i}: ${explorer}${winner.hash}`);
  } else {
    // Loat khong trung: neu stage da mo va con hang thi ban them 1 phat
    const s2 = await getMintStats({ nftContract: NFT_CONTRACT, provider, address: wallet.address }).catch(() => null);
    const left = s2 ? s2.maxSupply - s2.totalSupply : 0n;
    console.log(`\nLoat khong trung. Con lai ${left}.`);
    if (left > 0n) {
      const n = await provider.getTransactionCount(wallet.address, 'pending');
      const raw = await signAt(n);
      const hash = ethers.keccak256(raw);
      const r = await post(sendUrls[0], 'eth_sendRawTransaction', [raw]);
      console.log(`Ban bu 1 phat (nonce ${n}) sau ${r.ms}ms ${r.err ? '| ' + r.err : ''}`);
      const rec = await provider.waitForTransaction(hash, 1, 30000).catch(() => null);
      console.log(rec?.status === 1 ? `THANH CONG: ${explorer}${hash}` : 'Phat bu khong thanh cong.');
    }
  }

  const fin = await getMintStats({ nftContract: NFT_CONTRACT, provider, address: wallet.address }).catch(() => null);
  if (fin) console.log(`\nVi da mint: ${fin.minted} | tong cung ${fin.totalSupply}/${fin.maxSupply}`);
  console.log(`So du con lai: ${ethers.formatEther(await provider.getBalance(wallet.address))}`);

  feed.stop();
  agent.destroy();
  provider.destroy();
}

main().catch((err) => {
  console.error('\nLoi:', err.shortMessage || err.message);
  process.exit(1);
});
