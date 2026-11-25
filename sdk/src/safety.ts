import { isAddressEqual, type Address, type PublicClient } from 'viem';
import { CONSTANTS, ZERO_ADDRESS, type Bounty } from './types.js';
import { acceptPayout, formatUsdc } from './math.js';

export type Severity = 'DANGER' | 'WARN' | 'INFO';
export interface SafetyWarning { severity: Severity; code: string; message: string }
export interface SafetyReport {
  id: bigint;
  /** false if any DANGER warning is present */
  safe: boolean;
  warnings: SafetyWarning[];
  bounty: Bounty;
  /** what the worker receives on accept, and what they lose on reject/abandon */
  economics: { depositAtRisk: string; payoutOnAccept: string; fee: string; depositToRewardPct: number };
}

export interface SafetyOptions {
  /** Verifier addresses (independent adapters/oracles) the worker trusts. */
  knownSafeVerifiers?: Address[];
  /** Worker address, to flag self-dealing or already-claimed-by-other. */
  worker?: Address;
  /** Max acceptable deposit/reward ratio before WARN (default 0.25). */
  maxDepositRatio?: number;
  /** Min comfortable work window in seconds (default 6h). */
  minWorkWindow?: number;
  /** Review window above which funds-lock is flagged (default 7d). */
  longReviewWindow?: number;
  /** Override "now" (unix seconds). */
  now?: bigint;
}

interface Deps {
  getBounty: (id: bigint) => Promise<Bounty>;
  publicClient: Pick<PublicClient, 'getCode' | 'getBlock'>;
}

/** Pure check on a decoded bounty. `verifierIsContract` is informational. */
export function assessBounty(b: Bounty, opts: SafetyOptions & { now: bigint; verifierIsContract?: boolean }): SafetyReport {
  const w: SafetyWarning[] = [];
  const add = (severity: Severity, code: string, message: string) => w.push({ severity, code, message });
  const known = (opts.knownSafeVerifiers ?? []).some((a) => isAddressEqual(a, b.verifier));
  const agentIsVerifier = isAddressEqual(b.agent, b.verifier);

  if (b.state === 'None') add('DANGER', 'NOT_FOUND', 'Bounty does not exist.');
  else if (b.state !== 'Open') add('DANGER', 'NOT_OPEN', `Bounty is ${b.state}, not claimable.`);
  else if (opts.now > b.openUntil) add('DANGER', 'EXPIRED', 'openUntil has passed; claim will revert.');

  if (b.rejectMode === 'Refund') {
    if (agentIsVerifier)
      add('DANGER', 'REFUND_SELF_VERIFIED',
        'REFUND mode with the agent as its own verifier: the agent can reject, keep your work, get the reward back, and burn your deposit.');
    else if (!known)
      add('DANGER', 'REFUND_UNKNOWN_VERIFIER',
        'REFUND mode with a verifier not on your known-safe list: a verifier colluding with the agent can take your work for free and burn your deposit.');
  } else {
    if (agentIsVerifier)
      add('WARN', 'BURN_SELF_VERIFIED',
        'Agent is its own verifier (BURN mode). A reject costs the agent its reward too, but you lose your deposit and get nothing.');
    else if (!known) add('WARN', 'UNKNOWN_VERIFIER', 'Verifier is not on your known-safe list.');
  }
  if (opts.verifierIsContract === false && !agentIsVerifier && !known)
    add('INFO', 'VERIFIER_EOA', 'Verifier is an EOA (a person or bot key), not an audited adapter contract.');

  if (opts.worker) {
    if (isAddressEqual(opts.worker, b.agent)) add('WARN', 'SELF_CLAIM', 'You are the agent of this bounty.');
    if (isAddressEqual(opts.worker, b.verifier)) add('WARN', 'SELF_VERIFY', 'You are the verifier of this bounty.');
  }
  if (!isAddressEqual(b.claimAuthorizer, ZERO_ADDRESS))
    add('INFO', 'CLAIM_AUTH_REQUIRED', `Claims need an EIP-712 Claim signature from ${b.claimAuthorizer}.`);

  const ratio = b.reward > 0n ? Number((b.deposit * 10_000n) / b.reward) / 10_000 : 0;
  const maxRatio = opts.maxDepositRatio ?? 0.25;
  if (ratio > maxRatio)
    add('WARN', 'HIGH_DEPOSIT', `Deposit is ${(ratio * 100).toFixed(1)}% of reward (> ${(maxRatio * 100).toFixed(0)}%).`);

  const minWork = opts.minWorkWindow ?? 6 * 3600;
  if (b.workWindow < minWork)
    add('WARN', 'SHORT_WORK_WINDOW', `Work window is ${(b.workWindow / 3600).toFixed(1)}h; missing it burns your deposit.`);
  const longReview = opts.longReviewWindow ?? 7 * 86400;
  if (b.reviewWindow > longReview)
    add('INFO', 'LONG_REVIEW', `Review window ${(b.reviewWindow / 86400).toFixed(1)}d (can be extended once to ${(2 * b.reviewWindow / 86400).toFixed(1)}d); funds stay locked meanwhile.`);
  add('INFO', 'REJECT_OUTCOME', b.rejectMode === 'Refund'
    ? 'On reject (after 24h cooling): reward returns to the agent, your deposit burns.'
    : 'On reject (after 24h cooling): reward and your deposit both burn.');

  const { toWorker, fee } = acceptPayout(b.reward, b.deposit);
  return {
    id: b.id, safe: !w.some((x) => x.severity === 'DANGER'), warnings: w, bounty: b,
    economics: {
      depositAtRisk: formatUsdc(b.deposit), payoutOnAccept: formatUsdc(toWorker), fee: formatUsdc(fee),
      depositToRewardPct: Math.round(ratio * 10_000) / 100,
    },
  };
}

export async function checkBountyForWorker(deps: Deps, id: bigint, opts: SafetyOptions = {}): Promise<SafetyReport> {
  const b = await deps.getBounty(id);
  const now = opts.now ?? (await deps.publicClient.getBlock()).timestamp;
  let verifierIsContract: boolean | undefined;
  if (b.state !== 'None') {
    const code = await deps.publicClient.getCode({ address: b.verifier });
    verifierIsContract = !!code && code !== '0x';
  }
  return assessBounty(b, { ...opts, now, verifierIsContract });
}

export { CONSTANTS };
