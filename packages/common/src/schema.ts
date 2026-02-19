import { z } from 'zod';

import type { AddressString, HexString } from './types.js';

const MAX_DATA_HEX_CHARS = 200_000;
const MAX_DECIMAL_STR_CHARS = 80;
const MAX_METADATA_STR_CHARS = 200;
const MAX_BLOCKTAG_CHARS = 100;

const hexString: z.ZodType<HexString> = z.custom<HexString>((val) => {
  return (
    typeof val === 'string' &&
    val.length <= MAX_DATA_HEX_CHARS &&
    /^0x(?:[0-9a-fA-F]{2})*$/.test(val)
  );
});

const addressString: z.ZodType<AddressString> = z.custom<AddressString>((val) => {
  return typeof val === 'string' && /^0x[0-9a-fA-F]{40}$/.test(val);
});

export const AnalyzeTxRequestSchema = z.object({
  chainId: z.number().int().positive(),
  from: addressString,
  to: addressString,
  data: hexString.refine((v) => v === '0x' || v.length >= 10, { message: 'INVALID_CALLDATA' }),
  value: z
    .string()
    .max(MAX_DECIMAL_STR_CHARS)
    .regex(/^[0-9]+$/)
    .optional(),
  blockTag: z.union([z.literal('latest'), z.string().max(MAX_BLOCKTAG_CHARS)]).optional(),
  metadata: z
    .object({
      wallet: z.string().max(MAX_METADATA_STR_CHARS).optional(),
      origin: z.string().max(MAX_METADATA_STR_CHARS).optional(),
    })
    .optional(),
});

export const SimulationResultSchema = z.object({
  success: z.boolean(),
  gasUsed: z.string().optional(),
  errorMessage: z.string().optional(),
  nativeBalanceDeltas: z.array(
    z.object({
      address: addressString,
      deltaWei: z.string(),
    }),
  ),
  tokenBalanceDeltas: z.array(
    z.object({
      token: addressString,
      holder: addressString,
      delta: z.string(),
    }),
  ),
  decodedCalls: z.array(
    z.object({
      to: addressString,
      functionSig: z.string().optional(),
      functionName: z.string().optional(),
      args: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
    }),
  ),
  logs: z
    .array(
      z.object({
        address: addressString,
        topics: z.array(hexString),
        data: hexString,
      }),
    )
    .optional(),
});

const RiskFlagMaxApprovalSchema = z.object({
  code: z.literal('MAX_APPROVAL'),
  severity: z.literal('high'),
  details: z.string(),
});

const RiskFlagUnknownSpenderSchema = z.object({
  code: z.literal('UNKNOWN_SPENDER'),
  severity: z.literal('medium'),
  details: z.string(),
});

const RiskFlagUnknownCalldataSchema = z.object({
  code: z.literal('UNKNOWN_CALLDATA'),
  severity: z.literal('medium'),
  details: z.string(),
});

const RiskFlagOwnerChangeSchema = z.object({
  code: z.literal('OWNER_CHANGE'),
  severity: z.literal('high'),
  details: z.string(),
});

const RiskFlagDelegatecallPathSchema = z.object({
  code: z.literal('DELEGATECALL_PATH'),
  severity: z.literal('high'),
  details: z.string(),
});

const RiskFlagTokenDrainPatternSchema = z.object({
  code: z.literal('TOKEN_DRAIN_PATTERN'),
  severity: z.literal('high'),
  details: z.string(),
});

const RiskFlagSuspiciousTransferSchema = z.object({
  code: z.literal('SUSPICIOUS_TRANSFER'),
  severity: z.literal('medium'),
  details: z.string(),
});

const RiskFlagNewContractSchema = z.object({
  code: z.literal('NEW_CONTRACT'),
  severity: z.literal('low'),
  details: z.string(),
});

const RiskFlagUnverifiedCodeSchema = z.object({
  code: z.literal('UNVERIFIED_CODE'),
  severity: z.literal('low'),
  details: z.string(),
});

export const RiskFlagSchema = z.discriminatedUnion('code', [
  RiskFlagMaxApprovalSchema,
  RiskFlagUnknownSpenderSchema,
  RiskFlagUnknownCalldataSchema,
  RiskFlagOwnerChangeSchema,
  RiskFlagDelegatecallPathSchema,
  RiskFlagTokenDrainPatternSchema,
  RiskFlagSuspiciousTransferSchema,
  RiskFlagNewContractSchema,
  RiskFlagUnverifiedCodeSchema,
]);

export const RiskAssessmentSchema = z.object({
  score: z.number().min(0).max(100),
  level: z.enum(['low', 'medium', 'high']),
  flags: z.array(RiskFlagSchema),
});

export const WalletGuardReportSchema = z.object({
  request: AnalyzeTxRequestSchema,
  simulation: SimulationResultSchema,
  risk: RiskAssessmentSchema,
  summary: z.object({
    'tl;dr': z.string(),
    bullets: z.array(z.string()),
    recommendedAction: z.enum(['allow', 'warn', 'block']),
  }),
  provenance: z.object({
    engineVersion: z.string(),
    workflowRunId: z.string().optional(),
    reportHash: hexString,
    committedOnchain: z
      .object({
        chainId: z.number().int().positive(),
        contract: addressString,
        txHash: hexString,
      })
      .optional(),
  }),
});

export const ToolRunRequestSchema = z.object({
  toolId: z.string().min(1),
  payload: z.unknown(),
});

export const ToolReceiptSchema = z.object({
  toolId: z.string().min(1),
  payer: addressString,
  price: z.string().min(1),
  requestHash: hexString,
  responseHash: hexString,
  workflowRunId: z.string().optional(),
  timestamp: z.string(),
  receiptHash: hexString,
  anchor: z
    .object({
      chainId: z.number().int().positive(),
      contract: addressString,
      txHash: hexString,
    })
    .optional(),
});

export const ToolRunResponseSchema = z.object({
  result: z.unknown(),
  receipt: ToolReceiptSchema,
});

export const VaultExecutionModeSchema = z.enum(['AUTO_EXECUTE', 'PROPOSE_ONLY']);

export const VaultIntentSchema = z.object({
  chainId: z.number().int().positive(),
  vault: addressString,
  to: addressString,
  data: hexString.refine((v) => v === '0x' || v.length >= 10, { message: 'INVALID_CALLDATA' }),
  value: z
    .string()
    .max(MAX_DECIMAL_STR_CHARS)
    .regex(/^[0-9]+$/)
    .optional(),
  requestId: z.string().min(1).max(MAX_METADATA_STR_CHARS),
  mode: VaultExecutionModeSchema,
  metadata: z
    .object({
      origin: z.string().max(MAX_METADATA_STR_CHARS).optional(),
    })
    .optional(),
});

export const VaultRiskSignalSchema = z.object({
  riskScore: z.number().min(0).max(100),
  flags: z.array(z.string().min(1).max(MAX_METADATA_STR_CHARS)),
  reason: z.string().max(MAX_METADATA_STR_CHARS).optional(),
});

export const VaultDecisionSchema = z.object({
  action: z.enum(['allow', 'warn', 'block']),
  mode: VaultExecutionModeSchema,
  risk: VaultRiskSignalSchema,
});

export const VaultReceiptSchema = z.object({
  intent: VaultIntentSchema,
  decision: VaultDecisionSchema,
  hashes: z.object({
    intentHash: hexString,
    decisionHash: hexString,
    receiptHash: hexString,
  }),
  provenance: z.object({
    engineVersion: z.string(),
    workflowRunId: z.string().optional(),
  }),
});

export type AnalyzeTxRequestInput = z.input<typeof AnalyzeTxRequestSchema>;
export type AnalyzeTxRequestOutput = z.output<typeof AnalyzeTxRequestSchema>;
