import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicClient, encodeFunctionData, http, keccak256, stringToBytes, stringToHex, concatHex, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { madBountyCoreAbi, toContractParams } from '@madbounty/sdk';
import { appendSpec, extractSpec } from '../src/chain/specCalldata';
import { SPEC_MAX_BYTES } from '../src/config';

const spec = JSON.stringify({
  specVersion: 'madb-spec/1', title: 'Tëst ✓ unicode', instructions: 'do it', acceptanceCriteria: [{ id: 'a', description: 'x' }],
  evidenceFormat: 'url', verifier: 'self', deadlines: {}, language: 'en',
});
const baseCalldata = encodeFunctionData({
  abi: madBountyCoreAbi, functionName: 'post',
  args: [toContractParams({ verifier: '0x0000000000000000000000000000000000000001', reward: 1_000_000n, workWindow: 3600, reviewWindow: 43200, openUntil: 2_000_000_000n, specHash: keccak256(stringToBytes(spec)) })],
});

test('appendSpec/extractSpec round-trip (exact UTF-8 bytes)', () => {
  const { data, specHash, bytes } = appendSpec(baseCalldata, spec);
  assert.equal(specHash, keccak256(stringToBytes(spec)));
  assert.equal(bytes, stringToBytes(spec).length);
  assert.ok(data.startsWith(baseCalldata));
  const s = extractSpec(data, specHash);
  assert.equal(s.kind, 'verified');
  if (s.kind === 'verified') { assert.equal(s.spec.title, 'Tëst ✓ unicode'); assert.equal(s.bytes, bytes); }
});

test('tampered spec → mismatch', () => {
  const { data, specHash } = appendSpec(baseCalldata, spec);
  const tampered = (data.slice(0, -2) + (data.endsWith('7d') ? '5d' : '7d')) as Hex;
  assert.equal(extractSpec(tampered, specHash).kind, 'mismatch');
  assert.equal(extractSpec(data, keccak256('0x01')).kind, 'mismatch');
});

test('no magic → offchain', () => {
  assert.equal(extractSpec(baseCalldata, keccak256(stringToBytes(spec))).kind, 'offchain');
  assert.equal(extractSpec('0x', keccak256('0x')).kind, 'offchain');
});

test('last magic wins (magic inside earlier calldata is ignored)', () => {
  const tricky = concatHex([baseCalldata, stringToHex('MADBSPEC1garbage')]);
  const { data, specHash } = appendSpec(tricky, spec);
  assert.equal(extractSpec(data, specHash).kind, 'verified');
});

test('hash ok but bad JSON / bad shape → invalid', () => {
  const bad = '{not json';
  const r1 = appendSpec(baseCalldata, bad);
  const s1 = extractSpec(r1.data, r1.specHash);
  assert.equal(s1.kind, 'invalid');
  const r2 = appendSpec(baseCalldata, JSON.stringify({ specVersion: 'other', title: 't' }));
  const s2 = extractSpec(r2.data, r2.specHash);
  assert.equal(s2.kind, 'invalid');
  if (s2.kind === 'invalid') assert.match(s2.reason, /specVersion/);
});

test('size cap enforced', () => {
  assert.throws(() => appendSpec(baseCalldata, 'x'.repeat(SPEC_MAX_BYTES + 1)), /too long/);
  assert.doesNotThrow(() => appendSpec(baseCalldata, 'x'.repeat(SPEC_MAX_BYTES)));
  assert.throws(() => appendSpec(baseCalldata, ''), /empty/);
});

test('live: post #18 tx on Base Sepolia → verified "Calldata spec probe"', async (t) => {
  const pc = createPublicClient({ chain: baseSepolia, transport: http('https://base-sepolia-rpc.publicnode.com', { timeout: 15_000, retryCount: 1 }) });
  let tx;
  try {
    tx = await pc.getTransaction({ hash: '0xa5f5c09f303f0af0770ff96bd5e174d0e69d96ecf6866dadc6bf987a55bca1e3' });
  } catch (e) {
    t.skip(`offline: ${(e as Error).message.split('\n')[0]}`);
    return;
  }
  // specHash from the Posted event of that tx
  const rc = await pc.getTransactionReceipt({ hash: tx.hash });
  const { parseEventLogs } = await import('viem');
  const ev = parseEventLogs({ abi: madBountyCoreAbi, logs: rc.logs, eventName: 'Posted' })[0]!;
  assert.equal((ev.args as { id: bigint }).id, 18n);
  const s = extractSpec(tx.input, (ev.args as { specHash: Hex }).specHash);
  assert.equal(s.kind, 'verified');
  if (s.kind === 'verified') { assert.equal(s.spec.title, 'Calldata spec probe'); assert.equal(s.bytes, 251); }
});
