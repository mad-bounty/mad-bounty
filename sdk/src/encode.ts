import { encodeFunctionData, type Address, type Hex } from 'viem';
import { erc20Abi, madBountyCoreAbi } from './abi.js';
import { RejectMode, ZERO_ADDRESS, type PostParams, type UnsignedTx } from './types.js';
import { minDepositFor } from './math.js';

/** Normalise SDK PostParams into the struct the contract expects. */
export function toContractParams(p: PostParams) {
  const mode = p.rejectMode === undefined ? 0 : typeof p.rejectMode === 'number' ? p.rejectMode : RejectMode[p.rejectMode];
  if (mode !== 0 && mode !== 1) throw new Error('rejectMode must be Burn|Refund');
  return {
    verifier: p.verifier,
    claimAuthorizer: p.claimAuthorizer ?? ZERO_ADDRESS,
    reward: p.reward,
    deposit: p.deposit ?? minDepositFor(p.reward),
    workWindow: p.workWindow,
    reviewWindow: p.reviewWindow,
    openUntil: BigInt(p.openUntil),
    rejectMode: mode,
    specHash: p.specHash,
    encKey: p.encKey ?? '0x',
  } as const;
}

/** Unsigned transaction builders (to/data/value) for host wallets that sign themselves. */
export function buildTxs(core: Address, usdc: Address) {
  const tx = (data: Hex, description: string, to: Address = core): UnsignedTx => ({ to, data, value: 0n, description });
  const c = <F extends string>(functionName: F, args: readonly unknown[]) =>
    encodeFunctionData({ abi: madBountyCoreAbi, functionName: functionName as never, args: args as never });
  return {
    approve: (spender: Address, amount: bigint) =>
      tx(encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
        `USDC approve ${spender} for ${amount}`, usdc),
    post: (p: PostParams) => tx(c('post', [toContractParams(p)]), `post bounty (escrows reward ${p.reward})`),
    claim: (id: bigint, authDeadline: bigint = 0n, authSig: Hex = '0x') =>
      tx(c('claim', [id, authDeadline, authSig]), `claim bounty ${id} (escrows deposit)`),
    submit: (id: bigint, evidenceHash: Hex) => tx(c('submit', [id, evidenceHash]), `submit evidence for ${id}`),
    settle: (id: bigint, accept: boolean) => tx(c('settle', [id, accept]), `settle ${id} accept=${accept}`),
    settleWithSig: (id: bigint, accept: boolean, sig: Hex) =>
      tx(c('settleWithSig', [id, accept, sig]), `relay verdict for ${id} accept=${accept}`),
    reverse: (id: bigint) => tx(c('reverse', [id]), `reverse reject on ${id}`),
    reverseWithSig: (id: bigint, sig: Hex) => tx(c('reverseWithSig', [id, sig]), `relay reverse for ${id}`),
    payOnTimeout: (id: bigint) => tx(c('payOnTimeout', [id]), `pay worker on review timeout ${id}`),
    finalizeReject: (id: bigint) => tx(c('finalizeReject', [id]), `finalize reject ${id}`),
    reclaimAbandoned: (id: bigint) => tx(c('reclaimAbandoned', [id]), `reclaim abandoned ${id}`),
    refundExpired: (id: bigint) => tx(c('refundExpired', [id]), `refund expired ${id}`),
    cancel: (id: bigint) => tx(c('cancel', [id]), `cancel ${id}`),
    extendReview: (id: bigint) => tx(c('extendReview', [id]), `extend review ${id}`),
    withdraw: (id: bigint) => tx(c('withdraw', [id]), `withdraw owed from ${id}`),
  };
}
