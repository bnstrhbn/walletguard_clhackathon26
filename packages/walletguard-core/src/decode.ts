import { decodeFunctionData } from 'viem';

import type { AddressString, HexString, SimulationResult } from '@walletguard/common';

const ERC20_MIN_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'transferFrom',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

function bigintToString(value: unknown): string | undefined {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === 'string') return value;
  return undefined;
}

const ERC721_MIN_ABI = [
  {
    type: 'function',
    name: 'setApprovalForAll',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'approved', type: 'bool' },
    ],
    outputs: [],
  },
] as const;

function selector(data: HexString): HexString {
  return `0x${data.slice(2, 10)}` as HexString;
}

const SELECTORS = {
  ERC20_APPROVE: '0x095ea7b3',
  ERC20_TRANSFER: '0xa9059cbb',
  ERC20_TRANSFER_FROM: '0x23b872dd',
  ERC721_SET_APPROVAL_FOR_ALL: '0xa22cb465',
} as const;

export function decodeTopLevelCall(input: { to: AddressString; data: HexString }): SimulationResult['decodedCalls'] {
  const sig = selector(input.data).toLowerCase();

  try {
    if (
      sig === SELECTORS.ERC20_APPROVE ||
      sig === SELECTORS.ERC20_TRANSFER ||
      sig === SELECTORS.ERC20_TRANSFER_FROM
    ) {
      const decoded = decodeFunctionData({ abi: ERC20_MIN_ABI, data: input.data });

      if (decoded.functionName === 'approve') {
        const spender = decoded.args?.[0] as unknown;
        const amount = decoded.args?.[1] as unknown;

        return [
          {
            to: input.to,
            functionSig: sig,
            functionName: decoded.functionName,
            args: {
              spender: typeof spender === 'string' ? spender : String(spender),
              amount: bigintToString(amount) ?? String(amount),
            },
          },
        ];
      }

      if (decoded.functionName === 'transfer') {
        const to = decoded.args?.[0] as unknown;
        const amount = decoded.args?.[1] as unknown;

        return [
          {
            to: input.to,
            functionSig: sig,
            functionName: decoded.functionName,
            args: {
              to: typeof to === 'string' ? to : String(to),
              amount: bigintToString(amount) ?? String(amount),
            },
          },
        ];
      }

      if (decoded.functionName === 'transferFrom') {
        const from = decoded.args?.[0] as unknown;
        const to = decoded.args?.[1] as unknown;
        const amount = decoded.args?.[2] as unknown;

        return [
          {
            to: input.to,
            functionSig: sig,
            functionName: decoded.functionName,
            args: {
              from: typeof from === 'string' ? from : String(from),
              to: typeof to === 'string' ? to : String(to),
              amount: bigintToString(amount) ?? String(amount),
            },
          },
        ];
      }

      return [];
    }

    if (sig === SELECTORS.ERC721_SET_APPROVAL_FOR_ALL) {
      const decoded = decodeFunctionData({ abi: ERC721_MIN_ABI, data: input.data });

      if (decoded.functionName === 'setApprovalForAll') {
        const operator = decoded.args?.[0] as unknown;
        const approved = decoded.args?.[1] as unknown;

        return [
          {
            to: input.to,
            functionSig: sig,
            functionName: decoded.functionName,
            args: {
              operator: typeof operator === 'string' ? operator : String(operator),
              approved: Boolean(approved),
            },
          },
        ];
      }

      return [];
    }

    return [];
  } catch {
    return [];
  }
}
