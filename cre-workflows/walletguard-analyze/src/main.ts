import { EVMClient, HTTPCapability, Runner, encodeCallMsg, getAllNetworks, handler, type HTTPPayload, type Runtime } from '@chainlink/cre-sdk';

import { decodeTopLevelCall } from '../../../packages/walletguard-core/src/decode.js';
import { assessRisk } from '../../../packages/walletguard-core/src/riskRules.js';
import { buildSummary } from '../../../packages/walletguard-core/src/summarize.js';

type Config = {
  engineVersion?: string;
  simulationMode?: 'deterministic' | 'rpc';
};

type AddressString = `0x${string}`;
type HexString = `0x${string}`;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

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

const MAX_INPUT_BYTES = 256_000;
const MAX_DATA_HEX_CHARS = 200_000;
const MAX_DECIMAL_STR_CHARS = 80;
const MAX_METADATA_STR_CHARS = 200;
const MAX_BLOCKTAG_CHARS = 100;

function isHexString(value: unknown): value is HexString {
  return (
    typeof value === 'string' &&
    value.length <= MAX_DATA_HEX_CHARS &&
    /^0x(?:[0-9a-fA-F]{2})*$/.test(value)
  );
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
  if (data !== '0x' && data.length < 10) throw new Error('INVALID_REQUEST');

  const out: AnalyzeTxRequest = {
    chainId,
    from,
    to,
    data,
  };

  if (typeof obj.value === 'string') {
    if (obj.value.length > MAX_DECIMAL_STR_CHARS || !/^[0-9]+$/.test(obj.value)) throw new Error('INVALID_REQUEST');
    out.value = obj.value;
  }
  if (typeof obj.blockTag === 'string') {
    if (obj.blockTag.length > MAX_BLOCKTAG_CHARS) throw new Error('INVALID_REQUEST');
    out.blockTag = obj.blockTag;
  }

  if (obj.metadata && typeof obj.metadata === 'object') {
    const md = obj.metadata as Record<string, unknown>;
    const wallet = typeof md.wallet === 'string' ? md.wallet : undefined;
    const origin = typeof md.origin === 'string' ? md.origin : undefined;

    if (wallet !== undefined && wallet.length > MAX_METADATA_STR_CHARS) throw new Error('INVALID_REQUEST');
    if (origin !== undefined && origin.length > MAX_METADATA_STR_CHARS) throw new Error('INVALID_REQUEST');
    if (wallet !== undefined || origin !== undefined) {
      out.metadata = { wallet, origin };
    }
  }

  return out;
}

function canonicalize(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') return value.toString();

  if (Array.isArray(value)) {
    return value.map((v) => {
      const c = canonicalize(v);
      return c === undefined ? null : c;
    });
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(obj).sort()) {
      const c = canonicalize(obj[key]);
      if (c !== undefined) out[key] = c;
    }
    return out;
  }

  return String(value);
}

function canonicalJsonStringify(value: unknown): string {
  const c = canonicalize(value);
  return JSON.stringify(c === undefined ? null : c);
}

const MASK_64 = (1n << 64n) - 1n;

function rotl64(x: bigint, n: number): bigint {
  const bn = BigInt(n);
  return ((x << bn) | (x >> (64n - bn))) & MASK_64;
}

const ROTATION_OFFSETS: number[] = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

const ROUND_CONSTANTS: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

function keccakF1600(state: bigint[]): void {
  const b = new Array<bigint>(25);
  const c = new Array<bigint>(5);
  const d = new Array<bigint>(5);

  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) {
      c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      d[x] = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
    }
    for (let i = 0; i < 25; i++) {
      state[i] = (state[i] ^ d[i % 5]) & MASK_64;
    }

    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const idx = x + 5 * y;
        const rot = ROTATION_OFFSETS[idx];
        const newX = y;
        const newY = (2 * x + 3 * y) % 5;
        b[newX + 5 * newY] = rotl64(state[idx], rot);
      }
    }

    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const idx = x + 5 * y;
        const v0 = b[idx];
        const v1 = b[((x + 1) % 5) + 5 * y];
        const v2 = b[((x + 2) % 5) + 5 * y];
        state[idx] = (v0 ^ ((~v1) & v2)) & MASK_64;
      }
    }

    state[0] = (state[0] ^ ROUND_CONSTANTS[round]) & MASK_64;
  }
}

function laneFromBytesLE(bytes: Uint8Array, offset: number): bigint {
  let out = 0n;
  for (let i = 0; i < 8; i++) {
    out |= BigInt(bytes[offset + i] || 0) << (8n * BigInt(i));
  }
  return out & MASK_64;
}

function writeLaneToBytesLE(lane: bigint, out: Uint8Array, offset: number): void {
  for (let i = 0; i < 8; i++) {
    out[offset + i] = Number((lane >> (8n * BigInt(i))) & 0xffn);
  }
}

function keccak256Bytes(message: Uint8Array): Uint8Array {
  const rateBytes = 136;
  const state = new Array<bigint>(25);
  for (let i = 0; i < 25; i++) state[i] = 0n;

  let offset = 0;
  while (offset + rateBytes <= message.length) {
    for (let i = 0; i < rateBytes / 8; i++) {
      state[i] = (state[i] ^ laneFromBytesLE(message, offset + i * 8)) & MASK_64;
    }
    keccakF1600(state);
    offset += rateBytes;
  }

  const block = new Uint8Array(rateBytes);
  block.set(message.slice(offset));
  block[message.length - offset] = 0x01;
  block[rateBytes - 1] |= 0x80;

  for (let i = 0; i < rateBytes / 8; i++) {
    state[i] = (state[i] ^ laneFromBytesLE(block, i * 8)) & MASK_64;
  }
  keccakF1600(state);

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    writeLaneToBytesLE(state[i], out, i * 8);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): HexString {
  const hex: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    hex.push(b.toString(16).padStart(2, '0'));
  }
  return (`0x${hex.join('')}` as HexString);
}

function keccak256Utf8(value: string): HexString {
  const enc = new TextEncoder();
  return bytesToHex(keccak256Bytes(enc.encode(value)));
}

function hashCanonicalJson(value: unknown): HexString {
  return keccak256Utf8(canonicalJsonStringify(value));
}

function toBigIntDecimal(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

function recordNativeTransferDeltas(request: AnalyzeTxRequest): Array<{ address: AddressString; deltaWei: string }> {
  const valueWei = toBigIntDecimal(request.value);
  if (valueWei === undefined || valueWei === 0n) return [];

  return [
    { address: request.from, deltaWei: `-${valueWei.toString()}` },
    { address: request.to, deltaWei: valueWei.toString() },
  ];
}

function simulateTxDeterministic(request: AnalyzeTxRequest): SimulationResult {
  const decodedCalls = decodeTopLevelCall({ to: request.to, data: request.data }) as unknown as SimulationResult['decodedCalls'];

  const nativeBalanceDeltas = recordNativeTransferDeltas(request);
  const tokenBalanceDeltas: Array<{ token: AddressString; holder: AddressString; delta: string }> = [];

  for (const call of decodedCalls) {
    if (!call.functionName || !call.args) continue;
    const args = call.args as Record<string, unknown>;

    if (call.functionName === 'transfer') {
      const to = typeof args.to === 'string' ? (args.to as AddressString) : undefined;
      const amount = typeof args.amount === 'string' ? args.amount : undefined;
      if (!to || amount === undefined) continue;
      tokenBalanceDeltas.push({ token: request.to, holder: request.from, delta: `-${amount}` });
      tokenBalanceDeltas.push({ token: request.to, holder: to, delta: amount });
    }

    if (call.functionName === 'transferFrom') {
      const from = typeof args.from === 'string' ? (args.from as AddressString) : undefined;
      const to = typeof args.to === 'string' ? (args.to as AddressString) : undefined;
      const amount = typeof args.amount === 'string' ? args.amount : undefined;
      if (!from || !to || amount === undefined) continue;
      tokenBalanceDeltas.push({ token: request.to, holder: from, delta: `-${amount}` });
      tokenBalanceDeltas.push({ token: request.to, holder: to, delta: amount });
    }
  }

  return {
    success: true,
    nativeBalanceDeltas,
    tokenBalanceDeltas,
    decodedCalls,
  };
}

function chainSelectorFromChainId(chainId: number): bigint | undefined {
  const nets = getAllNetworks();
  const id = String(chainId);
  for (const n of nets) {
    if (n && n.chainId === id && n.chainSelector && typeof n.chainSelector.selector === 'bigint') {
      return n.chainSelector.selector;
    }
  }
  return undefined;
}

function simulateTxRpc(runtime: Runtime<Config>, request: AnalyzeTxRequest): SimulationResult {
  const decodedCalls = decodeTopLevelCall({ to: request.to, data: request.data }) as unknown as SimulationResult['decodedCalls'];
  const selector = chainSelectorFromChainId(request.chainId);
  if (selector === undefined) {
    return {
      success: false,
      errorMessage: 'UNSUPPORTED_CHAIN',
      nativeBalanceDeltas: [],
      tokenBalanceDeltas: [],
      decodedCalls,
    };
  }

  const evm = new EVMClient(selector);

  let gasUsed: string | undefined;
  let errorMessage: string | undefined;
  let success = true;

  try {
    const call = encodeCallMsg({ from: request.from, to: request.to, data: request.data });
    try {
      void evm.callContract(runtime, { call }).result();
    } catch (e) {
      success = false;
      errorMessage = e instanceof Error ? e.message : String(e);
    }

    const reply = evm.estimateGas(runtime, { msg: call }).result() as unknown as { gas?: unknown };
    if (reply && (reply as any).gas !== undefined) {
      gasUsed = String((reply as any).gas);
    }
  } catch (e) {
    success = false;
    errorMessage = e instanceof Error ? e.message : String(e);
  }

  const simulation = success ? simulateTxDeterministic(request) : {
    success: false,
    nativeBalanceDeltas: [],
    tokenBalanceDeltas: [],
    decodedCalls,
  };

  if (gasUsed !== undefined) {
    simulation.gasUsed = gasUsed;
  }
  if (!success && errorMessage !== undefined) {
    simulation.errorMessage = errorMessage;
  }

  return simulation;
}

function simulateTx(runtime: Runtime<Config>, request: AnalyzeTxRequest, config: Config): SimulationResult {
  const mode = config && config.simulationMode === 'rpc' ? 'rpc' : 'deterministic';
  if (mode === 'rpc') return simulateTxRpc(runtime, request);
  return simulateTxDeterministic(request);
}

function decodeInputJson(input: unknown): unknown {
  if (typeof input === 'string') {
    if (input.length > MAX_INPUT_BYTES) throw new Error('INPUT_TOO_LARGE');
    return JSON.parse(input);
  }

  if (input instanceof Uint8Array) {
    if (input.length > MAX_INPUT_BYTES) throw new Error('INPUT_TOO_LARGE');
    const decoder = new TextDecoder('utf-8');
    const textBody = decoder.decode(input);
    if (textBody.length > MAX_INPUT_BYTES) throw new Error('INPUT_TOO_LARGE');
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

function normalizeAddress(addr: AddressString): AddressString {
  return addr.toLowerCase() as AddressString;
}

function normalizeHex(hex: HexString): HexString {
  return hex.toLowerCase() as HexString;
}

function normalizeDecodedCallArgs(args: Record<string, string | number | boolean> | undefined): Record<string, string | number | boolean> | undefined {
  if (!args) return undefined;
  const out: Record<string, string | number | boolean> = {};
  const keys = Object.keys(args);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const v = (args as any)[k];
    if (typeof v === 'string') {
      if (/^0x[0-9a-fA-F]{40}$/.test(v)) {
        out[k] = v.toLowerCase();
      } else if (/^0x[0-9a-fA-F]*$/.test(v)) {
        out[k] = v.toLowerCase();
      } else {
        out[k] = v;
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

function requestForCommitment(request: AnalyzeTxRequest): Omit<AnalyzeTxRequest, 'metadata'> {
  return {
    chainId: request.chainId,
    from: normalizeAddress(request.from),
    to: normalizeAddress(request.to),
    data: normalizeHex(request.data),
    value: request.value,
    blockTag: request.blockTag,
  };
}

function simulationForCommitment(simulation: SimulationResult): Omit<SimulationResult, 'gasUsed' | 'errorMessage'> {
  const decodedCalls = simulation.decodedCalls.map((c) => {
    return {
      to: normalizeAddress(c.to),
      functionSig: c.functionSig ? String(c.functionSig).toLowerCase() : undefined,
      functionName: c.functionName,
      args: normalizeDecodedCallArgs(c.args),
    };
  });

  const nativeBalanceDeltas = simulation.nativeBalanceDeltas.map((d) => {
    return { address: normalizeAddress(d.address), deltaWei: d.deltaWei };
  });

  const tokenBalanceDeltas = simulation.tokenBalanceDeltas.map((d) => {
    return { token: normalizeAddress(d.token), holder: normalizeAddress(d.holder), delta: d.delta };
  });

  const logs = simulation.logs
    ? simulation.logs.map((l) => {
      return {
        address: normalizeAddress(l.address),
        topics: l.topics.map((t) => normalizeHex(t)),
        data: normalizeHex(l.data),
      };
    })
    : undefined;

  return {
    success: simulation.success,
    nativeBalanceDeltas,
    tokenBalanceDeltas,
    decodedCalls,
    logs,
  };
}

function buildHandler(config: Config) {
  return (runtime: Runtime<Config>, payload: HTTPPayload): WalletGuardReport => {
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

    const simulation = simulateTx(runtime, request, config);

    const risk = assessRisk({ request, simulation }) as unknown as WalletGuardReport['risk'];
    const summary = buildSummary({ risk: risk as unknown as any, simulation }) as WalletGuardReport['summary'];

    const reportForHash = {
      request: requestForCommitment(request),
      simulation: simulationForCommitment(simulation),
      risk,
      summary,
      provenance: {
        engineVersion,
      },
    };

    const reportHash = hashCanonicalJson(reportForHash);

    return {
      request,
      simulation,
      risk,
      summary,
      provenance: {
        engineVersion,
        reportHash,
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
