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

/** Live deployments. Base mainnet (8453) is LIVE. Base Sepolia (84532) is the testnet. */
export const DEPLOYMENTS = {
  8453: {
    core: '0xa2Be52807034990a4aa88a591D0fdb9E5E3Ef850',
    deployBlock: 62801963n,
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    verifiers: {
      fallback: '0x0e02866358fbCB186c1B6a520938400bdD8a2Dee',
      onchainCheck: '0xBfC7F4145cbC09a79C2afb3F3170Fe211849cE1c',
      hashReveal: '0x40bD8730095B5925f7FA1Da9bec35F1B7243b74E',
      teeML: '0x4211ED6f52B76AC38E43Bf8BF059b22689e3De1B',
      multi: '0x356ba86B972fe2ce3320DF390A8c2341A01cd601',
    },
    reputation: {
      receipts: '0x94bb7807484EeC7bCeF6e17a153621Fe439e6367',
      attest: '0x1f870dd7f55f6CEd3cDb1e8C4d153492ccbDaBd9',
    },
  },
  84532: {
    core: '0xee475BEd2B635e2CFD998db8a42C1B5C115A935F',
    deployBlock: 63726996n,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    verifiers: {
      fallback: '0x42EfE6C9e7d37587e97e17dB99be9A1e97F542DB',
      onchainCheck: '0x8cf0F5D5FA153883738409B91cc9caeBa3FC7EA8',
      hashReveal: '0x4CaAEdf13e0A6fF976E96ed808B749eFBc1982C5',
      teeML: '0xEDB11405cAd79464331D835748DB09Aa843f039C',
      multi: '0xA0526b60E273c0b58402E3283e1a31593B2d0fCc',
    },
    reputation: {
      receipts: '0x676394E710B21d2886FE33d323eeF99a1e586172',
      attest: '0x6E8402A1aCCC228F46968B646d9fB3726bEBC2Cf',
    },
  },
} as const satisfies Record<number, { core: Address; deployBlock: bigint; usdc: Address; verifiers: Record<string, Address>; reputation?: { receipts: Address; attest: Address } }>;
