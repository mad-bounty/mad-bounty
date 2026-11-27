// Live write-path check on Base Sepolia with local funded test keys (viem local accounts, NOT injected).
// Run: npx tsx test/chain-write-live.mts      Keys are read from ~/.secrets at runtime and never printed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createWalletClient, formatEther, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAINS } from '../src/config';
import { createReader } from '../src/chain/reads';
import { createWriter } from '../src/chain/writes';
import { specHashOf } from '../src/chain/specCalldata';
import type { TxProgress } from '../src/types';

const CHAIN = 84532 as const;
const cfg = CHAINS[CHAIN];
const loadKey = (f: string): Hex => {
  const raw = readFileSync(join(homedir(), '.secrets', f), 'utf8').trim();
  return (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex;
};
const agentAcc = privateKeyToAccount(loadKey('madb-testnet-deployer3.key'));
const workerAcc = privateKeyToAccount(loadKey('madb-testnet-deployer2.key'));
const verifierAcc = privateKeyToAccount(loadKey('madb-testnet-deployer.key'));

const reader = createReader(CHAIN);
const wc = (account: typeof agentAcc) => createWalletClient({ account, chain: cfg.viemChain, transport: http(cfg.rpc) });
const log = (who: string) => (p: TxProgress) => console.log(`  [${who}] ${p.stage}: ${p.label}${p.hash ? ' ' + p.hash : ''}${p.error ? ' — ' + p.error : ''}`);

for (const [n, a] of [['agent', agentAcc], ['worker', workerAcc], ['verifier', verifierAcc]] as const) {
  const [u, e] = await Promise.all([reader.usdcBalance(a.address), reader.ethBalance(a.address)]);
  console.log(`${n.padEnd(8)} ${a.address} USDC=${Number(u) / 1e6} ETH=${formatEther(e)}`);
}

const agent = createWriter({ chainId: CHAIN, walletClient: wc(agentAcc), account: agentAcc, reader });
const worker = createWriter({ chainId: CHAIN, walletClient: wc(workerAcc), account: workerAcc, reader });
const verifier = createWriter({ chainId: CHAIN, walletClient: wc(verifierAcc), account: verifierAcc, reader });

const title = `App chain-layer E2E ${new Date().toISOString().slice(0, 16)}Z`;
const specJson = JSON.stringify({
  specVersion: 'madb-spec/1', title, summary: 'Automated test of app/src/chain writes.',
  instructions: 'Submit the text "done". Test bounty — no real work.',
  acceptanceCriteria: [{ id: 'c1', description: 'Evidence text is "done"', required: true }],
  evidenceFormat: { type: 'text' }, verifier: { kind: 'address', address: verifierAcc.address },
  deadlines: { workWindowHours: 1, reviewWindowHours: 12 }, language: 'en',
});
const now = BigInt(Math.floor(Date.now() / 1000));

// Pre-flight: a bad call must produce a friendly sentence, not hex (simulate path).
await assert.rejects(worker.cancel(18n, log('worker')), (e: Error) => { console.log(`  friendly revert check: "${e.message}"`); return /state|allowed/i.test(e.message) && !/0x[0-9a-f]{8}/i.test(e.message); });

console.log('POST');
const posted = await agent.post({
  verifier: verifierAcc.address, reward: 1_000_000n, workWindow: 3600, reviewWindow: 12 * 3600,
  openUntil: now + 86_400n, rejectMode: 'Burn', specHash: specHashOf(specJson),
}, specJson, log('agent'));
const id = posted.id;
console.log(`  -> bounty #${id} tx ${posted.hash}`);

console.log('CLAIM');
const c = await worker.claim(id, log('worker'));
console.log('SUBMIT');
const s = await worker.submit(id, 'done', log('worker'));
console.log('SETTLE accept');
const a = await verifier.settle(id, true, log('verifier'));

reader.invalidate(id);
const v = await reader.getBountyView(id);
console.log(`#${id}: state=${v.bounty.state} title="${v.title}" spec=${v.spec.kind} kind=${v.verifierKind} timeline=${v.timeline.map((e) => e.kind).join('>')}`);
assert.equal(v.bounty.state, 'Paid');
assert.equal(v.spec.kind, 'verified');
assert.equal(v.title, title);
assert.equal(v.verifierKind, 'eoa');
const paid = v.timeline.find((e) => e.kind === 'Paid')!;
assert.equal(paid.args.toWorker, 1_000_000n - 50_000n + 1_000_000n);
assert.equal(paid.args.fee, 50_000n);
console.log(`WRITE PATH OK  id=${id} post=${posted.hash} claim=${c.hash} submit=${s.hash} settle=${a.hash}`);
