import { HTTPCapability, Runner, decodeJson, handler, type HTTPPayload, type Runtime } from '@chainlink/cre-sdk';
import { z } from 'zod';

const configSchema = z.object({
  engineVersion: z.string().optional(),
});

type Config = z.infer<typeof configSchema>;

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
  };
};

const hexString: z.ZodType<HexString> = z.custom<HexString>((val) => {
  return typeof val === 'string' && /^0x[0-9a-fA-F]*$/.test(val);
});

const addressString: z.ZodType<AddressString> = z.custom<AddressString>((val) => {
  return typeof val === 'string' && /^0x[0-9a-fA-F]{40}$/.test(val);
});

const AnalyzeTxRequestSchema = z.object({
  chainId: z.number().int().positive(),
  from: addressString,
  to: addressString,
  data: hexString,
  value: z.string().optional(),
  blockTag: z.union([z.literal('latest'), z.string()]).optional(),
  metadata: z
    .object({
      wallet: z.string().optional(),
      origin: z.string().optional(),
    })
    .optional(),
});

function stubSimulateTx(_input: { to: AddressString; data: HexString }): SimulationResult {
  return {
    success: true,
    nativeBalanceDeltas: [],
    tokenBalanceDeltas: [],
    decodedCalls: [],
  };
}

function buildHandler(config: Config) {
  return (runtime: Runtime<Config>, payload: HTTPPayload): WalletGuardReport => {
    void runtime;

    if (!payload.input || payload.input.length === 0) {
      throw new Error('EMPTY_INPUT');
    }

    const decoded = decodeJson(payload.input);
    const parsed = AnalyzeTxRequestSchema.safeParse(decoded);

    if (!parsed.success) {
      throw new Error('INVALID_REQUEST');
    }

    const request = parsed.data;
    const simulation = stubSimulateTx({ to: request.to, data: request.data });
    const engineVersion = config.engineVersion ?? 'dev';

    return {
      request,
      simulation,
      risk: {
        score: 0,
        level: 'low',
        flags: [],
      },
      summary: {
        'tl;dr': 'Stub report (local simulation only).',
        bullets: [],
        recommendedAction: 'allow',
      },
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
    const runner = await Runner.newRunner<Config>({ configSchema });
    await runner.run(initWorkflow);
  })();
}
