import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { getAddress, type Address } from 'viem';
import { startChain, KEYS, type Chain } from './anvil.js';
import {
  createClient, hashSpec, hashEvidence, generateEncryptionKeyPair, encryptForAgent, decryptAsAgentString,
  CONSTANTS, type MADBountyClient, type PostParams,
} from '../src/index.js';

let chain: Chain;
let agent: MADBountyClient, worker: MADBountyClient, verifier: MADBountyClient, keeper: MADBountyClient;
const addr = (k: `0x${string}`) => privateKeyToAccount(k).address;
const A = addr(KEYS.agent), W = addr(KEYS.worker), V = addr(KEYS.verifier);
const DEAD = getAddress(CONSTANTS.BURN);
const REWARD = 100_000_000n; // $100
const DEPOSIT = 5_000_000n;  // $5

beforeAll(async () => {
  chain = await startChain();
  const mk = (k: `0x${string}`) =>
    createClient({ publicClient: chain.publicClient as never, walletClient: chain.wallet(k) as never, core: chain.core, usdc: chain.usdc });
  agent = mk(KEYS.agent); worker = mk(KEYS.worker); verifier = mk(KEYS.verifier); keeper = mk(KEYS.keeper);
  await chain.mint(A, 10_000_000_000n);
  await chain.mint(W, 10_000_000_000n);
});
afterAll(async () => { await chain?.stop(); });

async function params(over: Partial<PostParams> = {}): Promise<PostParams> {
  const now = (await chain.publicClient.getBlock()).timestamp;
  return {
    verifier: V, reward: REWARD, deposit: DEPOSIT, workWindow: 86400, reviewWindow: 86400,
    openUntil: now + 7n * 86400n, rejectMode: 'Burn', specHash: hashSpec({ task: 'write a haiku', n: 1 }), ...over,
  };
}

describe('lifecycle on anvil', () => {
  it('post -> claim -> submit -> settleWithSig(accept) pays worker and treasury', async () => {
    const { id } = await agent.post(await params());
    let b = await agent.getBounty(id);
    expect(b.state).toBe('Open');
    expect(b.agent).toBe(A);
    expect(await agent.usdcBalance(b.vault)).toBe(REWARD);

    const open = await worker.listOpenBounties();
    expect(open.map((o) => o.id)).toContain(id);
    expect(open.find((o) => o.id === id)!.specHash).toBe(hashSpec({ n: 1, task: 'write a haiku' }));

    const w0 = await worker.usdcBalance(W);
    await worker.claim(id);
    expect((await worker.getBounty(id)).state).toBe('Claimed');
    expect(await worker.usdcBalance(W)).toBe(w0 - DEPOSIT);

    const ev = hashEvidence('ipfs://evidence');
    await worker.submit(id, ev);
    b = await worker.getBounty(id);
    expect(b.state).toBe('Submitted');
    expect(b.evidenceHash).toBe(ev);

    const sig = await verifier.signVerdict(id, true);
    await keeper.settleWithSig(id, true, sig); // anyone relays
    b = await agent.getBounty(id);
    expect(b.state).toBe('Paid');
    expect(await worker.usdcBalance(W)).toBe(w0 - DEPOSIT + REWARD - 1_000_000n + DEPOSIT);
    expect(await agent.usdcBalance(chain.treasury)).toBe(1_000_000n);
    expect(await agent.usdcBalance(b.vault)).toBe(0n);
    expect((await worker.listOpenBounties()).map((o) => o.id)).not.toContain(id);
  });

  it('signature for wrong accept value is rejected (BadSig)', async () => {
    const { id } = await agent.post(await params());
    await worker.claim(id);
    await worker.submit(id, hashEvidence('e'));
    const sig = await verifier.signVerdict(id, false);
    await expect(keeper.settleWithSig(id, true, sig)).rejects.toThrow(/BadSig/);
    await verifier.settle(id, true); // direct path
    expect((await agent.getBounty(id)).state).toBe('Paid');
  });

  it('reject -> 24h cooling -> finalizeReject burns reward + deposit (Burn mode)', async () => {
    const { id } = await agent.post(await params());
    await worker.claim(id);
    await worker.submit(id, hashEvidence('bad'));
    await keeper.settleWithSig(id, false, await verifier.signVerdict(id, false));
    expect((await agent.getBounty(id)).state).toBe('Rejected');
    await expect(keeper.finalizeReject(id)).rejects.toThrow(/TooEarly/);
    expect((await keeper.findTimeouts()).finalizeReject).not.toContain(id);
    const dead0 = await agent.usdcBalance(DEAD);
    await chain.increaseTime(CONSTANTS.COOLING + 1);
    expect((await keeper.findTimeouts()).finalizeReject).toContain(id);
    await keeper.finalizeReject(id);
    expect((await agent.getBounty(id)).state).toBe('Burned');
    expect(await agent.usdcBalance(DEAD)).toBe(dead0 + REWARD + DEPOSIT);
  });

  it('reject then reverseWithSig pays the worker', async () => {
    const { id } = await agent.post(await params());
    await worker.claim(id);
    await worker.submit(id, hashEvidence('ok'));
    await verifier.settle(id, false);
    await keeper.reverseWithSig(id, await verifier.signReverse(id));
    expect((await agent.getBounty(id)).state).toBe('Paid');
  });

  it('Refund mode reject returns reward to agent and burns deposit', async () => {
    const { id } = await agent.post(await params({ rejectMode: 'Refund' }));
    await worker.claim(id);
    await worker.submit(id, hashEvidence('x'));
    await verifier.settle(id, false);
    await chain.increaseTime(CONSTANTS.COOLING + 1);
    const a0 = await agent.usdcBalance(A);
    await keeper.finalizeReject(id);
    expect((await agent.getBounty(id)).state).toBe('Refunded');
    expect(await agent.usdcBalance(A)).toBe(a0 + REWARD);
  });

  it('verifier silence -> payOnTimeout pays worker; keeperSweep finds and executes it', async () => {
    const { id } = await agent.post(await params());
    await worker.claim(id);
    await worker.submit(id, hashEvidence('y'));
    expect((await keeper.findTimeouts()).payOnTimeout).not.toContain(id);
    await chain.increaseTime(86400 + 1);
    const w0 = await worker.usdcBalance(W);
    const sweep = await keeper.keeperSweep();
    expect(sweep.found.payOnTimeout).toContain(id);
    expect(sweep.results.find((r) => r.id === id)?.hash).toBeTruthy();
    expect((await agent.getBounty(id)).state).toBe('Paid');
    expect(await worker.usdcBalance(W)).toBe(w0 + REWARD - 1_000_000n + DEPOSIT);
  });

  it('direct payOnTimeout and reclaimAbandoned / refundExpired via findTimeouts', async () => {
    const p1 = await agent.post(await params());
    await worker.claim(p1.id);
    await worker.submit(p1.id, hashEvidence('z'));
    const p2 = await agent.post(await params()); // will be abandoned
    await worker.claim(p2.id);
    const now = (await chain.publicClient.getBlock()).timestamp;
    const p3 = await agent.post(await params({ openUntil: now + 3600n })); // will expire
    await chain.increaseTime(86400 + 1);
    const t = await keeper.findTimeouts();
    expect(t.payOnTimeout).toContain(p1.id);
    expect(t.reclaimAbandoned).toContain(p2.id);
    expect(t.refundExpired).toContain(p3.id);
    await keeper.payOnTimeout(p1.id);
    await keeper.reclaimAbandoned(p2.id);
    await keeper.refundExpired(p3.id);
    expect((await agent.getBounty(p1.id)).state).toBe('Paid');
    const b2 = await agent.getBounty(p2.id);
    expect(b2.state).toBe('Open');
    expect(b2.worker).toBe('0x0000000000000000000000000000000000000000');
    expect((await agent.getBounty(p3.id)).state).toBe('Cancelled');
    await agent.cancel(p2.id);
    expect((await agent.getBounty(p2.id)).state).toBe('Cancelled');
  });

  it('claimAuthorizer: claim requires a signed Claim', async () => {
    const { id } = await agent.post(await params({ claimAuthorizer: V }));
    await expect(worker.claim(id)).rejects.toThrow(/TooLate/); // authDeadline 0 is in the past
    const deadline = (await chain.publicClient.getBlock()).timestamp + 600n;
    const forged = await keeper.signClaim(id, W, deadline); // not the authorizer
    await expect(worker.claim(id, { deadline, sig: forged })).rejects.toThrow(/BadSig/);
    const sig = await verifier.signClaim(id, W, deadline);
    await worker.claim(id, { deadline, sig });
    expect((await agent.getBounty(id)).worker).toBe(W);
  });

  it('safety checker flags dangerous bounties', async () => {
    const selfRefund = await agent.post(await params({ verifier: A, rejectMode: 'Refund' }));
    let r = await worker.safety.checkBountyForWorker(selfRefund.id, { worker: W });
    expect(r.safe).toBe(false);
    expect(r.warnings.map((w) => w.code)).toContain('REFUND_SELF_VERIFIED');

    const unknownRefund = await agent.post(await params({ rejectMode: 'Refund' }));
    r = await worker.safety.checkBountyForWorker(unknownRefund.id);
    expect(r.safe).toBe(false);
    expect(r.warnings.map((w) => w.code)).toContain('REFUND_UNKNOWN_VERIFIER');
    r = await worker.safety.checkBountyForWorker(unknownRefund.id, { knownSafeVerifiers: [V] });
    expect(r.safe).toBe(true);

    const highDep = await agent.post(await params({ deposit: 50_000_000n, workWindow: 3600 }));
    r = await worker.safety.checkBountyForWorker(highDep.id, { knownSafeVerifiers: [V] });
    const codes = r.warnings.map((w) => w.code);
    expect(codes).toContain('HIGH_DEPOSIT');
    expect(codes).toContain('SHORT_WORK_WINDOW');
    expect(r.safe).toBe(true);
    expect(r.economics.payoutOnAccept).toBe('149');

    r = await worker.safety.checkBountyForWorker(9999n);
    expect(r.warnings.map((w) => w.code)).toContain('NOT_FOUND');
  });

  it('encKey on-chain roundtrip: worker encrypts to posted key, agent decrypts', async () => {
    const kp = generateEncryptionKeyPair();
    const { id } = await agent.post(await params({ encKey: kp.publicKey }));
    const posted = (await worker.listOpenBounties()).find((o) => o.id === id)!;
    expect(posted.encKey).toBe(kp.publicKey);
    const box = encryptForAgent(posted.encKey, 'credentials: hunter2');
    expect(decryptAsAgentString(kp.privateKey, box)).toBe('credentials: hunter2');
  });

  it('unsigned tx builders encode the same calldata the contract accepts', async () => {
    const p = await params();
    const tx = agent.txs.post(p);
    expect(tx.to).toBe(getAddress(chain.core));
    const wc = chain.wallet(KEYS.agent);
    await agent.approveIfNeeded(REWARD);
    const before = await agent.nextId();
    const hash = await wc.sendTransaction({ to: tx.to, data: tx.data, account: wc.account!, chain: wc.chain });
    await chain.publicClient.waitForTransactionReceipt({ hash });
    expect(await agent.nextId()).toBe(before + 1n);
    expect(await agent.minDeposit(REWARD)).toBe(2_000_000n);
    const m = await agent.manual();
    expect(m.uri).toBe('ipfs://test/llms.txt');
  });
});
void (null as unknown as Address);
