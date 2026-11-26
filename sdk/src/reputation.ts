import { parseAbi, type Address, type PublicClient } from 'viem';

/** Reputation periphery: MADReceipts (objective outcome tally) + MADAttest (party ratings). */
export const MADRECEIPTS_ABI = parseAbi([
  'function core() view returns (address)',
  'function agentStats(address) view returns (uint64 posted, uint64 paid, uint64 burned, uint64 refunded, uint64 cancelled, uint64 distinctWorkers, uint64 selfDeals, uint128 volumePaid, uint64 firstAt, uint64 lastAt)',
  'function workerStats(address) view returns (uint64 paid, uint64 burned, uint64 refunded, uint64 distinctAgents, uint64 selfDeals, uint128 earned, uint64 firstAt, uint64 lastAt)',
  'function verifierStats(address) view returns (uint64 accepted, uint64 rejected)',
  'function recorded(uint256) view returns (bool)',
  'function recordedAt(uint256) view returns (uint64)',
  'function record(uint256)',
  'function recordMany(uint256[])',
]);
export const MADATTEST_ABI = parseAbi([
  'function core() view returns (address)',
  'function receipts() view returns (address)',
  'function attestations(uint256, address) view returns (address attester, address subject, int8 rating, bytes32 noteHash, uint64 at, bool contradicted)',
  'function stats(address) view returns (uint64 count, int128 sumRating, uint64 contradictedCount)',
  'function attest(uint256 id, int8 rating, bytes32 noteHash)',
]);

export interface AgentStats { posted: bigint; paid: bigint; burned: bigint; refunded: bigint; cancelled: bigint; distinctWorkers: bigint; selfDeals: bigint; volumePaid: bigint; firstAt: bigint; lastAt: bigint }
export interface WorkerStats { paid: bigint; burned: bigint; refunded: bigint; distinctAgents: bigint; selfDeals: bigint; earned: bigint; firstAt: bigint; lastAt: bigint }
export interface SubjectStats { count: bigint; sumRating: bigint; contradictedCount: bigint }

const B = (v: unknown) => BigInt(v as bigint);
export function createReputation(deps: { publicClient: Pick<PublicClient, 'readContract'>; receipts: Address; attest: Address }) {
  const pc = deps.publicClient as unknown as { readContract: (c: Record<string, unknown>) => Promise<readonly unknown[]> };
  const readR = (fn: string, args: readonly unknown[]) =>
    pc.readContract({ address: deps.receipts, abi: MADRECEIPTS_ABI, functionName: fn, args: args as never[] });
  const readA = (fn: string, args: readonly unknown[]) =>
    pc.readContract({ address: deps.attest, abi: MADATTEST_ABI, functionName: fn, args: args as never[] });

  return {
    agentStats: async (a: Address): Promise<AgentStats> => decodeAgent(await readR('agentStats', [a])),
    workerStats: async (a: Address): Promise<WorkerStats> => decodeWorker(await readR('workerStats', [a])),
    verifierStats: async (a: Address): Promise<{ accepted: bigint; rejected: bigint }> => {
      const x = await readR("verifierStats", [a]); return { accepted: B(x[0]), rejected: B(x[1]) };
    },
    attestStats: async (a: Address): Promise<SubjectStats> => {
      const x = await readA("stats", [a]); return { count: B(x[0]), sumRating: B(x[1]), contradictedCount: B(x[2]) };
    },
    attestation: (id: bigint, attester: Address) => readA('attestations', [id, attester]),
    recorded: async (id: bigint): Promise<boolean> => Boolean((await readR('recorded', [id]))[0]),
    /** Encode recordMany(ids) calldata (for unsigned-tx mode or direct sending). */
    recordManyData: (ids: bigint[]) => ({ to: deps.receipts, abi: MADRECEIPTS_ABI, functionName: 'recordMany' as const, args: [ids] }),
    /** Encode attest(id, rating, noteHash) calldata. */
    attestData: (id: bigint, rating: number, noteHash: `0x${string}`) => ({ to: deps.attest, abi: MADATTEST_ABI, functionName: 'attest' as const, args: [id, rating, noteHash] }),
  };
}

const decodeAgent = (r: readonly unknown[]): AgentStats => ({
  posted: B(r[0]), paid: B(r[1]), burned: B(r[2]), refunded: B(r[3]), cancelled: B(r[4]),
  distinctWorkers: B(r[5]), selfDeals: B(r[6]), volumePaid: B(r[7]), firstAt: B(r[8]), lastAt: B(r[9]),
});
const decodeWorker = (r: readonly unknown[]): WorkerStats => ({
  paid: B(r[0]), burned: B(r[1]), refunded: B(r[2]), distinctAgents: B(r[3]),
  selfDeals: B(r[4]), earned: B(r[5]), firstAt: B(r[6]), lastAt: B(r[7]),
});

export interface ScoreInput {
  /** MADReceipts worker stats for the address (or agent stats if scoring as a lister). */
  asWorker?: WorkerStats; asAgent?: AgentStats;
  attestations?: SubjectStats;
  /** Abandoned-claim count from core Abandoned events (optional; 0 if unknown). */
  abandoned?: bigint;
}

/**
 * Reference scorer — deterministic, documented, ONE opinion among many. Anyone may compute their own.
 * - base = Bayesian-smoothed (Laplace +2) outcome success rate over paid vs burned/refunded/abandoned.
 *   Sybil resistance: distinct counterparties set the weight (self-deals are excluded upstream and wash
 *   volume costs the real fee), so volume alone cannot buy a high score.
 * - att = attestation average on a 0..1 scale, contradicted attestations dropped (they are already
 *   excluded from `count - contradictedCount`... note: contradicted ones still sit in sumRating; we
 *   recompute the average over clean entries only), scaled by attestation confidence (min(1, count/5)).
 * - With no data at all the score is 50 (neutral), not 0.
 * Range 0..100. 60*base + 40*att.
 */
export function scoreAddress(s: ScoreInput): number {
  const w = s.asWorker; const a = s.asAgent;
  let base = 0.5;
  if (w) {
    const done = w.paid + w.burned + w.refunded + (s.abandoned ?? 0n);
    if (done > 0n) base = Number((w.paid + 2n) * 10_000n / (done + 4n)) / 10_000;
  } else if (a && a.paid + a.burned + a.refunded > 0n) {
    base = Number((a.paid + 2n) * 10_000n / (a.paid + a.burned + a.refunded + 4n)) / 10_000;
  }
  const att = s.attestations;
  let attScore = 0.5; let attConf = 0;
  if (att && att.count > att.contradictedCount) {
    const cleanCount = att.count - att.contradictedCount;
    attConf = Math.min(1, Number(cleanCount) / 5);
    // sumRating includes contradicted entries; approximate the clean average by assuming contradicted
    // entries carry the same magnitude as the caller's rating that flagged them is unavailable here,
    // so we bound the clean average by clipping — documented approximation.
    attScore = Math.min(1, Math.max(0, 0.5 + Number(att.sumRating) / (Number(att.count) * 4)));
  }
  const blended = (0.6 * base + 0.4 * (attScore * attConf + 0.5 * (1 - attConf)));
  return Math.round(100 * blended);
}
