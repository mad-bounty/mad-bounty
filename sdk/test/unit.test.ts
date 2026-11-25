import { describe, expect, it } from 'vitest';
import { keccak256, stringToBytes } from 'viem';
import {
  canonicalJson, hashSpec, encryptForAgent, decryptAsAgent, decryptAsAgentString, generateEncryptionKeyPair,
  encryptionPublicKey, minDepositFor, acceptPayout, parseUsdc, formatUsdc,
} from '../src/index.js';

describe('spec hashing', () => {
  it('is key-order and whitespace independent', () => {
    const a = { title: 'x', reqs: [{ b: 2, a: 1 }], n: 1.5 };
    const b = { n: 1.5, reqs: [{ a: 1, b: 2 }], title: 'x' };
    expect(canonicalJson(a)).toBe('{"n":1.5,"reqs":[{"a":1,"b":2}],"title":"x"}');
    expect(hashSpec(a)).toBe(hashSpec(b));
    expect(hashSpec(JSON.stringify(b, null, 2))).toBe(hashSpec(a));
    expect(hashSpec(a)).toBe(keccak256(stringToBytes('{"n":1.5,"reqs":[{"a":1,"b":2}],"title":"x"}')));
  });
  it('rejects non-JSON values', () => {
    expect(() => canonicalJson({ a: NaN })).toThrow();
    expect(() => canonicalJson({ a: 1n })).toThrow();
  });
});

describe('encryption', () => {
  it('roundtrips and rejects wrong key / tamper', () => {
    const kp = generateEncryptionKeyPair();
    expect(encryptionPublicKey(kp.privateKey)).toBe(kp.publicKey);
    const box = encryptForAgent(kp.publicKey, 'api key: s3cret');
    expect(decryptAsAgentString(kp.privateKey, box)).toBe('api key: s3cret');
    const other = generateEncryptionKeyPair();
    expect(() => decryptAsAgent(other.privateKey, box)).toThrow();
    const tampered = (box.slice(0, -2) + (box.endsWith('00') ? '01' : '00')) as `0x${string}`;
    expect(() => decryptAsAgent(kp.privateKey, tampered)).toThrow();
    expect(encryptForAgent(kp.publicKey, 'x')).not.toBe(encryptForAgent(kp.publicKey, 'x'));
  });
});

describe('math', () => {
  it('mirrors contract rules', () => {
    expect(minDepositFor(10_000_000n)).toBe(1_000_000n);
    expect(minDepositFor(1_000_000_000n)).toBe(20_000_000n);
    expect(acceptPayout(100_000_000n, 5_000_000n)).toEqual({ toWorker: 104_000_000n, fee: 1_000_000n });
    expect(parseUsdc('12.5')).toBe(12_500_000n);
    expect(formatUsdc(12_500_000n)).toBe('12.5');
    expect(() => parseUsdc('1.1234567')).toThrow();
  });
});
