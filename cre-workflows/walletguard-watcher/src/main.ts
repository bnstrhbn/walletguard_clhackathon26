import {
  EVMClient,
  HTTPClient,
  Runner,
  TxStatus,
  bytesToHex,
  consensusIdenticalAggregation,
  encodeCallMsg,
  getNetwork,
  handler,
  hexToBase64,
  prepareReportRequest,
  type EVMLog,
  type HTTPSendRequester,
  type Runtime,
} from '@chainlink/cre-sdk';

import { buildVaultReceipt, type VaultDecision, type VaultIntent, type VaultRiskSignal } from '@walletguard/common';

import { decodeFunctionResult, encodeFunctionData, encodeAbiParameters, keccak256, parseAbiParameters, toBytes } from 'viem';

type AddressString = `0x${string}`;

type Config = {
  engineVersion?: string;
  chainId: number;
  chainSelectorName: string;
  registryAddress: AddressString;
  receiverAddress: AddressString;
  riskApiUrl?: string;
  secretOwner?: string;
  gasLimit: string;
};

const INTENT_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'getIntent',
    stateMutability: 'view',
    inputs: [{ name: 'intentId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'creator', type: 'address' },
          { name: 'vault', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'data', type: 'bytes' },
          { name: 'deadline', type: 'uint256' },
          { name: 'mode', type: 'uint8' },
          { name: 'status', type: 'uint8' },
          { name: 'receiptHash', type: 'bytes32' },
          { name: 'executorTxHash', type: 'bytes32' },
        ],
      },
    ],
  },
] as const;

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = i < bytes.length ? bytes[i] : 0;
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;

    const triplet = (b0 << 16) | (b1 << 8) | b2;
    const c0 = (triplet >> 18) & 0x3f;
    const c1 = (triplet >> 12) & 0x3f;
    const c2 = (triplet >> 6) & 0x3f;
    const c3 = triplet & 0x3f;

    out += BASE64_ALPHABET[c0] + BASE64_ALPHABET[c1];
    out += i + 1 < bytes.length ? BASE64_ALPHABET[c2] : '=';
    out += i + 2 < bytes.length ? BASE64_ALPHABET[c3] : '=';
  }
  return out;
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripUndefined(v)) as T;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out as T;
  }
  return value;
}

function parseRiskSignal(value: unknown): VaultRiskSignal {
  if (!value || typeof value !== 'object') throw new Error('INVALID_RISK_SIGNAL');
  const obj = value as Record<string, unknown>;

  const riskScore = obj.riskScore;
  const flags = obj.flags;
  const reason = obj.reason;

  if (typeof riskScore !== 'number' || !Number.isFinite(riskScore) || riskScore < 0 || riskScore > 100) {
    throw new Error('INVALID_RISK_SIGNAL');
  }
  if (!Array.isArray(flags) || !flags.every((f) => typeof f === 'string')) {
    throw new Error('INVALID_RISK_SIGNAL');
  }
  if (reason !== undefined && typeof reason !== 'string') {
    throw new Error('INVALID_RISK_SIGNAL');
  }

  const out: VaultRiskSignal = {
    riskScore,
    flags,
  };
  if (typeof reason === 'string') out.reason = reason;
  return out;
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
    risk,
  };
}

function actionCode(action: VaultDecision['action']): 0 | 1 | 2 {
  if (action === 'allow') return 0;
  if (action === 'warn') return 1;
  return 2;
}

function readIntent(runtime: Runtime<Config>, evm: EVMClient, config: Config, intentId: bigint) {
  const callData = encodeFunctionData({
    abi: INTENT_REGISTRY_ABI,
    functionName: 'getIntent',
    args: [intentId],
  });

  const reply = evm
    .callContract(runtime, {
      call: encodeCallMsg({
        from: '0x0000000000000000000000000000000000000000',
        to: config.registryAddress,
        data: callData,
      }),
    })
    .result();

  const decoded = decodeFunctionResult({
    abi: INTENT_REGISTRY_ABI,
    functionName: 'getIntent',
    data: bytesToHex(reply.data),
  }) as unknown;

  return decoded as {
    creator: AddressString;
    vault: AddressString;
    to: AddressString;
    value: bigint;
    data: `0x${string}`;
    deadline: bigint;
    mode: number;
    status: number;
    receiptHash: `0x${string}`;
    executorTxHash: `0x${string}`;
  };
}

function buildHandler(config: Config) {
  return (runtime: Runtime<Config>, log: EVMLog) => {
    const network = getNetwork({
      chainFamily: 'evm',
      chainSelectorName: config.chainSelectorName,
      isTestnet: true,
    });
    if (!network) throw new Error(`Network not found: ${config.chainSelectorName}`);

    const evm = new EVMClient(network.chainSelector.selector);

    if (!log.topics || log.topics.length < 2) {
      throw new Error('LOG_MISSING_TOPIC1');
    }

    const intentId = BigInt(bytesToHex(log.topics[1]));

    const onchain = readIntent(runtime, evm, config, intentId);

    const mode = onchain.mode === 1 ? 'PROPOSE_ONLY' : 'AUTO_EXECUTE';

    const intent: VaultIntent = {
      chainId: config.chainId,
      vault: onchain.vault.toLowerCase() as VaultIntent['vault'],
      to: onchain.to.toLowerCase() as VaultIntent['to'],
      data: onchain.data.toLowerCase() as VaultIntent['data'],
      value: onchain.value.toString(),
      requestId: `${config.registryAddress.toLowerCase()}:${intentId.toString()}`,
      mode,
    };

    const engineVersion = config && typeof config.engineVersion === 'string' && config.engineVersion
      ? config.engineVersion
      : 'dev';

    const riskApiUrl = config && typeof config.riskApiUrl === 'string' ? config.riskApiUrl : '';
    if (!riskApiUrl) throw new Error('RISK_API_URL_REQUIRED');

    const secretOwner = config && typeof config.secretOwner === 'string' ? config.secretOwner : '';

    let riskApiKey: string;
    try {
      const rt = runtime as unknown as {
        getSecret: (request: { id: string; owner?: string; namespace?: string }) => { result: () => { value?: string } };
      };
      const secret = rt.getSecret(secretOwner ? { id: 'riskApiKey', owner: secretOwner } : { id: 'riskApiKey' }).result();
      riskApiKey = typeof secret?.value === 'string' ? secret.value : '';
      riskApiKey = riskApiKey.trim();
      if (
        (riskApiKey.startsWith('"') && riskApiKey.endsWith('"')) ||
        (riskApiKey.startsWith("'") && riskApiKey.endsWith("'"))
      ) {
        riskApiKey = riskApiKey.slice(1, -1);
      }
      if (!riskApiKey) throw new Error('empty');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`RISK_API_KEY_MISSING:${msg}`);
    }

    const fetchRisk = (sendRequester: HTTPSendRequester, intentArg: VaultIntent): VaultRiskSignal => {
      const body = JSON.stringify({
        chainId: intentArg.chainId,
        from: intentArg.vault,
        to: intentArg.to,
        data: intentArg.data,
        value: intentArg.value ?? '0',
      });

      const bodyBytes = new TextEncoder().encode(body);

      const resp = sendRequester
        .sendRequest({
          url: riskApiUrl,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${riskApiKey}`,
            'Content-Type': 'application/json',
          },
          body: bytesToBase64(bodyBytes),
        })
        .result();

      const statusCode = Number(resp.statusCode);
      if (!Number.isFinite(statusCode) || statusCode < 200 || statusCode > 299) {
        throw new Error(`RISK_API_FAILED:${resp.statusCode}`);
      }

      const parsed = JSON.parse(new TextDecoder('utf-8').decode(resp.body ?? new Uint8Array()));
      return parseRiskSignal(parsed);
    };

    const httpClient = new HTTPClient();

    let risk: VaultRiskSignal;
    try {
      const raw = httpClient
        .sendRequest(runtime, fetchRisk, consensusIdenticalAggregation<VaultRiskSignal>())(intent)
        .result();
      risk = parseRiskSignal(raw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      runtime.log(`riskCall:failed ${msg}`);
      risk = {
        riskScore: 95,
        flags: ['RISK_API_FAILED'],
        reason: msg,
      };
    }

    const decisionRaw = decisionFromRisk({ intent, risk });
    const decision: VaultDecision = {
      ...decisionRaw,
      risk: {
        ...decisionRaw.risk,
        flags: [...decisionRaw.risk.flags].sort(),
      },
    };

    const receipt = buildVaultReceipt({
      intent,
      decision,
      engineVersion,
    });

    const reportData = encodeAbiParameters(
      parseAbiParameters('address registry, uint256 intentId, uint8 action, bytes32 receiptHash'),
      [config.registryAddress, intentId, actionCode(decision.action), receipt.hashes.receiptHash],
    );

    const report = runtime.report(prepareReportRequest(reportData)).result();

    const writeResult = evm
      .writeReport(runtime, {
        receiver: config.receiverAddress,
        report,
        gasConfig: {
          gasLimit: config.gasLimit,
        },
      })
      .result();

    const txHash = bytesToHex(writeResult.txHash || new Uint8Array(32));

    const receiverTx = {
      txStatus: writeResult.txStatus,
      txHash,
      ...(writeResult.receiverContractExecutionStatus !== undefined
        ? { receiverContractExecutionStatus: writeResult.receiverContractExecutionStatus }
        : {}),
      ...(writeResult.errorMessage !== undefined ? { errorMessage: writeResult.errorMessage } : {}),
    };

    return stripUndefined({
      intentId: intentId.toString(),
      decision,
      receiptHash: receipt.hashes.receiptHash,
      receiverTx,
      ok: writeResult.txStatus === TxStatus.SUCCESS,
    });
  };
}

function initWorkflow(config: Config) {
  const network = getNetwork({
    chainFamily: 'evm',
    chainSelectorName: config.chainSelectorName,
    isTestnet: true,
  });
  if (!network) {
    throw new Error(`Network not found: ${config.chainSelectorName}`);
  }

  const evm = new EVMClient(network.chainSelector.selector);

  const eventSig = keccak256(toBytes('IntentSubmitted(uint256,address,address,address,uint256,uint256,uint8)'));

  return [
    handler(
      evm.logTrigger({
        addresses: [hexToBase64(config.registryAddress)],
        topics: [
          {
            values: [hexToBase64(eventSig)],
          },
        ],
      }),
      buildHandler(config),
    ),
  ];
}

export function main(): Promise<void> {
  return (async () => {
    const runner = await Runner.newRunner<Config>();
    await runner.run(initWorkflow);
  })();
}
