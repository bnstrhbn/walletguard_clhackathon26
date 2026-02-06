import assert from 'node:assert/strict';
import test from 'node:test';

import type { AnalyzeTxRequest, SimulationResult } from '@walletguard/common';
import { hashCanonicalJson } from '@walletguard/common';

import { assessRisk } from '../src/riskRules.js';
import { buildWalletGuardReport } from '../src/report.js';

const ADDR_FROM = '0x1111111111111111111111111111111111111111';
const ADDR_TO = '0x2222222222222222222222222222222222222222';
const ADDR_TOKEN = '0x3333333333333333333333333333333333333333';
const ADDR_SPENDER = '0x4444444444444444444444444444444444444444';

function baseRequest(): AnalyzeTxRequest {
  return {
    chainId: 11155111,
    from: ADDR_FROM,
    to: ADDR_TO,
    data: '0x',
  };
}

function baseSimulation(): SimulationResult {
  return {
    success: true,
    nativeBalanceDeltas: [],
    tokenBalanceDeltas: [],
    decodedCalls: [],
  };
}

test('assessRisk flags unlimited ERC20 approval and unknown spender', () => {
  const request = baseRequest();
  const simulation: SimulationResult = {
    ...baseSimulation(),
    decodedCalls: [
      {
        to: ADDR_TOKEN,
        functionSig: '0x095ea7b3',
        functionName: 'approve',
        args: {
          spender: ADDR_SPENDER,
          amount: (2n ** 256n - 1n).toString(),
        },
      },
    ],
  };

  const risk = assessRisk({ request, simulation });

  assert.equal(risk.flags.some((f) => f.code === 'MAX_APPROVAL'), true);
  assert.equal(risk.flags.some((f) => f.code === 'UNKNOWN_SPENDER'), true);
  assert.equal(risk.level, 'medium');
});

test('assessRisk does not flag unknown spender when provided as knownSpenders', () => {
  const request = baseRequest();
  const simulation: SimulationResult = {
    ...baseSimulation(),
    decodedCalls: [
      {
        to: ADDR_TOKEN,
        functionSig: '0x095ea7b3',
        functionName: 'approve',
        args: {
          spender: ADDR_SPENDER,
          amount: (2n ** 256n - 1n).toString(),
        },
      },
    ],
  };

  const risk = assessRisk({ request, simulation, options: { knownSpenders: [ADDR_SPENDER] } });

  assert.equal(risk.flags.some((f) => f.code === 'UNKNOWN_SPENDER'), false);
  assert.equal(risk.flags.some((f) => f.code === 'MAX_APPROVAL'), true);
});

test('assessRisk flags token drain pattern with multiple negative token deltas', () => {
  const request = baseRequest();
  const simulation: SimulationResult = {
    ...baseSimulation(),
    tokenBalanceDeltas: [
      { token: ADDR_TOKEN, holder: ADDR_FROM, delta: '-1' },
      { token: '0x5555555555555555555555555555555555555555', holder: ADDR_FROM, delta: '-2' },
      { token: '0x6666666666666666666666666666666666666666', holder: ADDR_FROM, delta: '-3' },
    ],
  };

  const risk = assessRisk({ request, simulation });
  assert.equal(risk.flags.some((f) => f.code === 'TOKEN_DRAIN_PATTERN'), true);
  assert.equal(risk.level, 'medium');
});

test('assessRisk flags UNKNOWN_CALLDATA when calldata is present but undecodable', () => {
  const request: AnalyzeTxRequest = {
    ...baseRequest(),
    data: '0x12345678',
  };
  const simulation: SimulationResult = {
    ...baseSimulation(),
    decodedCalls: [],
  };

  const risk = assessRisk({ request, simulation });
  assert.equal(risk.flags.some((f) => f.code === 'UNKNOWN_CALLDATA'), true);
  assert.equal(risk.level, 'medium');
});

test('buildWalletGuardReport produces a stable canonical report hash', () => {
  const request = baseRequest();
  const simulation: SimulationResult = {
    ...baseSimulation(),
    decodedCalls: [
      {
        to: ADDR_TOKEN,
        functionSig: '0x095ea7b3',
        functionName: 'approve',
        args: {
          spender: ADDR_SPENDER,
          amount: (2n ** 256n - 1n).toString(),
        },
      },
    ],
  };

  const report = buildWalletGuardReport({
    request,
    simulation,
    engineVersion: 'test',
  });

  const expectedHash = hashCanonicalJson({
    request: {
      chainId: request.chainId,
      from: request.from,
      to: request.to,
      data: request.data,
    },
    simulation: {
      success: simulation.success,
      nativeBalanceDeltas: simulation.nativeBalanceDeltas,
      tokenBalanceDeltas: simulation.tokenBalanceDeltas,
      decodedCalls: simulation.decodedCalls,
    },
    risk: report.risk,
    summary: report.summary,
    provenance: {
      engineVersion: 'test',
    },
  });

  assert.equal(report.provenance.reportHash, expectedHash);
});
