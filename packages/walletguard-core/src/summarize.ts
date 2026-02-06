import type { RiskAssessment, SimulationResult, WalletGuardReport } from '@walletguard/common';

export function buildSummary(input: {
  risk: RiskAssessment;
  simulation: SimulationResult;
}): WalletGuardReport['summary'] {
  const { risk, simulation } = input;

  const recommendedAction: WalletGuardReport['summary']['recommendedAction'] =
    risk.level === 'high' ? 'block' : risk.level === 'medium' ? 'warn' : 'allow';

  const bullets: string[] = [];

  if (!simulation.success) {
    bullets.push('Simulation indicates the transaction may revert or fail.');
  }

  for (const flag of risk.flags) {
    bullets.push(flag.details);
  }

  if (bullets.length === 0) {
    bullets.push('No high-signal risk indicators detected by the deterministic ruleset.');
  }

  const tldr =
    risk.level === 'high'
      ? 'High risk transaction. Avoid signing unless you fully trust the destination and understand the effects.'
      : risk.level === 'medium'
        ? 'Medium risk transaction. Review approvals and outflows before signing.'
        : 'Low risk transaction based on current heuristics. Still review details before signing.';

  return {
    'tl;dr': tldr,
    bullets,
    recommendedAction,
  };
}
