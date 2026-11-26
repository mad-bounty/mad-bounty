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
  /** Fee ceiling (5%). The live rate for new bounties is core.feeBps(); each bounty's rate is core.feeBpsOf(id). */
  MAX_FEE_BPS: 500n,
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
  /** ABI-encoded adapter config; core calls verifier.onPost(id, agent, verifierInit) inside post (atomic setup). */
  verifierInit?: Hex;
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
  /** Fee in basis points locked into this bounty at post time (core.feeBpsOf). */
  feeBps: bigint;
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

/** Live deployments. Base Sepolia is a TESTNET deployment (pre-external-audit); mainnet is not deployed yet. */
export const DEPLOYMENTS = {
  84532: {
    core: '0x0Bb5cd6132a0361Da9747bC90F0B06a212FB7786',
    deployBlock: 63518400n,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    verifiers: {
      fallback: '0xf2e0Dc57d15BD6440D729bf1dCf7D45ec3028468',
      onchainCheck: '0x8Bf16e787b49649C3B6883F727977De5505083D7',
      hashReveal: '0x5554D841e3b7834B4602124B920aFDA6DBD0376C',
      teeML: '0xa4Ff0c36036191A64ef9BAD4d58CAD8f611C7899',
      multi: '0x174e9d5B2ff058DF8823855D5C270578E7eB57B2',
    },
  },
} as const satisfies Record<number, { core: Address; deployBlock: bigint; usdc: Address; verifiers: Record<string, Address> }>;
