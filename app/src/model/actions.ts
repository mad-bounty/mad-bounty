// PURE: which actions each role may take in each bounty state, mirroring src/MADBountyCore.sol exactly.
// No network, no DOM, no Date.now: callers pass `now` (unix seconds).
import { acceptPayout, ZERO_ADDRESS, type Bounty } from '@madbounty/sdk';
import type { Address } from 'viem';
import type { ActionOption, BountyView, NextStep, VerifierKind } from '../types';
import { duration, relTime, shortAddr, usdc, utc, verifierKindLabel } from './format';

export type Money = NonNullable<ActionOption['money']>;

const same = (a?: string, b?: string): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const ADAPTER_KINDS: readonly VerifierKind[] = ['onchainCheck', 'hashReveal', 'teeML', 'multi', 'fallback', 'contract'];
/** True when the verifier is a contract (adapter), so accept/reject cannot be pressed from a wallet. */
export const isAdapterKind = (k: VerifierKind): boolean => ADAPTER_KINDS.includes(k);
const TERMINAL = ['Paid', 'Burned', 'Refunded', 'Cancelled'];

interface Ctx {
  v: BountyView;
  b: Bounty;
  me?: Address;
  now: number;
  isAgent: boolean;
  isWorker: boolean;
  isVerifier: boolean;
  deadline: number;
  openUntil: number;
}

function act(o: Partial<ActionOption> & Pick<ActionOption, 'id' | 'label' | 'role' | 'enabled' | 'why'>): ActionOption {
  return { danger: 'none', ...o };
}

/** Money moved when the bounty is accepted (verdict, reverse, or silence timeout). Fee rounds down like Solidity. */
export function acceptMoney(b: Bounty): Money {
  const { toWorker, fee } = acceptPayout(b.reward, b.deposit, b.feeBps);
  return [
    { label: 'Worker receives (reward − fee + deposit)', amount: toWorker, to: 'worker' },
    { label: 'Fee to treasury', amount: fee, to: 'treasury' },
  ];
}

/** Money moved when a reject becomes final (after the 24h cooling window). */
export function rejectMoney(b: Bounty): Money {
  if (b.rejectMode === 'Refund') {
    return [
      { label: 'Reward returned to the poster', amount: b.reward, to: 'agent' },
      { label: 'Worker deposit burned', amount: b.deposit, to: 'burn' },
    ];
  }
  return [{ label: 'Reward + worker deposit burned', amount: b.reward + b.deposit, to: 'burn' }];
}

// ------------------------------------------------------------------ Open
function openActions(c: Ctx): ActionOption[] {
  const { b, me, now } = c;
  const out: ActionOption[] = [];
  const expired = now > c.openUntil;

  out.push(act({
    id: 'cancel', label: 'Cancel & get reward back', role: 'agent', enabled: c.isAgent, danger: 'caution', primary: c.isAgent,
    why: c.isAgent ? 'You can cancel any time while nobody has claimed it.' : 'Only the poster can cancel.',
    money: [{ label: 'Reward returned to the poster', amount: b.reward, to: 'agent' }],
  }));

  let canClaim = false;
  let claimWhy: string;
  if (expired) claimWhy = `The claim window closed ${relTime(c.openUntil, now)}.`;
  else if (!same(b.claimAuthorizer, ZERO_ADDRESS)) claimWhy = `Claims need a signed authorization from ${shortAddr(b.claimAuthorizer)}. Ask them for one; this app cannot create it.`;
  else if (!me) claimWhy = 'Connect a wallet to claim.';
  else if (c.isAgent) claimWhy = 'You posted this bounty, so you cannot claim it.';
  else {
    canClaim = true;
    claimWhy = `Lock a ${usdc(b.deposit)} deposit and start. Open until ${utc(c.openUntil)} (${relTime(c.openUntil, now)}).`;
  }
  out.push(act({
    id: 'claim', label: 'Claim this bounty', role: 'worker', enabled: canClaim, danger: 'caution', primary: canClaim, why: claimWhy,
    money: [{ label: 'You lock as deposit (returned on accept)', amount: b.deposit, to: 'escrow' }],
  }));

  out.push(act({
    id: 'refundExpired', label: 'Return reward to the poster', role: 'anyone', enabled: expired, availableAt: c.openUntil + 1,
    primary: expired && !!me && !c.isAgent,
    why: expired ? 'Nobody claimed it in time, so anyone may return the reward to the poster.' : `Available ${relTime(c.openUntil + 1, now)}, once the open window ends.`,
    money: [{ label: 'Reward returned to the poster', amount: b.reward, to: 'agent' }],
  }));
  return out;
}

// --------------------------------------------------------------- Claimed
function claimedActions(c: Ctx): ActionOption[] {
  const { b, now } = c;
  const out: ActionOption[] = [];
  const canSubmit = c.isWorker && now <= c.deadline;
  out.push(act({
    id: 'submit', label: 'Submit work', role: 'worker', enabled: canSubmit, primary: canSubmit,
    why: !c.isWorker ? `Only the worker ${shortAddr(b.worker)} can submit.`
      : now <= c.deadline ? `Submit your evidence hash before ${utc(c.deadline)} (${relTime(c.deadline, now)}).`
      : `The work window ended ${relTime(c.deadline, now)}.`,
  }));
  const late = now > c.deadline;
  out.push(act({
    id: 'reclaimAbandoned', label: 'Reopen abandoned bounty', role: 'anyone', enabled: late, danger: 'caution',
    availableAt: c.deadline + 1, primary: late && !!c.me && !c.isWorker,
    why: late ? 'The worker missed the work window: their deposit burns and the bounty reopens for others.' : `Available ${relTime(c.deadline + 1, now)}, if the worker has not submitted.`,
    money: [{ label: 'Worker deposit burned', amount: b.deposit, to: 'burn' }],
  }));
  return out;
}

// ------------------------------------------------------------- Submitted
/** Guidance for adapter verifiers: they settle from their own rule, not from a wallet signature. */
function adapterGuidance(c: Ctx): ActionOption | undefined {
  const { v, b } = c;
  const kind = v.verifierKind;
  const adapterWhy = `The verifier is a contract (${verifierKindLabel(kind)}), so accept/reject come from its rule, not from a wallet.`;
  if (kind === 'hashReveal') {
    return act({
      id: 'hashReveal', label: 'Reveal the committed answer', role: 'worker', enabled: c.isWorker, primary: c.isWorker,
      why: c.isWorker
        ? `Reveal the answer you committed to: the contract accepts and pays you. Anyone may reject once the reveal window has passed. ${adapterWhy}`
        : `Only the worker ${shortAddr(b.worker)} can reveal the committed answer. If it does not happen inside the reveal window, anyone may reject.`,
    });
  }
  if (kind === 'onchainCheck') {
    return act({
      id: 'adapterResolve', label: 'Settle the on-chain check', role: 'anyone', enabled: !!c.me, primary: c.isWorker,
      why: c.isWorker
        ? 'Do the on-chain work the check looks for (e.g. call the target). Then anyone, you included, can settle: the check passes → you are paid; still failing after the check window → anyone may reject.'
        : 'Anyone may settle once the configured check passes. If it still fails after the check window, anyone may reject instead.',
    });
  }
  if (kind === 'teeML') {
    return act({
      id: 'adapterResolve', label: 'Relay the TeeML verdict', role: 'anyone', enabled: !!c.me, primary: c.isWorker,
      why: c.isWorker
        ? 'Ask the pinned 0G enclave with the agent\'s template and relay the signed VERDICT before the proof window closes. No valid proof in time → anyone can reject and you lose your deposit.'
        : 'Anyone may relay a valid enclave verdict (VERDICT:Y pays the worker, VERDICT:N rejects). If no proof arrives inside the proof window, anyone may reject.',
    });
  }
  if (kind === 'multi') {
    return act({
      id: 'adapterResolve', label: 'Panel of signers decides', role: 'anyone', enabled: false,
      why: 'A multi-sig panel must sign the verdict (m of n) and relay it. That needs the signers\' signatures, so it cannot be done from this page.',
    });
  }
  if (kind === 'fallback') {
    return act({
      id: 'adapterResolve', label: 'Fallback signer decides', role: 'anyone', enabled: false,
      why: 'A ladder of fallback signers decides in turn (primary first, then backups after each step timeout). The next signer may resolve now; earlier signers stay valid. Relaying needs their signature, so it happens outside this page.',
    });
  }
  return act({
    id: 'adapterResolve', label: 'Contract verifier decides', role: 'anyone', enabled: false,
    why: 'This bounty uses a contract verifier, so the verdict comes from its own rule, not from this page.',
  });
}

function submittedActions(c: Ctx): ActionOption[] {
  const { b, now, v } = c;
  const out: ActionOption[] = [];
  const adapter = isAdapterKind(v.verifierKind);
  const late = now > c.deadline; // core.settle reverts TooLate past the review deadline
  const guidance = adapter ? adapterGuidance(c) : undefined;

  let acceptWhy: string;
  let rejectWhy: string;
  if (guidance) {
    acceptWhy = rejectWhy = guidance.why;
  } else if (!c.isVerifier) {
    acceptWhy = rejectWhy = `Only the verifier ${shortAddr(b.verifier)} can decide.`;
  } else if (late) {
    acceptWhy = rejectWhy = `The review window closed ${relTime(c.deadline, now)}, so the worker can be paid automatically now. A late verdict reverts.`;
  } else {
    acceptWhy = `Decide before ${utc(c.deadline)} (${relTime(c.deadline, now)}). If you stay silent the worker is paid automatically.`;
    rejectWhy = b.rejectMode === 'Refund'
      ? 'A reject starts a 24h cooling window; after it, the reward returns to the poster and the worker\'s deposit is burned.'
      : 'A reject starts a 24h cooling window; after it, the reward and the worker\'s deposit are both burned.';
  }
  const canVerdict = c.isVerifier && !adapter && !late;
  out.push(act({
    id: 'accept', label: 'Accept work & pay the worker', role: 'verifier', enabled: canVerdict, primary: canVerdict,
    why: acceptWhy, money: acceptMoney(b),
  }));
  out.push(act({
    id: 'reject', label: 'Reject work', role: 'verifier', enabled: canVerdict, danger: 'destructive', why: rejectWhy,
    money: rejectMoney(b).map((m) => ({ ...m, label: 'If it stands — ' + m.label })),
  }));
  if (guidance) out.push(guidance);
  const canExtend = (c.isAgent || c.isVerifier) && !b.extended && now <= c.deadline;
  out.push(act({
    id: 'extendReview', label: 'Extend the review window', role: 'agent', enabled: canExtend, danger: 'caution',
    why: b.extended ? 'Review was already extended once; it cannot happen twice.'
      : now > c.deadline ? 'The review window is already over.'
        : `Poster or verifier may add ${duration(b.reviewWindow)} to the review deadline, once only.`,
  }));

  out.push(act({
    id: 'payOnTimeout', label: 'Pay the worker (verifier was silent)', role: 'anyone', enabled: late,
    availableAt: c.deadline + 1, primary: late && !!c.me && !c.isWorker,
    why: late ? 'The review window passed with no verdict, so anyone may pay the worker.'
      : `Available ${relTime(c.deadline + 1, now)}, if the verifier has not decided.`,
    money: acceptMoney(b),
  }));
  return out;
}

// -------------------------------------------------------------- Rejected
function rejectedActions(c: Ctx): ActionOption[] {
  const { b, now, v } = c;
  const out: ActionOption[] = [];
  const adapter = isAdapterKind(v.verifierKind);
  const late = now > c.deadline; // deadline = end of the 24h cooling window
  const canReverse = c.isVerifier && !adapter && !late;
  out.push(act({
    id: 'reverse', label: 'Undo the reject & pay the worker', role: 'verifier', enabled: canReverse, danger: 'caution',
    primary: canReverse,
    why: adapter ? `Only the ${verifierKindLabel(v.verifierKind)} contract can undo its own reject, and only through its own rule.`
      : !c.isVerifier ? `Only the verifier ${shortAddr(b.verifier)} can undo its own reject.`
        : late ? `The 24h cooling window ended ${relTime(c.deadline, now)}; the reject can no longer be undone.`
          : `Undo your reject and pay the worker. You have until ${utc(c.deadline)} (${relTime(c.deadline, now)}).`,
    money: acceptMoney(b),
  }));
  out.push(act({
    id: 'finalizeReject', label: b.rejectMode === 'Refund' ? 'Make the reject final (refund the poster)' : 'Make the reject final (burn the escrow)',
    role: 'anyone', enabled: late, availableAt: c.deadline + 1, primary: late && !!c.me,
    danger: 'caution',
    why: late ? (b.rejectMode === 'Refund'
      ? 'Cooling is over: the reward returns to the poster and the worker\'s deposit is burned.'
      : 'Cooling is over: the reward and the worker\'s deposit are burned.')
      : `Available ${relTime(c.deadline + 1, now)}, when the 24h cooling window ends.`,
    money: rejectMoney(b),
  }));
  return out;
}

// ---------------------------------------------------------------- public
export function availableActions(view: BountyView, me: Address | undefined, now: number): ActionOption[] {
  const b = view.bounty;
  const c: Ctx = {
    v: view, b, me, now,
    isAgent: same(me, b.agent), isWorker: same(me, b.worker), isVerifier: same(me, b.verifier),
    deadline: Number(b.deadline), openUntil: Number(b.openUntil),
  };
  let out: ActionOption[];
  switch (b.state) {
    case 'Open': out = openActions(c); break;
    case 'Claimed': out = claimedActions(c); break;
    case 'Submitted': out = submittedActions(c); break;
    case 'Rejected': out = rejectedActions(c); break;
    default: out = [];
  }
  const owed = me ? view.owed?.find((o) => same(o.who, me))?.amount ?? 0n : 0n;
  if (owed > 0n) {
    out.push(act({
      id: 'withdraw', label: 'Withdraw what you are owed', role: 'anyone', enabled: true,
      primary: TERMINAL.includes(b.state) && !out.some((o) => o.primary),
      why: 'A payment to you could not be delivered earlier. You can pull it from the vault now.',
      money: [{ label: 'Paid to you', amount: owed, to: 'you' }],
    }));
  }
  // enabled means "the contract allows this now"; without a wallet the UI still needs a connect step.
  if (!me) {
    for (const a of out) if (a.role === 'anyone') a.why = `${a.why} Connect a wallet to send it.`;
  }
  return out;
}

// -------------------------------------------------------------- next step
/** One-line headline + detail for the timeline header. Pure: `now` is passed in. */
export function nextStep(view: BountyView, now: number): NextStep {
  const b = view.bounty;
  const openUntil = Number(b.openUntil);
  const deadline = Number(b.deadline);
  const at = (t: number) => `${utc(t)} (${relTime(t, now)})`;
  const { toWorker, fee } = acceptPayout(b.reward, b.deposit, b.feeBps);
  const refund = b.rejectMode === 'Refund';

  switch (b.state) {
    case 'Open':
      if (now > openUntil)
        return {
          headline: 'Claim window closed',
          detail: `Nobody claimed it. Anyone can return the ${usdc(b.reward)} reward to the poster now.`,
          deadline: openUntil,
        };
      return {
        headline: 'Waiting for a worker to claim',
        detail: `A worker must lock a ${usdc(b.deposit)} deposit. Claims close ${at(openUntil)}.`,
        deadline: openUntil,
      };
    case 'Claimed':
      if (now > deadline)
        return {
          headline: 'Work window missed',
          detail: `The worker did not submit in time. Anyone can reopen the bounty and their ${usdc(b.deposit)} deposit is burned.`,
          deadline,
        };
      return {
        headline: 'Worker is doing the work',
        detail: `They must submit by ${at(deadline)}. After that their ${usdc(b.deposit)} deposit can be burned and the bounty reopened.`,
        deadline,
      };
    case 'Submitted':
      if (now > deadline)
        return {
          headline: 'Ready to pay the worker',
          detail: `The verifier stayed silent past ${utc(deadline)}, so anyone can pay the worker ${usdc(toWorker)} now.`,
          deadline,
        };
      return {
        headline: 'Waiting for the verifier',
        detail: `If they stay silent until ${at(deadline)} the worker can be paid automatically: ${usdc(toWorker)} (fee ${usdc(fee)}).`,
        deadline,
      };
    case 'Rejected':
      if (now > deadline)
        return {
          headline: 'Reject is final',
          detail: refund
            ? `Cooling ended ${utc(deadline)}. Anyone can now return the ${usdc(b.reward)} reward to the poster and burn the ${usdc(b.deposit)} deposit.`
            : `Cooling ended ${utc(deadline)}. Anyone can now burn the ${usdc(b.reward + b.deposit)} escrow: nobody gets it back.`,
          deadline,
        };
      return {
        headline: 'Rejected — 24h to undo it',
        detail: `The verifier can still pay the worker until ${at(deadline)}. After that ${refund ? 'the poster gets the reward back and the deposit burns' : 'the reward and deposit burn'}.`,
        deadline,
      };
    case 'Paid':
      return { headline: 'Paid', detail: `The worker got ${usdc(toWorker)} and ${usdc(fee)} went to the treasury.` };
    case 'Burned':
      return { headline: 'Burned', detail: 'The reject became final: the reward and the deposit were burned. Nothing to claim.' };
    case 'Refunded':
      return { headline: 'Refunded', detail: 'The reject became final: the poster got the reward back and the worker\'s deposit was burned.' };
    case 'Cancelled':
      return { headline: 'Cancelled', detail: 'The poster cancelled, or the claim window expired. The reward went back to the poster.' };
    default:
      return { headline: 'Bounty not found', detail: 'No bounty with this id exists on this chain.' };
  }
}
