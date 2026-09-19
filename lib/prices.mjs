/**
 * Gia NFT tren OpenSea: floor, volume, canh bao.
 *
 * Canh bao luu trong db.alerts, 3 loai:
 *   below  floor <= value           -> bao 1 lan roi tu xoa
 *   above  floor >= value           -> bao 1 lan roi tu xoa
 *   move   floor lech >= value %    -> bao, roi lay floor moi lam moc (bao tiep lan lech sau)
 */

export async function fetchStats(opensea, slug) {
  const [{ status, data }, col] = await Promise.all([
    opensea(`/api/v2/collections/${slug}/stats`),
    opensea(`/api/v2/collections/${slug}`),
  ]);
  if (status !== 200) throw new Error(`OpenSea: ${(data.errors || []).join('; ') || `HTTP ${status}`}`);
  const day = (data.intervals || []).find((i) => i.interval === 'one_day') || {};
  return {
    slug,
    name: col.data?.name || slug,
    floor: Number(data.total?.floor_price || 0),
    symbol: data.total?.floor_price_symbol || data.total?.volume_symbol || 'ETH',
    owners: data.total?.num_owners ?? 0,
    sales: data.total?.sales ?? 0,
    volume: Number(data.total?.volume || 0),
    daySales: day.sales ?? 0,
    dayVolume: Number(day.volume || 0),
    url: `https://opensea.io/collection/${slug}`,
  };
}

const n = (v) => (v === 0 ? '0' : v < 0.0001 ? v.toExponential(2) : String(+v.toPrecision(4)));

export function statsText(s, mintPrice) {
  const lines = [
    `💰 ${s.name}`,
    `Floor: ${s.floor ? `${n(s.floor)} ${s.symbol}` : 'chưa có ai rao bán'}`,
  ];
  if (mintPrice && s.floor) {
    const x = s.floor / mintPrice;
    lines.push(`So với giá mint ${n(mintPrice)}: ${x >= 1 ? '📈' : '📉'} x${x.toFixed(2)} (${x >= 1 ? '+' : ''}${((x - 1) * 100).toFixed(0)}%)`);
  }
  lines.push(
    `24h: ${s.daySales} lượt bán, ${n(s.dayVolume)} ${s.symbol}`,
    `Tổng: ${s.sales} lượt bán, ${n(s.volume)} ${s.symbol}, ${s.owners} người giữ`,
    s.url,
  );
  return lines.join('\n');
}

/** Cu phap: "<" / "duoi" / ">" / "tren" + so, hoac "10%" */
export function parseAlert(args) {
  const [a, b] = args;
  const pct = (a || '').match(/^(\d+(?:\.\d+)?)%$/);
  if (pct) return { kind: 'move', value: Number(pct[1]) };
  const op = { '<': 'below', duoi: 'below', 'dưới': 'below', '>': 'above', tren: 'above', 'trên': 'above' }[(a || '').toLowerCase()];
  const v = Number(b);
  if (op && v > 0) return { kind: op, value: v };
  return null;
}

export function alertLabel(a) {
  if (a.kind === 'below') return `floor ≤ ${a.value}`;
  if (a.kind === 'above') return `floor ≥ ${a.value}`;
  return `floor lệch ±${a.value}% (mốc ${a.base ? n(a.base) : 'chưa có'})`;
}

/**
 * Kiem tra 1 canh bao voi floor moi. -> { fire: text|null, remove: bool }
 * Cap nhat a.base (moc) tai cho voi loai move.
 */
export function evalAlert(a, s) {
  if (!s.floor) return { fire: null, remove: false };
  if (a.kind === 'below' && s.floor <= a.value) {
    return { fire: `🔔 ${s.name}: floor ${n(s.floor)} ${s.symbol} đã xuống ≤ ${a.value}`, remove: true };
  }
  if (a.kind === 'above' && s.floor >= a.value) {
    return { fire: `🔔 ${s.name}: floor ${n(s.floor)} ${s.symbol} đã lên ≥ ${a.value}`, remove: true };
  }
  if (a.kind === 'move') {
    if (!a.base) {
      a.base = s.floor;
      return { fire: null, remove: false };
    }
    const change = ((s.floor - a.base) / a.base) * 100;
    if (Math.abs(change) >= a.value) {
      const text = `${change > 0 ? '📈' : '📉'} ${s.name}: floor ${n(a.base)} → ${n(s.floor)} ${s.symbol} (${change > 0 ? '+' : ''}${change.toFixed(1)}%)`;
      a.base = s.floor;
      return { fire: text, remove: false };
    }
  }
  return { fire: null, remove: false };
}
