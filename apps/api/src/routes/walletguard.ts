import express from 'express';

import { AnalyzeTxRequestSchema, type AnalyzeTxRequestOutput } from '@walletguard/common';
import type { SimulationResult } from '@walletguard/common';
import { buildWalletGuardReport, decodeTopLevelCall } from '@walletguard/walletguard-core';

import { requireX402Payment } from '../x402/middleware.js';

function stubSimulateTx(request: AnalyzeTxRequestOutput): SimulationResult {
  return {
    success: true,
    nativeBalanceDeltas: [],
    tokenBalanceDeltas: [],
    decodedCalls: decodeTopLevelCall({ to: request.to, data: request.data }),
  };
}

export const walletguardRouter: express.Router = express.Router();

walletguardRouter.post('/analyze', requireX402Payment, (req: express.Request, res: express.Response) => {
  const parsed = AnalyzeTxRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'INVALID_REQUEST',
      issues: parsed.error.issues,
    });
    return;
  }

  const request = parsed.data;
  const simulation = stubSimulateTx(request);

  const engineVersion = process.env.ENGINE_VERSION ?? 'dev';

  const report = buildWalletGuardReport({
    request,
    simulation,
    engineVersion,
  });

  res.status(200).json(report);
});
