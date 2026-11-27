// Shared contract between layers (chain / domain / ui). Owned by the integrator; change only via the integrator.
import type { Address, Hex } from 'viem';
import type { Bounty, StateName, RejectModeName } from '@madbounty/sdk';

export type ChainId = 8453 | 84532;

export type VerifierKind = 'self' | 'eoa' | 'onchainCheck' | 'hashReveal' | 'teeML' | 'multi' | 'fallback' | 'contract';

/** Spec JSON (docs/schemas/bounty-spec.schema.json, specVersion "madb-spec/1"), loosely typed for display. */
export interface BountySpec {
  specVersion: 'madb-spec/1';
  title: string;
  summary?: string;
  instructions: string;
  acceptanceCriteria: { id: string; description: string; required?: boolean }[];
  evidenceFormat: unknown;
  verifier: unknown;
  deadlines: unknown;
  language: string;
  [k: string]: unknown;
}

export type SpecStatus =
  | { kind: 'verified'; spec: BountySpec; bytes: number }      // found in post() calldata, keccak matches specHash
  | { kind: 'mismatch' }                                         // bytes found but hash differs (show warning)
  | { kind: 'offchain' }                                         // no MADBSPEC1 payload: hosted elsewhere
  | { kind: 'invalid'; reason: string }                          // hash ok but not valid JSON/spec
  | { kind: 'loading' };

export type TimelineKind =
  | 'Posted' | 'Cancelled' | 'Expired' | 'Claimed' | 'Submitted' | 'ReviewExtended' | 'Rejected' | 'Reversed'
  | 'Paid' | 'Burned' | 'Refunded' | 'Abandoned' | 'Owed' | 'Withdrawn';

export interface TimelineEvent {
  kind: TimelineKind;
  block: bigint;
  time: number;            // unix seconds
  tx: Hex;
  /** decoded event args, bigint amounts in USDC base units */
  args: Record<string, unknown>;
}

/** Everything the UI needs for one bounty. Built by chain/reads.ts. */
export interface BountyView {
  chainId: ChainId;
  bounty: Bounty;               // live on-chain struct (sdk decodeBounty), includes feeBps, deadline, state
  specHash: Hex;
  postedTx: Hex;
  postedAt: number;             // unix seconds
  verifierKind: VerifierKind;   // from DEPLOYMENTS adapters; 'self' if verifier == agent; 'eoa' if no code
  vaultBalance: bigint;         // USDC in the vault now
  title: string;                // spec.title if verified, else `Bounty #id`
  spec: SpecStatus;
  timeline: TimelineEvent[];    // ascending
  owed?: { who: Address; amount: bigint }[];  // from Owed events minus Withdrawn
}

export interface BountySummary {
  id: bigint;
  title: string;
  state: StateName;
  reward: bigint;
  deposit: bigint;
  agent: Address;
  worker: Address;
  verifier: Address;
  verifierKind: VerifierKind;
  rejectMode: RejectModeName;
  openUntil: bigint;
  deadline: bigint;
  postedAt: number;
}

export type Role = 'agent' | 'worker' | 'verifier' | 'anyone';

export type ActionId =
  | 'claim' | 'submit' | 'accept' | 'reject' | 'reverse' | 'extendReview' | 'cancel'
  | 'payOnTimeout' | 'finalizeReject' | 'reclaimAbandoned' | 'refundExpired' | 'withdraw'
  | 'adapterResolve' | 'hashReveal';

export interface ActionOption {
  id: ActionId;
  label: string;                 // button text, e.g. "Accept work & pay worker"
  role: Role;                    // who may press it
  enabled: boolean;              // false = show disabled with `why`
  why: string;                   // one line: when/why this is available, or why not yet ("Available in 3h 12m")
  danger: 'none' | 'caution' | 'destructive';
  primary?: boolean;             // the main thing the connected user should do
  /** money moves, for the confirmation sheet; base units */
  money?: { label: string; amount: bigint; to: string }[];
  availableAt?: number;          // unix seconds when it becomes enabled
}

export interface NextStep { headline: string; detail: string; deadline?: number }

/** Post wizard */
export type VerifierChoice =
  | { kind: 'self' }
  | { kind: 'address'; address: string }
  | { kind: 'multi'; signers: string[]; threshold: number }
  | { kind: 'fallback'; signers: string[]; stepSeconds: number }
  | { kind: 'hashReveal'; answer: string; salt: string; revealWindowSeconds: number }
  | { kind: 'onchainCheck'; target: string; calldata: string; expectedReturn: string; checkWindowSeconds: number }
  | { kind: 'teeML'; enclaveSigners: string[]; promptPrefix: string; promptSuffix: string; windowSeconds: number };

export interface PostFormState {
  title: string;
  summary: string;
  instructions: string;
  criteria: string[];
  evidenceFormat: string;
  rewardUsdc: string;        // user text, e.g. "25"
  depositUsdc: string;       // '' = use minimum
  workWindowHours: number;
  reviewWindowHours: number;
  openDays: number;
  verifier: VerifierChoice;
  rejectMode: 'Burn' | 'Refund';
  claimAuthorizer: string;   // '' = anyone may claim
}

export interface PostDerived {
  reward: bigint;
  deposit: bigint;
  minDeposit: bigint;
  feeBps: bigint;
  fee: bigint;
  workerGetsOnAccept: bigint;      // reward - fee + deposit
  burnedOnReject: bigint;          // Burn: reward + deposit ; Refund: deposit
  agentBackOnReject: bigint;       // Refund: reward ; Burn: 0
  errors: Partial<Record<keyof PostFormState | 'verifier' | 'spec', string>>;
  warnings: string[];              // e.g. REFUND + non-independent verifier (A6)
  ok: boolean;
}

export interface TxProgress {
  stage: 'wallet' | 'submitted' | 'confirmed' | 'failed';
  label: string;
  hash?: Hex;
  error?: string;
}
