/**
 * Preset cac chain EVM pho bien.
 * Neu chain ban can khong co trong day, cu dien tay CHAIN_ID / RPC_URL / EXPLORER vao .env.
 * Tra cuu chain ID chinh xac tai https://chainlist.org
 */

export const CHAINS = {
  ethereum: {
    chainId: 1,
    rpc: 'https://eth.llamarpc.com',
    explorer: 'https://etherscan.io/tx/',
  },
  base: {
    chainId: 8453,
    rpc: 'https://mainnet.base.org',
    explorer: 'https://basescan.org/tx/',
  },
  arbitrum: {
    chainId: 42161,
    rpc: 'https://arb1.arbitrum.io/rpc',
    explorer: 'https://arbiscan.io/tx/',
  },
  optimism: {
    chainId: 10,
    rpc: 'https://mainnet.optimism.io',
    explorer: 'https://optimistic.etherscan.io/tx/',
  },
  polygon: {
    chainId: 137,
    rpc: 'https://polygon-rpc.com',
    explorer: 'https://polygonscan.com/tx/',
  },
  bsc: {
    chainId: 56,
    rpc: 'https://bsc-dataseed.binance.org',
    explorer: 'https://bscscan.com/tx/',
  },
  avalanche: {
    chainId: 43114,
    rpc: 'https://api.avax.network/ext/bc/C/rpc',
    explorer: 'https://snowtrace.io/tx/',
  },
  zksync: {
    chainId: 324,
    rpc: 'https://mainnet.era.zksync.io',
    explorer: 'https://explorer.zksync.io/tx/',
  },
  blast: {
    chainId: 81457,
    rpc: 'https://rpc.blast.io',
    explorer: 'https://blastscan.io/tx/',
  },
  scroll: {
    chainId: 534352,
    rpc: 'https://rpc.scroll.io',
    explorer: 'https://scrollscan.com/tx/',
  },
  linea: {
    chainId: 59144,
    rpc: 'https://rpc.linea.build',
    explorer: 'https://lineascan.build/tx/',
  },
  robinhood: {
    chainId: 4663,
    rpc: 'https://rpc.mainnet.chain.robinhood.com',
    explorer: 'https://robinhoodchain.blockscout.com/tx/',
  },
};

export function resolveChain(env) {
  const preset = env.CHAIN ? CHAINS[env.CHAIN.toLowerCase()] : null;

  if (env.CHAIN && !preset && !env.CHAIN_ID) {
    throw new Error(
      `Khong biet chain "${env.CHAIN}". Chon mot trong: ${Object.keys(CHAINS).join(', ')}\n` +
        'Hoac dien tay CHAIN_ID + RPC_URL + EXPLORER vao .env.'
    );
  }

  // .env luon uu tien hon preset
  const chainId = env.CHAIN_ID ? parseInt(env.CHAIN_ID, 10) : preset?.chainId;
  const rpc = env.RPC_URL || preset?.rpc;
  const explorer = env.EXPLORER || preset?.explorer || '';

  if (!chainId) throw new Error('Thieu CHAIN hoac CHAIN_ID trong .env');
  if (!rpc) throw new Error('Thieu RPC_URL trong .env');

  return { chainId, rpc, explorer };
}
