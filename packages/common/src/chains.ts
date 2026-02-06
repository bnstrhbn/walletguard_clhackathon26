export type ChainInfo = {
  chainId: number;
  name: string;
};

export const CHAINS: Record<number, ChainInfo> = {
  1: { chainId: 1, name: 'Ethereum' },
  10: { chainId: 10, name: 'Optimism' },
  56: { chainId: 56, name: 'BNB Chain' },
  137: { chainId: 137, name: 'Polygon' },
  8453: { chainId: 8453, name: 'Base' },
  42161: { chainId: 42161, name: 'Arbitrum' },
  43114: { chainId: 43114, name: 'Avalanche' },
  11155111: { chainId: 11155111, name: 'Sepolia' },
};
