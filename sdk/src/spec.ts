import { keccak256, stringToBytes, type Hex } from 'viem';

/**
 * Deterministic JSON: object keys sorted (by UTF-16 code unit), no whitespace.
 * Rejects values JSON cannot represent faithfully (undefined, functions, NaN/Infinity, bigint).
 */
export function canonicalJson(value: unknown): string {
  return ser(value, '$');
}

function ser(v: unknown, path: string): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new Error(`canonicalJson: non-finite number at ${path}`);
      return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) return '[' + v.map((x, i) => ser(x, `${path}[${i}]`)).join(',') + ']';
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + ser(obj[k], `${path}.${k}`)).join(',') + '}';
    }
    default:
      throw new Error(`canonicalJson: unsupported ${typeof v} at ${path}`);
  }
}

/**
 * keccak256 of the canonical JSON of a spec. Pass an object, or a JSON string (parsed then canonicalized,
 * so whitespace and key order do not change the hash).
 */
export function hashSpec(spec: unknown): Hex {
  const value = typeof spec === 'string' ? JSON.parse(spec) : spec;
  return keccak256(stringToBytes(canonicalJson(value)));
}

/** keccak256 of arbitrary evidence bytes or UTF-8 text. */
export function hashEvidence(evidence: string | Uint8Array): Hex {
  return keccak256(typeof evidence === 'string' ? stringToBytes(evidence) : evidence);
}
