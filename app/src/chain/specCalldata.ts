// Spec-in-calldata: post() calldata || ascii("MADBSPEC1") || utf8(specJson). specHash = keccak256(specBytes).
import { bytesToHex, concatHex, hexToBytes, keccak256, stringToBytes, stringToHex, type Hex } from 'viem';
import { SPEC_MAGIC, SPEC_MAX_BYTES } from '../config';
import type { BountySpec, SpecStatus } from '../types';

const MAGIC_BYTES = stringToBytes(SPEC_MAGIC);

/** UTF-8 bytes + keccak of a spec JSON string, exactly as given (no canonicalisation). */
export function specHashOf(specJson: string): Hex {
  return keccak256(stringToBytes(specJson));
}

/** Append MAGIC + spec bytes to calldata. Throws if the spec exceeds SPEC_MAX_BYTES. */
export function appendSpec(calldata: Hex, specJson: string): { data: Hex; specHash: Hex; bytes: number } {
  const specBytes = stringToBytes(specJson);
  if (specBytes.length === 0) throw new Error('Spec is empty.');
  if (specBytes.length > SPEC_MAX_BYTES) {
    throw new Error(`Spec is too long (${specBytes.length} bytes; max ${SPEC_MAX_BYTES}). Shorten the instructions.`);
  }
  return {
    data: concatHex([calldata, stringToHex(SPEC_MAGIC), bytesToHex(specBytes)]),
    specHash: keccak256(specBytes),
    bytes: specBytes.length,
  };
}

function lastIndexOf(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = hay.length - needle.length; i >= 0; i--) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Minimal shape check for display; returns a reason string when the spec is unusable. */
export function checkSpecShape(v: unknown): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'spec is not a JSON object';
  const o = v as Record<string, unknown>;
  if (o.specVersion !== 'madb-spec/1') return 'specVersion is not "madb-spec/1"';
  if (typeof o.title !== 'string' || !o.title.trim()) return 'missing title';
  if (typeof o.instructions !== 'string') return 'missing instructions';
  if (!Array.isArray(o.acceptanceCriteria)) return 'acceptanceCriteria is not a list';
  return null;
}

/** Recover the spec from a post() tx input: bytes after the LAST magic, keccak must equal specHash. */
export function extractSpec(input: Hex, specHash: Hex): SpecStatus {
  let bytes: Uint8Array;
  try { bytes = hexToBytes(input); } catch { return { kind: 'offchain' }; }
  const at = lastIndexOf(bytes, MAGIC_BYTES);
  if (at < 0) return { kind: 'offchain' };
  const specBytes = bytes.slice(at + MAGIC_BYTES.length);
  if (specBytes.length === 0 || specBytes.length > SPEC_MAX_BYTES) return { kind: 'offchain' };
  if (keccak256(specBytes).toLowerCase() !== specHash.toLowerCase()) return { kind: 'mismatch' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(specBytes));
  } catch (e) {
    return { kind: 'invalid', reason: `not valid UTF-8 JSON (${(e as Error).message})` };
  }
  const bad = checkSpecShape(parsed);
  if (bad) return { kind: 'invalid', reason: bad };
  return { kind: 'verified', spec: parsed as BountySpec, bytes: specBytes.length };
}
