// PURE: post-wizard form state → validation, derived money, spec JSON and post() params.
// Mirrors MADBountyCore.post() guards, AdapterBase._checkWindow and docs/schemas/bounty-spec.schema.json.
// No network, no DOM, no Date.now: callers pass `now` and the adapter addresses in `ctx`.
import {
  CONSTANTS,
  canonicalJson,
  minDepositFor,
  parseUsdc,
  ZERO_ADDRESS,
  type PostParams,
  type RejectModeName,
} from '@madbounty/sdk';
import { encodeAbiParameters, getAddress, isAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import type { PostDerived, PostFormState, VerifierChoice, VerifierKind } from '../types';
import { duration, shortAddr, usdc, utc, verifierKindLabel } from './format';

/** Core constants as seconds, re-exported for the UI's sliders. */
export const BOUNDS = {
  MIN_REWARD: CONSTANTS.MIN_REWARD,
  MAX_REWARD: CONSTANTS.MAX_REWARD,
  MIN_WORK: CONSTANTS.MIN_WORK,
  MAX_WORK: CONSTANTS.MAX_WORK,
  MIN_REVIEW: CONSTANTS.MIN_REVIEW,
  MAX_REVIEW: CONSTANTS.MAX_REVIEW,
  MAX_OPEN: CONSTANTS.MAX_OPEN,
  COOLING: CONSTANTS.COOLING,
  /** Periphery AdapterBase: a rule window must leave 12h before the review deadline. */
  INCLUSION_MARGIN: 12 * 3600,
  MIN_WINDOW: 1 * 3600,
  MAX_SPEC_BYTES: 16 * 1024,
  MAX_TITLE: 120,
  MIN_TITLE: 3,
  MIN_INSTRUCTIONS: 10,
  MAX_CRITERIA: 50,
  MAX_SUMMARY: 500,
  MAX_INSTRUCTIONS: 20000,
  MAX_CRITERION: 2000,
} as const;

export interface PostCtx {
  me?: Address;
  /** Live fee rate for new bounties (core.feeBps()). */
  feeBps: bigint;
  now: number;
  /** Adapter addresses for the chain (DEPLOYMENTS[chainId].verifiers); required for adapter verifiers. */
  adapters?: Partial<Record<'fallback' | 'onchainCheck' | 'hashReveal' | 'teeML' | 'multi', Address>>;
}

/** Defaults for a fresh form. 24h work, 24h review (>= 12h), 7 days to claim, min deposit. */
export function defaultForm(): PostFormState {
  return {
    title: '',
    summary: '',
    instructions: '',
    criteria: [''],
    evidenceFormat: '',
    rewardUsdc: '',
    depositUsdc: '',
    workWindowHours: 24,
    reviewWindowHours: 24,
    openDays: 7,
    verifier: { kind: 'self' },
    rejectMode: 'Burn',
    claimAuthorizer: '',
  };
}

const err = (o: PostDerived['errors'], k: keyof PostDerived['errors'], msg: string) => {
  if (!o[k]) o[k] = msg;
};

const isCount = (n: number) => Number.isInteger(n) && n > 0;
const bytesLen = (s: string) => new TextEncoder().encode(s).length;
const sameAddr = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Whole units → seconds; non-finite/negative UI input collapses to 0 so the spec JSON stays serialisable. */
function wholeSec(value: number, perUnit: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value * perUnit)) : 0;
}

/** Non-finite numbers (NaN/Infinity from a half-typed input) become 0: canonicalJson refuses them by design. */
function sanitizeJson<T>(value: T): T {
  if (typeof value === 'number') return (Number.isFinite(value) ? value : 0) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeJson(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sanitizeJson(v);
    return out as T;
  }
  return value;
}

/** Strict address parse: valid + checksummed (or all-lowercase / all-uppercase, which viem accepts). */
function addrOf(v: string): Address | undefined {
  if (!isAddress(v)) return undefined;
  try {
    return getAddress(v);
  } catch {
    return undefined;
  }
}

/**
 * Case check separate from validity: a mixed-case address with the wrong checksum is a typo trap, so we reject it
 * with its own message instead of silently normalising.
 */
function checksumOk(v: string): boolean {
  if (!isAddress(v)) return false;
  const body = v.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  try {
    return getAddress(v) === v;
  } catch {
    return false;
  }
}

const ADAPTER_KEY = {
  fallback: 'fallback',
  onchainCheck: 'onchainCheck',
  hashReveal: 'hashReveal',
  teeML: 'teeML',
  multi: 'multi',
} as const;

/** Address of the adapter contract for a choice, or `me` for 'self', or the given EOA address. */
export function verifierAddressFor(choice: VerifierChoice, ctx: PostCtx): Address | undefined {
  if (choice.kind === 'self') return ctx.me;
  if (choice.kind === 'address') return addrOf(choice.address.trim());
  const key = ADAPTER_KEY[choice.kind];
  return key ? ctx.adapters?.[key] : undefined;
}

/** True when the verifier is an independent periphery adapter (not the agent, not a single EOA). */
export function isIndependentVerifier(choice: VerifierChoice, ctx: PostCtx): boolean {
  return choice.kind === 'multi' || choice.kind === 'fallback' || choice.kind === 'hashReveal'
    || choice.kind === 'onchainCheck' || choice.kind === 'teeML';
}

/** Window rules for rule-based adapters: >= 1h and <= reviewWindow - 12h. */
function checkAdapterWindow(errors: PostDerived['errors'], label: string, windowSec: number, reviewSec: number) {
  if (!isCount(windowSec)) return err(errors, 'verifier', `${label} window is required (whole seconds).`);
  if (windowSec < BOUNDS.MIN_WINDOW) return err(errors, 'verifier', `${label} window must be at least 1h.`);
  if (windowSec + BOUNDS.INCLUSION_MARGIN > reviewSec)
    return err(errors, 'verifier', `${label} window must be at most review window − 12h (${duration(Math.max(0, reviewSec - BOUNDS.INCLUSION_MARGIN))}); raise the review window.`);
}

/** Hex commit value: keccak256(abi.encode(bytes answer)) exactly as HashRevealVerifier.commit(). */
export function hashRevealCommitment(answer: string): Hex {
  return keccak256(encodeAbiParameters([{ type: 'bytes' }], [toHex(answer)]));
}

function criterionIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `c${i + 1}`);
}

/** Addresses sorted strictly ascending, as MultiVerifier._set requires. */
function sortedAddrs(signers: string[]): Address[] {
  return signers
    .map((s) => addrOf(s.trim()) ?? ZERO_ADDRESS)
    .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
}

function chooseVerifierSpec(choice: VerifierChoice, verifier: Address | undefined) {
  const type = choice.kind === 'self' ? 'self'
    : choice.kind === 'address' ? 'eoa'
      : choice.kind === 'onchainCheck' ? 'OnchainCheckVerifier'
        : choice.kind === 'hashReveal' ? 'HashRevealVerifier'
          : choice.kind === 'teeML' ? 'TeeMLVerifier'
            : choice.kind === 'multi' ? 'MultiVerifier' : 'FallbackVerifier';
  const base: Record<string, unknown> = { type, address: verifier ?? ZERO_ADDRESS };
  switch (choice.kind) {
    case 'self':
      return { ...base, independentOfAgent: false };
    case 'address':
      return { ...base, independentOfAgent: true };
    case 'multi':
      return { ...base, independentOfAgent: true, config: { threshold: choice.threshold, signers: sortedAddrs(choice.signers) } };
    case 'fallback':
      return { ...base, independentOfAgent: true, config: { stepTimeoutSec: choice.stepSeconds, signers: sortedAddrs(choice.signers) } };
    case 'hashReveal':
      return { ...base, independentOfAgent: true, config: { commitment: hashRevealCommitment(choice.answer), revealWindowSec: choice.revealWindowSeconds } };
    case 'onchainCheck':
      return {
        ...base, independentOfAgent: true,
        config: {
          target: choice.target.trim(), calldata: choice.calldata.trim(),
          expectedResultHash: choice.expectedReturn.trim(), checkWindowSec: choice.checkWindowSeconds,
        },
      };
    case 'teeML':
      return {
        ...base, independentOfAgent: true,
        config: {
          signers: choice.enclaveSigners.map((s) => (addrOf(s.trim()) ?? ZERO_ADDRESS) as string),
          prefixHash: keccak256(toHex(choice.promptPrefix)),
          suffixHash: keccak256(toHex(choice.promptSuffix)),
          proofWindowSec: choice.windowSeconds,
        },
      };
  }
}

/** The spec JSON published in the post() calldata (madb-spec/1, valid against the JSON schema). */
export function buildSpecJson(form: PostFormState, ctx?: Partial<PostCtx>): string {
  const reward = safeUsdc(form.rewardUsdc);
  const minD = reward === undefined ? CONSTANTS.MIN_DEPOSIT : minDepositFor(reward);
  const deposit = form.depositUsdc.trim() === '' ? minD : (safeUsdc(form.depositUsdc) ?? minD);
  const verifier = ctx ? verifierAddressFor(form.verifier, ctx as PostCtx) : undefined;

  const criteria = form.criteria.map((c) => c.trim()).filter((c) => c.length > 0);
  const ids = criterionIds(criteria.length);

  const evidenceItems = parseEvidenceItems(form.evidenceFormat);

  const spec: Record<string, unknown> = {
    specVersion: 'madb-spec/1',
    title: form.title.trim(),
    instructions: form.instructions.trim(),
    acceptanceCriteria: criteria.map((description, i) => ({ id: ids[i]!, description, required: true })),
    evidenceFormat: {
      manifest: 'madb-evidence/1',
      items: evidenceItems,
      storage: ['ipfs', '0g-storage', 'https', 'arweave'],
    },
    verifier: chooseVerifierSpec(form.verifier, verifier),
    deadlines: {
      workWindowSec: wholeSec(form.workWindowHours, 3600),
      reviewWindowSec: wholeSec(form.reviewWindowHours, 3600),
      openUntil: ctx?.now !== undefined ? ctx.now + wholeSec(form.openDays, 86400) : 0,
    },
    language: 'en',
  };
  if (form.summary.trim()) spec.summary = form.summary.trim();
  return canonicalJson(sanitizeJson(spec));
}

function safeUsdc(s: string): bigint | undefined {
  try {
    return parseUsdc(s.trim());
  } catch {
    return undefined;
  }
}

/** Evidence items: one line per item, "name | mediaType | description" (mediaType and description optional). */
function parseEvidenceItems(text: string): { name: string; mediaType: string; description?: string }[] {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [{ name: 'evidence', mediaType: 'application/octet-stream' }];
  return lines.slice(0, 10).map((line, i) => {
    const parts = line.split('|').map((p) => p.trim());
    const rawName = parts[0] ?? '';
    const name = rawName.replace(/[^\w .@:/+-]/g, '').slice(0, 100) || `item-${i + 1}`;
    const mt = parts[1] ?? '';
    const mediaType = /^[-\w.+]+\/[-\w.+-]+$/.test(mt) ? mt : 'application/octet-stream';
    const description = (mediaType === 'application/octet-stream' && mt !== '' ? [mt, ...parts.slice(2)] : parts.slice(2))
      .join(' | ').trim();
    return description ? { name, mediaType, description: description.slice(0, 500) } : { name, mediaType };
  });
}

/** Tolerant converters: the wizard calls this on every keystroke, so bad input must never throw. */
const addrOrZero = (v: string): Address => addrOf(v.trim()) ?? ZERO_ADDRESS;
const hexOrEmpty = (v: string): Hex => (/^0x([0-9a-fA-F]{2})*$/.test(v.trim()) ? (v.trim() as Hex) : '0x');
const bytes32OrZero = (v: string): Hex => (/^0x[0-9a-fA-F]{64}$/.test(v.trim()) ? (v.trim() as Hex) : (`0x${'00'.repeat(32)}` as Hex));
const intOrZero = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);

/** ABI-encode an adapter's per-bounty config, byte-identical to what deployments/e2e_full.py passes in post(). */
export function encodeVerifierInit(choice: VerifierChoice): Hex {
  switch (choice.kind) {
    case 'fallback':
      return encodeAbiParameters(
        [{ type: 'address[]' }, { type: 'uint32' }],
        [choice.signers.map((s) => addrOrZero(s)), intOrZero(choice.stepSeconds)],
      );
    case 'multi':
      return encodeAbiParameters(
        [{ type: 'address[]' }, { type: 'uint8' }],
        [sortedAddrs(choice.signers), intOrZero(choice.threshold)],
      );
    case 'hashReveal':
      return encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'uint32' }],
        [hashRevealCommitment(choice.answer), intOrZero(choice.revealWindowSeconds)],
      );
    case 'onchainCheck':
      return encodeAbiParameters(
        [{ type: 'address' }, { type: 'bytes' }, { type: 'bytes32' }, { type: 'uint32' }],
        [addrOrZero(choice.target), hexOrEmpty(choice.calldata), bytes32OrZero(choice.expectedReturn), intOrZero(choice.checkWindowSeconds)],
      );
    case 'teeML':
      return encodeAbiParameters(
        [{ type: 'address[]' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint32' }],
        [
          choice.enclaveSigners.map((s) => addrOrZero(s)),
          keccak256(toHex(choice.promptPrefix)),
          keccak256(toHex(choice.promptSuffix)),
          intOrZero(choice.windowSeconds),
        ],
      );
    default:
      return '0x'; // 'self' and 'address' verifiers take no config
  }
}

/** Validate + derive everything the wizard and confirm screen need. */
export function derive(form: PostFormState, ctx: PostCtx): PostDerived {
  const errors: PostDerived['errors'] = {};
  const warnings: string[] = [];
  const now = ctx.now;

  // ---- text
  const title = form.title.trim();
  if (bytesLen(title) < BOUNDS.MIN_TITLE) err(errors, 'title', `Title needs at least ${BOUNDS.MIN_TITLE} characters.`);
  else if (bytesLen(title) > BOUNDS.MAX_TITLE) err(errors, 'title', `Title must be at most ${BOUNDS.MAX_TITLE} characters.`);
  if (form.summary.trim().length > BOUNDS.MAX_SUMMARY) err(errors, 'summary', `Summary must be at most ${BOUNDS.MAX_SUMMARY} characters.`);
  const instructions = form.instructions.trim();
  if (instructions.length < BOUNDS.MIN_INSTRUCTIONS) err(errors, 'instructions', `Instructions need at least ${BOUNDS.MIN_INSTRUCTIONS} characters.`);
  else if (instructions.length > BOUNDS.MAX_INSTRUCTIONS) err(errors, 'instructions', `Instructions must be at most ${BOUNDS.MAX_INSTRUCTIONS} characters.`);

  const criteria = form.criteria.map((c) => c.trim()).filter(Boolean);
  if (criteria.length === 0) err(errors, 'criteria', 'Add at least one acceptance criterion.');
  else if (criteria.length > BOUNDS.MAX_CRITERIA) err(errors, 'criteria', `At most ${BOUNDS.MAX_CRITERIA} criteria.`);
  else if (criteria.some((c) => c.length < 3)) err(errors, 'criteria', 'Each criterion needs at least 3 characters.');
  else if (criteria.some((c) => c.length > BOUNDS.MAX_CRITERION)) err(errors, 'criteria', `Each criterion must be at most ${BOUNDS.MAX_CRITERION} characters.`);

  // ---- money
  let reward = 0n;
  const rewardText = form.rewardUsdc.trim();
  if (!rewardText) err(errors, 'rewardUsdc', 'Set a reward.');
  else if (safeUsdc(rewardText) === undefined) err(errors, 'rewardUsdc', 'Reward must be a USDC amount with up to 6 decimals, e.g. 25 or 12.5.');
  else {
    reward = safeUsdc(rewardText)!;
    if (reward < BOUNDS.MIN_REWARD) err(errors, 'rewardUsdc', `Reward must be at least ${usdc(BOUNDS.MIN_REWARD)}.`);
    else if (reward > BOUNDS.MAX_REWARD) err(errors, 'rewardUsdc', `Reward must be at most ${usdc(BOUNDS.MAX_REWARD)}.`);
  }
  const minDeposit = reward > 0n ? minDepositFor(reward) : CONSTANTS.MIN_DEPOSIT;
  let deposit = minDeposit;
  const depositText = form.depositUsdc.trim();
  if (depositText !== '') {
    const d = safeUsdc(depositText);
    if (d === undefined) err(errors, 'depositUsdc', 'Deposit must be a USDC amount with up to 6 decimals.');
    else {
      deposit = d;
      if (d < minDeposit) err(errors, 'depositUsdc', `Deposit must be at least ${usdc(minDeposit)} (1 USDC or 2% of the reward).`);
      else if (reward > 0n && d > reward) err(errors, 'depositUsdc', `Deposit cannot exceed the reward (${usdc(reward)}).`);
    }
  }

  // ---- windows
  const workSec = Math.round(form.workWindowHours * 3600);
  if (!isCount(form.workWindowHours) || workSec < BOUNDS.MIN_WORK) err(errors, 'workWindowHours', 'Work window must be at least 1 hour.');
  else if (workSec > BOUNDS.MAX_WORK) err(errors, 'workWindowHours', 'Work window must be at most 30 days.');
  const reviewSec = Math.round(form.reviewWindowHours * 3600);
  if (!isCount(form.reviewWindowHours) || reviewSec < BOUNDS.MIN_REVIEW) err(errors, 'reviewWindowHours', 'Review window must be at least 12 hours.');
  else if (reviewSec > BOUNDS.MAX_REVIEW) err(errors, 'reviewWindowHours', 'Review window must be at most 30 days.');

  const openUntil = now + Math.round(form.openDays * 86400);
  if (!isCount(form.openDays) || openUntil <= now) err(errors, 'openDays', 'The claim window must end in the future.');
  else if (openUntil > now + BOUNDS.MAX_OPEN) err(errors, 'openDays', 'The claim window can be at most 180 days.');

  // ---- claim authorizer
  let claimAuthorizer: Address = ZERO_ADDRESS;
  const authText = form.claimAuthorizer.trim();
  if (authText !== '') {
    const a = addrOf(authText);
    if (!a) err(errors, 'claimAuthorizer', 'Claim authorizer must be a valid address.');
    else if (!checksumOk(authText)) err(errors, 'claimAuthorizer', 'Address checksum is wrong: copy it again.');
    else claimAuthorizer = a;
  }

  // ---- verifier
  const choice = form.verifier;
  const verifier = verifierAddressFor(choice, ctx);
  if (choice.kind === 'self') {
    if (!ctx.me) err(errors, 'verifier', 'Connect a wallet: the poster address is the verifier.');
    if (form.rejectMode === 'Refund')
      warnings.push('A6: you are the verifier and the reject mode is REFUND. You could keep the work and the reward, so honest workers will not claim. Use BURN, or name an independent verifier.');
  } else if (choice.kind === 'address') {
    if (!addrOf(choice.address.trim())) err(errors, 'verifier', 'Verifier must be a valid address.');
    else if (!checksumOk(choice.address.trim())) err(errors, 'verifier', 'Address checksum is wrong: copy it again.');
    else if (sameAddr(choice.address, ctx.me))
      warnings.push('This address is you, so the verifier is not independent. Workers treat that as self-review.');
  } else {
    if (!verifier) err(errors, 'verifier', 'This adapter is not deployed on the selected chain.');
    if ((choice.kind === 'fallback' || choice.kind === 'multi')) {
      const signers = choice.signers.map((s) => s.trim()).filter(Boolean);
      if (signers.length === 0) err(errors, 'verifier', 'Add at least one signer.');
      if (signers.some((s) => !addrOf(s))) err(errors, 'verifier', 'Every signer must be a valid address.');
      else if (signers.some((s) => !checksumOk(s))) err(errors, 'verifier', 'A signer address checksum is wrong: copy it again.');
      const lower = signers.map((s) => s.toLowerCase());
      if (new Set(lower).size !== lower.length) err(errors, 'verifier', 'Signers must be unique.');
      if (signers.length > (choice.kind === 'multi' ? 7 : 3))
        err(errors, 'verifier', `At most ${choice.kind === 'multi' ? 7 : 3} signers.`);
      if (choice.kind === 'multi') {
        if (!isCount(choice.threshold) || choice.threshold > signers.length)
          err(errors, 'verifier', `Threshold must be between 1 and ${signers.length}.`);
        else if (choice.threshold * 2 <= signers.length)
          warnings.push(`Threshold ${choice.threshold} of ${signers.length} is not a strict majority, so an accept quorum and a reject quorum can both exist. Use more than half.`);
      }
      if (choice.kind === 'fallback') {
        if (signers.length > 1 && !isCount(choice.stepSeconds)) err(errors, 'verifier', 'Step timeout is required when there is more than one signer.');
        else if (signers.length > 1 && choice.stepSeconds * (signers.length - 1) >= reviewSec)
          err(errors, 'verifier', 'Step timeout × (signers − 1) must be shorter than the review window so every signer gets a turn.');
      }
      if (signers.some((s) => sameAddr(s, ctx.me)) && form.rejectMode === 'Refund')
        warnings.push('You are one of the signers: REFUND with a signer the poster controls is not independent (A6).');
    } else if (choice.kind === 'hashReveal') {
      if (!choice.answer) err(errors, 'verifier', 'Enter the answer the worker must reveal.');
      else if (bytesLen(choice.answer) < 8)
        warnings.push('Short answers (under 8 bytes) can be brute-forced from the commitment. Use a long, unguessable value and never reuse it.');
      if (choice.salt.trim() !== '')
        warnings.push('The salt is not part of the commitment (HashRevealVerifier commits keccak256(abi.encode(bytes answer)) alone). Put the salt inside the answer field, and publish it with the task.');
      if (/^0x[0-9a-fA-F]*$/.test(choice.answer.trim()) && choice.answer.trim().length > 2)
        warnings.push('The answer is committed as the UTF-8 text you typed, not as raw hex bytes. Tell the worker to reveal exactly this text.');
      checkAdapterWindow(errors, 'Reveal', choice.revealWindowSeconds, reviewSec);
    } else if (choice.kind === 'onchainCheck') {
      if (!addrOf(choice.target.trim())) err(errors, 'verifier', 'Check target must be a valid contract address.');
      else if (!checksumOk(choice.target.trim())) err(errors, 'verifier', 'Address checksum is wrong: copy it again.');
      if (!/^0x([0-9a-fA-F]{2})*$/.test(choice.calldata.trim())) err(errors, 'verifier', 'Calldata must be 0x-prefixed hex.');
      else if (bytesLen(choice.calldata.trim()) / 2 - 1 > 4096) err(errors, 'verifier', 'Calldata is capped at 4096 bytes.');
      if (!/^0x[0-9a-fA-F]{64}$/.test(choice.expectedReturn.trim())) err(errors, 'verifier', 'Expected return hash must be a 32-byte keccak value.');
      checkAdapterWindow(errors, 'Check', choice.checkWindowSeconds, reviewSec);
      if (form.rejectMode === 'Refund')
        warnings.push('REFUND with an on-chain check: if anyone can make the check false after the work is delivered, the poster keeps the work and the reward. Prefer BURN.');
    } else if (choice.kind === 'teeML') {
      const signers = choice.enclaveSigners.map((s) => s.trim()).filter(Boolean);
      if (signers.length === 0) err(errors, 'verifier', 'Add at least one enclave signer.');
      else if (signers.length > 3) err(errors, 'verifier', 'At most 3 enclave signers.');
      if (signers.some((s) => !addrOf(s))) err(errors, 'verifier', 'Every enclave signer must be a valid address.');
      else if (signers.some((s) => !checksumOk(s))) err(errors, 'verifier', 'An enclave signer checksum is wrong: copy it again.');
      else if (new Set(signers.map((s) => s.toLowerCase())).size !== signers.length) err(errors, 'verifier', 'Enclave signers must be unique.');
      if (!choice.promptPrefix.trim() || !choice.promptSuffix.trim()) err(errors, 'verifier', 'Prompt prefix and suffix are required: without them a worker can ask the enclave for any verdict.');
      checkAdapterWindow(errors, 'Proof', choice.windowSeconds, reviewSec);
      if (/VERDICT/i.test(choice.promptPrefix) || /VERDICT/i.test(choice.promptSuffix))
        warnings.push('The template mentions "VERDICT": the response must contain exactly one VERDICT: token, so a model that echoes the format string invalidates it. Keep the format instruction in the suffix and check one sample response.');
      if (choice.promptPrefix && (choice.promptPrefix.match(/"/g) ?? []).length % 2 === 0)
        warnings.push('The prompt prefix must leave the evidence inside an open JSON string (an odd number of double quotes), or TeeML resolve reverts BadEvidence.');
      if (choice.promptPrefix && bytesLen(choice.promptPrefix) + bytesLen(choice.promptSuffix) > 8000)
        warnings.push('Template is large: the evidence itself is capped at 8 KB, so keep prefix + suffix short.');
      if (form.rejectMode === 'Refund' && signers.some((s) => sameAddr(s, ctx.me)))
        warnings.push('You pinned one of your own addresses as the enclave signer: REFUND then lets you reject at will (A6).');
    }
    if (form.rejectMode === 'Refund' && (choice.kind === 'fallback' || choice.kind === 'multi' || choice.kind === 'teeML'))
      warnings.push('REFUND is only safe if fewer than the threshold of signers / none of the enclave signers are controlled by you. Workers will check.');
  }

  // ---- spec
  const specJson = buildSpecJson(form, ctx);
  const specBytes = bytesLen(specJson);
  if (specBytes > BOUNDS.MAX_SPEC_BYTES) err(errors, 'spec', `Spec is ${specBytes} bytes; the cap is 16 KB. Shorten the instructions.`);

  const rewardOk = reward > 0n && !errors.rewardUsdc;
  const fee = rewardOk ? (reward * ctx.feeBps) / 10_000n : 0n;
  const dep = errors.depositUsdc ? 0n : deposit;
  const toWorker = rewardOk ? reward - fee + dep : 0n;
  const burnedOnReject = form.rejectMode === 'Burn' ? reward + dep : dep;
  const agentBackOnReject = form.rejectMode === 'Refund' ? reward : 0n;

  const ok = Object.keys(errors).length === 0;
  return {
    reward: rewardOk ? reward : 0n,
    deposit: dep,
    minDeposit,
    feeBps: ctx.feeBps,
    fee,
    workerGetsOnAccept: toWorker,
    burnedOnReject,
    agentBackOnReject,
    errors,
    warnings,
    ok,
  };
}

/** post() params. `verifierInit` is byte-identical to the e2e examples; '' verifiers get '0x'. */
export function buildPostParams(form: PostFormState, ctx: PostCtx): PostParams {
  const d = derive(form, ctx);
  const verifier = verifierAddressFor(form.verifier, ctx);
  const specBytes = buildSpecJson(form, ctx);
  const claimAuthorizer = form.claimAuthorizer.trim() === ''
    ? ZERO_ADDRESS
    : (addrOf(form.claimAuthorizer.trim()) ?? ZERO_ADDRESS);
  const rejectMode: RejectModeName = form.rejectMode;
  return {
    verifier: verifier ?? ZERO_ADDRESS,
    claimAuthorizer,
    reward: d.reward,
    deposit: d.deposit,
    workWindow: Math.round(form.workWindowHours * 3600),
    reviewWindow: Math.round(form.reviewWindowHours * 3600),
    openUntil: BigInt(ctx.now + wholeSec(form.openDays, 86400)),
    rejectMode,
    specHash: keccak256(toHex(specBytes)),
    encKey: '0x',
    verifierInit: encodeVerifierInit(form.verifier),
  };
}

/** Plain-language lines for the confirm screen (amounts, parties, rules, outcome table). */
export function describe(form: PostFormState, d: PostDerived, ctx?: PostCtx): string[] {
  const choice = form.verifier;
  const lines: string[] = [];
  const reward = usdc(d.reward);
  const dep = usdc(d.deposit);
  const verifier = ctx ? verifierAddressFor(choice, ctx) : verifierAddressFor(choice, { feeBps: d.feeBps, now: 0 });
  const who = choice.kind === 'self'
    ? 'you (the poster)'
    : choice.kind === 'address'
      ? shortAddr(choice.address.trim())
      : `${verifierKindLabel(choice.kind as VerifierKind)}${verifier ? ' ' + shortAddr(verifier) : ''}`;

  lines.push(`You lock ${reward} as the reward. A worker must lock ${dep} to claim (min ${usdc(d.minDeposit)}).`);
  lines.push(`Verifier: ${who}. ${form.rejectMode === 'Burn' ? 'If it is rejected the escrow is burned.' : 'If it is rejected the reward comes back to you and the worker deposit is burned.'}`);
  lines.push(`Work window ${duration(Math.round(form.workWindowHours * 3600))}; review window ${duration(Math.round(form.reviewWindowHours * 3600))} (extendable once).`);
  if (ctx) lines.push(`Claims close ${utc(ctx.now + Math.round(form.openDays * 86400))}; after that anyone can return your reward.`);
  lines.push(`On accept: worker gets ${usdc(d.workerGetsOnAccept)} (reward − ${usdc(d.fee)} fee at ${Number(d.feeBps) / 100}% + their deposit); the ${usdc(d.fee)} fee goes to the treasury.`);
  lines.push(form.rejectMode === 'Burn'
    ? `On a final reject: ${usdc(d.burnedOnReject)} (reward + deposit) is burned.`
    : `On a final reject: ${usdc(d.agentBackOnReject)} comes back to you, ${usdc(d.burnedOnReject)} (the deposit) is burned.`);
  lines.push('If the verifier stays silent past the review window, the worker is paid automatically. Deposits are not refundable otherwise.');
  lines.push('Bounties are immutable: no admin, no pause, no appeals.');
  return lines;
}
