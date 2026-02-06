import type {
  AnalyzeTxRequest,
  SimulationResult,
  WalletGuardReport,
} from '@walletguard/common';

import { hashCanonicalJson } from '@walletguard/common';

import { assessRisk, type RiskOptions } from './riskRules.js';
import { buildSummary } from './summarize.js';

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
    request,
    simulation,
    risk,
    summary,
    provenance: {
      engineVersion,
      workflowRunId,
    },
  };

  const reportHash = hashCanonicalJson(reportForHash);

  return {
    ...reportForHash,
    provenance: {
      ...reportForHash.provenance,
      reportHash,
    },
  };
}
