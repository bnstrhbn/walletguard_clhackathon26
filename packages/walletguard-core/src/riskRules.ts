import type {
  AnalyzeTxRequest,
  AddressString,
  RiskAssessment,
  RiskFlag,
  SimulationResult,
} from '@walletguard/common';

import { decodeTopLevelCall } from './decode.js';

const MAX_UINT256 = (2n ** 256n - 1n).toString();

function normalizeAddress(addr: string): string {
  return addr.toLowerCase();
}

function toBigIntSafe(value: unknown): bigint | undefined {
  try {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') return BigInt(Math.trunc(value));
    if (typeof value === 'string' && value.length > 0) return BigInt(value);
    return undefined;
  } catch {
    return undefined;
  }
}

function severityWeight(sev: RiskFlag['severity']): number {
  if (sev === 'high') return 40;
  if (sev === 'medium') return 20;
  return 10;
}

export type RiskOptions = {
  knownSpenders?: AddressString[];
};

export function assessRisk(input: {
  request: AnalyzeTxRequest;
  simulation: SimulationResult;
  options?: RiskOptions;
}): RiskAssessment {
  const { request, simulation, options } = input;
  const decodedCalls = simulation.decodedCalls.length
    ? simulation.decodedCalls
    : decodeTopLevelCall({ to: request.to, data: request.data });

  const flags: RiskFlag[] = [];
  const known = new Set((options?.knownSpenders ?? []).map((a) => normalizeAddress(a)));

  for (const call of decodedCalls) {
    if (call.functionName === 'approve') {
      const spender = call.args?.spender;
      const amount = call.args?.amount;

      if (typeof spender === 'string' && !known.has(normalizeAddress(spender))) {
        flags.push({
          code: 'UNKNOWN_SPENDER',
          severity: 'medium',
          details: `Token approval grants spending to ${spender}`,
        });
      }

      if (amount !== undefined) {
        const amountStr = String(amount);
        if (amountStr === MAX_UINT256) {
          flags.push({
            code: 'MAX_APPROVAL',
            severity: 'high',
            details: 'Unlimited token approval detected (max uint256)',
          });
        }
      }
    }

    if (call.functionName === 'setApprovalForAll') {
      const operator = call.args?.operator;
      const approved = call.args?.approved;

      if (approved === true && typeof operator === 'string' && !known.has(normalizeAddress(operator))) {
        flags.push({
          code: 'UNKNOWN_SPENDER',
          severity: 'medium',
          details: `ApprovalForAll grants control to ${operator}`,
        });
      }
    }
  }

  const nativeDelta = simulation.nativeBalanceDeltas.find(
    (d) => normalizeAddress(d.address) === normalizeAddress(request.from),
  );

  const nativeDeltaWei = nativeDelta ? toBigIntSafe(nativeDelta.deltaWei) : undefined;
  if (nativeDeltaWei !== undefined && nativeDeltaWei < 0n) {
    const abs = nativeDeltaWei * -1n;
    if (abs >= 100000000000000000n) {
      flags.push({
        code: 'SUSPICIOUS_TRANSFER',
        severity: 'medium',
        details: `Large native asset outflow detected: -${abs.toString()} wei`,
      });
    }
  }

  const negativeTokenDeltas = simulation.tokenBalanceDeltas.filter((d) => {
    if (normalizeAddress(d.holder) !== normalizeAddress(request.from)) return false;
    const bi = toBigIntSafe(d.delta);
    return bi !== undefined && bi < 0n;
  });

  if (negativeTokenDeltas.length >= 3) {
    flags.push({
      code: 'TOKEN_DRAIN_PATTERN',
      severity: 'high',
      details: 'Multiple token outflows detected in a single transaction',
    });
  }

  let score = 0;
  for (const f of flags) score += severityWeight(f.severity);
  if (!simulation.success) score += 20;
  if (score > 100) score = 100;

  const level: RiskAssessment['level'] = score >= 70 ? 'high' : score >= 35 ? 'medium' : 'low';

  return {
    score,
    level,
    flags,
  };
}
