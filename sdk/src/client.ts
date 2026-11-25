import {
  getAddress, isAddressEqual, parseEventLogs,
  type Account, type Address, type Chain, type Hex, type PublicClient, type TransactionReceipt,
  type Transport, type WalletClient,
} from 'viem';
import { erc20Abi, madBountyCoreAbi } from './abi.js';
import { buildTxs, toContractParams } from './encode.js';
import {
  REJECT_MODE_NAMES, STATE_NAMES, TERMINAL_STATES, ZERO_ADDRESS,
  type Bounty, type PostParams, type PostedInfo, type StateName, type TimeoutSet,
} from './types.js';
import { checkBountyForWorker, type SafetyOptions, type SafetyReport } from './safety.js';

export interface MADBountyClientConfig {
  publicClient: PublicClient<Transport, Chain | undefined>;
  walletClient?: WalletClient<Transport, Chain | undefined, Account | undefined>;
  core: Address;
  usdc: Address;
}

export interface WriteResult {
  hash: Hex;
  receipt: TransactionReceipt;
}

export const EIP712_TYPES = {
  Verdict: [
    { name: 'id', type: 'uint256' },
    { name: 'worker', type: 'address' },
    { name: 'evidenceHash', type: 'bytes32' },
    { name: 'accept', type: 'bool' },
  ],
  Reverse: [
    { name: 'id', type: 'uint256' },
    { name: 'worker', type: 'address' },
    { name: 'evidenceHash', type: 'bytes32' },
  ],
  Claim: [
    { name: 'id', type: 'uint256' },
    { name: 'worker', type: 'address' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

type CoreWriteFn =
  | 'post' | 'claim' | 'submit' | 'settle' | 'settleWithSig' | 'reverse' | 'reverseWithSig' | 'payOnTimeout'
  | 'finalizeReject' | 'reclaimAbandoned' | 'refundExpired' | 'cancel' | 'extendReview' | 'withdraw';

export function decodeBounty(id: bigint, r: readonly unknown[]): Bounty {
  const [agent, verifier, claimAuthorizer, worker, vault, reward, deposit, workWindow, reviewWindow, openUntil,
    deadline, extended, rejectMode, state, evidenceHash] = r as [Address, Address, Address, Address, Address,
    bigint, bigint, number, number, bigint, bigint, boolean, number, number, Hex];
  return {
    id, agent, verifier, claimAuthorizer, worker, vault, reward, deposit, workWindow, reviewWindow, openUntil,
    deadline, extended,
    rejectMode: REJECT_MODE_NAMES[rejectMode] ?? 'Burn',
    state: STATE_NAMES[state] ?? 'None',
    stateCode: state,
    evidenceHash,
  };
}

export function createClient(cfg: MADBountyClientConfig) {
  const { publicClient, walletClient } = cfg;
  const core = getAddress(cfg.core);
  const usdc = getAddress(cfg.usdc);
  const txs = buildTxs(core, usdc);

  function requireWallet() {
    if (!walletClient) throw new Error('walletClient required for this action');
    const account = walletClient.account;
    if (!account) throw new Error('walletClient has no account');
    return { wallet: walletClient, account };
  }

  async function write(functionName: CoreWriteFn, args: readonly unknown[]): Promise<WriteResult> {
    const { wallet, account } = requireWallet();
    const { request } = await publicClient.simulateContract({
      address: core, abi: madBountyCoreAbi, functionName: functionName as never, args: args as never, account,
    });
    const hash = await wallet.writeContract({ ...(request as object), chain: wallet.chain ?? null, account } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted: ${hash}`);
    return { hash, receipt };
  }

  async function domain() {
    const chainId = await publicClient.getChainId();
    return { name: 'MADBounty', version: '1', chainId, verifyingContract: core } as const;
  }

  async function getBounty(id: bigint | number): Promise<Bounty> {
    const bid = BigInt(id);
    const r = await publicClient.readContract({ address: core, abi: madBountyCoreAbi, functionName: 'bounties', args: [bid] });
    return decodeBounty(bid, r as readonly unknown[]);
  }

  async function nextId(): Promise<bigint> {
    return publicClient.readContract({ address: core, abi: madBountyCoreAbi, functionName: 'nextId' });
  }

  async function allIds(): Promise<bigint[]> {
    const n = await nextId();
    const ids: bigint[] = [];
    for (let i = 1n; i < n; i++) ids.push(i);
    return ids;
  }

  async function getBounties(ids: bigint[]): Promise<Bounty[]> {
    const out: Bounty[] = [];
    const B = 25;
    for (let i = 0; i < ids.length; i += B) out.push(...(await Promise.all(ids.slice(i, i + B).map(getBounty))));
    return out;
  }

  async function getPostedLogs(opts: { fromBlock?: bigint; toBlock?: bigint; blockChunk?: bigint } = {}): Promise<PostedInfo[]> {
    const toBlock = opts.toBlock ?? (await publicClient.getBlockNumber());
    const fromBlock = opts.fromBlock ?? 0n;
    // Public RPCs cap eth_getLogs ranges (Base Sepolia public RPC: 200 blocks, others 1k-10k). Start with the
    // requested chunk (or the whole range) and halve on a range-limit error, so any provider works unconfigured.
    let chunk = opts.blockChunk && opts.blockChunk > 0n ? opts.blockChunk : toBlock - fromBlock + 1n;
    const out: PostedInfo[] = [];
    let s = fromBlock;
    while (s <= toBlock) {
      const e = s + chunk - 1n > toBlock ? toBlock : s + chunk - 1n;
      let logs;
      try {
        logs = await publicClient.getContractEvents({
          address: core, abi: madBountyCoreAbi, eventName: 'Posted', fromBlock: s, toBlock: e,
        });
      } catch (err) {
        const m = String((err as Error)?.message ?? err);
        if (chunk > 1n && /range|limit|413|too many|exceed/i.test(m)) {
          const hinted = /limited to a (\d+) range/i.exec(m);
          chunk = hinted ? BigInt(hinted[1]!) : chunk / 2n;
          continue;
        }
        throw err;
      }
      for (const l of logs) {
        const x = l.args as Record<string, unknown>;
        out.push({
          id: x.id as bigint, agent: x.agent as Address, verifier: x.verifier as Address, vault: x.vault as Address,
          reward: x.reward as bigint, deposit: x.deposit as bigint, workWindow: Number(x.workWindow),
          reviewWindow: Number(x.reviewWindow), openUntil: x.openUntil as bigint,
          rejectMode: REJECT_MODE_NAMES[Number(x.rejectMode)] ?? 'Burn', claimAuthorizer: x.claimAuthorizer as Address,
          specHash: x.specHash as Hex, encKey: x.encKey as Hex,
          blockNumber: l.blockNumber as bigint, transactionHash: l.transactionHash as Hex,
        });
      }
      s = e + 1n;
    }
    return out;
  }

  /**
   * Bounties from Posted logs whose current on-chain state is in `states` (default: claimable = Open and not
   * past openUntil). Each result carries the Posted info (specHash, encKey) plus live state.
   */
  async function listOpenBounties(opts: { fromBlock?: bigint; toBlock?: bigint; blockChunk?: bigint;
    states?: StateName[]; includeExpired?: boolean } = {}) {
    const posted = await getPostedLogs(opts);
    const live = await getBounties(posted.map((p) => p.id));
    const now = (await publicClient.getBlock()).timestamp;
    const states = opts.states ?? ['Open'];
    return posted
      .map((p, i) => ({ ...p, bounty: live[i]! }))
      .filter(({ bounty }) => states.includes(bounty.state))
      .filter(({ bounty }) => opts.includeExpired || bounty.state !== 'Open' || bounty.openUntil >= now)
      .map(({ bounty, ...p }) => ({ ...p, ...bounty, specHash: p.specHash, encKey: p.encKey }));
  }

  /** Ids whose permissionless timeout action would succeed now (based on the latest block timestamp). */
  async function findTimeouts(opts: { ids?: bigint[]; now?: bigint } = {}): Promise<TimeoutSet> {
    const ids = opts.ids ?? (await allIds());
    const bs = await getBounties(ids);
    const now = opts.now ?? (await publicClient.getBlock()).timestamp;
    const r: TimeoutSet = { payOnTimeout: [], finalizeReject: [], reclaimAbandoned: [], refundExpired: [] };
    for (const b of bs) {
      if (b.state === 'Submitted' && now > b.deadline) r.payOnTimeout.push(b.id);
      else if (b.state === 'Rejected' && now > b.deadline) r.finalizeReject.push(b.id);
      else if (b.state === 'Claimed' && now > b.deadline) r.reclaimAbandoned.push(b.id);
      else if (b.state === 'Open' && now > b.openUntil) r.refundExpired.push(b.id);
    }
    return r;
  }

  /** Execute every action findTimeouts reports. Failures are collected, not thrown. */
  async function keeperSweep(opts: { ids?: bigint[] } = {}) {
    const t = await findTimeouts(opts);
    const done: { action: keyof TimeoutSet; id: bigint; hash?: Hex; error?: string }[] = [];
    for (const action of Object.keys(t) as (keyof TimeoutSet)[]) {
      for (const id of t[action]) {
        try {
          const { hash } = await write(action, [id]);
          done.push({ action, id, hash });
        } catch (e) {
          done.push({ action, id, error: (e as Error).message.split('\n')[0] });
        }
      }
    }
    return { found: t, results: done };
  }

  async function usdcBalance(who: Address) {
    return publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [who] });
  }

  async function allowance(owner: Address) {
    return publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: 'allowance', args: [owner, core] });
  }

  /** Approve the core for `amount` USDC if current allowance is lower. Returns null when no tx was needed. */
  async function approveIfNeeded(amount: bigint): Promise<WriteResult | null> {
    const { wallet, account } = requireWallet();
    if ((await allowance(account.address)) >= amount) return null;
    const hash = await wallet.writeContract({
      address: usdc, abi: erc20Abi, functionName: 'approve', args: [core, amount], account, chain: wallet.chain ?? null,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`approve reverted: ${hash}`);
    return { hash, receipt };
  }

  async function signVerdict(id: bigint, accept: boolean, ctx?: { worker: Address; evidenceHash: Hex }): Promise<Hex> {
    const { wallet, account } = requireWallet();
    const c = ctx ?? (await getBounty(id));
    return wallet.signTypedData({
      account, domain: await domain(), types: EIP712_TYPES, primaryType: 'Verdict',
      message: { id, worker: c.worker, evidenceHash: c.evidenceHash, accept },
    });
  }

  async function signReverse(id: bigint, ctx?: { worker: Address; evidenceHash: Hex }): Promise<Hex> {
    const { wallet, account } = requireWallet();
    const c = ctx ?? (await getBounty(id));
    return wallet.signTypedData({
      account, domain: await domain(), types: EIP712_TYPES, primaryType: 'Reverse',
      message: { id, worker: c.worker, evidenceHash: c.evidenceHash },
    });
  }

  /** Signed by the bounty's claimAuthorizer to let `worker` claim before `deadline` (unix seconds). */
  async function signClaim(id: bigint, worker: Address, deadline: bigint): Promise<Hex> {
    const { wallet, account } = requireWallet();
    return wallet.signTypedData({
      account, domain: await domain(), types: EIP712_TYPES, primaryType: 'Claim', message: { id, worker, deadline },
    });
  }

  return {
    core, usdc, txs, domain,
    publicClient: publicClient as MADBountyClientConfig['publicClient'],
    walletClient: walletClient as MADBountyClientConfig['walletClient'],
    // reads
    getBounty, getBounties, nextId, getPostedLogs, listOpenBounties, findTimeouts, usdcBalance, allowance,
    minDeposit: (reward: bigint) =>
      publicClient.readContract({ address: core, abi: madBountyCoreAbi, functionName: 'minDeposit', args: [reward] }),
    owed: (id: bigint, who: Address) =>
      publicClient.readContract({ address: core, abi: madBountyCoreAbi, functionName: 'owed', args: [id, who] }),
    manual: async () => {
      const [uri, hash] = await Promise.all([
        publicClient.readContract({ address: core, abi: madBountyCoreAbi, functionName: 'manualURI' }),
        publicClient.readContract({ address: core, abi: madBountyCoreAbi, functionName: 'manualHash' }),
      ]);
      return { uri, hash };
    },
    // signatures
    signVerdict, signReverse, signClaim,
    // writes
    approveIfNeeded,
    /** Approves reward if needed, posts, and returns the new bounty id. */
    async post(p: PostParams): Promise<WriteResult & { id: bigint }> {
      await approveIfNeeded(p.reward);
      const res = await write('post', [toContractParams(p)]);
      const ev = parseEventLogs({ abi: madBountyCoreAbi, eventName: 'Posted', logs: res.receipt.logs })[0];
      if (!ev) throw new Error('Posted event missing');
      return { ...res, id: ev.args.id };
    },
    /** Approves the deposit if needed, then claims. Pass authDeadline/authSig when claimAuthorizer is set. */
    async claim(id: bigint, auth?: { deadline: bigint; sig: Hex }): Promise<WriteResult> {
      const b = await getBounty(id);
      await approveIfNeeded(b.deposit);
      return write('claim', [id, auth?.deadline ?? 0n, auth?.sig ?? '0x']);
    },
    submit: (id: bigint, evidenceHash: Hex) => write('submit', [id, evidenceHash]),
    settle: (id: bigint, accept: boolean) => write('settle', [id, accept]),
    settleWithSig: (id: bigint, accept: boolean, sig: Hex) => write('settleWithSig', [id, accept, sig]),
    reverse: (id: bigint) => write('reverse', [id]),
    reverseWithSig: (id: bigint, sig: Hex) => write('reverseWithSig', [id, sig]),
    payOnTimeout: (id: bigint) => write('payOnTimeout', [id]),
    finalizeReject: (id: bigint) => write('finalizeReject', [id]),
    reclaimAbandoned: (id: bigint) => write('reclaimAbandoned', [id]),
    refundExpired: (id: bigint) => write('refundExpired', [id]),
    cancel: (id: bigint) => write('cancel', [id]),
    extendReview: (id: bigint) => write('extendReview', [id]),
    withdraw: (id: bigint) => write('withdraw', [id]),
    keeperSweep,
    safety: {
      checkBountyForWorker: (id: bigint, opts: SafetyOptions = {}): Promise<SafetyReport> =>
        checkBountyForWorker({ getBounty, publicClient }, id, opts),
    },
  };
}

export type MADBountyClient = ReturnType<typeof createClient>;
export { isAddressEqual, TERMINAL_STATES, ZERO_ADDRESS };
