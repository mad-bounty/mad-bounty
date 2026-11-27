// Read-only chain access: works with NO wallet. Returns plain view models from ../types.
import {
  createPublicClient, http, isAddressEqual, numberToHex, pad, parseEventLogs, toEventSelector,
  type AbiEvent, type Address, type Hex, type Log, type PublicClient,
} from 'viem';
import { decodeBounty, erc20Abi, madBountyCoreAbi, minDepositFor, ZERO_ADDRESS, type Bounty } from '@madbounty/sdk';
import { CACHE_TTL_MS, CHAINS, LOG_CHUNK, type ChainConfig } from '../config';
import { extractSpec } from './specCalldata';
import type {
  BountySummary, BountyView, ChainId, SpecStatus, TimelineEvent, TimelineKind, VerifierKind,
} from '../types';

const TIMELINE_KINDS: readonly TimelineKind[] = [
  'Posted', 'Cancelled', 'Expired', 'Claimed', 'Submitted', 'ReviewExtended', 'Rejected', 'Reversed',
  'Paid', 'Burned', 'Refunded', 'Abandoned', 'Owed', 'Withdrawn',
];
const coreEvents = (madBountyCoreAbi as readonly { type: string; name?: string }[])
  .filter((x) => x.type === 'event') as unknown as AbiEvent[];
const POSTED_EVENT = coreEvents.find((e) => e.name === 'Posted')!;
export const POSTED_TOPIC = toEventSelector(POSTED_EVENT);

const SPEC_CONCURRENCY = 6;
/** Blocks re-scanned on every incremental Posted scan (~1 min on Base). */
const RESCAN_TAIL = 30n;
/** Blocks re-scanned when a bounty id exists on-chain but wasn't found in our scan. */
const MISS_RESCAN = 2_000n;

export interface PostedRecord {
  id: bigint;
  agent: Address;
  verifier: Address;
  vault: Address;
  reward: bigint;
  deposit: bigint;
  specHash: Hex;
  tx: Hex;
  block: bigint;
}

// ------------------------------------------------------------------ helpers
function isRangeError(e: unknown): boolean {
  const s = `${(e as Error)?.message ?? ''} ${(e as { details?: string })?.details ?? ''}`.toLowerCase();
  return /range|413|too many|limit|exceed|block range|query returned more/.test(s);
}

async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

const ss = (): Storage | undefined => { try { return typeof sessionStorage !== 'undefined' ? sessionStorage : undefined; } catch { return undefined; } };

function serializeSpec(s: SpecStatus): string { return JSON.stringify(s); }

// ------------------------------------------------------------------ reader
export function createReader(chainId: ChainId, opts: { rpc?: string; publicClient?: PublicClient } = {}) {
  const cfg: ChainConfig = CHAINS[chainId];
  const publicClient: PublicClient = opts.publicClient ?? (createPublicClient({
    chain: cfg.viemChain,
    transport: http(opts.rpc ?? cfg.rpc, { batch: { batchSize: 40, wait: 16 }, retryCount: 3, retryDelay: 400, timeout: 30_000 }),
  }) as PublicClient);

  // caches
  const ttl = new Map<string, { at: number; v: unknown }>();
  const cached = async <T>(key: string, fn: () => Promise<T>, ms = CACHE_TTL_MS): Promise<T> => {
    const hit = ttl.get(key);
    if (hit && Date.now() - hit.at < ms) return hit.v as T;
    const p = fn();
    ttl.set(key, { at: Date.now(), v: p });
    try { const v = await p; return v; } catch (e) { ttl.delete(key); throw e; }
  };
  const blockTimes = new Map<bigint, Promise<number>>();
  const codeKind = new Map<string, Promise<'eoa' | 'contract'>>();
  const specCache = new Map<string, SpecStatus>();
  let posted: PostedRecord[] = [];
  let scannedTo: bigint = cfg.deployBlock - 1n;
  let scanning: Promise<PostedRecord[]> | undefined;
  let chunk = LOG_CHUNK;

  async function getLogsChunked(topics: (Hex | null)[], from: bigint, to: bigint): Promise<Log[]> {
    const out: Log[] = [];
    let f = from;
    while (f <= to) {
      const t = f + chunk - 1n < to ? f + chunk - 1n : to;
      try {
        const logs = (await publicClient.request({
          method: 'eth_getLogs',
          params: [{ address: cfg.core, fromBlock: numberToHex(f), toBlock: numberToHex(t), topics }],
        } as never)) as unknown as Log[];
        out.push(...logs);
        f = t + 1n;
      } catch (e) {
        if (isRangeError(e) && chunk > 1n) { chunk = chunk / 2n || 1n; continue; }
        throw e;
      }
    }
    return out;
  }

  const decode = (logs: Log[]) =>
    parseEventLogs({ abi: madBountyCoreAbi, logs: logs.map((l) => ({ ...l, blockNumber: BigInt(l.blockNumber as unknown as string), logIndex: Number(l.logIndex as unknown as string) })) as Log[], strict: false });

  /** Incrementally scan Posted logs from deployBlock (or the last scanned block). */
  async function scanPosted(): Promise<PostedRecord[]> {
    if (scanning) return scanning;
    scanning = (async () => {
      const head = await publicClient.getBlockNumber({ cacheTime: 2_000 });
      if (head > scannedTo) {
        const logs = await getLogsChunked([POSTED_TOPIC], scannedTo + 1n, head);
        for (const ev of decode(logs)) {
          if (ev.eventName !== 'Posted') continue;
          const a = ev.args as Record<string, unknown>;
          const id = a.id as bigint;
          if (posted.some((p) => p.id === id)) continue;
          posted.push({
            id, agent: a.agent as Address, verifier: a.verifier as Address, vault: a.vault as Address,
            reward: a.reward as bigint, deposit: a.deposit as bigint, specHash: a.specHash as Hex,
            tx: ev.transactionHash as Hex, block: ev.blockNumber as bigint,
          });
        }
        posted.sort((x, y) => (x.id < y.id ? -1 : 1));
        // Load-balanced public RPCs can answer getLogs from a node a few blocks behind the one that gave
        // `head` (empty result, no error). Re-scan a short tail every time so a fresh post is never skipped.
        const tail = head - RESCAN_TAIL;
        scannedTo = tail > scannedTo ? tail : scannedTo;
      }
      return posted;
    })();
    try { return await scanning; } finally { scanning = undefined; }
  }

  function blockTime(n?: bigint): Promise<number> {
    if (n === undefined) {
      return cached('latestBlockTime', async () => Number((await publicClient.getBlock({ blockTag: 'latest' })).timestamp), 4_000);
    }
    let p = blockTimes.get(n);
    if (!p) {
      p = publicClient.getBlock({ blockNumber: n }).then((b) => Number(b.timestamp));
      p.catch(() => blockTimes.delete(n));
      blockTimes.set(n, p);
    }
    return p;
  }

  function adapterKind(verifier: Address): VerifierKind | undefined {
    for (const [k, a] of Object.entries(cfg.adapters)) if (isAddressEqual(a as Address, verifier)) return k as VerifierKind;
    return undefined;
  }

  async function verifierKindOf(verifier: Address, agent: Address): Promise<VerifierKind> {
    const ad = adapterKind(verifier);
    if (ad) return ad;
    if (isAddressEqual(verifier, agent)) return 'self';
    const key = verifier.toLowerCase();
    let p = codeKind.get(key);
    if (!p) {
      p = publicClient.getCode({ address: verifier }).then((c) => (!c || c === '0x' ? 'eoa' : 'contract'));
      p.catch(() => codeKind.delete(key));
      codeKind.set(key, p);
    }
    return p;
  }

  async function readBounty(id: bigint): Promise<Bounty> {
    return cached(`bounty:${id}`, async () => {
      const [raw, fee] = await Promise.all([
        publicClient.readContract({ address: cfg.core, abi: madBountyCoreAbi, functionName: 'bounties', args: [id] }),
        publicClient.readContract({ address: cfg.core, abi: madBountyCoreAbi, functionName: 'feeBpsOf', args: [id] }),
      ]);
      return decodeBounty(id, raw as readonly unknown[], fee as bigint);
    });
  }

  /** Spec from the Posted tx input (memory + sessionStorage cache keyed chain:txhash). */
  async function getSpec(postedTx: Hex, specHash: Hex): Promise<SpecStatus> {
    const key = `madb:spec:${chainId}:${postedTx.toLowerCase()}`;
    const mem = specCache.get(key);
    if (mem) return mem;
    const stored = ss()?.getItem(key);
    if (stored) {
      try { const s = JSON.parse(stored) as SpecStatus; specCache.set(key, s); return s; } catch { /* refetch */ }
    }
    const tx = await publicClient.getTransaction({ hash: postedTx });
    const s = extractSpec(tx.input, specHash);
    specCache.set(key, s);
    try { ss()?.setItem(key, serializeSpec(s)); } catch { /* quota */ }
    return s;
  }

  const titleOf = (id: bigint, s: SpecStatus) => (s.kind === 'verified' && s.spec.title.trim() ? s.spec.title.trim() : `Bounty #${id}`);

  async function listBounties(): Promise<BountySummary[]> {
    return cached('list', async () => {
      const recs = await scanPosted();
      const [bounties, specs, times, kinds] = await Promise.all([
        Promise.all(recs.map((r) => readBounty(r.id))),
        pool(recs, SPEC_CONCURRENCY, (r) => getSpec(r.tx, r.specHash).catch((): SpecStatus => ({ kind: 'offchain' }))),
        Promise.all(recs.map((r) => blockTime(r.block).catch(() => 0))),
        Promise.all(recs.map((r) => verifierKindOf(r.verifier, r.agent).catch((): VerifierKind => 'contract'))),
      ]);
      return recs.map((r, i): BountySummary => {
        const b = bounties[i]!;
        return {
          id: r.id, title: titleOf(r.id, specs[i]!), state: b.state, reward: b.reward, deposit: b.deposit,
          agent: b.agent, worker: b.worker, verifier: b.verifier, verifierKind: kinds[i]!, rejectMode: b.rejectMode,
          openUntil: b.openUntil, deadline: b.deadline, postedAt: times[i]!,
        };
      });
    });
  }

  async function getTimeline(id: bigint): Promise<TimelineEvent[]> {
    return cached(`timeline:${id}`, async () => {
      const rec = (await scanPosted()).find((p) => p.id === id);
      const from = rec?.block ?? cfg.deployBlock;
      const head = await publicClient.getBlockNumber({ cacheTime: 2_000 });
      const logs = await getLogsChunked([null, pad(numberToHex(id), { size: 32 })], from, head);
      const evs = decode(logs)
        .filter((e) => (TIMELINE_KINDS as readonly string[]).includes(e.eventName))
        .sort((a, b) => (a.blockNumber === b.blockNumber ? (a.logIndex ?? 0) - (b.logIndex ?? 0) : a.blockNumber! < b.blockNumber! ? -1 : 1));
      const times = await Promise.all(evs.map((e) => blockTime(e.blockNumber as bigint).catch(() => 0)));
      return evs.map((e, i) => ({
        kind: e.eventName as TimelineKind, block: e.blockNumber as bigint, time: times[i]!,
        tx: e.transactionHash as Hex, args: { ...(e.args as Record<string, unknown>) },
      }));
    });
  }

  const nextId = () => publicClient.readContract({ address: cfg.core, abi: madBountyCoreAbi, functionName: 'nextId' }).catch(() => 0n) as Promise<bigint>;

  async function getBountyView(id: bigint): Promise<BountyView> {
    let rec = (await scanPosted()).find((p) => p.id === id);
    if (!rec && id < (await nextId())) {
      // Exists on-chain but our log scan missed it (lagging RPC node): re-scan the recent window once.
      const back = scannedTo - MISS_RESCAN;
      scannedTo = back > cfg.deployBlock - 1n ? back : cfg.deployBlock - 1n;
      rec = (await scanPosted()).find((p) => p.id === id);
    }
    if (!rec) throw new Error(`Bounty #${id} does not exist on ${cfg.name}.`);
    const [bounty, timeline, spec, kind, postedAt] = await Promise.all([
      readBounty(id),
      getTimeline(id),
      getSpec(rec.tx, rec.specHash).catch((): SpecStatus => ({ kind: 'offchain' })),
      verifierKindOf(rec.verifier, rec.agent),
      blockTime(rec.block).catch(() => 0),
    ]);
    const vaultBalance = await usdcBalance(bounty.vault);
    const owedMap = new Map<string, { who: Address; amount: bigint }>();
    for (const ev of timeline) {
      if (ev.kind !== 'Owed' && ev.kind !== 'Withdrawn') continue;
      const who = ev.args.to as Address;
      const cur = owedMap.get(who.toLowerCase()) ?? { who, amount: 0n };
      cur.amount += ev.kind === 'Owed' ? (ev.args.amount as bigint) : -(ev.args.amount as bigint);
      owedMap.set(who.toLowerCase(), cur);
    }
    const owed = [...owedMap.values()].filter((o) => o.amount > 0n);
    return {
      chainId, bounty, specHash: rec.specHash, postedTx: rec.tx, postedAt, verifierKind: kind, vaultBalance,
      title: titleOf(id, spec), spec, timeline, owed: owed.length ? owed : undefined,
    };
  }

  async function usdcBalance(addr: Address): Promise<bigint> {
    return cached(`bal:${addr.toLowerCase()}`, () =>
      publicClient.readContract({ address: cfg.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [addr] }) as Promise<bigint>, 5_000);
  }
  async function allowance(owner: Address): Promise<bigint> {
    return cached(`allow:${owner.toLowerCase()}`, () =>
      publicClient.readContract({ address: cfg.usdc, abi: erc20Abi, functionName: 'allowance', args: [owner, cfg.core] }) as Promise<bigint>, 5_000);
  }
  async function feeBps(): Promise<bigint> {
    return cached('feeBps', () => publicClient.readContract({ address: cfg.core, abi: madBountyCoreAbi, functionName: 'feeBps' }) as Promise<bigint>, 60_000);
  }
  async function minDeposit(reward: bigint): Promise<bigint> {
    try {
      return await (publicClient.readContract({ address: cfg.core, abi: madBountyCoreAbi, functionName: 'minDeposit', args: [reward] }) as Promise<bigint>);
    } catch { return minDepositFor(reward); }
  }
  async function ethBalance(addr: Address): Promise<bigint> {
    return cached(`eth:${addr.toLowerCase()}`, () => publicClient.getBalance({ address: addr }), 5_000);
  }

  /** Drop cached data for one bounty (after a write) or everything. */
  function invalidate(id?: bigint): void {
    ttl.delete('list');
    for (const k of [...ttl.keys()]) {
      if (id === undefined || k === `bounty:${id}` || k === `timeline:${id}` || k.startsWith('bal:') || k.startsWith('allow:') || k.startsWith('eth:')) ttl.delete(k);
    }
  }

  return {
    chainId, config: cfg, publicClient,
    listBounties, getBountyView, getBounty: readBounty, getTimeline, getSpec, scanPosted,
    usdcBalance, allowance, feeBps, minDeposit, ethBalance, blockTime: () => blockTime(), verifierKindOf, invalidate,
    ZERO_ADDRESS,
  };
}

export type Reader = ReturnType<typeof createReader>;
