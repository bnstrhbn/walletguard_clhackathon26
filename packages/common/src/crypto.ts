import { keccak256, stringToHex } from 'viem';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function canonicalize(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') return value.toString();

  if (Array.isArray(value)) {
    return value.map((v) => {
      const c = canonicalize(v);
      return c === undefined ? null : c;
    });
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, JsonValue> = {};

    for (const key of Object.keys(obj).sort()) {
      const c = canonicalize(obj[key]);
      if (c !== undefined) out[key] = c;
    }

    return out;
  }

  return String(value);
}

export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value) ?? null);
}

export function keccak256Utf8(value: string): `0x${string}` {
  return keccak256(stringToHex(value));
}

export function hashCanonicalJson(value: unknown): `0x${string}` {
  return keccak256Utf8(canonicalJsonStringify(value));
}
