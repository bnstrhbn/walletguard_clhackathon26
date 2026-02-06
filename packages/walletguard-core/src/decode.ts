import type { AddressString, HexString, SimulationResult } from '@walletguard/common';

function readWord(data: HexString, index: number): string | undefined {
  const hex = data.slice(2);
  const start = 8 + index * 64;
  const end = start + 64;
  if (hex.length < end) return undefined;
  return hex.slice(start, end);
}

function decodeAddressWord(word: string | undefined): AddressString | undefined {
  if (!word || word.length !== 64) return undefined;
  return (`0x${word.slice(24)}` as AddressString).toLowerCase() as AddressString;
}

function decodeUint256Word(word: string | undefined): string | undefined {
  if (!word || word.length !== 64) return undefined;
  try {
    return BigInt(`0x${word}`).toString();
  } catch {
    return undefined;
  }
}

function decodeBoolWord(word: string | undefined): boolean | undefined {
  if (!word || word.length !== 64) return undefined;
  const last = word[word.length - 1];
  if (last === '0') return false;
  if (last === '1') return true;
  try {
    return BigInt(`0x${word}`) !== 0n;
  } catch {
    return undefined;
  }
}

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
      if (sig === SELECTORS.ERC20_APPROVE) {
        const spender = decodeAddressWord(readWord(input.data, 0));
        const amount = decodeUint256Word(readWord(input.data, 1));
        if (!spender || amount === undefined) return [];

        return [
          {
            to: input.to,
            functionSig: sig,
            functionName: 'approve',
            args: {
              spender,
              amount,
            },
          },
        ];
      }

      if (sig === SELECTORS.ERC20_TRANSFER) {
        const to = decodeAddressWord(readWord(input.data, 0));
        const amount = decodeUint256Word(readWord(input.data, 1));
        if (!to || amount === undefined) return [];

        return [
          {
            to: input.to,
            functionSig: sig,
            functionName: 'transfer',
            args: {
              to,
              amount,
            },
          },
        ];
      }

      if (sig === SELECTORS.ERC20_TRANSFER_FROM) {
        const from = decodeAddressWord(readWord(input.data, 0));
        const to = decodeAddressWord(readWord(input.data, 1));
        const amount = decodeUint256Word(readWord(input.data, 2));
        if (!from || !to || amount === undefined) return [];

        return [
          {
            to: input.to,
            functionSig: sig,
            functionName: 'transferFrom',
            args: {
              from,
              to,
              amount,
            },
          },
        ];
      }

      return [];
    }

    if (sig === SELECTORS.ERC721_SET_APPROVAL_FOR_ALL) {
      const operator = decodeAddressWord(readWord(input.data, 0));
      const approved = decodeBoolWord(readWord(input.data, 1));
      if (!operator || approved === undefined) return [];

        return [
          {
            to: input.to,
            functionSig: sig,
            functionName: 'setApprovalForAll',
            args: {
              operator,
              approved,
            },
          },
        ];
    }

    return [];
  } catch {
    return [];
  }
}
