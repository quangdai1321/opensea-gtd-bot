/**
 * Ví co quyen mint tung giai doan hay khong, TRUOC khi giai doan mo.
 *
 * API cong khai cua OpenSea khong co thong tin nay. Trang web opensea.io lay tu GraphQL noi bo
 * (gql.opensea.io, DropEligibilityQuery), can phien dang nhap cua chinh ban.
 * Bot KHONG tu dang nhap: ban chep token tu trinh duyet vao .env
 *   OPENSEA_JWT=eyJ...        (header authorization: Bearer ...)
 *   OPENSEA_COOKIE=...        (hoac nguyen header cookie)
 * API noi bo, khong co tai lieu: co the hong khi OpenSea doi web. Hong thi bot quay ve cach cu.
 */

const GQL_URL = 'https://gql.opensea.io/graphql';
const QUERY = `query DropEligibilityQuery($collectionSlug: String!, $address: Address!) {
  dropBySlug(slug: $collectionSlug) {
    __typename
    stages {
      uuid stageType stageIndex
      viewerEligibility(minter: $address) { status alternateWallet maxMintable }
      maxTotalMintableByWallet
    }
  }
}`;

export function hasAuth() {
  return Boolean(process.env.OPENSEA_JWT || process.env.OPENSEA_COOKIE);
}

/** Thoi diem het han cua JWT (ms) hoac null neu khong doc duoc */
export function jwtExpiry() {
  const t = (process.env.OPENSEA_JWT || '').replace(/^Bearer\s+/i, '');
  try {
    const payload = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));
    return payload.exp ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * -> { stages: Map<uuid, { status, maxMintable, stageType }> }
 *    status: ELIGIBLE | NOT_ELIGIBLE | ELIGIBLE_VIA_OTHER_WALLET | UNKNOWN
 * Nem loi co .auth = true neu token sai / het han.
 */
export async function fetchEligibility(slug, address) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    origin: 'https://opensea.io',
    referer: 'https://opensea.io/',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
    'x-app-id': 'os2-web',
  };
  if (process.env.OPENSEA_JWT) headers.authorization = `Bearer ${process.env.OPENSEA_JWT.replace(/^Bearer\s+/i, '')}`;
  if (process.env.OPENSEA_COOKIE) headers.cookie = process.env.OPENSEA_COOKIE;

  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ operationName: 'DropEligibilityQuery', query: QUERY, variables: { collectionSlug: slug, address } }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  const authErr = (body.errors || []).find((e) => e.extensions?.code === 'UNAUTHORIZED' || /jwt|unauth/i.test(e.message || ''));
  if (authErr || res.status === 401 || res.status === 403) {
    const err = new Error(`OpenSea từ chối token (${body.extensions?.auth?.error?.classification || authErr?.message || res.status}). Lấy token mới.`);
    err.auth = true;
    throw err;
  }
  const drop = body.data?.dropBySlug;
  if (!drop) throw new Error(`Không đọc được eligibility: ${(body.errors || []).map((e) => e.message).join('; ') || `HTTP ${res.status}`}`);

  const stages = new Map();
  for (const s of drop.stages || []) {
    stages.set(s.uuid, {
      stageType: s.stageType,
      status: s.viewerEligibility?.status || 'UNKNOWN',
      maxMintable: s.viewerEligibility?.maxMintable ?? null,
      alternateWallet: s.viewerEligibility?.alternateWallet || null,
    });
  }
  return { stages };
}

export function eligIcon(e) {
  if (!e) return '';
  if (e.status === 'ELIGIBLE') return ` ✅ CÓ QUYỀN${e.maxMintable ? ` (${e.maxMintable})` : ''}`;
  if (e.status === 'NOT_ELIGIBLE') return ' ❌ không có quyền';
  if (e.status === 'ELIGIBLE_VIA_OTHER_WALLET') return ` ↪️ ví khác có quyền${e.alternateWallet ? ` (${e.alternateWallet.slice(0, 6)}…)` : ''}`;
  return ' ❔';
}
