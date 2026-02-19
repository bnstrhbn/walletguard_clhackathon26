import cors from 'cors';
import dotenv from 'dotenv';
import express, { type Request, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env'), override: true });
dotenv.config({ path: path.resolve(__dirname, './.env'), override: true });

type RiskRequest = {
  chainId?: number;
  from?: string;
  to?: string;
  data?: string;
  value?: string;
};

type AlchemyRpcError = {
  code?: number;
  message?: string;
  data?: unknown;
};

type AlchemySimDecoded = {
  methodName?: string;
  eventName?: string;
};

type AlchemySimCall = {
  type?: string;
  from?: string;
  to?: string;
  input?: string;
  gasUsed?: string;
  decoded?: AlchemySimDecoded;
};

type AlchemySimLog = {
  address?: string;
  topics?: string[];
  data?: string;
  decoded?: AlchemySimDecoded;
};

type AlchemySimResult = {
  calls?: AlchemySimCall[];
  logs?: AlchemySimLog[];
  error?: string;
  revertReason?: string | null;
};

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ ok: true });
});

function readBearerToken(req: Request): string | undefined {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return undefined;
  if (!header.toLowerCase().startsWith('bearer ')) return undefined;
  return header.slice('bearer '.length).trim();
}

function selectorFromData(data: string | undefined): string | undefined {
  if (!data) return undefined;
  if (typeof data !== 'string') return undefined;
  if (!data.startsWith('0x')) return undefined;
  if (data.length < 10) return undefined;
  return data.slice(0, 10).toLowerCase();
}

function computeRisk(reqBody: RiskRequest): { riskScore: number; flags: string[]; reason: string } {
  const flags: string[] = [];

  const sig = selectorFromData(reqBody.data);
  if (!sig) {
    flags.push('NO_CALLDATA');
  } else {
    if (sig === '0x095ea7b3') flags.push('ERC20_APPROVE');
    else if (sig === '0xa22cb465') flags.push('ERC721_APPROVAL_FOR_ALL');
    else if (sig === '0xa9059cbb') flags.push('ERC20_TRANSFER');
    else if (sig === '0x23b872dd') flags.push('ERC20_TRANSFER_FROM');
    else flags.push('UNKNOWN_SELECTOR');
  }

  let valueWei = 0n;
  try {
    valueWei = BigInt(reqBody.value ?? '0');
  } catch {
    flags.push('INVALID_VALUE');
  }

  const highValueThreshold = 1_000_000_000_000_000_000n;
  if (valueWei >= highValueThreshold) flags.push('HIGH_VALUE');

  let riskScore = 5;
  if (flags.includes('ERC20_APPROVE') || flags.includes('ERC721_APPROVAL_FOR_ALL')) riskScore = 70;
  else if (flags.includes('UNKNOWN_SELECTOR')) riskScore = 50;
  else if (flags.includes('HIGH_VALUE')) riskScore = 40;

  if (flags.includes('INVALID_VALUE')) riskScore = Math.max(riskScore, 60);

  if (riskScore > 100) riskScore = 100;
  if (riskScore < 0) riskScore = 0;

  return {
    riskScore,
    flags,
    reason: `mock-risk:${riskScore}`,
  };
}

function decimalStringToHex(value: string | undefined): string {
  const v = value ?? '0';
  const bi = BigInt(v);
  return `0x${bi.toString(16)}`;
}

function tryParseHexToBigInt(hex: string | undefined): bigint {
  if (!hex) return 0n;
  if (typeof hex !== 'string') return 0n;
  if (!hex.startsWith('0x')) return 0n;
  try {
    return BigInt(hex);
  } catch {
    return 0n;
  }
}

async function alchemySimulateExecution(input: {
  from: string;
  to: string;
  data: string;
  value?: string;
}): Promise<AlchemySimResult> {
  const rpcUrl = process.env.ALCHEMY_RPC_URL ?? process.env.RPC_URL;
  if (!rpcUrl) throw new Error('RPC_URL is required');
  const rpcUrlStr: string = rpcUrl;

  const tx = {
    from: input.from,
    to: input.to,
    data: input.data,
    value: decimalStringToHex(input.value),
    gas: '0x2dc6c0',
    type: '0x2',
    maxPriorityFeePerGas: '0x3b9aca00',
    maxFeePerGas: '0x174876e800',
  };

  async function doRequest(params: unknown[]) {
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'alchemy_simulateExecution',
      params,
    };

    const resp = await fetch(rpcUrlStr, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const rawText = await resp.text();
    let parsed: { result?: AlchemySimResult; error?: AlchemyRpcError } | undefined;
    try {
      parsed = JSON.parse(rawText) as { result?: AlchemySimResult; error?: AlchemyRpcError };
    } catch {
      parsed = undefined;
    }

    if (!resp.ok) {
      if (parsed?.error) return { ok: false as const, error: parsed.error, rawText };
      const bodyPreview = rawText.length > 400 ? `${rawText.slice(0, 400)}...` : rawText;
      throw new Error(`ALCHEMY_HTTP_${resp.status}${bodyPreview ? `:${bodyPreview}` : ''}`);
    }

    if (parsed?.error) return { ok: false as const, error: parsed.error, rawText };
    if (!parsed?.result) throw new Error('ALCHEMY_EMPTY_RESULT');

    return { ok: true as const, result: parsed.result };
  }

  const primary = await doRequest(['FLAT', tx, 'latest']);
  if (primary.ok) return primary.result;

  const msg = primary.error?.message ?? '';
  const canRetry =
    (primary.error?.code === -32602 || primary.error?.code === -32600) &&
    msg.toLowerCase().includes('invalid 1st argument') &&
    msg.toLowerCase().includes('transaction');
  if (!canRetry) {
    throw new Error(`ALCHEMY_RPC_${primary.error?.code ?? 'ERR'}:${primary.error?.message ?? 'unknown'}`);
  }

  const fallbackParamSets: unknown[][] = [
    [tx, 'latest', 'FLAT'],
    [tx, 'FLAT', 'latest'],
    [tx, 'latest'],
  ];

  let lastError: AlchemyRpcError | undefined;
  for (const params of fallbackParamSets) {
    const attempt = await doRequest(params);
    if (attempt.ok) return attempt.result;
    lastError = attempt.error;
  }

  throw new Error(`ALCHEMY_RPC_${lastError?.code ?? 'ERR'}:${lastError?.message ?? 'unknown'}`);
}

function riskFromAlchemySimulation(input: {
  sim: AlchemySimResult;
  heuristic: { riskScore: number; flags: string[]; reason: string };
}): { riskScore: number; flags: string[]; reason: string } {
  const flags = new Set<string>(input.heuristic.flags);
  const { sim } = input;

  flags.add('ALCHEMY_SIMULATED');

  const decodedMethods = (sim.calls ?? [])
    .map((c) => c.decoded?.methodName)
    .filter((m): m is string => typeof m === 'string' && m.length > 0);

  if (decodedMethods.includes('approve')) flags.add('SIM_DECODE_APPROVE');
  if (decodedMethods.includes('setApprovalForAll')) flags.add('SIM_DECODE_SET_APPROVAL_FOR_ALL');

  const totalGasUsed = (sim.calls ?? []).reduce((acc, c) => acc + tryParseHexToBigInt(c.gasUsed), 0n);
  if (totalGasUsed > 500_000n) flags.add('SIM_HIGH_GAS');

  if (sim.revertReason) flags.add('SIM_REVERT');
  if (sim.error && sim.error.length > 0) flags.add('SIM_ERROR');

  let simScore = 0;
  if (flags.has('SIM_DECODE_APPROVE') || flags.has('SIM_DECODE_SET_APPROVAL_FOR_ALL')) simScore = 70;
  else if (flags.has('SIM_HIGH_GAS')) simScore = 40;
  else simScore = 10;

  const riskScore = Math.max(input.heuristic.riskScore, simScore);

  const reason = sim.revertReason
    ? `alchemy:revert:${sim.revertReason}`
    : decodedMethods[0]
      ? `alchemy:method:${decodedMethods[0]}`
      : 'alchemy:ok';

  return {
    riskScore,
    flags: [...flags].sort(),
    reason,
  };
}

app.post('/risk/tx', async (req: Request, res: Response) => {
  const expected = process.env.RISK_API_KEY_ALL;
  const got = readBearerToken(req);

  const gotLen = got?.length ?? 0;
  const gotHasBraces = typeof got === 'string' ? got.includes('{') || got.includes('}') : false;
  const gotPreview =
    typeof got === 'string' && got.length > 0
      ? got.length <= 8
        ? got
        : `${got.slice(0, 3)}...${got.slice(-3)}`
      : '';

  if (expected && got !== expected) {
    console.log(
      `UNAUTHORIZED: bearerLen=${gotLen} expectedLen=${expected.length} hasBraces=${gotHasBraces} preview=${gotPreview} path=${req.path}`,
    );
    res.status(401).json({
      error: 'UNAUTHORIZED',
      bearerLen: gotLen,
      hasBraces: gotHasBraces,
      preview: gotPreview,
    });
    return;
  }

  const body = (req.body ?? {}) as RiskRequest;

  const heuristic = computeRisk(body);

  const canSimulate = Boolean(body.from && body.to && body.data);
  if (!canSimulate) {
    res.status(200).json({
      ...heuristic,
      flags: [...new Set([...heuristic.flags, 'ALCHEMY_SIM_SKIPPED'])].sort(),
      reason: 'alchemy:skipped',
    });
    return;
  }

  try {
    const sim = await alchemySimulateExecution({
      from: body.from as string,
      to: body.to as string,
      data: body.data as string,
      value: body.value,
    });

    const out = riskFromAlchemySimulation({ sim, heuristic });
    res.status(200).json(out);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(200).json({
      ...heuristic,
      flags: [...new Set([...heuristic.flags, 'ALCHEMY_SIM_FAILED'])].sort(),
      reason: `alchemy:failed:${msg}`,
    });
  }
});

const port = process.env.PORT ? Number(process.env.PORT) : 8811;

app.listen(port, () => {
  const expected = process.env.RISK_API_KEY_ALL;
  console.log(`Auth enabled: ${Boolean(expected)}${expected ? ` (expectedLen=${expected.length})` : ''}`);
  console.log(`Mock risk service listening on :${port}`);
});
