import type {
  AnalyzeTxRequest,
  SimulationResult,
  WalletGuardReport,
} from '@walletguard/common';

import { hashCanonicalJson } from '@walletguard/common';

import { assessRisk, type RiskOptions } from './riskRules.js';
import { buildSummary } from './summarize.js';

function normalizeAddress(addr: string): string {
  return addr.toLowerCase();
}

function normalizeHex(hex: string): string {
  return hex.toLowerCase();
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
    from: normalizeAddress(request.from) as AnalyzeTxRequest['from'],
    to: normalizeAddress(request.to) as AnalyzeTxRequest['to'],
    data: normalizeHex(request.data) as AnalyzeTxRequest['data'],
    value: request.value,
    blockTag: request.blockTag,
  };
}

function simulationForCommitment(simulation: SimulationResult): Omit<SimulationResult, 'gasUsed' | 'errorMessage'> {
  return {
    success: simulation.success,
    nativeBalanceDeltas: simulation.nativeBalanceDeltas.map((d) => {
      return { address: normalizeAddress(d.address) as any, deltaWei: d.deltaWei };
    }),
    tokenBalanceDeltas: simulation.tokenBalanceDeltas.map((d) => {
      return { token: normalizeAddress(d.token) as any, holder: normalizeAddress(d.holder) as any, delta: d.delta };
    }),
    decodedCalls: simulation.decodedCalls.map((c) => {
      return {
        to: normalizeAddress(c.to) as any,
        functionSig: c.functionSig ? String(c.functionSig).toLowerCase() : undefined,
        functionName: c.functionName,
        args: normalizeDecodedCallArgs(c.args),
      };
    }),
    logs: simulation.logs
      ? simulation.logs.map((l) => {
        return {
          address: normalizeAddress(l.address) as any,
          topics: l.topics.map((t) => normalizeHex(t) as any),
          data: normalizeHex(l.data) as any,
        };
      })
      : undefined,
  };
}

export function buildWalletGuardReport(input: {
  request: AnalyzeTxRequest;
  simulation: SimulationResult;
  engineVersion: string;
  workflowRunId?: string;
  riskOptions?: RiskOptions;
}): WalletGuardReport {
  const { request, simulation, engineVersion, workflowRunId, riskOptions } = input;

  const risk = assessRisk({ request, simulation, options: riskOptions });
  const summary = buildSummary({ risk, simulation });

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
      workflowRunId,
      reportHash,
    },
  };
}
