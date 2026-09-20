/**
 * Dong bo dong ho may voi chain, de ban dung khoanh khac stage mo.
 *
 * Cach do: goi eth_getBlockByNumber lien tuc, voi moi giay S tren chain ghi lai LUC SOM NHAT
 * may nhan duoc phan hoi bao timestamp = S. Min cua (luc nhan - S*1000) gom ca do tre mang,
 * nen ket qua lech ve phia MUON hon mot chut -> ban hoi tre, an toan hon la ban qua som.
 *
 * offset > 0: dong ho may CHAY NHANH hon chain (hoac do tre mang) bay nhieu ms.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function syncClock(ctx, { durationMs = 8000, gapMs = 120 } = {}) {
  const firstSeen = new Map(); // giay tren chain -> luc som nhat nhan duoc
  const jobs = [];
  const end = Date.now() + durationMs;
  let rtt = [];

  while (Date.now() < end) {
    const t0 = Date.now();
    jobs.push(
      ctx.main.send('eth_getBlockByNumber', ['latest', false]).then(
        (b) => {
          const arrival = Date.now();
          rtt.push(arrival - t0);
          const s = Number(BigInt(b?.timestamp ?? 0));
          if (!s) return;
          if (!firstSeen.has(s) || arrival < firstSeen.get(s)) firstSeen.set(s, arrival);
        },
        () => {},
      ),
    );
    await sleep(gapMs);
  }
  await Promise.all(jobs);

  const secs = [...firstSeen.keys()].sort((a, b) => a - b);
  // Bo giay dau: co the bat dau nghe giua chung giay do nen khong phai moc that
  const vals = secs.slice(1).map((s) => firstSeen.get(s) - s * 1000);
  rtt = rtt.sort((a, b) => a - b);
  if (vals.length < 3) return null;
  return {
    offsetMs: Math.min(...vals),
    samples: vals.length,
    rttMs: rtt[Math.floor(rtt.length / 2)] ?? 0,
  };
}
