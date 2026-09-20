/**
 * Soi mot drop: hang di luc nao, ai gom, tra gas bao nhieu.
 *
 *   node recon.mjs robinhood 0x54bc2d6dc962ad37003a47362b28b4766ac895da
 *
 * Public chua mo -> du bao toi gio mo con bao nhieu cai (co dang thuc canh khong).
 * Public da mo   -> block mo bay bao nhieu, vao tay vi thuong hay contract gom nhieu vi.
 *
 * Tren Telegram: /soi <link opensea | slug | chain 0x...>
 */

import './lib/env.mjs'; // nap .env truoc cac import doc process.env
import { ethers } from 'ethers';
import { CHAINS, chainCtx } from './lib/chains.mjs';
import { analyze } from './lib/recon.mjs';

const iso = (s) => `${new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 19)}Z`;
const short = (a) => (a ? `${a.slice(0, 10)}…${a.slice(-6)}` : '?');

async function main() {

  const chain = (process.argv[2] || '').toLowerCase();
  const nft = process.argv[3];
  if (!CHAINS[chain] || !ethers.isAddress(nft || '')) {
    console.log(`Cach dung: node recon.mjs <chain> <dia-chi-NFT>\nChain: ${Object.keys(CHAINS).join(', ')}`);
    process.exit(1);
  }

  const ctx = chainCtx(chain);
  console.log(`\nDang doc ${nft} tren ${chain} ...`);
  const r = await analyze(ctx, nft, {
    onProgress: (done, all) => process.stdout.write(`\r  quet log ${Math.floor((done / all) * 100)}%   `),
  });
  process.stdout.write('\r                      \r');

  console.log(`\n=== ${r.name || '(khong doc duoc ten)'}${r.symbol ? ` (${r.symbol})` : ''} ===`);
  console.log(`chain ${chain} (id ${r.chainId}), block ${r.latest}${r.secPerBlock ? `, ~${r.secPerBlock.toFixed(2)}s/block` : ''}`);
  if (r.supply != null && r.max != null) {
    console.log(`nguon cung: ${r.supply}/${r.max}` + (r.max > 0n && r.supply >= r.max ? '  -> DA HET HANG' : `  -> con ${r.max - r.supply}`));
  }

  if (r.drop) {
    console.log('\n--- Stage public (SeaDrop) ---');
    console.log(`gia     ${ethers.formatEther(r.drop.mintPrice)} ${r.coin}`);
    console.log(`mo      ${iso(r.drop.startTime)}`);
    console.log(`dong    ${iso(r.drop.endTime)}`);
    console.log(`cap/vi  ${r.drop.maxPerWallet}`);
  } else {
    console.log('\n(khong doc duoc public drop tu SeaDrop - contract co the dung co che mint khac)');
  }

  if (r.mints === 0) {
    console.log('\nKhong thay lan mint nao (RPC nay co the da cat bot lich su).');
    return;
  }

  console.log(`\n--- Toan bo ${r.mints} lan mint ---`);
  console.log(`tu  block ${r.firstBlock} (${iso(r.firstTs)})`);
  console.log(`den block ${r.lastBlock} (${iso(r.lastTs)})  = ${r.durationMin.toFixed(1)} phut`);
  console.log(`${r.blockCount} block, ${r.txCount} giao dich, ${r.walletCount} vi nhan`);

  if (r.upcoming) {
    const u = r.upcoming;
    console.log('\n--- Public CHUA mo: du bao ---');
    console.log(`con ${u.left}/${r.max} chua ai lay, public mo sau ${u.minsToOpen.toFixed(0)} phut nua`);
    console.log(`${u.windowMin} phut qua di ${u.recent} cai (~${u.perMin.toFixed(1)}/phut)`);
    console.log(`=> toi gio public uoc con khoang ${Math.round(u.forecast)} cai`);
    if (u.perMin > 0 && u.forecast <= 0) console.log('   HET TRUOC GIO MO theo nhip nay - dung thuc canh.');
    else if (r.drop?.maxPerWallet > 0n && u.forecast < Number(r.drop.maxPerWallet) * 20) {
      console.log('   Con rat it. Vao duoc block mo thi moi co cua.');
    }
    return;
  }

  const o = r.opening;
  if (o) {
    console.log('\n--- Khoanh khac public mo ---');
    if (o.soldOutBeforeOpen) {
      console.log(`het hang TRUOC khi public mo (${o.before} cai da di o cac stage truoc)`);
    } else {
      console.log(`truoc gio mo da di ${o.before}/${r.mints} (cac stage allowlist/GTD)`);
      console.log(`block mo public ${o.openBlock}: ${o.count} lan mint`);
      console.log(`sau block do con ${o.after} lan mint nua`);
    }
  }

  console.log('\n--- Block gom nhieu nhat ---');
  for (const [b, n] of r.topBlocks) console.log(`  block ${b}  ${n} cai`);

  console.log('\n--- Vi gom nhieu nhat ---');
  for (const [a, n] of r.topRecipients) console.log(`  ${String(n).padStart(4)}  ${a}`);

  console.log('\n--- Giao dich gom nhieu nhat ---');
  for (const t of r.topTxs) {
    console.log(`  ${String(t.count).padStart(4)} cai | block ${t.block} | ${t.recipients > 1 ? `CONTRACT GOM ${t.recipients} vi` : 'mint thuong'}`);
    console.log(`       tx  ${t.hash}`);
    console.log(`       tu  ${short(t.from)} -> ${short(t.to)}`);
    console.log(`       gas ${t.gasUsed} @ ${t.gwei?.toFixed(4) ?? '?'} gwei (dat tip ${t.tipGwei?.toFixed(4) ?? '?'} gwei) = ${t.paid != null ? ethers.formatEther(t.paid) : '?'} ${r.coin}`);
  }

  console.log('\n--- Ket luan ---');
  if (r.drop?.maxPerWallet > 0n) console.log(`Cap ${r.drop.maxPerWallet}/vi -> bot 1 vi lay duoc toi da ${r.drop.maxPerWallet} cai.`);
  if (o && !o.soldOutBeforeOpen) {
    console.log(`Block mo public: ${o.count} cai, ${o.batched} (${o.pct}%) di qua contract gom nhieu vi.`);
    console.log(
      o.pct >= 50
        ? '=> Phan public bi gom bang SO LUONG DIA CHI, khong phai bang toc do.\n   Bot 1 vi van an duoc phan cua no, nhung dung ky vong gom nhieu.'
        : '=> Phan public chia deu cho vi thuong -> bot 1 vi co cua neu ban sat gio mo.',
    );
  }
  if (r.secPerBlock) {
    console.log(`Nhip block ~${r.secPerBlock.toFixed(2)}s -> dat BURST_SPACING_MS ~${Math.max(30, Math.round(r.secPerBlock * 1000))} de moi phat roi vao 1 block khac nhau.`);
  }
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});
