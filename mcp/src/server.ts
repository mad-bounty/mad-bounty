import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import {
  EIP712_TYPES, encryptForAgent, hashEvidence, formatUsdc, hashSpec, minDepositFor, parseUsdc, type UnsignedTx,
  createReputation, MADRECEIPTS_ABI,
} from '@madbounty/sdk';
import { encodeFunctionData } from 'viem';
import { makeRuntime, type Runtime, type ServerConfig } from './config.js';

export const VERSION = '0.1.0';

const BUILTIN_MANUAL = `# MAD Bounty v1 (summary; full manual not bundled with this install)
Immutable dual-deposit USDC escrow on Base for agent-posted bounties. No owner, no upgrades, no appeals.
- Agent posts: escrows reward P (1..1000 USDC). Names a verifier, work window (1h..30d), review window (12h..30d), openUntil (<=180d), rejectMode BURN or REFUND, specHash.
- Worker claims: escrows deposit D >= max(1 USDC, 2% of P). Must submit evidenceHash before the work deadline or D burns and the bounty reopens.
- Fee: the rate locked when the bounty was posted (feeBpsOf(id)); starts at 5% (MAX_FEE_BPS), the treasury can only lower it for new bounties, never raise it.
- Verifier decides while Submitted. ACCEPT: worker gets P - fee + D. REJECT: 24h cooling (verifier may Reverse), then BURN (P+D burned) or REFUND (P to agent, D burned).
- Verifier silence past the review deadline: anyone calls payOnTimeout and the worker is paid.
- REFUND mode with the agent (or an agent-controlled key) as verifier lets the agent take work for free. Workers must check the verifier.
Full manual: llms-full.txt in the MAD Bounty repo (docs/llms-full.txt), and the manualURI/manualHash stored on the core contract.`;

const addr = z.string().refine((s) => isAddress(s, { strict: false }), 'must be a 0x address');
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be 0x + 64 hex chars (bytes32)');
const idSchema = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).describe('Bounty id (decimal).');
const usdcAmount = z.union([z.string(), z.number()]).describe('USDC amount in whole-dollar decimal form, e.g. "25" or "12.5" (NOT base units).');

/** JSON with bigint -> string. */
function json(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
}
const ok = (v: unknown) => ({ content: [{ type: 'text' as const, text: json(v) }] });
const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: 'text' as const, text: `Error: ${(e instanceof Error ? e.message : String(e)).split('\n').slice(0, 3).join(' ')}` }],
});
function wrap<A>(fn: (a: A) => Promise<unknown>) {
  return async (a: A) => { try { return ok(await fn(a)); } catch (e) { return fail(e); } };
}

function loadManual(cfg: ServerConfig): { source: string; text: string } {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [cfg.manualPath, join(here, '..', '..', 'docs', 'llms-full.txt'), join(process.cwd(), 'docs', 'llms-full.txt')]
    .filter((p): p is string => !!p);
  for (const p of candidates) if (existsSync(p)) return { source: p, text: readFileSync(p, 'utf8') };
  return { source: 'builtin', text: BUILTIN_MANUAL };
}

const UNSIGNED_NOTE =
  'MADB_PRIVATE_KEY is not set, so nothing was sent. Sign and broadcast these transactions IN ORDER from the acting wallet (host wallet). Each has to/data/value (value is 0; amounts are in calldata).';

function unsigned(txs: UnsignedTx[], extra: Record<string, unknown> = {}) {
  return { mode: 'unsigned', note: UNSIGNED_NOTE, transactions: txs, ...extra };
}

export function createServer(cfg: ServerConfig) {
  const rt: Runtime = makeRuntime(cfg);
  const server = new McpServer({ name: 'madbounty', version: VERSION });
  const bid = (v: string | number) => BigInt(v);
  const knownSafe = (extra?: string[]) => [...cfg.knownVerifiers, ...(extra ?? []).filter((s): s is Address => isAddress(s)).map((a) => getAddress(a))];

  const bountyView = async (id: bigint) => {
    const c = rt.client();
    const b = await c.getBounty(id);
    const now = (await c.publicClient.getBlock()).timestamp;
    return {
      ...b,
      rewardUsdc: formatUsdc(b.reward), depositUsdc: formatUsdc(b.deposit), feePct: Number(b.feeBps) / 100,
      chainTime: now,
      secondsToDeadline: b.deadline > 0n ? Number(b.deadline - now) : null,
    };
  };

  // ---------------------------------------------------------------- read-only
  server.registerTool('madb_get_manual', {
    title: 'MAD Bounty manual',
    description:
      'Return the full MAD Bounty protocol manual (llms-full.txt): rules, money flows, every function, failure modes and safety rules. ' +
      'Call this FIRST if you have not read the manual in this session, before posting, claiming or verifying anything. Read-only, free.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, wrap(async () => {
    const m = loadManual(cfg);
    let onchain: unknown = null;
    if (cfg.core) { try { onchain = await rt.client().manual(); } catch { onchain = null; } }
    return { source: m.source, onchainPointer: onchain, manual: m.text };
  }));

  server.registerTool('madb_list_open_bounties', {
    title: 'List open bounties',
    description:
      'List bounties that are currently claimable (state Open and openUntil not passed), from Posted events plus live state. ' +
      'Returns id, agent, verifier, reward/deposit (USDC), windows (seconds), rejectMode, claimAuthorizer, specHash, encKey. ' +
      'The spec text is off-chain: you must get it from the agent and check it hashes to specHash (madb_hash_spec). ' +
      'Before claiming any result, run madb_check_bounty_safety on it. Read-only.',
    inputSchema: {
      fromBlock: z.union([z.string(), z.number()]).optional().describe('Start block for the Posted-log scan (default MADB_FROM_BLOCK or 0). Use the core deploy block on public RPCs.'),
      limit: z.number().int().positive().max(500).optional().describe('Max results (default 50), newest first.'),
    },
    annotations: { readOnlyHint: true },
  }, wrap(async ({ fromBlock, limit }) => {
    const list = await rt.client().listOpenBounties({ fromBlock: fromBlock !== undefined ? BigInt(fromBlock) : cfg.fromBlock });
    const out = list.reverse().slice(0, limit ?? 50).map((b) => ({
      id: b.id, agent: b.agent, verifier: b.verifier, rewardUsdc: formatUsdc(b.reward), depositUsdc: formatUsdc(b.deposit),
      workWindow: b.workWindow, reviewWindow: b.reviewWindow, openUntil: b.openUntil, rejectMode: b.rejectMode,
      claimAuthorizer: b.claimAuthorizer, specHash: b.specHash, encKey: b.encKey, verifierIsAgent: b.agent === b.verifier,
    }));
    return { count: out.length, bounties: out };
  }));

  server.registerTool('madb_get_bounty', {
    title: 'Get bounty',
    description:
      'Read one bounty\'s full on-chain record: agent, verifier, worker, vault, reward/deposit, windows, state ' +
      '(None|Open|Claimed|Submitted|Rejected|Paid|Burned|Refunded|Cancelled), current phase deadline, rejectMode, evidenceHash, feeBps/feePct (fee locked at post time), ' +
      'plus chain time and seconds left until the deadline. Use it to check state before any write. Read-only.',
    inputSchema: { id: idSchema },
    annotations: { readOnlyHint: true },
  }, wrap(async ({ id }) => bountyView(bid(id))));
  const reputationOf = async (address: string) => {
    const rc = cfg.reputation?.receipts; const at = cfg.reputation?.attest;
    if (!rc && !at) throw new Error('reputation contracts not configured for this chain (MADB_RECEIPTS / MADB_ATTEST or DEPLOYMENTS)');
    const rep = createReputation({ publicClient: rt.client().publicClient as never, receipts: rc!, attest: at! });
    const [agentStats, workerStats, attestStats] = await Promise.all([
      rc ? rep.agentStats(getAddress(address)) : Promise.resolve(null),
      rc ? rep.workerStats(getAddress(address)) : Promise.resolve(null),
      at ? rep.attestStats(getAddress(address)) : Promise.resolve(null),
    ]);
    return { address: getAddress(address), asAgent: agentStats, asWorker: workerStats, attestations: attestStats,
      note: 'facts are objective on-chain tallies; any scorer may interpret them' };
  };

  server.registerTool('madb_reputation', {
    title: 'Reputation of an address',
    description:
      'Objective on-chain record for any address: bounties posted/paid/burned/refunded/cancelled, distinct counterparties, ' +
      'self-deals flagged, volume paid or earned, and party-to-party attestation aggregates (count, sum, contradicted). ' +
      'These are FACTS read from MADReceipts/MADAttest, not opinions; compute your own score from them. Read-only.',
    inputSchema: { address: z.string().describe('The address to look up.') },
    annotations: { readOnlyHint: true },
  }, wrap(async ({ address }) => reputationOf(address)));

  server.registerTool('madb_record_receipts', {
    title: 'Record terminal bounties — writes onchain',
    description:
      'Call MADReceipts.recordMany(ids) to seal the outcome tally for terminal bounties (Paid/Burned/Refunded/Cancelled). ' +
      'Permissionless keeper action: anyone may record; each bounty is recorded exactly once. Without MADB_PRIVATE_KEY returns an unsigned transaction.',
    inputSchema: { ids: z.array(z.number().int().positive()).min(1).max(200).describe('Bounty ids to record.') },
  }, wrap(async ({ ids }) => {
    const rc = cfg.reputation?.receipts;
    if (!rc) throw new Error('MADB_RECEIPTS not configured');
    const data = encodeFunctionData({ abi: MADRECEIPTS_ABI, functionName: 'recordMany', args: [ids.map(BigInt)] });
    // permissionless keeper action: return the tx for any wallet to broadcast (even with a signer configured)
    return unsigned([{ to: rc, data, value: 0n }], { ids });
  }));


  server.registerTool('madb_check_bounty_safety', {
    title: 'Check bounty safety (worker)',
    description:
      'Run the worker-side safety check on a bounty BEFORE claiming it. Claiming locks your deposit, which burns on reject or a missed work window. ' +
      'Returns safe=false with DANGER warnings for: REFUND mode where the verifier is the agent, an unknown verifier, or a known adapter whose ' +
      'per-bounty config uses signers you do not trust (pass trustedSigners) or an OnchainCheck the agent could falsify (the agent can then take your work for free); ' +
      'bounty not Open; expired. WARN for high deposit/reward ratio, short work window, unknown verifier, OnchainCheck targets to read. ' +
      'Do NOT claim when safe=false unless a human explicitly accepts the risk. Read-only.',
    inputSchema: {
      id: idSchema,
      knownSafeVerifiers: z.array(addr).optional().describe('Extra verifier addresses you trust (added to MADB_KNOWN_VERIFIERS).'),
      worker: addr.optional().describe('Your address (defaults to the MADB_PRIVATE_KEY signer), to flag self-dealing.'),
      trustedSigners: z.array(addr).optional().describe('Signer keys you trust as independent of the agent (human verifiers, oracle keys, 0G enclave signers). Added to MADB_TRUSTED_SIGNERS. Adapter signers not on this list make a REFUND bounty unsafe.'),
    },
    annotations: { readOnlyHint: true },
  }, wrap(async ({ id, knownSafeVerifiers, worker, trustedSigners }) => {
    const w = (worker as Address | undefined) ?? rt.signer;
    const r = await rt.client().safety.checkBountyForWorker(bid(id), {
      knownSafeVerifiers: knownSafe(knownSafeVerifiers), worker: w, adapters: cfg.adapters,
      trustedSigners: [...cfg.trustedSigners, ...((trustedSigners as Address[] | undefined) ?? [])],
    });
    return r;
  }));

  server.registerTool('madb_hash_spec', {
    title: 'Hash a spec',
    description:
      'Compute the specHash for a bounty spec: keccak256 of canonical JSON (keys sorted, no whitespace). ' +
      'Agents: hash the exact spec you will publish, then pass it to madb_post_bounty. Workers: hash the spec the agent gave you and ' +
      'compare with the on-chain specHash; a mismatch means the spec you were shown is not the one the verifier will judge. Pure, no chain access.',
    inputSchema: { spec: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]).describe('Spec as a JSON object or a JSON string.') },
    annotations: { readOnlyHint: true },
  }, wrap(async ({ spec }) => ({ specHash: hashSpec(spec) })));

  server.registerTool('madb_encrypt_for_agent', {
    title: 'Encrypt for agent',
    description:
      'Encrypt a secret (credentials, private deliverable) to a bounty agent\'s x25519 public key (the encKey from the Posted event / madb_list_open_bounties). ' +
      'Output is a hex box (x25519 + HKDF-SHA256 + XChaCha20-Poly1305) only the agent can open. Never put plaintext secrets in evidence or on-chain. Pure, no chain access.',
    inputSchema: {
      agentPubKey: hex32.describe('Agent x25519 public key (32 bytes hex).'),
      plaintext: z.string().describe('UTF-8 text to encrypt.'),
    },
    annotations: { readOnlyHint: true },
  }, wrap(async ({ agentPubKey, plaintext }) => ({ box: encryptForAgent(agentPubKey as Hex, plaintext) })));

  // ---------------------------------------------------------------- writes
  server.registerTool('madb_post_bounty', {
    title: 'Post bounty (agent) — MOVES USDC',
    description:
      'Post a new bounty as the agent. MONEY AT RISK: pulls the full reward in USDC from the signer into escrow (approves the core first if needed). ' +
      'You get it back only via cancel (while Open), refundExpired (after openUntil, unclaimed), or a REFUND-mode reject. In BURN mode a reject burns the reward. ' +
      'On accept or verifier silence the worker is paid reward-fee+deposit (fee = core.feeBps() at post time, max 5%, locked per bounty). Preconditions: reward 1..1000 USDC; deposit >= max(1, 2% of reward) and <= reward; ' +
      'workWindow 3600..2592000 s; reviewWindow 43200..2592000 s; openUntilDays <= 180; verifier must be able to sign/settle. ' +
      'Workers avoid REFUND bounties verified by the agent itself. Without MADB_PRIVATE_KEY returns unsigned approve+post transactions.',
    inputSchema: {
      verifier: addr.describe('Address that will accept/reject (EOA, ERC-1271 wallet, or adapter contract).'),
      reward: usdcAmount,
      deposit: usdcAmount.optional().describe('Worker deposit in USDC decimal; default max(1, 2% of reward).'),
      workWindowSeconds: z.number().int().describe('Time the worker has after claiming to submit (3600..2592000).'),
      reviewWindowSeconds: z.number().int().describe('Time the verifier has after submit; silence pays the worker (43200..2592000).'),
      openUntilDays: z.number().positive().max(180).describe('Days the bounty stays claimable.'),
      rejectMode: z.enum(['Burn', 'Refund']).optional().describe('Burn (default): reject burns reward+deposit. Refund: reject returns reward to agent, burns deposit.'),
      specHash: hex32.optional().describe('bytes32 spec hash; or pass spec instead.'),
      spec: z.unknown().optional().describe('Spec JSON (hashed with madb_hash_spec rules) if specHash not given.'),
      claimAuthorizer: addr.optional().describe('If set, this address must sign an EIP-712 Claim for each worker.'),
      encKey: z.string().regex(/^0x([0-9a-fA-F]{64})?$/).optional().describe('Agent x25519 public key for encrypted secrets.'),
      verifierInit: z.string().regex(/^0x([0-9a-fA-F]{2})*$/).optional().describe('ABI-encoded adapter config. When the verifier is an adapter contract, ALWAYS pass this so the adapter is configured atomically in the same tx (otherwise a worker can claim before configuration). See periphery/README.md for each adapter\'s encoding.'),
    },
    annotations: { destructiveHint: true },
  }, wrap(async (a) => {
    if (!a.specHash && a.spec === undefined) throw new Error('provide specHash or spec');
    const c = rt.client();
    const now = (await c.publicClient.getBlock()).timestamp;
    const reward = parseUsdc(a.reward);
    const p = {
      verifier: getAddress(a.verifier), reward,
      deposit: a.deposit !== undefined ? parseUsdc(a.deposit) : minDepositFor(reward),
      workWindow: a.workWindowSeconds, reviewWindow: a.reviewWindowSeconds,
      openUntil: now + BigInt(Math.floor(a.openUntilDays * 86400)),
      rejectMode: a.rejectMode ?? 'Burn', specHash: (a.specHash ?? hashSpec(a.spec)) as Hex,
      claimAuthorizer: a.claimAuthorizer ? getAddress(a.claimAuthorizer) : undefined,
      encKey: (a.encKey ?? '0x') as Hex,
      verifierInit: (a.verifierInit ?? '0x') as Hex,
    } as const;
    if (!rt.signer) return unsigned([c.txs.approve(c.core, reward), c.txs.post(p)], { params: p });
    const r = await c.post(p);
    return { mode: 'sent', id: r.id, txHash: r.hash, params: p };
  }));

  server.registerTool('madb_claim', {
    title: 'Claim bounty (worker) — MOVES USDC',
    description:
      'Claim an Open bounty as the worker. MONEY AT RISK: pulls the deposit in USDC from the signer (approves first if needed). ' +
      'The deposit BURNS if the verifier rejects or you miss the work window. You must submit before deadline = now + workWindow. ' +
      'ALWAYS run madb_check_bounty_safety first and refuse if safe=false. Verify the spec you were given hashes to the on-chain specHash. ' +
      'If claimAuthorizer is set, pass authDeadline + authSig from the authorizer. Without MADB_PRIVATE_KEY returns unsigned approve+claim transactions.',
    inputSchema: {
      id: idSchema,
      authDeadline: z.union([z.string(), z.number()]).optional().describe('Claim authorization deadline (unix seconds), only if claimAuthorizer is set.'),
      authSig: z.string().regex(/^0x[0-9a-fA-F]*$/).optional().describe('EIP-712 Claim signature from claimAuthorizer.'),
    },
    annotations: { destructiveHint: true },
  }, wrap(async ({ id, authDeadline, authSig }) => {
    const c = rt.client();
    const b = await c.getBounty(bid(id));
    if (b.state !== 'Open') throw new Error(`bounty ${id} is ${b.state}, not Open`);
    const auth = authSig ? { deadline: BigInt(authDeadline ?? 0), sig: authSig as Hex } : undefined;
    if (!rt.signer)
      return unsigned([c.txs.approve(c.core, b.deposit), c.txs.claim(b.id, auth?.deadline, auth?.sig)], { depositUsdc: formatUsdc(b.deposit) });
    const r = await c.claim(b.id, auth);
    const after = await c.getBounty(b.id);
    return { mode: 'sent', txHash: r.hash, workDeadline: after.deadline, depositUsdc: formatUsdc(b.deposit) };
  }));

  server.registerTool('madb_submit', {
    title: 'Submit evidence (worker)',
    description:
      'Submit the evidence hash for a bounty you claimed. Only the worker, only while Claimed and before the work deadline. ' +
      'Starts the review window; if the verifier stays silent past it, anyone can pay you via madb_keeper_sweep. ' +
      'evidenceHash is bytes32 (e.g. keccak256 of your deliverable or its URI); the verifier signs over it, so it cannot be changed after submit. ' +
      'Deliver the actual work to the agent/verifier off-chain. Without MADB_PRIVATE_KEY returns an unsigned transaction.',
    inputSchema: {
      id: idSchema,
      evidenceHash: hex32.optional().describe('bytes32 evidence hash.'),
      evidence: z.string().optional().describe('Alternatively, evidence text/URI; hashed as keccak256(utf8).'),
    },
    annotations: { destructiveHint: false },
  }, wrap(async ({ id, evidenceHash, evidence }) => {
    const c = rt.client();
    const h = (evidenceHash ?? (evidence !== undefined ? hashEvidence(evidence) : undefined)) as Hex | undefined;
    if (!h) throw new Error('provide evidenceHash or evidence');
    if (!rt.signer) return unsigned([c.txs.submit(bid(id), h)], { evidenceHash: h });
    const r = await c.submit(bid(id), h);
    const b = await c.getBounty(bid(id));
    return { mode: 'sent', txHash: r.hash, evidenceHash: h, reviewDeadline: b.deadline };
  }));

  server.registerTool('madb_settle', {
    title: 'Settle / verdict (verifier) — MOVES USDC',
    description:
      'Verifier verdict on a Submitted bounty. MONEY AT RISK and IRREVERSIBLE except as noted: accept pays the worker reward-fee+deposit at once (fee locked at post, max 5%). ' +
      'reject starts 24h cooling, then BURN mode burns reward+deposit (REFUND mode: reward back to agent, deposit burned). ' +
      'reverse (verifier only, during cooling) turns a reject into an accept. Judge strictly against the spec that hashes to specHash. ' +
      'mode=direct: signer must be the verifier and calls settle/reverse. mode=sign: signer (the verifier) returns an EIP-712 signature for anyone to relay. ' +
      'mode=relay: submit a verifier signature you were given (signer pays gas, needs no role). Without MADB_PRIVATE_KEY: direct/relay return an unsigned tx, ' +
      'sign returns the EIP-712 typed data for the host wallet to sign.',
    inputSchema: {
      id: idSchema,
      verdict: z.enum(['accept', 'reject', 'reverse']),
      mode: z.enum(['direct', 'sign', 'relay']).optional().describe('Default direct.'),
      signature: z.string().regex(/^0x[0-9a-fA-F]+$/).optional().describe('Verifier signature, required for mode=relay.'),
    },
    annotations: { destructiveHint: true },
  }, wrap(async ({ id, verdict, mode, signature }) => {
    const c = rt.client();
    const b = await c.getBounty(bid(id));
    const m = mode ?? 'direct';
    const isReverse = verdict === 'reverse';
    const accept = verdict === 'accept';
    const need = isReverse ? 'Rejected' : 'Submitted';
    if (b.state !== need) throw new Error(`bounty ${id} is ${b.state}; ${verdict} needs ${need}`);
    if (m === 'relay' && !signature) throw new Error('mode=relay needs signature');
    if (m === 'sign') {
      if (rt.signer) {
        const sig = isReverse ? await c.signReverse(b.id, b) : await c.signVerdict(b.id, accept, b);
        return { mode: 'signed', signer: rt.signer, verifier: b.verifier, signerIsVerifier: rt.signer === b.verifier, signature: sig };
      }
      const domain = await c.domain();
      const typedData = isReverse
        ? { domain, types: { Reverse: EIP712_TYPES.Reverse }, primaryType: 'Reverse', message: { id: b.id, worker: b.worker, evidenceHash: b.evidenceHash } }
        : { domain, types: { Verdict: EIP712_TYPES.Verdict }, primaryType: 'Verdict', message: { id: b.id, worker: b.worker, evidenceHash: b.evidenceHash, accept } };
      return { mode: 'unsigned-typed-data', note: 'Sign with eth_signTypedData_v4 from the verifier wallet, then call madb_settle mode=relay.', typedData };
    }
    const tx = m === 'relay'
      ? (isReverse ? c.txs.reverseWithSig(b.id, signature as Hex) : c.txs.settleWithSig(b.id, accept, signature as Hex))
      : (isReverse ? c.txs.reverse(b.id) : c.txs.settle(b.id, accept));
    if (!rt.signer) return unsigned([tx]);
    if (m === 'direct' && rt.signer !== b.verifier) throw new Error(`signer ${rt.signer} is not the verifier ${b.verifier}; use mode=sign on the verifier or mode=relay`);
    const r = m === 'relay'
      ? (isReverse ? await c.reverseWithSig(b.id, signature as Hex) : await c.settleWithSig(b.id, accept, signature as Hex))
      : (isReverse ? await c.reverse(b.id) : await c.settle(b.id, accept));
    const after = await c.getBounty(b.id);
    return { mode: 'sent', txHash: r.hash, state: after.state, deadline: after.deadline };
  }));

  server.registerTool('madb_keeper_sweep', {
    title: 'Keeper sweep (permissionless timeouts)',
    description:
      'Find bounties whose permissionless timeout has passed and (with a key) execute them: payOnTimeout (verifier silent -> worker paid), ' +
      'finalizeReject (cooling over -> burn/refund), reclaimAbandoned (work window missed -> deposit burned, bounty reopens), ' +
      'refundExpired (unclaimed past openUntil -> reward to agent). Anyone may call these; the caller only pays gas and receives nothing. ' +
      'dryRun=true (or no MADB_PRIVATE_KEY) only lists them / returns unsigned txs.',
    inputSchema: {
      ids: z.array(idSchema).optional().describe('Limit to these ids (default: all ids).'),
      dryRun: z.boolean().optional(),
    },
    annotations: { destructiveHint: true },
  }, wrap(async ({ ids, dryRun }) => {
    const c = rt.client();
    const list = ids?.map(bid);
    if (dryRun || !rt.signer) {
      const t = await c.findTimeouts({ ids: list });
      const txs = [
        ...t.payOnTimeout.map(c.txs.payOnTimeout), ...t.finalizeReject.map(c.txs.finalizeReject),
        ...t.reclaimAbandoned.map(c.txs.reclaimAbandoned), ...t.refundExpired.map(c.txs.refundExpired),
      ];
      return rt.signer ? { mode: 'dry-run', found: t, transactions: txs } : unsigned(txs, { found: t });
    }
    const r = await c.keeperSweep({ ids: list });
    return { mode: 'sent', ...r };
  }));

  server.registerTool('madb_withdraw', {
    title: 'Withdraw owed funds',
    description:
      'Withdraw USDC credited to you in owed[id][you] when a direct payout failed (e.g. your address was temporarily blocked by the token). ' +
      'Only needed after an Owed event; check with owedOnly=true first. Sends funds to the signer. Without MADB_PRIVATE_KEY returns an unsigned tx.',
    inputSchema: {
      id: idSchema,
      account: addr.optional().describe('Address to check (defaults to signer).'),
      owedOnly: z.boolean().optional().describe('Only report the owed amount; do not withdraw.'),
    },
    annotations: { destructiveHint: false },
  }, wrap(async ({ id, account, owedOnly }) => {
    const c = rt.client();
    const who = (account as Address | undefined) ?? rt.signer;
    const owed = who ? await c.owed(bid(id), getAddress(who)) : undefined;
    if (owedOnly) return { account: who, owed, owedUsdc: owed !== undefined ? formatUsdc(owed) : undefined };
    if (!rt.signer) return unsigned([c.txs.withdraw(bid(id))], { account: who, owed });
    if (!owed) throw new Error('nothing owed to signer for this bounty');
    const r = await c.withdraw(bid(id));
    return { mode: 'sent', txHash: r.hash, amountUsdc: formatUsdc(owed) };
  }));

  return { server, runtime: rt };
}
