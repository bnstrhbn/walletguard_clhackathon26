import { keccak256, stringToHex } from 'viem';

import type { HexString, VaultDecision, VaultIntent, VaultReceipt } from './types.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

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

export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value) ?? null);
}

export function keccak256Utf8(value: string): `0x${string}` {
  return keccak256(stringToHex(value));
}

export function hashCanonicalJson(value: unknown): `0x${string}` {
  return keccak256Utf8(canonicalJsonStringify(value));
}

function normalizeAddress(addr: string): string {
  return addr.toLowerCase();
}

function normalizeHex(hex: string): string {
  return hex.toLowerCase();
}

function normalizeDecimalString(value: string | undefined): string {
  return BigInt(value ?? '0').toString();
}

function normalizeSignedDecimalString(value: string | undefined): string {
  return BigInt(value ?? '0').toString();
}

function intentForHash(intent: VaultIntent): VaultIntent {
  const expected = Array.isArray((intent as VaultIntent).expectedTokenBalanceDeltas)
    ? [...((intent as VaultIntent).expectedTokenBalanceDeltas ?? [])]
        .map((e) => {
          const token = normalizeAddress(String((e as { token?: string }).token ?? ''));
          const holder = normalizeAddress(String((e as { holder?: string }).holder ?? ''));
          const delta = normalizeSignedDecimalString((e as { delta?: string }).delta);
          const toleranceRaw = (e as { tolerance?: string }).tolerance;
          const tolerance = toleranceRaw === undefined ? undefined : normalizeDecimalString(toleranceRaw);
          return { token, holder, delta, tolerance };
        })
        .sort((a, b) =>
          `${a.token}|${a.holder}|${a.delta}|${a.tolerance ?? ''}`.localeCompare(
            `${b.token}|${b.holder}|${b.delta}|${b.tolerance ?? ''}`,
          ),
        )
    : undefined;

  return {
    chainId: intent.chainId,
    vault: normalizeAddress(intent.vault) as VaultIntent['vault'],
    to: normalizeAddress(intent.to) as VaultIntent['to'],
    data: normalizeHex(intent.data) as VaultIntent['data'],
    value: normalizeDecimalString(intent.value),
    expectedTokenBalanceDeltas: expected as VaultIntent['expectedTokenBalanceDeltas'],
    requestId: intent.requestId,
    mode: intent.mode,
    metadata: intent.metadata?.origin ? { origin: intent.metadata.origin } : undefined,
  };
}

function decisionForHash(decision: VaultDecision): VaultDecision {
  const flags = Array.isArray(decision.risk.flags) ? [...decision.risk.flags].sort() : [];
  return {
    action: decision.action,
    mode: decision.mode,
    risk: {
      riskScore: decision.risk.riskScore,
      flags,
      reason: decision.risk.reason,
    },
  };
}

export function hashVaultIntent(intent: VaultIntent): HexString {
  return hashCanonicalJson(intentForHash(intent)) as HexString;
}

export function hashVaultDecision(decision: VaultDecision): HexString {
  return hashCanonicalJson(decisionForHash(decision)) as HexString;
}

export function hashVaultReceipt(input: { intent: VaultIntent; decision: VaultDecision }): HexString {
  const { intent, decision } = input;
  return hashCanonicalJson({ intent: intentForHash(intent), decision: decisionForHash(decision) }) as HexString;
}

export function buildVaultReceipt(input: {
  intent: VaultIntent;
  decision: VaultDecision;
  engineVersion: string;
  workflowRunId?: string;
}): VaultReceipt {
  const { intent, decision, engineVersion, workflowRunId } = input;
  const intentHash = hashVaultIntent(intent);
  const decisionHash = hashVaultDecision(decision);
  const receiptHash = hashVaultReceipt({ intent, decision });

  const provenance = workflowRunId === undefined
    ? { engineVersion }
    : { engineVersion, workflowRunId };

  return {
    intent,
    decision,
    hashes: {
      intentHash,
      decisionHash,
      receiptHash,
    },
    provenance,
  };
}
