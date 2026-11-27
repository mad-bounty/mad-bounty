import test from 'node:test';
import assert from 'node:assert/strict';
import { ZERO_ADDRESS, type Bounty, type RejectModeName, type StateName } from '@madbounty/sdk';
import type { Address, Hex } from 'viem';
import type { ActionId, BountyView, VerifierKind } from '../src/types';
import { acceptMoney, availableActions, nextStep, rejectMoney } from '../src/model/actions';

const AGENT = '0x1111111111111111111111111111111111111111' as Address;
const WORKER = '0x2222222222222222222222222222222222222222' as Address;
const VERIFIER = '0x3333333333333333333333333333333333333333' as Address;
const STRANGER = '0x4444444444444444444444444444444444444444' as Address;
const OTHER = '0x5555555555555555555555555555555555555555' as Address;
const NOW = 1_800_000_000;
const USDC = 1_000_000n;

interface MkOpts {
  state?: StateName;
  kind?: VerifierKind;
  rejectMode?: RejectModeName;
  extended?: boolean;
  claimAuthorizer?: Address;
  reward?: bigint;
  deposit?: bigint;
  feeBps?: bigint;
  /** seconds from NOW for the phase deadline (review deadline / cooling end / work deadline) */
  deadlineIn?: number;
  openIn?: number;
  owed?: { who: Address; amount: bigint }[];
  worker?: Address;
}

function mkView(o: MkOpts = {}): BountyView {
  const state = o.state ?? 'Open';
  const bounty: Bounty = {
    id: 1n,
    agent: AGENT,
    verifier: o.kind === 'self' ? AGENT : o.kind && o.kind !== 'eoa' ? OTHER : VERIFIER,
    claimAuthorizer: o.claimAuthorizer ?? ZERO_ADDRESS,
    worker: o.worker ?? WORKER,
    vault: '0x6666666666666666666666666666666666666666' as Address,
    reward: o.reward ?? 100n * USDC,
    deposit: o.deposit ?? 2n * USDC,
    workWindow: 86400,
    reviewWindow: 43200,
    openUntil: BigInt(NOW + (o.openIn ?? 86400)),
    deadline: BigInt(NOW + (o.deadlineIn ?? 43200)),
    extended: o.extended ?? false,
    rejectMode: o.rejectMode ?? 'Burn',
    state,
    stateCode: 0,
    evidenceHash: `0x${'ab'.repeat(32)}` as Hex,
    feeBps: o.feeBps ?? 500n,
  };
  return {
    chainId: 84532,
    bounty,
    specHash: `0x${'cd'.repeat(32)}` as Hex,
    postedTx: `0x${'ee'.repeat(32)}` as Hex,
    postedAt: NOW - 60,
    verifierKind: o.kind ?? 'eoa',
    vaultBalance: bounty.reward + bounty.deposit,
    title: 'Bounty',
    spec: { kind: 'offchain' },
    timeline: [],
    owed: o.owed,
  };
}

const ROLE_ADDR = { agent: AGENT, worker: WORKER, verifier: VERIFIER, stranger: STRANGER, none: undefined } as const;
type RoleName = keyof typeof ROLE_ADDR;

function actionsAt(view: BountyView, role: RoleName, now: number) {
  return availableActions(view, ROLE_ADDR[role] as Address | undefined, now);
}
const pick = (list: ReturnType<typeof availableActions>, id: ActionId) => list.find((a) => a.id === id);

/** now before / after the phase deadline (openUntil for Open, deadline otherwise). */
function timeFor(view: BountyView, after: boolean): number {
  const base = view.bounty.state === 'Open' ? Number(view.bounty.openUntil) : Number(view.bounty.deadline);
  return after ? base + 60 : base - 60;
}

interface Case {
  name: string;
  state: StateName;
  role: RoleName;
  after: boolean;
  kind?: VerifierKind;
  rejectMode?: RejectModeName;
  extra?: MkOpts;
  enabled?: Partial<Record<ActionId, boolean>>;
  primary?: ActionId | null;
}

const CASES: Case[] = [
  // ---- Open
  { name: 'Open agent before openUntil', state: 'Open', role: 'agent', after: false, enabled: { cancel: true, claim: false, refundExpired: false }, primary: 'cancel' },
  { name: 'Open agent after openUntil', state: 'Open', role: 'agent', after: true, enabled: { cancel: true, claim: false, refundExpired: true }, primary: 'cancel' },
  { name: 'Open worker before openUntil', state: 'Open', role: 'worker', after: false, enabled: { cancel: false, claim: true, refundExpired: false }, primary: 'claim' },
  { name: 'Open worker after openUntil', state: 'Open', role: 'worker', after: true, enabled: { claim: false, refundExpired: true }, primary: 'refundExpired' },
  { name: 'Open stranger before openUntil claims', state: 'Open', role: 'stranger', after: false, enabled: { claim: true, cancel: false }, primary: 'claim' },
  { name: 'Open stranger after openUntil refunds', state: 'Open', role: 'stranger', after: true, enabled: { claim: false, refundExpired: true }, primary: 'refundExpired' },
  { name: 'Open verifier may claim (only the agent is blocked)', state: 'Open', role: 'verifier', after: false, enabled: { claim: true }, primary: 'claim' },
  { name: 'Open without wallet can do nothing', state: 'Open', role: 'none', after: false, enabled: { claim: false, cancel: false, refundExpired: false }, primary: null },
  { name: 'Open with claimAuthorizer blocks claim for workers', state: 'Open', role: 'worker', after: false, extra: { claimAuthorizer: VERIFIER }, enabled: { claim: false, refundExpired: false }, primary: null },
  // ---- Claimed
  { name: 'Claimed worker before work deadline submits', state: 'Claimed', role: 'worker', after: false, enabled: { submit: true, reclaimAbandoned: false }, primary: 'submit' },
  { name: 'Claimed worker after work deadline cannot submit (anyone may reclaim)', state: 'Claimed', role: 'worker', after: true, enabled: { submit: false, reclaimAbandoned: true }, primary: null },
  { name: 'Claimed stranger before work deadline waits', state: 'Claimed', role: 'stranger', after: false, enabled: { submit: false, reclaimAbandoned: false }, primary: null },
  { name: 'Claimed stranger after work deadline reclaims', state: 'Claimed', role: 'stranger', after: true, enabled: { reclaimAbandoned: true }, primary: 'reclaimAbandoned' },
  { name: 'Claimed agent after work deadline reclaims', state: 'Claimed', role: 'agent', after: true, enabled: { reclaimAbandoned: true }, primary: 'reclaimAbandoned' },
  { name: 'Claimed without wallet shows disabled reclaim', state: 'Claimed', role: 'none', after: true, enabled: { reclaimAbandoned: true }, primary: null },
  // ---- Submitted (EOA verifier)
  { name: 'Submitted eoa verifier before deadline decides', state: 'Submitted', role: 'verifier', after: false, enabled: { accept: true, reject: true, payOnTimeout: false }, primary: 'accept' },
  { name: 'Submitted eoa verifier after deadline is too late', state: 'Submitted', role: 'verifier', after: true, enabled: { accept: false, reject: false, payOnTimeout: true }, primary: 'payOnTimeout' },
  { name: 'Submitted agent before deadline may extend', state: 'Submitted', role: 'agent', after: false, enabled: { accept: false, reject: false, extendReview: true, payOnTimeout: false }, primary: null },
  { name: 'Submitted agent after deadline pays worker', state: 'Submitted', role: 'agent', after: true, enabled: { extendReview: false, payOnTimeout: true }, primary: 'payOnTimeout' },
  { name: 'Submitted worker before deadline waits', state: 'Submitted', role: 'worker', after: false, enabled: { accept: false, payOnTimeout: false }, primary: null },
  { name: 'Submitted worker after deadline cannot press pay itself', state: 'Submitted', role: 'worker', after: true, enabled: { payOnTimeout: true }, primary: null },
  { name: 'Submitted stranger after deadline pays worker', state: 'Submitted', role: 'stranger', after: true, enabled: { payOnTimeout: true }, primary: 'payOnTimeout' },
  { name: 'Submitted already extended blocks a second extension', state: 'Submitted', role: 'agent', after: false, extra: { extended: true }, enabled: { extendReview: false }, primary: null },
  // ---- Submitted (adapters)
  { name: 'Submitted hashReveal worker reveals', state: 'Submitted', role: 'worker', after: false, kind: 'hashReveal', enabled: { hashReveal: true, accept: false, reject: false }, primary: 'hashReveal' },
  { name: 'Submitted hashReveal stranger cannot reveal', state: 'Submitted', role: 'stranger', after: false, kind: 'hashReveal', enabled: { hashReveal: false, accept: false }, primary: null },
  { name: 'Submitted onchainCheck worker can settle', state: 'Submitted', role: 'worker', after: false, kind: 'onchainCheck', enabled: { adapterResolve: true, accept: false, reject: false }, primary: 'adapterResolve' },
  { name: 'Submitted onchainCheck anyone can settle', state: 'Submitted', role: 'stranger', after: false, kind: 'onchainCheck', enabled: { adapterResolve: true, accept: false }, primary: null },
  { name: 'Submitted teeML worker relays proof', state: 'Submitted', role: 'worker', after: false, kind: 'teeML', enabled: { adapterResolve: true, accept: false }, primary: 'adapterResolve' },
  { name: 'Submitted multi needs signatures out of app', state: 'Submitted', role: 'verifier', after: false, kind: 'multi', enabled: { adapterResolve: false, accept: false, reject: false }, primary: null },
  { name: 'Submitted fallback needs signer signature', state: 'Submitted', role: 'agent', after: false, kind: 'fallback', enabled: { adapterResolve: false, accept: false }, primary: null },
  { name: 'Submitted contract verifier is opaque', state: 'Submitted', role: 'stranger', after: false, kind: 'contract', enabled: { adapterResolve: false }, primary: null },
  { name: 'Submitted self verifier is the agent', state: 'Submitted', role: 'agent', after: false, kind: 'self', enabled: { accept: true, reject: true }, primary: 'accept' },
  // ---- Rejected (cooling)
  { name: 'Rejected eoa verifier before cooling end reverses', state: 'Rejected', role: 'verifier', after: false, enabled: { reverse: true, finalizeReject: false }, primary: 'reverse' },
  { name: 'Rejected eoa verifier after cooling end cannot reverse', state: 'Rejected', role: 'verifier', after: true, enabled: { reverse: false, finalizeReject: true }, primary: 'finalizeReject' },
  { name: 'Rejected stranger before cooling end waits', state: 'Rejected', role: 'stranger', after: false, enabled: { reverse: false, finalizeReject: false }, primary: null },
  { name: 'Rejected stranger after cooling end finalizes', state: 'Rejected', role: 'stranger', after: true, enabled: { finalizeReject: true }, primary: 'finalizeReject' },
  { name: 'Rejected agent after cooling end finalizes REFUND', state: 'Rejected', role: 'agent', after: true, rejectMode: 'Refund', enabled: { finalizeReject: true, reverse: false }, primary: 'finalizeReject' },
  { name: 'Rejected adapter cannot be reversed by its address', state: 'Rejected', role: 'verifier', after: false, kind: 'hashReveal', enabled: { reverse: false, finalizeReject: false }, primary: null },
  { name: 'Rejected self verifier (agent) may reverse', state: 'Rejected', role: 'agent', after: false, kind: 'self', enabled: { reverse: true }, primary: 'reverse' },
  { name: 'Rejected without wallet shows disabled finalize', state: 'Rejected', role: 'none', after: true, enabled: { finalizeReject: true }, primary: null },
  // ---- terminal
  { name: 'Paid shows nothing', state: 'Paid', role: 'stranger', after: true, primary: null },
  { name: 'Burned shows nothing', state: 'Burned', role: 'worker', after: true, primary: null },
  { name: 'Refunded shows nothing', state: 'Refunded', role: 'agent', after: true, primary: null },
  { name: 'Cancelled shows nothing', state: 'Cancelled', role: 'agent', after: false, primary: null },
  { name: 'Missing bounty shows nothing', state: 'None', role: 'stranger', after: false, primary: null },
  // ---- extra contract corners
  { name: 'Submitted extended review keeps the timeout at bay', state: 'Submitted', role: 'stranger', after: false, extra: { extended: true, deadlineIn: 6 * 3600 }, enabled: { payOnTimeout: false }, primary: null },
  { name: 'Rejected REFUND agent waits out cooling before finalizing', state: 'Rejected', role: 'agent', after: false, rejectMode: 'Refund', enabled: { finalizeReject: false, reverse: false }, primary: null },
  { name: 'Claimed worker still owes a submission right at the deadline', state: 'Claimed', role: 'worker', after: false, extra: { deadlineIn: 1 }, enabled: { submit: true }, primary: 'submit' },
  { name: 'Open cancel is available even after openUntil (state is still Open)', state: 'Open', role: 'agent', after: true, enabled: { cancel: true }, primary: 'cancel' },
  { name: 'Rejected adapter verifier after cooling finalizes like anyone', state: 'Rejected', role: 'verifier', after: true, kind: 'multi', enabled: { finalizeReject: true, reverse: false }, primary: 'finalizeReject' },
];

for (const c of CASES) {
  test(`actions: ${c.name}`, () => {
    const view = mkView({ state: c.state, kind: c.kind, rejectMode: c.rejectMode, ...c.extra });
    const now = timeFor(view, c.after);
    const me = c.role === 'verifier' ? view.bounty.verifier : (ROLE_ADDR[c.role] as Address | undefined);
    const list = availableActions(view, me, now);
    const where = `${c.name} [${c.state}/${c.role}/${c.kind ?? 'eoa'}/${c.after ? 'after' : 'before'}]`;

    for (const [id, expected] of Object.entries(c.enabled ?? {})) {
      const a = pick(list, id as ActionId);
      assert.ok(a, `${where}: missing action ${id}`);
      assert.equal(a!.enabled, expected, `${where}: ${id}.enabled — why: ${a!.why}`);
    }
    const primaries = list.filter((a) => a.primary);
    assert.ok(primaries.length <= 1, `${where}: more than one primary (${primaries.map((p) => p.id).join(',')})`);
    if (c.primary === null) assert.equal(primaries.length, 0, `${where}: expected no primary, got ${primaries[0]?.id}`);
    else assert.equal(primaries[0]?.id, c.primary, `${where}: expected primary ${c.primary}, got ${primaries[0]?.id}`);

    for (const a of list) {
      assert.ok(a.label.length > 2, `${where}: ${a.id} label too short`);
      assert.ok(a.why.length > 10, `${where}: ${a.id} needs a why line`);
      assert.ok(['none', 'caution', 'destructive'].includes(a.danger), `${where}: ${a.id} danger`);
      assert.ok(['agent', 'worker', 'verifier', 'anyone'].includes(a.role), `${where}: ${a.id} role`);
    }
  });
}

test('disabled actions explain when they open, with a relative time', () => {
  const open = mkView({ state: 'Open', openIn: 3 * 3600 + 12 * 60 });
  const refund = pick(availableActions(open, STRANGER, NOW), 'refundExpired')!;
  assert.equal(refund.enabled, false);
  assert.match(refund.why, /in 3h 12m/);
  assert.equal(refund.availableAt, Number(open.bounty.openUntil) + 1);

  const submitted = mkView({ state: 'Submitted', deadlineIn: 7200 });
  const pay = pick(availableActions(submitted, STRANGER, NOW), 'payOnTimeout')!;
  assert.equal(pay.enabled, false);
  assert.match(pay.why, /in 2h/);
});

test('claimAuthorizer bounties say a signature is needed', () => {
  const v = mkView({ state: 'Open', claimAuthorizer: VERIFIER });
  const claim = pick(availableActions(v, WORKER, NOW), 'claim')!;
  assert.equal(claim.enabled, false);
  assert.match(claim.why, /signed authorization/i);
});

test('expired claim window explains the closed window', () => {
  const v = mkView({ state: 'Open', openIn: -60 });
  const claim = pick(availableActions(v, STRANGER, NOW), 'claim')!;
  assert.equal(claim.enabled, false);
  assert.match(claim.why, /closed/);
});

test('accept money splits reward−fee and deposit exactly like _accept', () => {
  const b = mkView({ state: 'Submitted' }).bounty;
  const m = acceptMoney(b);
  assert.equal(m[0]!.amount, 97n * USDC);
  assert.equal(m[1]!.amount, 5n * USDC);

  const sub = availableActions(mkView({ state: 'Submitted' }), VERIFIER, NOW);
  const accept = pick(sub, 'accept')!;
  assert.deepEqual(accept.money, m);

  const latePay = pick(availableActions(mkView({ state: 'Submitted', deadlineIn: -10 }), STRANGER, NOW), 'payOnTimeout')!;
  assert.deepEqual(latePay.money, m, 'payOnTimeout pays the same as accept');
});

test('fee rounds down like Solidity integer division', () => {
  // 1_000_003 * 500 / 10_000 = 50000.15 → 50_000 base units
  const b = mkView({ state: 'Submitted', reward: 1_000_003n, deposit: 1_000_000n, feeBps: 500n }).bounty;
  const m = acceptMoney(b);
  assert.equal(m[1]!.amount, 50_000n);
  assert.equal(m[0]!.amount, 1_000_003n - 50_000n + 1_000_000n);
  // 0% fee (treasury lowered it) leaves the reward whole
  const zero = acceptMoney(mkView({ state: 'Submitted', feeBps: 0n }).bounty);
  assert.equal(zero[1]!.amount, 0n);
  assert.equal(zero[0]!.amount, 102n * USDC);
});

test('reject money differs by reject mode exactly as finalizeReject', () => {
  const burn = rejectMoney(mkView({ state: 'Rejected', rejectMode: 'Burn' }).bounty);
  assert.equal(burn.length, 1);
  assert.equal(burn[0]!.amount, 102n * USDC);
  assert.equal(burn[0]!.to, 'burn');

  const refund = rejectMoney(mkView({ state: 'Rejected', rejectMode: 'Refund' }).bounty);
  assert.deepEqual(refund.map((x) => [x.amount, x.to]), [[100n * USDC, 'agent'], [2n * USDC, 'burn']]);

  const fin = pick(availableActions(mkView({ state: 'Rejected', rejectMode: 'Refund', deadlineIn: -1 }), STRANGER, NOW), 'finalizeReject')!;
  assert.match(fin.label, /refund the poster/i);
  assert.deepEqual(fin.money, refund);
  assert.match(fin.why, /burned/);
});

test('withdraw appears only when the connected address is owed money', () => {
  const owed = [{ who: STRANGER, amount: 7n * USDC }];
  const v = mkView({ state: 'Paid', owed });
  const mine = pick(availableActions(v, STRANGER, NOW), 'withdraw')!;
  assert.equal(mine.enabled, true);
  assert.equal(mine.primary, true, 'in a terminal state withdraw is the only thing to do');
  assert.deepEqual(mine.money, [{ label: 'Paid to you', amount: 7n * USDC, to: 'you' }]);
  assert.equal(pick(availableActions(v, WORKER, NOW), 'withdraw'), undefined, 'someone else’s owed balance is not shown');

  // in a live state withdraw never steals the primary slot
  const live = mkView({ state: 'Open', owed });
  const w = pick(availableActions(live, STRANGER, NOW), 'withdraw')!;
  assert.equal(w.enabled, true);
  assert.equal(w.primary, false);
});

test('zero-value bounties never produce negative money', () => {
  const b = mkView({ state: 'Submitted', reward: 0n, deposit: 0n, feeBps: 500n }).bounty;
  const m = acceptMoney(b);
  assert.equal(m[0]!.amount, 0n);
  assert.equal(m[1]!.amount, 0n);
  assert.equal(rejectMoney(b)[0]!.amount, 0n);
  const max = mkView({ state: 'Submitted', reward: 1_000_000_000n, deposit: 1_000_000_000n, feeBps: 500n }).bounty;
  assert.equal(acceptMoney(max)[0]!.amount, 1_950_000_000n);
  assert.equal(acceptMoney(max)[1]!.amount, 50_000_000n);
});

test('permissionless actions mention the wallet when nobody is connected', () => {
  const cases: [Parameters<typeof mkView>[0], ActionId][] = [
    [{ state: 'Open', openIn: -60 }, 'refundExpired'],
    [{ state: 'Claimed', deadlineIn: -60 }, 'reclaimAbandoned'],
    [{ state: 'Submitted', deadlineIn: -60 }, 'payOnTimeout'],
    [{ state: 'Rejected', deadlineIn: -60 }, 'finalizeReject'],
  ];
  for (const [opts, id] of cases) {
    const view = mkView(opts);
    const anon = pick(availableActions(view, undefined, NOW), id)!;
    assert.equal(anon.enabled, true, `${id} is available on-chain`);
    assert.match(anon.why, /Connect a wallet/, `${id} should ask for a wallet`);
    const connected = pick(availableActions(view, STRANGER, NOW), id)!;
    assert.doesNotMatch(connected.why, /Connect a wallet/, `${id} should not nag a connected user`);
  }
});

test('nextStep explains each state in plain words', () => {
  const open = nextStep(mkView({ state: 'Open', openIn: 86400 }), NOW);
  assert.equal(open.headline, 'Waiting for a worker to claim');
  assert.match(open.detail, /2\.00 USDC deposit/);
  assert.match(open.detail, /Claims close/);
  assert.equal(open.deadline, NOW + 86400);

  const expired = nextStep(mkView({ state: 'Open', openIn: -60 }), NOW);
  assert.equal(expired.headline, 'Claim window closed');
  assert.match(expired.detail, /100\.00 USDC/);

  const claimed = nextStep(mkView({ state: 'Claimed', deadlineIn: 7200 }), NOW);
  assert.equal(claimed.headline, 'Worker is doing the work');
  assert.match(claimed.detail, /in 2h/);

  const missed = nextStep(mkView({ state: 'Claimed', deadlineIn: -60 }), NOW);
  assert.equal(missed.headline, 'Work window missed');
  assert.match(missed.detail, /2\.00 USDC/);

  const review = nextStep(mkView({ state: 'Submitted', deadlineIn: 3600 }), NOW);
  assert.equal(review.headline, 'Waiting for the verifier');
  assert.match(review.detail, /in 1h/);
  assert.match(review.detail, /97\.00 USDC/);
  assert.match(review.detail, /5\.00 USDC/);

  const ready = nextStep(mkView({ state: 'Submitted', deadlineIn: -1 }), NOW);
  assert.equal(ready.headline, 'Ready to pay the worker');
  assert.match(ready.detail, /97\.00 USDC/);

  const cooling = nextStep(mkView({ state: 'Rejected', deadlineIn: 3600 }), NOW);
  assert.match(cooling.headline, /24h to undo/);
  assert.match(cooling.detail, /burn/);

  const finalBurn = nextStep(mkView({ state: 'Rejected', deadlineIn: -1 }), NOW);
  assert.equal(finalBurn.headline, 'Reject is final');
  assert.match(finalBurn.detail, /102\.00 USDC/);

  const finalRefund = nextStep(mkView({ state: 'Rejected', rejectMode: 'Refund', deadlineIn: -1 }), NOW);
  assert.match(finalRefund.detail, /100\.00 USDC/);
  assert.match(finalRefund.detail, /2\.00 USDC/);

  const paid = nextStep(mkView({ state: 'Paid' }), NOW);
  assert.equal(paid.headline, 'Paid');
  assert.match(paid.detail, /97\.00 USDC/);

  for (const [state, headline] of [['Burned', 'Burned'], ['Refunded', 'Refunded'], ['Cancelled', 'Cancelled'], ['None', 'Bounty not found']] as const) {
    const s = nextStep(mkView({ state }), NOW);
    assert.equal(s.headline, headline);
    assert.ok(s.detail.length > 10);
  }
});
