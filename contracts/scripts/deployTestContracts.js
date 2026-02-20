import 'dotenv/config';

import fs from 'node:fs';
import path from 'node:path';

import solc from 'solc';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

function compileTestContracts() {
  const filePath = path.join(process.cwd(), 'src', 'TestContracts.sol');
  const content = fs.readFileSync(filePath, 'utf8');

  const input = {
    language: 'Solidity',
    sources: {
      'TestContracts.sol': {
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

  const compiled = output.contracts?.['TestContracts.sol'];
  if (!compiled) throw new Error('Compilation output missing TestContracts.sol');

  function pick(name) {
    const c = compiled[name];
    if (!c) throw new Error(`Compilation output missing ${name}`);
    const abi = c.abi;
    const bytecodeObject = c.evm?.bytecode?.object;
    if (!bytecodeObject) throw new Error(`Compilation output missing bytecode for ${name}`);
    const bytecode = `0x${bytecodeObject}`;
    return { abi, bytecode };
  }

  return {
    testErc20: pick('TestERC20'),
    evilSpender: pick('EvilSpender'),
  };
}

async function main() {
  const rpcUrl = process.env.RPC_URL;
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  const chainIdFromEnv = process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : undefined;

  if (!rpcUrl) throw new Error('RPC_URL is required');
  if (!pk) throw new Error('DEPLOYER_PRIVATE_KEY is required');

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

  const { testErc20, evilSpender } = compileTestContracts();

  const tokenHash = await walletClient.deployContract({
    abi: testErc20.abi,
    bytecode: testErc20.bytecode,
    args: [],
  });
  const tokenReceipt = await publicClient.waitForTransactionReceipt({ hash: tokenHash });
  if (!tokenReceipt.contractAddress) throw new Error('Token deploy missing contractAddress');

  const evilHash = await walletClient.deployContract({
    abi: evilSpender.abi,
    bytecode: evilSpender.bytecode,
    args: [],
  });
  const evilReceipt = await publicClient.waitForTransactionReceipt({ hash: evilHash });
  if (!evilReceipt.contractAddress) throw new Error('EvilSpender deploy missing contractAddress');

  process.stdout.write(
    JSON.stringify(
      {
        chainId,
        testErc20: tokenReceipt.contractAddress,
        evilSpender: evilReceipt.contractAddress,
      },
      null,
      2,
    ) + '\n',
  );
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + '\n');
  process.exit(1);
});
