import type { Address, Hex } from 'viem';

export const STATE_NAMES = [
  'None', 'Open', 'Claimed', 'Submitted', 'Rejected', 'Paid', 'Burned', 'Refunded', 'Cancelled',
] as const;
export type StateName = (typeof STATE_NAMES)[number];
export const State = {
  None: 0, Open: 1, Claimed: 2, Submitted: 3, Rejected: 4, Paid: 5, Burned: 6, Refunded: 7, Cancelled: 8,
} as const;
export const TERMINAL_STATES: readonly StateName[] = ['Paid', 'Burned', 'Refunded', 'Cancelled'];

export const REJECT_MODE_NAMES = ['Burn', 'Refund'] as const;
export type RejectModeName = (typeof REJECT_MODE_NAMES)[number];
export const RejectMode = { Burn: 0, Refund: 1 } as const;

/** Protocol constants mirrored from MADBountyCore (v1). Amounts are USDC base units (6 decimals). */
export const CONSTANTS = {
  FEE_BPS: 100n,
  MIN_REWARD: 1_000_000n,
  MAX_REWARD: 1_000_000_000n,
  MIN_DEPOSIT: 1_000_000n,
  MIN_DEPOSIT_BPS: 200n,
  MIN_WORK: 3600,
  MAX_WORK: 30 * 86400,
  MIN_REVIEW: 12 * 3600,
  MAX_REVIEW: 30 * 86400,
  MAX_OPEN: 180 * 86400,
  COOLING: 86400,
  BURN: '0x000000000000000000000000000000000000dEaD' as Address,
} as const;

export const BASE_MAINNET_USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

export interface PostParams {
  verifier: Address;
  /** 0x0 (default) = anyone may claim; otherwise this address must sign each Claim. */
  claimAuthorizer?: Address;
  reward: bigint;
  /** Defaults to minDeposit(reward). */
  deposit?: bigint;
  /** seconds, 1h..30d */
  workWindow: number;
  /** seconds, 12h..30d */
  reviewWindow: number;
  /** unix seconds; must be in (now, now+180d] */
  openUntil: bigint | number;
  /** 'Burn' (default) or 'Refund'. */
  rejectMode?: RejectModeName | 0 | 1;
  specHash: Hex;
  /** agent's x25519 public key (32 bytes hex) for encrypted secrets; '0x' if none. */
  encKey?: Hex;
}

export interface Bounty {
  id: bigint;
  agent: Address;
  verifier: Address;
  claimAuthorizer: Address;
  worker: Address;
  vault: Address;
  reward: bigint;
  deposit: bigint;
  workWindow: number;
  reviewWindow: number;
  openUntil: bigint;
  /** current phase deadline (work deadline while Claimed, review while Submitted, cooling end while Rejected) */
  deadline: bigint;
  extended: boolean;
  rejectMode: RejectModeName;
  state: StateName;
  stateCode: number;
  evidenceHash: Hex;
}

export interface PostedInfo {
  id: bigint;
  agent: Address;
  verifier: Address;
  vault: Address;
  reward: bigint;
  deposit: bigint;
  workWindow: number;
  reviewWindow: number;
  openUntil: bigint;
  rejectMode: RejectModeName;
  claimAuthorizer: Address;
  specHash: Hex;
  encKey: Hex;
  blockNumber: bigint;
  transactionHash: Hex;
}

export interface UnsignedTx {
  to: Address;
  data: Hex;
  value: bigint;
  /** human-readable summary of what this transaction does */
  description?: string;
}

export interface TimeoutSet {
  payOnTimeout: bigint[];
  finalizeReject: bigint[];
  reclaimAbandoned: bigint[];
  refundExpired: bigint[];
}
