import 'dotenv/config';

import { createPublicClient, createWalletClient, defineChain, http, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const VAULT_ABI = [
  {
    type: 'function',
    name: 'setTargetAllowed',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'allowed', type: 'bool' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setSelectorAllowed',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'selector', type: 'bytes4' },
      { name: 'allowed', type: 'bool' },
    ],
    outputs: [],
  },
] ;

function parsePrivateKey(pk) {
  return pk.startsWith('0x') ? pk : `0x${pk}`;
}

function parseSelectors(value) {
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!parts.length) return [];

  return parts.map((p) => {
    const hex = p.startsWith('0x') ? p : `0x${p}`;
    if (hex.length !== 10) throw new Error(`Selector must be 4 bytes (0x + 8 hex chars), got ${p}`);
    return hex;
  });
}

async function main() {
  const rpcUrl = process.env.RPC_URL;
  const chainIdFromEnv = process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : undefined;

  const ownerPk = process.env.OWNER_PRIVATE_KEY;
  const vaultAddress = process.env.VAULT_ADDRESS;
  const allowTarget = process.env.ALLOW_TARGET;
  const allowSelectorsRaw = process.env.ALLOW_SELECTORS;

  if (!rpcUrl) throw new Error('RPC_URL is required');
  if (!ownerPk) throw new Error('OWNER_PRIVATE_KEY is required');
  if (!vaultAddress) throw new Error('VAULT_ADDRESS is required');
  if (!allowTarget) throw new Error('ALLOW_TARGET is required');
  if (!allowSelectorsRaw) throw new Error('ALLOW_SELECTORS is required');

  if (!isAddress(vaultAddress)) throw new Error('VAULT_ADDRESS must be a valid address');
  if (!isAddress(allowTarget)) throw new Error('ALLOW_TARGET must be a valid address');

  const account = privateKeyToAccount(parsePrivateKey(ownerPk));

  const tempPublicClient = createPublicClient({
    transport: http(rpcUrl),
  });

  const chainId = chainIdFromEnv ?? (await tempPublicClient.getChainId());

  const chain = defineChain({
    id: chainId,
    name: `Custom-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: {
      default: {
        http: [rpcUrl],
      },
    },
  });

  const walletClient = createWalletClient({
    chain,
    account,
    transport: http(rpcUrl),
  });

  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });

  const selectors = parseSelectors(allowSelectorsRaw);

  const hashes = [];

  hashes.push(
    await walletClient.writeContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'setTargetAllowed',
      args: [allowTarget, true],
    }),
  );

  for (const sel of selectors) {
    hashes.push(
      await walletClient.writeContract({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: 'setSelectorAllowed',
        args: [allowTarget, sel, true],
      }),
    );
  }

  for (const h of hashes) {
    await publicClient.waitForTransactionReceipt({ hash: h });
    process.stdout.write(`${h}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + '\n');
  process.exit(1);
});
