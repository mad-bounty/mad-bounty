import test from 'node:test';
import assert from 'node:assert/strict';
import type { Hex } from 'viem';
import type { TimelineEvent } from '../src/types';
import { feeLabel, feeOf, moneyRows, pct } from '../src/model/money';
import { eventDetail, gapLabel, outcomeForViewer, outcomeOf, prefillFromSpec } from '../src/model/outcome';
import { buildSpecJson, defaultForm } from '../src/model/postForm';

const U = 1_000_000n;
const W = '0x2Ae54f56054fd4b758FA2d60500fEFDB3f5834f7';
const A = '0xdb04aa53590e1D93A9Dd747552f7f51aa8f4d720';
const V = '0xE54d497657C862d84C6eCEF5f6dA17D88C0959b1';
const ev = (kind: TimelineEvent['kind'], args: Record<string, unknown> = {}, time = 1_800_000_000): TimelineEvent =>
  ({ kind, args, time, block: 1n, tx: '0x01' as Hex });

test('money: every row is a NET change and the four parties sum to zero', () => {
  for (const rejectMode of ['Burn', 'Refund'] as const) {
    const rows = moneyRows({ reward: U, deposit: U, feeBps: 500n, rejectMode });
    for (const r of rows) {
      const sum = r.poster.net + (r.worker?.net ?? 0n) + r.treasury + r.burned;
      assert.equal(sum, 0n, `${rejectMode}/${r.id} sums to zero`);
    }
  }
});

test('money: 1 USDC reward, 1 USDC deposit, 5% fee — the design-review example', () => {
  const [acc, rej, silent, aband] = moneyRows({ reward: U, deposit: U, feeBps: 500n, rejectMode: 'Burn' });
  assert.equal(acc!.worker!.net, 950_000n);                      // +0.95 net
  assert.deepEqual(acc!.worker!.wallet, { dir: 'in', amount: 1_950_000n, of: U }); // gets 1.95 back
  assert.equal(acc!.poster.net, -U);                              // −1.00 paid to worker
  assert.equal(acc!.treasury, 50_000n);
  assert.equal(rej!.poster.net, -U); assert.equal(rej!.burned, 2n * U); assert.equal(rej!.worker!.net, -U);
  assert.equal(silent!.worker!.net, 950_000n); assert.equal(silent!.poster.net, -U);
  assert.equal(aband!.poster.net, 0n); assert.equal(aband!.worker!.net, -U); assert.equal(aband!.burned, U);
});

test('money: REFUND reject gives the poster 0.00 net and burns only the deposit', () => {
  const rej = moneyRows({ reward: 10n * U, deposit: U, feeBps: 500n, rejectMode: 'Refund' })[1]!;
  assert.equal(rej.poster.net, 0n);
  assert.equal(rej.burned, U);
});

test('money: fee rounds down like Solidity, labels use the bounty fee', () => {
  assert.equal(feeOf(1_000_001n, 500n), 50_000n);
  assert.equal(feeOf(U, 0n), 0n);
  assert.equal(pct(500n), '5'); assert.equal(pct(250n), '2.5'); assert.equal(pct(1n), '0.01');
  assert.equal(feeLabel(100n), '1% of reward');
});

test('outcome: Paid via accept vs timeout is read from byTimeout', () => {
  const acc = outcomeOf([ev('Posted'), ev('Claimed'), ev('Submitted'), ev('Paid', { worker: W, toWorker: 1_950_000n, fee: 50_000n, byTimeout: false })]);
  assert.equal(acc.path, 'accept');
  assert.equal(acc.headline, 'Paid · 1.95 USDC to 0x2Ae5…34f7');
  assert.equal(acc.amount, 1_950_000n); assert.equal(acc.to, W);
  const to = outcomeOf([ev('Paid', { worker: W, toWorker: 1_950_000n, fee: 50_000n, byTimeout: true })]);
  assert.equal(to.path, 'timeout');
  assert.match(to.detail, /No verdict before the review deadline/);
  assert.match(acc.detail, /1\.95 USDC went to 0x2Ae5…34f7/);
});

test('outcome: burn / refund / cancel / not finished', () => {
  assert.equal(outcomeOf([ev('Rejected'), ev('Burned', { amount: 2n * U })]).path, 'burn');
  assert.equal(outcomeOf([ev('Refunded', { toAgent: U, depositBurned: U })]).path, 'refund');
  assert.equal(outcomeOf([ev('Posted'), ev('Cancelled')]).path, 'cancelled');
  assert.equal(outcomeOf([ev('Posted'), ev('Expired'), ev('Cancelled')]).word, 'Cancelled');
  assert.equal(outcomeOf([ev('Posted'), ev('Claimed')]).path, 'none');
});

test('outcome: viewer role sentence', () => {
  const acc = outcomeOf([ev('Paid', { worker: W, toWorker: 1n, fee: 0n, byTimeout: false })]);
  const roles = { agent: A, worker: W, verifier: V };
  assert.equal(outcomeForViewer(acc, roles, V as Hex), 'You accepted this work');
  assert.equal(outcomeForViewer(acc, roles, W as Hex), 'Your work was accepted');
  assert.equal(outcomeForViewer(acc, roles, undefined), undefined);
  assert.equal(outcomeForViewer(acc, roles, '0x4444444444444444444444444444444444444444'), undefined);
  const to = outcomeOf([ev('Paid', { worker: W, toWorker: 1n, fee: 0n, byTimeout: true })]);
  assert.notEqual(outcomeForViewer(to, roles, V as Hex), 'You accepted this work');
});

test('timeline: verdict, deposit escrowed, fee to treasury and gaps come from event args', () => {
  const ctx = { reward: U, deposit: U, feeBps: 500n };
  assert.match(eventDetail(ev('Claimed', { worker: W, deadline: 1_800_003_600n }), ctx)!, /deposit 1\.00 USDC escrowed/);
  const paid = eventDetail(ev('Paid', { worker: W, toWorker: 1_950_000n, fee: 50_000n, byTimeout: false }), ctx)!;
  assert.match(paid, /accepted by the verifier/); assert.match(paid, /0\.05 USDC fee to treasury/);
  assert.match(eventDetail(ev('Paid', { worker: W, toWorker: 1n, fee: 0n, byTimeout: true }), ctx)!, /paid on timeout — verifier silent/);
  assert.equal(gapLabel(1000, 1000 + 22 * 60, 'Claimed'), '22m after claim');
  assert.equal(gapLabel(1000, 1007, 'Submitted'), '7s after submission');
  assert.equal(gapLabel(1000, 1000, 'Claimed'), '');
  assert.match(eventDetail(ev('Paid', { worker: W, toWorker: 1n, fee: 0n, byTimeout: false }), { ...ctx, verifier: V })!, /accepted by 0xE54d…59b1/);
});

test('prefill: a spec written by buildSpecJson round-trips into the wizard fields', () => {
  const f = { ...defaultForm(), title: 'Translate FAQ', summary: 'ctx', instructions: 'Translate every answer.', criteria: ['All done', 'No typos'], evidenceFormat: 'A link to a public doc' };
  const p = prefillFromSpec(JSON.parse(buildSpecJson(f)))!;
  assert.deepEqual(p.fields, { title: 'Translate FAQ', summary: 'ctx', instructions: 'Translate every answer.', criteria: ['All done', 'No typos'], evidenceFormat: 'A link to a public doc' });
  assert.equal(prefillFromSpec({ nope: 1 }), undefined);
});
