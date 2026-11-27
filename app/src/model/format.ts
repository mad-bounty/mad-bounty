// Pure formatting helpers (no Date.now, no network, no DOM).
import type { StateName } from '@madbounty/sdk';
import type { VerifierKind } from '../types';

export type Tone = 'neutral' | 'info' | 'good' | 'warn' | 'bad';

const ONE = 1_000_000n;

/** '12.50' (at least 2 decimals, up to 6 when the amount needs them; never rounds). */
export function usdcShort(units: bigint): string {
  const neg = units < 0n;
  const u = neg ? -units : units;
  let frac = (u % ONE).toString().padStart(6, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return (neg ? '-' : '') + (u / ONE).toString() + '.' + frac;
}

/** '12.50 USDC' */
export function usdc(units: bigint): string {
  return usdcShort(units) + ' USDC';
}

/** '0x1234…abcd' */
export function shortAddr(a: string): string {
  return a.length <= 12 ? a : a.slice(0, 6) + '…' + a.slice(-4);
}

/** Seconds → '2d 3h' / '3h 12m' / '12m 5s' / '45s'. Negative values clamp to 0. */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
  return `${sec}s`;
}

/** 'in 3h 12m' / '2d ago' / 'now'. Both arguments are unix seconds. */
export function relTime(target: number, now: number): string {
  const diff = target - now;
  if (diff === 0) return 'now';
  return diff > 0 ? `in ${duration(diff)}` : `${duration(-diff)} ago`;
}

/** '2026-11-27 14:00 UTC' */
export function utc(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

const KIND_LABELS: Record<VerifierKind, string> = {
  self: 'Poster reviews it (self)',
  eoa: 'Single reviewer (address)',
  onchainCheck: 'On-chain check',
  hashReveal: 'Hash reveal',
  teeML: 'TeeML (0G)',
  multi: 'Multi-sig panel',
  fallback: 'Fallback ladder',
  contract: 'Smart-contract verifier',
};

export function verifierKindLabel(kind: VerifierKind): string {
  return KIND_LABELS[kind] ?? kind;
}

const STATE_LABELS: Record<StateName, string> = {
  None: 'Not found',
  Open: 'Open',
  Claimed: 'In progress',
  Submitted: 'In review',
  Rejected: 'Rejected (cooling)',
  Paid: 'Paid',
  Burned: 'Burned',
  Refunded: 'Refunded',
  Cancelled: 'Cancelled',
};

const STATE_TONES: Record<StateName, Tone> = {
  None: 'neutral',
  Open: 'info',
  Claimed: 'info',
  Submitted: 'warn',
  Rejected: 'bad',
  Paid: 'good',
  Burned: 'bad',
  Refunded: 'neutral',
  Cancelled: 'neutral',
};

export function stateLabel(state: StateName): string {
  return STATE_LABELS[state] ?? state;
}

export function stateTone(state: StateName): Tone {
  return STATE_TONES[state] ?? 'neutral';
}
