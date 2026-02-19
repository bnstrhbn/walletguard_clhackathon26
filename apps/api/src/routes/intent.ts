import express from 'express';

import {
  VaultIntentSchema,
  VaultReceiptSchema,
  VaultRiskSignalSchema,
  buildVaultReceipt,
  type VaultDecision,
  type VaultIntent,
  type VaultReceipt,
  type VaultRiskSignal,
} from '@walletguard/common';

import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const VAULT_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'receiptHash', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;

function loadExecutorAccount(): { rpcUrl: string; privateKey: `0x${string}` } {
  const rpcUrl = process.env.RPC_URL;
  const pk = process.env.CRE_EXECUTOR_PRIVATE_KEY;

  if (!rpcUrl) throw new Error('RPC_URL is required');
  if (!pk) throw new Error('CRE_EXECUTOR_PRIVATE_KEY is required');

  const privateKey = pk.startsWith('0x') ? (pk as `0x${string}`) : (`0x${pk}` as `0x${string}`);
  return { rpcUrl, privateKey };
}

function loadRiskApiConfig(): { riskApiUrl: string; riskApiKey: string } {
  const riskApiUrl = process.env.RISK_API_URL;
  const riskApiKey = process.env.RISK_API_KEY ?? process.env.RISK_API_KEY_ALL;

  if (!riskApiUrl) throw new Error('RISK_API_URL is required');
  if (!riskApiKey) throw new Error('RISK_API_KEY (or RISK_API_KEY_ALL) is required');

  return { riskApiUrl, riskApiKey };
}

function decisionFromRisk(input: { intent: VaultIntent; risk: VaultRiskSignal }): VaultDecision {
  const { intent, risk } = input;

  let action: VaultDecision['action'];
  if (risk.riskScore >= 80) action = 'block';
  else if (risk.riskScore >= 40) action = 'warn';
  else action = 'allow';

  return {
    action,
    mode: intent.mode,
    risk: {
      ...risk,
      flags: [...risk.flags].sort(),
    },
  };
}

export const intentRouter: express.Router = express.Router();

intentRouter.post('/analyze', async (req: express.Request, res: express.Response) => {
  const parsed = VaultIntentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'INVALID_REQUEST',
      issues: parsed.error.issues,
    });
    return;
  }

  const engineVersion = process.env.ENGINE_VERSION ?? 'dev';

  const intent: VaultIntent = {
    ...parsed.data,
    vault: parsed.data.vault.toLowerCase() as VaultIntent['vault'],
    to: parsed.data.to.toLowerCase() as VaultIntent['to'],
    data: parsed.data.data.toLowerCase() as VaultIntent['data'],
    value: (parsed.data.value ?? '0').toString(),
  };

  let riskApiUrl: string;
  let riskApiKey: string;
  try {
    ({ riskApiUrl, riskApiKey } = loadRiskApiConfig());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg });
    return;
  }

  try {
    const riskResp = await fetch(riskApiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${riskApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chainId: intent.chainId,
        from: intent.vault,
        to: intent.to,
        data: intent.data,
        value: intent.value ?? '0',
      }),
    });

    if (!riskResp.ok) {
      res.status(502).json({
        error: 'RISK_API_FAILED',
        status: riskResp.status,
      });
      return;
    }

    const riskJson = await riskResp.json();
    const parsedRisk = VaultRiskSignalSchema.safeParse(riskJson);
    if (!parsedRisk.success) {
      res.status(502).json({
        error: 'RISK_API_INVALID_RESPONSE',
        issues: parsedRisk.error.issues,
      });
      return;
    }

    const decision = decisionFromRisk({ intent, risk: parsedRisk.data });

    const receipt = buildVaultReceipt({
      intent,
      decision,
      engineVersion,
    });

    res.status(200).json(receipt);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: 'ANALYZE_FAILED', message: msg });
  }
});

intentRouter.post('/execute', async (req: express.Request, res: express.Response) => {
  const parsed = VaultReceiptSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'INVALID_REQUEST',
      issues: parsed.error.issues,
    });
    return;
  }

  const receipt = parsed.data as VaultReceipt;

  if (receipt.decision.action === 'block') {
    res.status(403).json({
      error: 'BLOCKED',
      receipt,
    });
    return;
  }

  let rpcUrl: string;
  let privateKey: `0x${string}`;
  try {
    ({ rpcUrl, privateKey } = loadExecutorAccount());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg });
    return;
  }

  const account = privateKeyToAccount(privateKey);

  const chain = defineChain({
    id: receipt.intent.chainId,
    name: `Custom-${receipt.intent.chainId}`,
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

  const value = BigInt(receipt.intent.value ?? '0');

  try {
    const hash = await walletClient.writeContract({
      address: receipt.intent.vault,
      abi: VAULT_ABI,
      functionName: 'execute',
      args: [receipt.intent.to, value, receipt.intent.data, receipt.hashes.receiptHash],
    });

    const txReceipt = await publicClient.waitForTransactionReceipt({ hash });

    res.status(200).json({
      ok: true,
      txHash: hash,
      status: txReceipt.status,
      receiptHash: receipt.hashes.receiptHash,
      executor: account.address,
      vault: receipt.intent.vault,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({
      error: 'EXECUTION_FAILED',
      message: msg,
    });
  }
});
