// MONEY, one row per outcome. Shared by the bounty page table, the confirm sheet and the post wizard,
// so a number a poster sees before posting is the number a worker sees after.
//
// Convention: every amount is the party's NET change in USDC over the whole bounty, from money they
// own (deposit and reward both leave a wallet when they go into escrow). Gross figures — what actually
// lands in a wallet — are carried separately as `in`/`out` so the UI can show them as secondary text.
import type { Bounty } from '@madbounty/sdk';

/** Basis-point fee, rounded down — same as Solidity's `amount - amount * bps / 10_000`. */
export function feeOf(amount: bigint, feeBps: bigint): bigint {
  return feeBps <= 0n ? 0n : amount * feeBps / 10_000n;
}

export interface MoneyView {
  reward: bigint;
  deposit: bigint;
  feeBps: bigint;
  rejectMode: 'Burn' | 'Refund';
}

/** Build a view from the on-chain struct used by the app. */
export function moneyView(b: Pick<Bounty, 'reward' | 'deposit' | 'feeBps' | 'rejectMode'>): MoneyView {
  return { reward: b.reward, deposit: b.deposit, feeBps: b.feeBps, rejectMode: b.rejectMode as MoneyView['rejectMode'] };
}

export interface RowAmount {
  /** net change for this party; sign is authoritative (negative = they end with less than they started) */
  net: bigint;
  /** what lands back in or leaves their wallet, for the secondary line. Omit when there is no movement. */
  wallet?: { dir: 'in' | 'out'; amount: bigint; of?: bigint };
  /** short label under the number */
  note: string;
}

export interface MoneyRow {
  id: 'accept' | 'reject' | 'timeout' | 'abandon';
  label: string;
  hint: string;
  worker: RowAmount | null;   // null = worker had nothing in this outcome (never claimed)
  poster: RowAmount;
  /** goes to the treasury on this path (footnote) */
  treasury: bigint;
  /** burned on this path (footnote) */
  burned: bigint;
}

const z = (note: string): RowAmount => ({ net: 0n, note });

/**
 * Every way a bounty can end, with each party's net change. Identity that always holds:
 * poster.net + worker.net + treasury + burned === 0 for the two money-moving paths.
 */
export function moneyRows(v: MoneyView): MoneyRow[] {
  const { reward, deposit, feeBps } = v;
  const fee = feeOf(reward, feeBps);
  const payout = reward - fee;                 // reaches the worker before their own deposit returns
  const refund = v.rejectMode === 'Refund';
  const rows: MoneyRow[] = [
    {
      id: 'accept', label: 'Work accepted',
      hint: fee > 0n
        ? `The worker is paid the reward minus the ${pct(feeBps)}% fee, plus their deposit back. The fee goes to the treasury.`
        : 'The worker is paid the whole reward, plus their deposit back.',
      worker: {
        net: payout, note: 'gets paid',
        wallet: { dir: 'in', amount: payout + deposit, of: deposit },
      },
      poster: {
        net: -reward, note: 'reward paid out',
        wallet: { dir: 'out', amount: reward },
      },
      treasury: fee, burned: 0n,
    },
    {
      id: 'reject', label: 'Work rejected',
      hint: refund
        ? 'After a 24h cooling-off period the reward goes back to the poster and the deposit burns.'
        : 'After a 24h cooling-off period the reward and the deposit both burn.',
      worker: {
        net: -deposit, note: 'loses deposit',
        wallet: { dir: 'out', amount: deposit },
      },
      poster: refund
        ? { net: 0n, note: 'refunded' }
        : { net: -reward, note: 'burned' },
      treasury: 0n, burned: refund ? deposit : reward + deposit,
    },
    {
      id: 'timeout', label: 'Verifier silent',
      hint: 'If nobody gives a verdict before the review deadline, the worker is paid automatically — same split as an accept.',
      worker: {
        net: payout, note: 'gets paid',
        wallet: { dir: 'in', amount: payout + deposit, of: deposit },
      },
      poster: {
        net: -reward, note: 'reward paid out',
        wallet: { dir: 'out', amount: reward },
      },
      treasury: fee, burned: 0n,
    },
    {
      id: 'abandon', label: 'Worker abandons',
      hint: 'No work arrives in the work window: the deposit burns and the bounty reopens. The reward is not touched.',
      worker: {
        net: -deposit, note: 'loses deposit',
        wallet: { dir: 'out', amount: deposit },
      },
      poster: z('reopens'),
      treasury: 0n, burned: deposit,
    },
  ];
  return rows;
}

/** Fee as a percent string: 500n → '5', 250n → '2.5', 1n → '0.01'. */
export function pct(bps: bigint): string {
  const whole = bps / 100n;
  const frac = (bps % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** '5% of reward' */
export function feeLabel(bps: bigint): string {
  return `${pct(bps)}% of reward`;
}
