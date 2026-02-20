import cors from 'cors';
import dotenv from 'dotenv';
import express, { type Request, type Response } from 'express';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.resolve(__dirname, './.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeHexTopic(topic: string | undefined): string | undefined {
  if (!topic || typeof topic !== 'string') return undefined;
  const t = topic.toLowerCase();
  if (!t.startsWith('0x')) return undefined;
  return t;
}

function addressFromTopic(topic: string | undefined): string | undefined {
  const t = normalizeHexTopic(topic);
  if (!t) return undefined;
  if (t.length !== 66) return undefined;
  return `0x${t.slice(26)}`;
}

function uint256FromHexData(data: string | undefined): bigint | undefined {
  if (!data || typeof data !== 'string') return undefined;
  const d = data.toLowerCase();
  if (!d.startsWith('0x')) return undefined;
  try {
    return BigInt(d);
  } catch {
    return undefined;
  }
}

type RiskRequest = {
  chainId?: number;
  from?: string;
  to?: string;
  data?: string;
  value?: string;
  expectedTokenBalanceDeltas?: Array<{
    token: string;
    holder: string;
    delta: string;
    tolerance?: string;
  }>;
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
  address: string;
  topics: string[];
  data: string;
};

type SimLog = {
  address: string;
  topics: string[];
  data: string;
};

type AlchemySimResult = {
  calls?: AlchemySimCall[];
  logs?: AlchemySimLog[];
  error?: string;
  revertReason?: string | null;
};

type SimSummary = {
  decodedMethods: string[];
  totalGasUsed: bigint;
  revertReason?: string;
  errorMessage?: string;
  source?: 'alchemy' | 'tenderly:rest' | 'tenderly:rpc';
  logs?: SimLog[];
  traceCalls?: Array<{ from: string; to: string; callType?: string; valueWei?: bigint; depth: number }>;
};

const debugTenderly = (() => {
  const v = (process.env.DEBUG_TENDERLY ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
})();

function tenderlyLog(event: string, data: Record<string, unknown>) {
  if (!debugTenderly) return;
  try {
    process.stdout.write(`[tenderly] ${event} ${JSON.stringify(data)}\n`);
  } catch {
    process.stdout.write(`[tenderly] ${event}\n`);
  }
}

async function ethBlockNumber(rpcUrl: string): Promise<number> {
  const resp = await fetch(rpcUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_blockNumber',
      params: [],
    }),
  });

  const json = (await resp.json()) as { result?: string };
  const hex = typeof json?.result === 'string' ? json.result : '';
  if (!hex || !hex.startsWith('0x')) throw new Error('ETH_BLOCK_NUMBER_MISSING');
  return Number.parseInt(hex.slice(2), 16);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const simCache = new Map<
  string,
  {
    ts: number;
    out: { riskScore: number; flags: string[]; reason: string };
  }
>();

function cacheKey(body: RiskRequest): string {
  const expected = Array.isArray(body.expectedTokenBalanceDeltas)
    ? [...body.expectedTokenBalanceDeltas]
        .map((e) => {
          const token = String(e?.token ?? '').toLowerCase();
          const holder = String(e?.holder ?? '').toLowerCase();
          const delta = String(e?.delta ?? '0');
          const tolerance = e?.tolerance === undefined ? '' : String(e.tolerance);
          return `${token}:${holder}:${delta}:${tolerance}`;
        })
        .sort()
        .join(',')
    : '';

  return [
    String(body.chainId ?? ''),
    String(body.from ?? '').toLowerCase(),
    String(body.to ?? '').toLowerCase(),
    String(body.value ?? '0'),
    String(body.data ?? '').toLowerCase(),
    expected,
  ].join('|');
}

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

function wordAt(data: string, wordIndex: number): string | undefined {
  if (!data.startsWith('0x')) return undefined;
  const start = 2 + 8 + wordIndex * 64;
  const end = start + 64;
  if (data.length < end) return undefined;
  return data.slice(start, end).toLowerCase();
}

function addressFromWord(word: string | undefined): string | undefined {
  if (!word || word.length !== 64) return undefined;
  return `0x${word.slice(24)}`.toLowerCase();
}

function isAllFs(word: string | undefined): boolean {
  if (!word || word.length !== 64) return false;
  return /^f{64}$/.test(word);
}

function readAllowedAddresses(): Set<string> {
  const raw = process.env.ALLOWED_ADDRESSES;
  if (!raw || typeof raw !== 'string') return new Set();
  const trimmed = raw.trim();
  if (!trimmed) return new Set();
  return new Set(
    trimmed
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^0x[0-9a-f]{40}$/.test(s)),
  );
}

function isEmptyCalldata(data: string | undefined): boolean {
  if (!data || typeof data !== 'string') return true;
  const d = data.toLowerCase();
  return d === '0x' || d === '0x0';
}

function computeRisk(reqBody: RiskRequest): { riskScore: number; flags: string[]; reason: string } {
  const flags: string[] = [];

  const allowlist = readAllowedAddresses();

  if (allowlist.size > 0) {
    const target = typeof reqBody.to === 'string' ? reqBody.to.toLowerCase() : '';
    if (/^0x[0-9a-f]{40}$/.test(target) && !allowlist.has(target)) {
      flags.push('TARGET_NOT_ALLOWLISTED');
    }
  }

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

  if (typeof reqBody.data === 'string' && reqBody.data.startsWith('0x') && sig === '0x095ea7b3') {
    const spenderWord = wordAt(reqBody.data, 0);
    const spender = addressFromWord(spenderWord);
    if (allowlist.size > 0 && spender && !allowlist.has(spender)) flags.push('SPENDER_NOT_ALLOWLISTED');

    const amountWord = wordAt(reqBody.data, 1);
    if (isAllFs(amountWord)) flags.push('MAX_APPROVAL');
  }

  if (typeof reqBody.data === 'string' && reqBody.data.startsWith('0x') && sig === '0xa22cb465') {
    const operatorWord = wordAt(reqBody.data, 0);
    const operator = addressFromWord(operatorWord);
    if (allowlist.size > 0 && operator && !allowlist.has(operator)) flags.push('SPENDER_NOT_ALLOWLISTED');
  }

  if (typeof reqBody.data === 'string' && reqBody.data.startsWith('0x') && sig === '0xa9059cbb') {
    const toWord = wordAt(reqBody.data, 0);
    const recipient = addressFromWord(toWord);
    if (allowlist.size > 0 && recipient && !allowlist.has(recipient)) flags.push('RECIPIENT_NOT_ALLOWLISTED');
  }

  if (typeof reqBody.data === 'string' && reqBody.data.startsWith('0x') && sig === '0x23b872dd') {
    const toWord = wordAt(reqBody.data, 1);
    const recipient = addressFromWord(toWord);
    if (allowlist.size > 0 && recipient && !allowlist.has(recipient)) flags.push('RECIPIENT_NOT_ALLOWLISTED');
  }

  if (allowlist.size > 0 && isEmptyCalldata(reqBody.data)) {
    const recipient = typeof reqBody.to === 'string' ? reqBody.to.toLowerCase() : '';
    if (/^0x[0-9a-f]{40}$/.test(recipient) && !allowlist.has(recipient)) {
      flags.push('RECIPIENT_NOT_ALLOWLISTED');
    }
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
  if (flags.includes('TARGET_NOT_ALLOWLISTED')) riskScore = Math.max(riskScore, 95);
  if (flags.includes('RECIPIENT_NOT_ALLOWLISTED')) riskScore = Math.max(riskScore, 95);
  if (flags.includes('SPENDER_NOT_ALLOWLISTED')) riskScore = Math.max(riskScore, 95);
  if (flags.includes('MAX_APPROVAL')) riskScore = Math.max(riskScore, 85);
  if (flags.includes('ERC20_APPROVE') || flags.includes('ERC721_APPROVAL_FOR_ALL')) riskScore = Math.max(riskScore, 70);
  if (flags.includes('UNKNOWN_SELECTOR')) riskScore = Math.max(riskScore, 85);
  if (flags.includes('HIGH_VALUE')) riskScore = Math.max(riskScore, 40);

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

  const tx1559: Record<string, unknown> = {
    from: input.from,
    to: input.to,
    data: input.data,
    value: decimalStringToHex(input.value),
    gas: '0x2dc6c0',
    type: '0x2',
    maxPriorityFeePerGas: '0x3b9aca00',
    maxFeePerGas: '0x174876e800',
  };

  const txLegacyZeroGasPrice: Record<string, unknown> = {
    from: input.from,
    to: input.to,
    data: input.data,
    value: decimalStringToHex(input.value),
    gas: '0x2dc6c0',
    gasPrice: '0x0',
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

  async function simulateWithTx(tx: Record<string, unknown>) {
    const paramSets: unknown[][] = [
      ['FLAT', tx, 'latest'],
      [tx, 'latest', 'FLAT'],
      [tx, 'FLAT', 'latest'],
      [tx, 'latest'],
    ];

    let lastError: AlchemyRpcError | undefined;
    for (const params of paramSets) {
      const attempt = await doRequest(params);
      if (attempt.ok) return { ok: true as const, result: attempt.result };
      lastError = attempt.error;
    }

    return { ok: false as const, error: lastError };
  }

  const first = await simulateWithTx(tx1559);
  if (first.ok) return first.result;

  const firstMsg = first.error?.message ?? '';
  const insufficientFunds =
    first.error?.code === -32000 &&
    firstMsg.toLowerCase().includes('insufficient funds for gas');

  if (insufficientFunds) {
    const retry = await simulateWithTx(txLegacyZeroGasPrice);
    if (retry.ok) return retry.result;
    throw new Error(`ALCHEMY_RPC_${retry.error?.code ?? 'ERR'}:${retry.error?.message ?? 'unknown'}`);
  }

  throw new Error(`ALCHEMY_RPC_${first.error?.code ?? 'ERR'}:${first.error?.message ?? 'unknown'}`);
}

function simSummaryFromAlchemy(sim: AlchemySimResult): SimSummary {
  const decodedMethods = (sim.calls ?? [])
    .map((c) => c.decoded?.methodName)
    .filter((m): m is string => typeof m === 'string' && m.length > 0);

  const totalGasUsed = (sim.calls ?? []).reduce((acc, c) => acc + tryParseHexToBigInt(c.gasUsed), 0n);

  return {
    decodedMethods,
    totalGasUsed,
    revertReason: typeof sim.revertReason === 'string' ? sim.revertReason : undefined,
    errorMessage: typeof sim.error === 'string' ? sim.error : undefined,
    source: 'alchemy',
    logs: (sim.logs ?? []).filter((l) => l && typeof l.address === 'string' && Array.isArray(l.topics) && typeof l.data === 'string'),
  };
}

function extractSimSummaryDeep(input: unknown): SimSummary {
  const decodedMethods = new Set<string>();
  let totalGasUsed = 0n;
  let revertReason: string | undefined;
  let errorMessage: string | undefined;
  const logs: SimLog[] = [];
  const traceCalls: Array<{ from: string; to: string; callType?: string; valueWei?: bigint; depth: number }> = [];

  const seen = new Set<unknown>();
  const queue: Array<{ v: unknown; depth: number }> = [{ v: input, depth: 0 }];
  const MAX_DEPTH = 10;
  const MAX_NODES = 5000;
  let nodes = 0;

  while (queue.length > 0) {
    const { v, depth } = queue.shift() as { v: unknown; depth: number };
    nodes += 1;
    if (nodes > MAX_NODES) break;
    if (!v || typeof v !== 'object') continue;
    if (seen.has(v)) continue;
    seen.add(v);

    const obj = v as Record<string, unknown>;

    const fromLike = (() => {
      const cand =
        (typeof obj.from === 'string' && obj.from) ||
        (typeof obj.caller === 'string' && obj.caller) ||
        (typeof (obj as { caller_address?: unknown }).caller_address === 'string' && (obj as { caller_address: string }).caller_address) ||
        (typeof (obj as { callerAddress?: unknown }).callerAddress === 'string' && (obj as { callerAddress: string }).callerAddress);
      const s = typeof cand === 'string' ? cand.toLowerCase() : '';
      return /^0x[0-9a-f]{40}$/.test(s) ? s : undefined;
    })();

    const toLike = (() => {
      const cand =
        (typeof obj.to === 'string' && obj.to) ||
        (typeof obj.callee === 'string' && obj.callee) ||
        (typeof (obj as { callee_address?: unknown }).callee_address === 'string' && (obj as { callee_address: string }).callee_address) ||
        (typeof (obj as { calleeAddress?: unknown }).calleeAddress === 'string' && (obj as { calleeAddress: string }).calleeAddress) ||
        (typeof (obj as { contract_address?: unknown }).contract_address === 'string' &&
          (obj as { contract_address: string }).contract_address) ||
        (typeof (obj as { contractAddress?: unknown }).contractAddress === 'string' && (obj as { contractAddress: string }).contractAddress);
      const s = typeof cand === 'string' ? cand.toLowerCase() : '';
      return /^0x[0-9a-f]{40}$/.test(s) ? s : undefined;
    })();

    const callTypeLike = (() => {
      const cand =
        (typeof (obj as { call_type?: unknown }).call_type === 'string' && (obj as { call_type: string }).call_type) ||
        (typeof (obj as { callType?: unknown }).callType === 'string' && (obj as { callType: string }).callType) ||
        (typeof obj.type === 'string' && obj.type);
      const s = typeof cand === 'string' ? cand.toUpperCase() : undefined;
      return s;
    })();

    const valueWeiLike = (() => {
      const cand =
        obj.value ??
        (obj as { value_wei?: unknown }).value_wei ??
        (obj as { valueWei?: unknown }).valueWei;
      if (typeof cand === 'string') {
        const s = cand.toLowerCase();
        if (s.startsWith('0x')) {
          try {
            return BigInt(s);
          } catch {
            return undefined;
          }
        }
        if (/^[0-9]+$/.test(s)) {
          try {
            return BigInt(s);
          } catch {
            return undefined;
          }
        }
      }
      if (typeof cand === 'number' && Number.isFinite(cand) && cand >= 0) {
        return BigInt(Math.floor(cand));
      }
      return undefined;
    })();

    if (fromLike && toLike && traceCalls.length < 400) {
      if (callTypeLike && ['CALL', 'DELEGATECALL', 'STATICCALL', 'CALLCODE', 'CREATE', 'CREATE2'].includes(callTypeLike)) {
        traceCalls.push({ from: fromLike, to: toLike, callType: callTypeLike, valueWei: valueWeiLike, depth });
      }
    }

    for (const [k, val] of Object.entries(obj)) {
      const key = k.toLowerCase();

      if (
        (key === 'methodname' || key === 'method_name' || key === 'functionname' || key === 'function_name') &&
        typeof val === 'string' &&
        val.length > 0
      ) {
        decodedMethods.add(val);
      }

      if (key === 'logs' && Array.isArray(val) && logs.length < 200) {
        for (const it of val) {
          if (!it || typeof it !== 'object') continue;
          const lo = it as Record<string, unknown>;
          const address = typeof lo.address === 'string' ? lo.address.toLowerCase() : '';
          const topics = Array.isArray(lo.topics) ? lo.topics.filter((t) => typeof t === 'string') : [];
          const data = typeof lo.data === 'string' ? lo.data.toLowerCase() : '';
          if (!/^0x[0-9a-f]{40}$/.test(address)) continue;
          if (!data.startsWith('0x')) continue;
          if (topics.length === 0) continue;
          logs.push({ address, topics: topics.map((t) => t.toLowerCase()), data });
          if (logs.length >= 200) break;
        }
      }

      if ((key === 'revertreason' || key === 'revert_reason') && typeof val === 'string' && val.length > 0) {
        revertReason = revertReason ?? val;
      }

      if ((key === 'errormessage' || key === 'error_message' || key === 'error') && typeof val === 'string' && val.length > 0) {
        errorMessage = errorMessage ?? val;
      }

      if (key === 'gasused' || key === 'gas_used') {
        if (typeof val === 'string') {
          totalGasUsed += tryParseHexToBigInt(val);
        } else if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
          totalGasUsed += BigInt(Math.floor(val));
        }
      }

      if (depth < MAX_DEPTH) {
        if (Array.isArray(val)) {
          for (const it of val) queue.push({ v: it, depth: depth + 1 });
        } else if (val && typeof val === 'object') {
          queue.push({ v: val, depth: depth + 1 });
        }
      }
    }
  }

  return {
    decodedMethods: [...decodedMethods],
    totalGasUsed,
    revertReason,
    errorMessage,
    logs: logs.length > 0 ? logs : undefined,
    traceCalls: traceCalls.length > 0 ? traceCalls : undefined,
  };
}

async function tenderlySimulateExecution(input: {
  chainId?: number;
  from: string;
  to: string;
  data: string;
  value?: string;
}): Promise<SimSummary> {
  const rpcUrl = process.env.TENDERLY_RPC_URL;
  const accessToken = process.env.TENDERLY_ACCESS_TOKEN;
  const looksLikeRest =
    typeof rpcUrl === 'string' &&
    (rpcUrl.includes('api.tenderly.co/api/v1/') || rpcUrl.includes('/simulate') || rpcUrl.includes('/account/'));

  async function simulateRest(): Promise<SimSummary> {
    if (!accessToken) throw new Error('TENDERLY_ACCESS_TOKEN_REQUIRED');

    const accountSlug = process.env.TENDERLY_ACCOUNT_SLUG ?? 'bnstrhbn';
    const projectSlug = process.env.TENDERLY_PROJECT_SLUG ?? 'project';

    const url = `https://api.tenderly.co/api/v1/account/${accountSlug}/project/${projectSlug}/simulate`;

    const rpc =
      rpcUrl && typeof rpcUrl === 'string' && rpcUrl.length > 0 && !looksLikeRest
        ? rpcUrl
        : (process.env.RPC_URL ?? process.env.ALCHEMY_RPC_URL);
    let blockNumber: number | undefined;
    if (rpc) {
      try {
        blockNumber = await ethBlockNumber(rpc);
      } catch {
        blockNumber = undefined;
      }
    }

    const valueNum = (() => {
      try {
        const bi = BigInt(input.value ?? '0');
        if (bi > BigInt(Number.MAX_SAFE_INTEGER)) return 0;
        return Number(bi);
      } catch {
        return 0;
      }
    })();

    const baseBody: Record<string, unknown> = {
      network_id: String(input.chainId ?? 1),
      from: input.from,
      to: input.to,
      input: input.data,
      gas: 1_000_000,
      gas_price: 0,
      value: valueNum,
      simulation_type: 'full',
    };

    const candidates: Array<Record<string, unknown>> = [];
    if (typeof blockNumber === 'number' && Number.isFinite(blockNumber)) {
      candidates.push({ ...baseBody, block_number: blockNumber });
    }
    candidates.push({ ...baseBody, block_number: 'latest' });
    candidates.push({ ...baseBody });

    let lastErr: unknown;

    for (const body of candidates) {
      tenderlyLog('rest_request', {
        url,
        network_id: baseBody.network_id,
        block_number: (body as { block_number?: unknown }).block_number ?? null,
        from: input.from,
        to: input.to,
        dataLen: typeof input.data === 'string' ? input.data.length : null,
        value: input.value ?? '0',
      });

      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Access-Key': accessToken,
        },
        body: JSON.stringify(body),
      });

      const rawText = await resp.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText) as unknown;
      } catch {
        parsed = undefined;
      }

      if (!resp.ok) {
        const bodyPreview = rawText.length > 400 ? `${rawText.slice(0, 400)}...` : rawText;
        const err = new Error(`TENDERLY_REST_HTTP_${resp.status}${bodyPreview ? `:${bodyPreview}` : ''}`);
        lastErr = err;

        tenderlyLog('rest_response_error', {
          status: resp.status,
          bodyPreview,
        });

        const preview = bodyPreview.toLowerCase();
        const retryable = resp.status === 400 && preview.includes('json_unmarshal');
        if (retryable) continue;
        throw err;
      }

      const summary = extractSimSummaryDeep(parsed);
      summary.source = 'tenderly:rest';
      tenderlyLog('rest_response_ok', {
        status: resp.status,
        decodedMethods: summary.decodedMethods,
        totalGasUsed: summary.totalGasUsed.toString(),
        revertReason: summary.revertReason ?? null,
        errorMessage: summary.errorMessage ?? null,
      });
      return summary;
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? 'TENDERLY_REST_FAILED'));
  }

  let restErr: unknown | undefined;
  if (accessToken) {
    try {
      return await simulateRest();
    } catch (e) {
      restErr = e;
    }
  }

  if (rpcUrl && typeof rpcUrl === 'string' && rpcUrl.length > 0 && !looksLikeRest) {
    try {
      const rpcEndpoint = rpcUrl;
      const fromLower = input.from.toLowerCase();
      const toLower = input.to.toLowerCase();
      const dataLower = typeof input.data === 'string' ? input.data.toLowerCase() : input.data;
      const stateOverrides = {
        [fromLower]: {
          balance: '0x8ac7230489e80000',
        },
      };
      async function simulateRpcOnce(tx: Record<string, unknown>): Promise<SimSummary> {
        const payload = {
          jsonrpc: '2.0',
          id: 1,
          method: 'tenderly_simulateTransaction',
          params: [tx, 'latest', stateOverrides],
        };

        tenderlyLog('rpc_request', {
          rpcEndpoint,
          from: fromLower,
          to: toLower,
          dataLen: typeof dataLower === 'string' ? dataLower.length : null,
          txKeys: Object.keys(tx).sort(),
        });

        const resp = await fetch(rpcEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(accessToken ? { 'X-Access-Key': accessToken } : {}),
          },
          body: JSON.stringify(payload),
        });

        const rawText = await resp.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawText) as unknown;
        } catch {
          parsed = undefined;
        }

        if (!resp.ok) {
          const bodyPreview = rawText.length > 400 ? `${rawText.slice(0, 400)}...` : rawText;
          tenderlyLog('rpc_response_error', { status: resp.status, bodyPreview });
          throw new Error(`TENDERLY_RPC_HTTP_${resp.status}${bodyPreview ? `:${bodyPreview}` : ''}`);
        }

        const errMsg = (parsed as { error?: { message?: string } } | undefined)?.error?.message;
        if (errMsg) throw new Error(`TENDERLY_RPC_ERROR:${errMsg}`);

        const result = (parsed as { result?: unknown } | undefined)?.result;
        if (!result) throw new Error('TENDERLY_EMPTY_RESULT');

        const summary = extractSimSummaryDeep(result);
        summary.source = 'tenderly:rpc';
        tenderlyLog('rpc_response_ok', {
          decodedMethods: summary.decodedMethods,
          totalGasUsed: summary.totalGasUsed.toString(),
          revertReason: summary.revertReason ?? null,
          errorMessage: summary.errorMessage ?? null,
        });
        return summary;
      }

      const tx1559 = {
        from: fromLower,
        to: toLower,
        gas: '0x0f4240',
        type: '0x2',
        maxPriorityFeePerGas: '0x3b9aca00',
        maxFeePerGas: '0x174876e800',
        value: decimalStringToHex(input.value),
        data: dataLower,
      };

      try {
        return await simulateRpcOnce(tx1559);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes('json_unmarshal')) throw e;

        const txLegacy = {
          from: fromLower,
          to: toLower,
          gas: '0x0f4240',
          gasPrice: '0x0',
          value: decimalStringToHex(input.value),
          data: dataLower,
        };

        return await simulateRpcOnce(txLegacy);
      }
    } catch (e) {
      if (restErr) {
        const restMsg = restErr instanceof Error ? restErr.message : String(restErr);
        const rpcMsg = e instanceof Error ? e.message : String(e);
        throw new Error(`TENDERLY_REST_FAILED:${restMsg}:TENDERLY_RPC_FAILED:${rpcMsg}`);
      }

      if (!accessToken) throw e;
    }
  }

  if (restErr) throw restErr;

  return await simulateRest();
}

function riskFromSimSummary(input: {
  provider: 'alchemy' | 'tenderly';
  summary: SimSummary;
  txFrom: string;
  request: RiskRequest;
  heuristic: { riskScore: number; flags: string[]; reason: string };
}): { riskScore: number; flags: string[]; reason: string } {
  const flags = new Set<string>(input.heuristic.flags);

  if (input.provider === 'alchemy') flags.add('ALCHEMY_SIMULATED');
  else flags.add('TENDERLY_SIMULATED');

  if (input.summary.source === 'tenderly:rest') flags.add('TENDERLY_REST');
  if (input.summary.source === 'tenderly:rpc') flags.add('TENDERLY_RPC');

  const decodedMethods = input.summary.decodedMethods;

  if (decodedMethods.includes('approve')) flags.add('SIM_DECODE_APPROVE');
  if (decodedMethods.includes('setApprovalForAll')) flags.add('SIM_DECODE_SET_APPROVAL_FOR_ALL');

  if (input.summary.totalGasUsed > 500_000n) flags.add('SIM_HIGH_GAS');
  if (input.summary.revertReason) flags.add('SIM_REVERT');
  if (input.summary.errorMessage && input.summary.errorMessage.length > 0) flags.add('SIM_ERROR');

  const allowlist = readAllowedAddresses();
  const txFromLower = input.txFrom.toLowerCase();

  const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';

  const tokenDelta = new Map<string, bigint>();
  function addDelta(token: string, holder: string, delta: bigint) {
    const k = `${token.toLowerCase()}|${holder.toLowerCase()}`;
    tokenDelta.set(k, (tokenDelta.get(k) ?? 0n) + delta);
  }

  if (Array.isArray(input.summary.logs)) {
    for (const l of input.summary.logs) {
      const t0 = normalizeHexTopic(l.topics?.[0]);
      if (!t0) continue;

      if (t0 === TRANSFER_TOPIC) {
        const from = addressFromTopic(l.topics?.[1]);
        const to = addressFromTopic(l.topics?.[2]);
        const amount = uint256FromHexData(l.data) ?? 0n;

        if (from) addDelta(l.address, from, -amount);
        if (to) addDelta(l.address, to, amount);

        if (from && from.toLowerCase() === txFromLower) {
          flags.add('SIM_TOKEN_OUTFLOW');
          if (allowlist.size > 0 && to && !allowlist.has(to.toLowerCase())) {
            flags.add('RECIPIENT_NOT_ALLOWLISTED');
          }
        }
      }

      if (t0 === APPROVAL_TOPIC) {
        const owner = addressFromTopic(l.topics?.[1]);
        const spender = addressFromTopic(l.topics?.[2]);
        if (owner && owner.toLowerCase() === txFromLower) {
          flags.add('SIM_APPROVAL');
          const amount = uint256FromHexData(l.data);
          if (amount === (2n ** 256n - 1n)) flags.add('MAX_APPROVAL');
          if (allowlist.size > 0 && spender && !allowlist.has(spender.toLowerCase())) {
            flags.add('SPENDER_NOT_ALLOWLISTED');
          }
        }
      }
    }
  }

  if (Array.isArray(input.request.expectedTokenBalanceDeltas) && input.request.expectedTokenBalanceDeltas.length > 0) {
    let mismatch = false;
    let unavailable = false;

    for (const exp of input.request.expectedTokenBalanceDeltas) {
      const token = typeof exp?.token === 'string' ? exp.token.toLowerCase() : '';
      const holder = typeof exp?.holder === 'string' ? exp.holder.toLowerCase() : '';
      if (!/^0x[0-9a-f]{40}$/.test(token) || !/^0x[0-9a-f]{40}$/.test(holder)) {
        unavailable = true;
        continue;
      }

      let expected: bigint;
      try {
        expected = BigInt(String(exp.delta ?? '0'));
      } catch {
        unavailable = true;
        continue;
      }

      let tolerance = 0n;
      try {
        if (exp.tolerance !== undefined) tolerance = BigInt(String(exp.tolerance));
      } catch {
        tolerance = 0n;
      }

      const key = `${token}|${holder}`;
      const observed = tokenDelta.get(key) ?? 0n;
      if (!tokenDelta.has(key) && expected !== 0n) unavailable = true;

      const diff = observed >= expected ? observed - expected : expected - observed;
      if (diff > tolerance) mismatch = true;
    }

    if (mismatch) flags.add('EXPECTED_TOKEN_DELTA_MISMATCH');
    else if (unavailable) flags.add('EXPECTED_TOKEN_DELTA_UNAVAILABLE');
  }

  if (Array.isArray(input.summary.traceCalls)) {
    for (const c of input.summary.traceCalls) {
      const to = c.to.toLowerCase();
      const depth = c.depth ?? 0;
      const valueWei = c.valueWei ?? 0n;

      if (c.callType === 'DELEGATECALL' || c.callType === 'CALLCODE') flags.add('SIM_DELEGATECALL_PATH');

      if (depth > 0 && to === txFromLower) flags.add('SIM_REENTRANCY');

      if (depth > 0 && valueWei > 0n) {
        flags.add('SIM_INTERNAL_VALUE_TRANSFER');
        if (allowlist.size > 0 && /^0x[0-9a-f]{40}$/.test(to) && !allowlist.has(to)) {
          flags.add('SIM_INTERNAL_VALUE_TRANSFER_NOT_ALLOWLISTED');
        }
      }

      if (allowlist.size > 0 && depth > 0 && /^0x[0-9a-f]{40}$/.test(to) && !allowlist.has(to)) {
        flags.add('SIM_INTERNAL_TARGET_NOT_ALLOWLISTED');
      }
    }
  }

  let simScore = 0;
  if (flags.has('SIM_DECODE_APPROVE') || flags.has('SIM_DECODE_SET_APPROVAL_FOR_ALL')) simScore = 70;
  else if (flags.has('EXPECTED_TOKEN_DELTA_MISMATCH')) simScore = 85;
  else if (flags.has('SIM_DELEGATECALL_PATH') || flags.has('SIM_INTERNAL_VALUE_TRANSFER_NOT_ALLOWLISTED')) simScore = 95;
  else if (flags.has('SIM_REENTRANCY')) simScore = 85;
  else if (flags.has('SIM_ERROR') || flags.has('SIM_REVERT')) simScore = 85;
  else if (flags.has('SIM_INTERNAL_TARGET_NOT_ALLOWLISTED')) simScore = 40;
  else if (flags.has('SIM_HIGH_GAS')) simScore = 40;
  else if (flags.has('SIM_TOKEN_OUTFLOW')) simScore = 40;
  else simScore = 10;

  let riskScore = Math.max(input.heuristic.riskScore, simScore);
  if (flags.has('TARGET_NOT_ALLOWLISTED') || flags.has('RECIPIENT_NOT_ALLOWLISTED') || flags.has('SPENDER_NOT_ALLOWLISTED')) {
    riskScore = Math.max(riskScore, 95);
  }
  if (flags.has('MAX_APPROVAL')) riskScore = Math.max(riskScore, 85);
  if (flags.has('UNKNOWN_SELECTOR')) riskScore = Math.max(riskScore, 85);
  if (flags.has('EXPECTED_TOKEN_DELTA_UNAVAILABLE')) riskScore = Math.max(riskScore, 60);

  const providerLabel =
    input.summary.source === 'tenderly:rest'
      ? 'tenderly:rest'
      : input.summary.source === 'tenderly:rpc'
        ? 'tenderly:rpc'
        : input.provider;

  const errorPreview =
    typeof input.summary.errorMessage === 'string' && input.summary.errorMessage.length > 0
      ? input.summary.errorMessage.length > 180
        ? `${input.summary.errorMessage.slice(0, 180)}...`
        : input.summary.errorMessage
      : '';

  const reason = input.summary.revertReason
    ? `${providerLabel}:revert:${input.summary.revertReason}`
    : errorPreview
      ? `${providerLabel}:error:${errorPreview}`
      : decodedMethods[0]
        ? `${providerLabel}:method:${decodedMethods[0]}`
        : `${providerLabel}:ok`;

  return {
    riskScore,
    flags: [...flags].sort(),
    reason,
  };
}

function riskFromAlchemySimulation(input: {
  sim: AlchemySimResult;
  txFrom: string;
  request: RiskRequest;
  heuristic: { riskScore: number; flags: string[]; reason: string };
}): { riskScore: number; flags: string[]; reason: string } {
  const summary = simSummaryFromAlchemy(input.sim);
  return riskFromSimSummary({ provider: 'alchemy', summary, txFrom: input.txFrom, request: input.request, heuristic: input.heuristic });
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

  const key = cacheKey(body);
  const cached = simCache.get(key);
  const now = Date.now();
  const TTL_MS = 3_000;
  if (cached && now - cached.ts < TTL_MS) {
    res.status(200).json(cached.out);
    return;
  }
  if (cached) simCache.delete(key);

  const heuristic = computeRisk(body);

  const canSimulate = Boolean(body.from && body.to && body.data);
  if (!canSimulate) {
    const out = {
      ...heuristic,
      flags: [...new Set([...heuristic.flags, 'ALCHEMY_SIM_SKIPPED'])].sort(),
      reason: 'alchemy:skipped',
    };
    simCache.set(key, { ts: now, out });
    res.status(200).json(out);
    return;
  }

  const tenderlyConfigured = Boolean(process.env.TENDERLY_ACCESS_TOKEN || process.env.TENDERLY_RPC_URL);

  let tenderlyErr: unknown;
  if (tenderlyConfigured) {
    tenderlyLog('primary_attempt', {
      chainId: body.chainId ?? null,
      from: body.from as string,
      to: body.to as string,
      dataLen: typeof body.data === 'string' ? body.data.length : null,
      value: body.value ?? '0',
    });
    try {
      const summary = await tenderlySimulateExecution({
        chainId: body.chainId,
        from: body.from as string,
        to: body.to as string,
        data: body.data as string,
        value: body.value,
      });

      const out = riskFromSimSummary({ provider: 'tenderly', summary, txFrom: body.from as string, request: body, heuristic });
      tenderlyLog('primary_used', {
        source: summary.source ?? null,
        riskScore: out.riskScore,
        flags: out.flags,
        reason: out.reason,
      });
      simCache.set(key, { ts: Date.now(), out });
      res.status(200).json(out);
      return;
    } catch (e) {
      tenderlyErr = e;
      tenderlyLog('primary_failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  try {
    let sim: AlchemySimResult | undefined;
    let lastErr: unknown;

    for (const waitMs of [0, 250, 750]) {
      if (waitMs > 0) await sleep(waitMs);
      try {
        sim = await alchemySimulateExecution({
          from: body.from as string,
          to: body.to as string,
          data: body.data as string,
          value: body.value,
        });
        break;
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        const is429 = msg.includes('ALCHEMY_RPC_429') || msg.includes('ALCHEMY_HTTP_429');
        if (!is429) break;
      }
    }

    if (sim) {
      const out = riskFromAlchemySimulation({ sim, txFrom: body.from as string, request: body, heuristic });
      tenderlyLog('fallback_used', {
        provider: 'alchemy',
        riskScore: out.riskScore,
        flags: out.flags,
        reason: out.reason,
      });
      simCache.set(key, { ts: Date.now(), out });
      res.status(200).json(out);
      return;
    }

    const alchemyMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    const tenderlyMsg = tenderlyErr instanceof Error ? tenderlyErr.message : String(tenderlyErr);
    const out = {
      ...heuristic,
      riskScore: Math.max(heuristic.riskScore, 40),
      flags: [
        ...new Set([
          ...heuristic.flags,
          ...(tenderlyConfigured ? ['TENDERLY_SIM_FAILED'] : []),
          'ALCHEMY_SIM_FAILED',
          'SIM_UNAVAILABLE',
        ]),
      ].sort(),
      reason: tenderlyConfigured
        ? `sim:failed:tenderly:${tenderlyMsg}:alchemy:${alchemyMsg}`
        : `sim:failed:alchemy:${alchemyMsg}`,
    };
    simCache.set(key, { ts: Date.now(), out });
    res.status(200).json(out);
    return;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const out = {
      ...heuristic,
      riskScore: Math.max(heuristic.riskScore, 40),
      flags: [...new Set([...heuristic.flags, 'ALCHEMY_SIM_FAILED', 'SIM_UNAVAILABLE'])].sort(),
      reason: `alchemy:failed:${msg}`,
    };
    simCache.set(key, { ts: Date.now(), out });
    res.status(200).json(out);
  }
});

const port = process.env.PORT ? Number(process.env.PORT) : 8811;

let server: Server | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function startServer(attempt: number) {
  const next = createServer(app);
  server = next;

  next.on('error', (err: unknown) => {
    const e = err as { code?: string; message?: string };
    if (e?.code === 'EADDRINUSE') {
      const delayMs = Math.min(250 * (attempt + 1), 5_000);
      try {
        next.close();
      } catch {
        // ignore
      }
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => startServer(attempt + 1), delayMs);
      return;
    }
    process.stderr.write(String((err as { stack?: unknown })?.stack ?? err) + '\n');
    process.exit(1);
  });

  try {
    next.listen(port, () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      const expected = process.env.RISK_API_KEY_ALL;
      console.log(`Auth enabled: ${Boolean(expected)}${expected ? ` (expectedLen=${expected.length})` : ''}`);
      console.log(`Mock risk service listening on :${port}`);
    });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e?.code === 'EADDRINUSE') {
      const delayMs = Math.min(250 * (attempt + 1), 5_000);
      try {
        next.close();
      } catch {
        // ignore
      }
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => startServer(attempt + 1), delayMs);
      return;
    }
    throw err;
  }
}

function shutdown(code: number) {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }
  if (!server) {
    process.exit(code);
    return;
  }

  const s = server;
  const force = setTimeout(() => process.exit(code), 1_000);
  force.unref();

  try {
    (s as unknown as { closeIdleConnections?: () => void }).closeIdleConnections?.();
  } catch {
    // ignore
  }

  try {
    (s as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  } catch {
    // ignore
  }

  s.close(() => {
    clearTimeout(force);
    process.exit(code);
  });
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

startServer(0);
