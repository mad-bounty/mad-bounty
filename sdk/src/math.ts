import { CONSTANTS } from './types.js';

/** Mirror of MADBountyCore.minDeposit: max(1 USDC, 2% of reward). */
export function minDepositFor(reward: bigint): bigint {
  const pct = (reward * CONSTANTS.MIN_DEPOSIT_BPS) / 10_000n;
  return pct > CONSTANTS.MIN_DEPOSIT ? pct : CONSTANTS.MIN_DEPOSIT;
}

/** Worker payout on accept: reward - 1% fee + deposit. */
export function acceptPayout(reward: bigint, deposit: bigint): { toWorker: bigint; fee: bigint } {
  const fee = (reward * CONSTANTS.FEE_BPS) / 10_000n;
  return { toWorker: reward - fee + deposit, fee };
}

/** Parse a decimal USDC string ("12.5") into base units. */
export function parseUsdc(amount: string | number): bigint {
  const s = String(amount).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`invalid USDC amount: ${s}`);
  const [w, f = ''] = s.split('.');
  return BigInt(w!) * 1_000_000n + BigInt((f + '000000').slice(0, 6));
}

export function formatUsdc(units: bigint): string {
  const neg = units < 0n;
  const u = neg ? -units : units;
  const f = (u % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + (u / 1_000_000n).toString() + (f ? '.' + f : '');
}
