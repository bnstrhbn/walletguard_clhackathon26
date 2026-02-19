import {
  ConfidentialHTTPClient,
  HTTPCapability,
  Runner,
  consensusIdenticalAggregation,
  handler,
  type ConfidentialHTTPSendRequester,
  type HTTPPayload,
  type Runtime,
} from '@chainlink/cre-sdk';

import {
  VaultIntentSchema,
  buildVaultReceipt,
  type VaultDecision,
  type VaultIntent,
  type VaultRiskSignal,
  type VaultReceipt,
} from '@walletguard/common';

type Config = {
  engineVersion?: string;
  riskApiUrl?: string;
  secretOwner?: string;
};

const MAX_INPUT_BYTES = 256_000;

function decodeInputJson(input: unknown): unknown {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (
      (trimmed.startsWith('./') || trimmed.startsWith('../') || trimmed.startsWith('/')) &&
      (trimmed.endsWith('.json') || trimmed.includes('.json'))
    ) {
      throw new Error('HTTP_PAYLOAD_LOOKS_LIKE_PATH_USE_AT_PREFIX');
    }
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
    if (typeof input === 'string') return input.slice(0, 200);
    if (input instanceof Uint8Array) {
      return new TextDecoder('utf-8').decode(input.slice(0, 200));
    }
    return JSON.stringify(input).slice(0, 200);
  } catch {
    return '[unpreviewable]';
  }
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

function buildHandler(config: Config) {
  return (runtime: Runtime<Config>, payload: HTTPPayload): VaultReceipt => {
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

    const parsedIntent = VaultIntentSchema.parse(decoded);
    const intent: VaultIntent = {
      ...parsedIntent,
      vault: parsedIntent.vault.toLowerCase() as VaultIntent['vault'],
      to: parsedIntent.to.toLowerCase() as VaultIntent['to'],
      data: parsedIntent.data.toLowerCase() as VaultIntent['data'],
      value: (parsedIntent.value ?? '0').toString(),
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
      throw new Error(`RISK_API_KEY_MISSING:${msg}:expected secrets.yaml id=riskApiKey env=RISK_API_KEY_ALL`);
    }

    runtime.log(`riskApiKeyLen=${riskApiKey.length}`);

    const fetchRisk = (sendRequester: ConfidentialHTTPSendRequester, intentArg: VaultIntent): VaultRiskSignal => {
      const payloadBody = {
        chainId: intentArg.chainId,
        from: intentArg.vault,
        to: intentArg.to,
        data: intentArg.data,
        value: intentArg.value ?? '0',
      };

      const enclaveReply = sendRequester
        .sendRequests({
          input: {
            requests: [
              {
                url: riskApiUrl,
                method: 'POST',
                body: JSON.stringify(payloadBody),
                headers: [
                  `Authorization: Bearer ${riskApiKey}`,
                  'Content-Type: application/json',
                ],
              },
            ],
          },
        })
        .result();

      const r0 = Array.isArray(enclaveReply.responses) ? enclaveReply.responses[0] : undefined;
      if (!r0) throw new Error('RISK_API_FAILED:NO_RESPONSE');

      const statusCode = Number(r0.statusCode);
      const bodyText = new TextDecoder('utf-8').decode(r0.body ?? new Uint8Array());
      if (!Number.isFinite(statusCode) || statusCode < 200 || statusCode > 299) {
        const preview = bodyText.length > 300 ? `${bodyText.slice(0, 300)}...` : bodyText;
        throw new Error(`RISK_API_FAILED:${statusCode}:${preview}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        throw new Error('RISK_API_FAILED:INVALID_JSON');
      }

      return parseRiskSignal(parsed);
    };

    const confHTTPClient = new ConfidentialHTTPClient();

    const risk = confHTTPClient
      .sendRequests(runtime, fetchRisk, consensusIdenticalAggregation<VaultRiskSignal>())(intent)
      .result();

    const decisionRaw = decisionFromRisk({ intent, risk });
    const decision: VaultDecision = {
      ...decisionRaw,
      risk: {
        ...decisionRaw.risk,
        flags: [...decisionRaw.risk.flags].sort(),
      },
    };

    return buildVaultReceipt({
      intent,
      decision,
      engineVersion,
    });
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
