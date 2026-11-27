// Wallet-signed writes: approve-if-needed, simulate first (surface reverts), send, wait for receipt.
import {
  encodeFunctionData, keccak256, parseAbi, parseEventLogs, stringToBytes, isHex,
  type Abi, type Account, type Address, type Hex, type TransactionReceipt, type WalletClient,
} from 'viem';
import { erc20Abi, madBountyCoreAbi, toContractParams, type PostParams } from '@madbounty/sdk';
import { CHAINS } from '../config';
import { allErrorsAbi, friendlyError } from './errors';
import { appendSpec } from './specCalldata';
import type { Reader } from './reads';
import type { ChainId, TxProgress } from '../types';

export type OnProgress = (p: TxProgress) => void;

export const onchainCheckAbi = parseAbi(['function resolve(uint256 id)', 'function rejectUnmet(uint256 id)']);
export const hashRevealAbi = parseAbi(['function reveal(uint256 id, bytes answer)', 'function rejectUnrevealed(uint256 id, bytes opening)']);
export const teeMLAbi = parseAbi(['function rejectUnproven(uint256 id)']);

/** Gas floor for OnchainCheck.rejectUnmet (CHECK_GAS 1M * 64/63 + margin): wallets' estimates can be too tight. */
const REJECT_UNMET_GAS = 1_400_000n;

export interface WriterDeps {
  chainId: ChainId;
  walletClient: WalletClient;
  account: Address | Account;
  reader: Reader;
}

export interface WriteOutcome { hash: Hex; receipt: TransactionReceipt }

/** keccak256 of UTF-8 evidence text, or the given 0x 32-byte hash unchanged. */
export function evidenceHashOf(evidence: string): Hex {
  const t = evidence.trim();
  if (isHex(t) && t.length === 66) return t as Hex;
  return keccak256(stringToBytes(evidence));
}

export function createWriter({ chainId, walletClient, account, reader }: WriterDeps) {
  const cfg = CHAINS[chainId];
  const pc = reader.publicClient;
  const from: Address = typeof account === 'string' ? account : account.address;
  const noop: OnProgress = () => {};

  async function checkChain() {
    const id = await walletClient.getChainId().catch(() => undefined);
    if (id !== undefined && id !== chainId) {
      throw new Error(`Your wallet is on the wrong network. Switch to ${cfg.name} and try again.`);
    }
  }

  /** Simulate (eth_call from the sender) then send, wait for the receipt, report progress. */
  async function run(
    label: string,
    tx: { to: Address; data: Hex; gas?: bigint },
    onProgress: OnProgress,
    simulate: { abi: Abi; functionName: string; args: readonly unknown[] } | 'call',
  ): Promise<WriteOutcome> {
    let hash: Hex | undefined;
    try {
      await checkChain();
      // 1) simulate: surfaces custom-error reverts before the wallet opens
      if (simulate === 'call') {
        await pc.call({ account: from, to: tx.to, data: tx.data, gas: tx.gas });
      } else {
        await pc.simulateContract({
          account: from, address: tx.to, abi: [...simulate.abi, ...allErrorsAbi] as Abi,
          functionName: simulate.functionName, args: simulate.args as never, gas: tx.gas,
        } as never);
      }
      // 2) wallet
      onProgress({ stage: 'wallet', label: `${label}: confirm in your wallet` });
      hash = await walletClient.sendTransaction({
        account, chain: cfg.viemChain, to: tx.to, data: tx.data, gas: tx.gas,
      } as never);
      onProgress({ stage: 'submitted', label: `${label}: submitted`, hash });
      // 3) receipt
      const receipt = await pc.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 180_000 });
      if (receipt.status !== 'success') {
        // replay at the mined block to recover the revert reason
        let msg = 'The transaction was reverted by the contract.';
        try { await pc.call({ account: from, to: tx.to, data: tx.data, blockNumber: receipt.blockNumber }); } catch (e) { msg = friendlyError(e); }
        throw new Error(msg);
      }
      onProgress({ stage: 'confirmed', label: `${label}: confirmed`, hash });
      return { hash, receipt };
    } catch (e) {
      const error = friendlyError(e);
      onProgress({ stage: 'failed', label: `${label}: failed`, hash, error });
      const err = new Error(error);
      (err as Error & { cause?: unknown }).cause = e;
      throw err;
    }
  }

  const core = (functionName: string, args: readonly unknown[]) => ({
    to: cfg.core, data: encodeFunctionData({ abi: madBountyCoreAbi, functionName: functionName as never, args: args as never }),
  });
  const coreSim = (functionName: string, args: readonly unknown[]) => ({ abi: madBountyCoreAbi as Abi, functionName, args });

  function after<T extends WriteOutcome>(id: bigint | undefined, r: T): T {
    reader.invalidate(id);
    return r;
  }

  /** Approve the core for `amount` USDC if the current allowance is short. Returns undefined if not needed. */
  async function approveIfNeeded(amount: bigint, onProgress: OnProgress = noop): Promise<WriteOutcome | undefined> {
    const current = (await pc.readContract({ address: cfg.usdc, abi: erc20Abi, functionName: 'allowance', args: [from, cfg.core] })) as bigint;
    if (current >= amount) return undefined;
    const bal = (await pc.readContract({ address: cfg.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [from] })) as bigint;
    if (bal < amount) throw new Error(`Not enough USDC in your wallet (have ${fmt(bal)}, need ${fmt(amount)}).`);
    const args = [cfg.core, amount] as const;
    const r = await run('Approve USDC', { to: cfg.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args }) },
      onProgress, { abi: erc20Abi as Abi, functionName: 'approve', args });
    reader.invalidate();
    return r;
  }

  /** Post: approve reward if needed, then post() with the spec appended to calldata. Returns the new id. */
  async function post(params: PostParams, specJson: string, onProgress: OnProgress = noop): Promise<WriteOutcome & { id: bigint; specHash: Hex }> {
    const base = encodeFunctionData({ abi: madBountyCoreAbi, functionName: 'post', args: [toContractParams(params)] as never });
    const { data, specHash } = appendSpec(base, specJson);
    if (params.specHash.toLowerCase() !== specHash.toLowerCase()) {
      throw new Error('Internal error: specHash in params does not match the spec bytes being published.');
    }
    await approveIfNeeded(params.reward, onProgress);
    const r = await run('Post bounty', { to: cfg.core, data }, onProgress, 'call');
    const ev = parseEventLogs({ abi: madBountyCoreAbi, logs: r.receipt.logs, eventName: 'Posted' })
      .find((l) => l.address.toLowerCase() === cfg.core.toLowerCase());
    if (!ev) throw new Error('Posted, but the bounty id could not be read from the receipt. Refresh the list.');
    reader.invalidate();
    return { ...r, id: (ev.args as { id: bigint }).id, specHash };
  }

  async function claim(id: bigint, onProgress: OnProgress = noop, auth?: { deadline: bigint; sig: Hex }) {
    const b = await reader.getBounty(id);
    await approveIfNeeded(b.deposit, onProgress);
    const args = [id, auth?.deadline ?? 0n, auth?.sig ?? '0x'] as const;
    return after(id, await run('Claim bounty', core('claim', args), onProgress, coreSim('claim', args)));
  }

  async function submit(id: bigint, evidence: string, onProgress: OnProgress = noop) {
    const args = [id, evidenceHashOf(evidence)] as const;
    return after(id, await run('Submit work', core('submit', args), onProgress, coreSim('submit', args)));
  }

  async function settle(id: bigint, accept: boolean, onProgress: OnProgress = noop) {
    const args = [id, accept] as const;
    return after(id, await run(accept ? 'Accept work' : 'Reject work', core('settle', args), onProgress, coreSim('settle', args)));
  }

  const simple = (fn: string, label: string) => async (id: bigint, onProgress: OnProgress = noop) =>
    after(id, await run(label, core(fn, [id]), onProgress, coreSim(fn, [id])));

  async function adapterCall(id: bigint, label: string, to: Address, abi: Abi, functionName: string, args: readonly unknown[], onProgress: OnProgress, gas?: bigint) {
    const data = encodeFunctionData({ abi, functionName: functionName as never, args: args as never });
    return after(id, await run(label, { to, data, gas }, onProgress, { abi, functionName, args }));
  }

  return {
    approveIfNeeded,
    post,
    claim,
    submit,
    settle,
    reverse: simple('reverse', 'Reverse rejection'),
    extendReview: simple('extendReview', 'Extend review'),
    cancel: simple('cancel', 'Cancel bounty'),
    payOnTimeout: simple('payOnTimeout', 'Pay worker (review timed out)'),
    finalizeReject: simple('finalizeReject', 'Finalize rejection'),
    reclaimAbandoned: simple('reclaimAbandoned', 'Reclaim abandoned bounty'),
    refundExpired: simple('refundExpired', 'Refund expired bounty'),
    withdraw: simple('withdraw', 'Withdraw owed USDC'),
    /** HashReveal: worker reveals the committed answer (raw bytes as hex). */
    hashRevealReveal: (id: bigint, answerHex: Hex, onProgress: OnProgress = noop) =>
      adapterCall(id, 'Reveal answer', cfg.adapters.hashReveal, hashRevealAbi as Abi, 'reveal', [id, answerHex], onProgress),
    hashRevealRejectUnrevealed: (id: bigint, opening: Hex = '0x', onProgress: OnProgress = noop) =>
      adapterCall(id, 'Reject (no reveal)', cfg.adapters.hashReveal, hashRevealAbi as Abi, 'rejectUnrevealed', [id, opening], onProgress),
    onchainCheckResolve: (id: bigint, onProgress: OnProgress = noop) =>
      adapterCall(id, 'Resolve on-chain check', cfg.adapters.onchainCheck, onchainCheckAbi as Abi, 'resolve', [id], onProgress),
    onchainCheckRejectUnmet: (id: bigint, onProgress: OnProgress = noop) =>
      adapterCall(id, 'Reject (check unmet)', cfg.adapters.onchainCheck, onchainCheckAbi as Abi, 'rejectUnmet', [id], onProgress, REJECT_UNMET_GAS),
    teeMLRejectUnproven: (id: bigint, onProgress: OnProgress = noop) =>
      adapterCall(id, 'Reject (no TEE proof)', cfg.adapters.teeML, teeMLAbi as Abi, 'rejectUnproven', [id], onProgress),
  };
}

export type Writer = ReturnType<typeof createWriter>;

function fmt(units: bigint): string {
  return `${units / 1_000_000n}.${(units % 1_000_000n).toString().padStart(6, '0').slice(0, 2)} USDC`;
}
