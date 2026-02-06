import { HTTPCapability, Runner, handler, type HTTPPayload, type Runtime } from '@chainlink/cre-sdk';

import { decodeTopLevelCall } from '../../../packages/walletguard-core/src/decode.js';
import { assessRisk } from '../../../packages/walletguard-core/src/riskRules.js';
import { buildSummary } from '../../../packages/walletguard-core/src/summarize.js';

type Config = {
  engineVersion?: string;
};

type AddressString = `0x${string}`;
type HexString = `0x${string}`;

type AnalyzeTxRequest = {
  chainId: number;
  from: AddressString;
  to: AddressString;
  data: HexString;
  value?: string;
  blockTag?: 'latest' | string;
  metadata?: {
    wallet?: string;
    origin?: string;
  };
};

type SimulationResult = {
  success: boolean;
  gasUsed?: string;
  errorMessage?: string;
  nativeBalanceDeltas: Array<{ address: AddressString; deltaWei: string }>;
  tokenBalanceDeltas: Array<{ token: AddressString; holder: AddressString; delta: string }>;
  decodedCalls: Array<{
    to: AddressString;
    functionSig?: string;
    functionName?: string;
    args?: Record<string, string | number | boolean>;
  }>;
  logs?: Array<{ address: AddressString; topics: HexString[]; data: HexString }>;
};

type WalletGuardReport = {
  request: AnalyzeTxRequest;
  simulation: SimulationResult;
  risk: {
    score: number;
    level: 'low' | 'medium' | 'high';
    flags: Array<{ code: string; severity: string; details: string }>;
  };
  summary: {
    'tl;dr': string;
    bullets: string[];
    recommendedAction: 'allow' | 'warn' | 'block';
  };
  provenance: {
    engineVersion: string;
    workflowRunId?: string;
    reportHash: HexString;
    committedOnchain?: {
      chainId: number;
      contract: AddressString;
      txHash: HexString;
    };
  };
};

function isHexString(value: unknown): value is HexString {
  return typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value);
}

function isAddressString(value: unknown): value is AddressString {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function parseAnalyzeTxRequest(value: unknown): AnalyzeTxRequest {
  if (!value || typeof value !== 'object') throw new Error('INVALID_REQUEST');
  const obj = value as Record<string, unknown>;

  const chainId = obj.chainId;
  const from = obj.from;
  const to = obj.to;
  const data = obj.data;

  if (typeof chainId !== 'number' || !Number.isInteger(chainId) || chainId <= 0) throw new Error('INVALID_REQUEST');
  if (!isAddressString(from)) throw new Error('INVALID_REQUEST');
  if (!isAddressString(to)) throw new Error('INVALID_REQUEST');
  if (!isHexString(data)) throw new Error('INVALID_REQUEST');

  const out: AnalyzeTxRequest = {
    chainId,
    from,
    to,
    data,
  };

  if (typeof obj.value === 'string') out.value = obj.value;
  if (typeof obj.blockTag === 'string') out.blockTag = obj.blockTag;

  if (obj.metadata && typeof obj.metadata === 'object') {
    const md = obj.metadata as Record<string, unknown>;
    const wallet = typeof md.wallet === 'string' ? md.wallet : undefined;
    const origin = typeof md.origin === 'string' ? md.origin : undefined;
    if (wallet !== undefined || origin !== undefined) {
      out.metadata = { wallet, origin };
    }
  }

  return out;
}

function stubSimulateTx(request: AnalyzeTxRequest): SimulationResult {
  return {
    success: true,
    nativeBalanceDeltas: [],
    tokenBalanceDeltas: [],
    decodedCalls: decodeTopLevelCall({ to: request.to, data: request.data }) as unknown as SimulationResult['decodedCalls'],
  };
}

function decodeInputJson(input: unknown): unknown {
  if (typeof input === 'string') {
    return JSON.parse(input);
  }

  if (input instanceof Uint8Array) {
    const decoder = new TextDecoder('utf-8');
    const textBody = decoder.decode(input);
    return JSON.parse(textBody);
  }

  if (input && typeof input === 'object') {
    return input;
  }

  throw new Error('INVALID_INPUT');
}

function previewInput(input: unknown): string {
  try {
    if (typeof input === 'string') {
      return input.slice(0, 200);
    }

    if (input instanceof Uint8Array) {
      const decoder = new TextDecoder('utf-8');
      const text = decoder.decode(input);
      return text.slice(0, 200);
    }

    return String(input);
  } catch {
    return '<<unpreviewable>>';
  }
}

function buildHandler(config: Config) {
  return (runtime: Runtime<Config>, payload: HTTPPayload): WalletGuardReport => {
    void runtime;

    if (payload.input === undefined || payload.input === null) {
      throw new Error('EMPTY_INPUT');
    }

    let decoded: unknown;
    try {
      decoded = decodeInputJson(payload.input);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const preview = previewInput(payload.input);
      throw new Error(`DECODE_INPUT_FAILED:${msg}:preview=${preview}`);
    }
    const request = parseAnalyzeTxRequest(decoded);
    const engineVersion = config && typeof config.engineVersion === 'string' && config.engineVersion
      ? config.engineVersion
      : 'dev';

    const simulation = stubSimulateTx(request);

    const risk = assessRisk({ request, simulation }) as unknown as WalletGuardReport['risk'];
    const summary = buildSummary({ risk: risk as unknown as any, simulation }) as WalletGuardReport['summary'];

    return {
      request,
      simulation,
      risk,
      summary,
      provenance: {
        engineVersion,
        reportHash: `0x${'00'.repeat(32)}`,
      },
    };
  };
}

function initWorkflow(config: Config) {
  const http = new HTTPCapability();
  return [handler(http.trigger({}), buildHandler(config))];
}

export function main(): Promise<void> {
  return (async () => {
    const runner = await Runner.newRunner<Config>();
    await runner.run(initWorkflow);
  })();
}
