export type HexString = `0x${string}`;
export type AddressString = `0x${string}`;

export type VaultExecutionMode = 'AUTO_EXECUTE' | 'PROPOSE_ONLY';

export type VaultIntent = {
  chainId: number;
  vault: AddressString;
  to: AddressString;
  data: HexString;
  value?: string;
  requestId: string;
  mode: VaultExecutionMode;
  metadata?: {
    origin?: string;
  };
};

export type VaultRiskSignal = {
  riskScore: number;
  flags: string[];
  reason?: string;
};

export type VaultDecision = {
  action: 'allow' | 'warn' | 'block';
  mode: VaultExecutionMode;
  risk: VaultRiskSignal;
};

export type VaultReceipt = {
  intent: VaultIntent;
  decision: VaultDecision;
  hashes: {
    intentHash: HexString;
    decisionHash: HexString;
    receiptHash: HexString;
  };
  provenance: {
    engineVersion: string;
    workflowRunId?: string;
  };
};

export type AnalyzeTxRequest = {
  chainId: number;
  from: AddressString;
  to: AddressString;
  data: HexString;
  value?: string;
  blockTag?: 'latest' | string;
  metadata?: {
    wallet?: string;
    origin?: string;
  };
};

export type SimulationResult = {
  success: boolean;
  gasUsed?: string;
  errorMessage?: string;
  nativeBalanceDeltas: Array<{ address: AddressString; deltaWei: string }>;
  tokenBalanceDeltas: Array<{ token: AddressString; holder: AddressString; delta: string }>;
  decodedCalls: Array<{
    to: AddressString;
    functionSig?: string;
    functionName?: string;
    args?: Record<string, string | number | boolean>;
  }>;
  logs?: Array<{ address: AddressString; topics: HexString[]; data: HexString }>;
};

export type RiskFlag =
  | { code: 'MAX_APPROVAL'; severity: 'high'; details: string }
  | { code: 'UNKNOWN_SPENDER'; severity: 'medium'; details: string }
  | { code: 'UNKNOWN_CALLDATA'; severity: 'medium'; details: string }
  | { code: 'OWNER_CHANGE'; severity: 'high'; details: string }
  | { code: 'DELEGATECALL_PATH'; severity: 'high'; details: string }
  | { code: 'TOKEN_DRAIN_PATTERN'; severity: 'high'; details: string }
  | { code: 'SUSPICIOUS_TRANSFER'; severity: 'medium'; details: string }
  | { code: 'NEW_CONTRACT'; severity: 'low'; details: string }
  | { code: 'UNVERIFIED_CODE'; severity: 'low'; details: string };

export type RiskAssessment = {
  score: number;
  level: 'low' | 'medium' | 'high';
  flags: RiskFlag[];
};

export type WalletGuardReport = {
  request: AnalyzeTxRequest;
  simulation: SimulationResult;
  risk: RiskAssessment;
  summary: {
    'tl;dr': string;
    bullets: string[];
    recommendedAction: 'allow' | 'warn' | 'block';
  };
  provenance: {
    engineVersion: string;
    workflowRunId?: string;
    reportHash: HexString;
    committedOnchain?: {
      chainId: number;
      contract: AddressString;
      txHash: HexString;
    };
  };
};

export type ToolRunRequest = {
  toolId: string;
  payload: unknown;
};

export type ToolReceipt = {
  toolId: string;
  payer: AddressString;
  price: string;
  requestHash: HexString;
  responseHash: HexString;
  workflowRunId?: string;
  timestamp: string;
  receiptHash: HexString;
  anchor?: {
    chainId: number;
    contract: AddressString;
    txHash: HexString;
  };
};

export type ToolRunResponse = {
  result: unknown;
  receipt: ToolReceipt;
};
