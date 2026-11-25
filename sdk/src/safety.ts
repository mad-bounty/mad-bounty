import { isAddressEqual, parseAbi, type Address, type PublicClient } from 'viem';
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
  /** Adapter contracts by kind, so the gate can read the per-bounty config (audit r3 F-1). */
  adapters?: { fallback?: Address; onchainCheck?: Address; hashReveal?: Address; teeML?: Address; multi?: Address };
  /** Signer keys the worker trusts as independent of the agent (human verifiers, oracle keys, 0G enclave signers). */
  trustedSigners?: Address[];
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
  publicClient: Pick<PublicClient, 'getCode' | 'getBlock' | 'readContract'>;
}

export type AdapterKind = 'fallback' | 'onchainCheck' | 'hashReveal' | 'teeML' | 'multi';
/** Per-bounty adapter config, as read on-chain. `signers` empty for rule adapters. */
export interface AdapterConfig { kind: AdapterKind; signers: Address[]; threshold?: number; target?: Address }

const ADAPTER_ABI = parseAbi([
  'function config(uint256) view returns (address[] signers, uint32 stepTimeout)',
]);
const TEE_ABI = parseAbi(['function config(uint256) view returns (address[] signers, bytes32 prefixHash, bytes32 suffixHash, uint32 proofWindow)']);
const MULTI_ABI = parseAbi(['function signersOf(uint256) view returns (address[])', 'function threshold(uint256) view returns (uint8)']);
const OC_ABI = parseAbi(['function config(uint256) view returns (address target, bytes data, bytes32 expectedResultHash, uint32 checkWindow)']);

/** Pure check on a decoded bounty. `verifierIsContract` is informational. */
export function assessBounty(
  b: Bounty,
  opts: SafetyOptions & { now: bigint; verifierIsContract?: boolean; adapterConfig?: AdapterConfig },
): SafetyReport {
  const w: SafetyWarning[] = [];
  const add = (severity: Severity, code: string, message: string) => w.push({ severity, code, message });
  const ac = opts.adapterConfig;
  // An adapter is only as independent as the config the agent wrote for THIS bounty (audit r3 F-1). A known adapter
  // address is "safe" only once its per-bounty config is checked below.
  const knownAddr = (opts.knownSafeVerifiers ?? []).some((a) => isAddressEqual(a, b.verifier));
  const trusted = (a: Address) => (opts.trustedSigners ?? []).some((t) => isAddressEqual(t, a));
  let known = knownAddr;
  if (knownAddr && ac) {
    if (ac.kind === 'fallback' || ac.kind === 'teeML') {
      const bad = ac.signers.filter((s) => !trusted(s));
      if (bad.length) {
        known = false;
        add(b.rejectMode === 'Refund' ? 'DANGER' : 'WARN', 'UNTRUSTED_ADAPTER_SIGNER',
          `${ac.kind} config for this bounty uses signer(s) not on your trusted list: ${bad.join(', ')}. Any of them could be the agent's own key.`);
      }
      if (ac.kind === 'teeML')
        add('WARN', 'TEEML_TEMPLATE', 'Before claiming, get the prompt prefix/suffix from the agent and check they hash to the on-chain prefixHash/suffixHash and that the rubric is satisfiable. No template = no accept proof = reject.');
    } else if (ac.kind === 'multi') {
      const good = ac.signers.filter(trusted).length;
      if (good < (ac.threshold ?? 1)) {
        known = false;
        add(b.rejectMode === 'Refund' ? 'DANGER' : 'WARN', 'MULTI_QUORUM_UNTRUSTED',
          `Only ${good} of the ${ac.signers.length} panel signers are on your trusted list; threshold is ${ac.threshold}. The agent may control a quorum.`);
      }
    } else if (ac.kind === 'onchainCheck') {
      if (b.rejectMode === 'Refund') {
        known = false;
        add('DANGER', 'REFUND_ONCHAIN_CHECK',
          `REFUND + OnchainCheck: read the target ${ac.target}. If the agent (or anyone) can make the check false after you deliver (e.g. move a delivered NFT), the agent keeps your work and the reward.`);
      } else add('WARN', 'ONCHAIN_CHECK_TARGET', `Read the check target ${ac.target}: a check anyone can make false after you deliver lets a stranger burn your deposit.`);
    } else if (ac.kind === 'hashReveal') {
      add('INFO', 'HASH_REVEAL', 'HashReveal: a REFUND reject requires the agent to open its commitment, so a junk commitment pays you on timeout. Low-entropy answers can be brute-forced by anyone.');
    }
  } else if (knownAddr && !ac && opts.verifierIsContract && b.rejectMode === 'Refund') {
    known = false;
    add('DANGER', 'ADAPTER_CONFIG_UNCHECKED', 'REFUND bounty on an adapter whose per-bounty config was not checked. Pass `adapters` + `trustedSigners`.');
  }
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

export async function readAdapterConfig(
  pc: Pick<PublicClient, 'readContract'>, adapters: NonNullable<SafetyOptions['adapters']>, verifier: Address, id: bigint,
): Promise<AdapterConfig | undefined> {
  const is = (a?: Address) => !!a && isAddressEqual(a, verifier);
  if (is(adapters.fallback)) {
    const [signers] = await pc.readContract({ address: verifier, abi: ADAPTER_ABI, functionName: 'config', args: [id] });
    return { kind: 'fallback', signers: [...signers] };
  }
  if (is(adapters.teeML)) {
    const [signers] = await pc.readContract({ address: verifier, abi: TEE_ABI, functionName: 'config', args: [id] });
    return { kind: 'teeML', signers: [...signers] };
  }
  if (is(adapters.multi)) {
    const signers = await pc.readContract({ address: verifier, abi: MULTI_ABI, functionName: 'signersOf', args: [id] });
    const threshold = await pc.readContract({ address: verifier, abi: MULTI_ABI, functionName: 'threshold', args: [id] });
    return { kind: 'multi', signers: [...signers], threshold: Number(threshold) };
  }
  if (is(adapters.onchainCheck)) {
    const [target] = await pc.readContract({ address: verifier, abi: OC_ABI, functionName: 'config', args: [id] });
    return { kind: 'onchainCheck', signers: [], target };
  }
  if (is(adapters.hashReveal)) return { kind: 'hashReveal', signers: [] };
  return undefined;
}

export async function checkBountyForWorker(deps: Deps, id: bigint, opts: SafetyOptions = {}): Promise<SafetyReport> {
  const b = await deps.getBounty(id);
  const now = opts.now ?? (await deps.publicClient.getBlock()).timestamp;
  let verifierIsContract: boolean | undefined;
  let adapterConfig: AdapterConfig | undefined;
  if (b.state !== 'None') {
    const code = await deps.publicClient.getCode({ address: b.verifier });
    verifierIsContract = !!code && code !== '0x';
    if (opts.adapters) adapterConfig = await readAdapterConfig(deps.publicClient, opts.adapters, b.verifier, id);
  }
  return assessBounty(b, { ...opts, now, verifierIsContract, adapterConfig });
}

export { CONSTANTS };
