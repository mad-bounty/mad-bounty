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

// audit r3 F-1: a known adapter address is not enough; the per-bounty config decides REFUND safety.
import { assessBounty } from '../src/safety.js';
describe('safety gate reads adapter config (r3 F-1)', () => {
  const agent = '0x00000000000000000000000000000000000000a1' as const;
  const adapter = '0x00000000000000000000000000000000000000ad' as const;
  const agentAlt = '0x00000000000000000000000000000000000000a2' as const;
  const oracle = '0x00000000000000000000000000000000000000b0' as const;
  const b = {
    id: 1n, agent, verifier: adapter, claimAuthorizer: '0x0000000000000000000000000000000000000000', worker: '0x0000000000000000000000000000000000000000',
    vault: '0x0000000000000000000000000000000000000001', reward: 100_000_000n, deposit: 10_000_000n, workWindow: 86400, reviewWindow: 86400,
    openUntil: 10n ** 12n, deadline: 0n, extended: false, rejectMode: 'Refund', state: 'Open', evidenceHash: '0x',
  } as any;
  const base = { now: 1n, verifierIsContract: true, knownSafeVerifiers: [adapter] };
  it('Fallback with an untrusted (possibly agent) signer is DANGER in REFUND', () => {
    const r = assessBounty(b, { ...base, adapterConfig: { kind: 'fallback', signers: [agentAlt] }, trustedSigners: [oracle] });
    expect(r.safe).toBe(false);
    expect(r.warnings.map((w) => w.code)).toContain('UNTRUSTED_ADAPTER_SIGNER');
  });
  it('Fallback with only trusted signers is safe', () => {
    expect(assessBounty(b, { ...base, adapterConfig: { kind: 'fallback', signers: [oracle] }, trustedSigners: [oracle] }).safe).toBe(true);
  });
  it('Multi quorum not trusted is DANGER', () => {
    const r = assessBounty(b, { ...base, adapterConfig: { kind: 'multi', signers: [oracle, agentAlt, agent], threshold: 2 }, trustedSigners: [oracle] });
    expect(r.safe).toBe(false);
  });
  it('REFUND + OnchainCheck is DANGER; REFUND adapter with unread config is DANGER', () => {
    expect(assessBounty(b, { ...base, adapterConfig: { kind: 'onchainCheck', signers: [], target: oracle } }).safe).toBe(false);
    expect(assessBounty(b, { ...base }).warnings.map((w) => w.code)).toContain('ADAPTER_CONFIG_UNCHECKED');
  });
  it('REFUND + HashReveal is safe (reject needs the opening)', () => {
    expect(assessBounty(b, { ...base, adapterConfig: { kind: 'hashReveal', signers: [] } }).safe).toBe(true);
  });
});
