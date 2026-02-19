import 'dotenv/config';

import fs from 'node:fs';
import path from 'node:path';

import solc from 'solc';
import { createPublicClient, createWalletClient, defineChain, http, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

function compileWalletGuardVault() {
  const filePath = path.join(process.cwd(), 'src', 'WalletGuardVault.sol');
  const content = fs.readFileSync(filePath, 'utf8');

  const input = {
    language: 'Solidity',
    sources: {
      'WalletGuardVault.sol': {
        content,
      },
    },
    settings: {
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode.object'],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  const errors = Array.isArray(output.errors) ? output.errors : [];
  const fatal = errors.filter((e) => e.severity === 'error');
  if (fatal.length) {
    throw new Error(fatal.map((e) => e.formattedMessage ?? e.message).join('\n'));
  }

  const contract = output.contracts?.['WalletGuardVault.sol']?.['WalletGuardVault'];
  if (!contract) throw new Error('Compilation output missing WalletGuardVault');

  const abi = contract.abi;
  const bytecodeObject = contract.evm?.bytecode?.object;
  if (!bytecodeObject) throw new Error('Compilation output missing bytecode');

  const bytecode = `0x${bytecodeObject}`;

  return { abi, bytecode };
}

async function main() {
  const rpcUrl = process.env.RPC_URL;
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  const chainIdFromEnv = process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : undefined;

  const ownerFromEnv = process.env.OWNER_ADDRESS;
  const creExecutorFromEnv = process.env.CRE_EXECUTOR_ADDRESS;
  const maxValuePerTxFromEnv = process.env.MAX_VALUE_PER_TX;

  if (!rpcUrl) throw new Error('RPC_URL is required');
  if (!pk) throw new Error('DEPLOYER_PRIVATE_KEY is required');
  if (!creExecutorFromEnv) throw new Error('CRE_EXECUTOR_ADDRESS is required');
  if (!maxValuePerTxFromEnv) throw new Error('MAX_VALUE_PER_TX is required');

  if (!isAddress(creExecutorFromEnv)) throw new Error('CRE_EXECUTOR_ADDRESS must be a valid address');
  if (ownerFromEnv && !isAddress(ownerFromEnv)) throw new Error('OWNER_ADDRESS must be a valid address');

  const maxValuePerTx = BigInt(maxValuePerTxFromEnv);

  const account = privateKeyToAccount(pk);

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

  const { abi, bytecode } = compileWalletGuardVault();

  const owner = ownerFromEnv ?? account.address;

  const hash = await walletClient.deployContract({
    abi,
    bytecode,
    args: [owner, creExecutorFromEnv, maxValuePerTx],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  if (!receipt.contractAddress) {
    throw new Error('Deployment receipt missing contractAddress');
  }

  process.stdout.write(`${receipt.contractAddress}\n`);
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + '\n');
  process.exit(1);
});
