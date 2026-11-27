// Live read-path check against Base Sepolia, no private key.  Run: npx tsx test/chain-live.mts
import assert from 'node:assert/strict';
import { createReader } from '../src/chain/reads';

const r = createReader(84532);
const t0 = Date.now();
const list = await r.listBounties();
const t1 = Date.now();
console.log(`listBounties: ${list.length} bounties in ${t1 - t0} ms`);
for (const b of list) {
  console.log(`  #${b.id} ${b.state.padEnd(9)} ${(Number(b.reward) / 1e6).toFixed(2).padStart(7)} USDC  ${b.verifierKind.padEnd(12)} ${b.title}`);
}
assert.ok(list.length >= 18, 'expected >= 18 bounties');

const v3 = await r.getBountyView(3n);
const kinds3 = v3.timeline.map((e) => e.kind);
console.log(`#3: state=${v3.bounty.state} reward=${v3.bounty.reward} vault=${v3.vaultBalance} kind=${v3.verifierKind} spec=${v3.spec.kind} timeline=${kinds3.join('>')}`);
assert.equal(v3.bounty.state, 'Paid');
assert.equal(v3.bounty.reward, 1_000_000n);
for (const k of ['Posted', 'Claimed', 'Submitted', 'Paid']) assert.ok(kinds3.includes(k as never), `#3 timeline has ${k}`);
assert.ok(v3.timeline.every((e) => e.time > 1_700_000_000), 'timeline has block timestamps');

const v18 = await r.getBountyView(18n);
console.log(`#18: state=${v18.bounty.state} title="${v18.title}" spec=${v18.spec.kind}${v18.spec.kind === 'verified' ? ` (${v18.spec.bytes} bytes)` : ''} timeline=${v18.timeline.map((e) => e.kind).join('>')}`);
assert.equal(v18.spec.kind, 'verified');
if (v18.spec.kind === 'verified') assert.equal(v18.spec.spec.title, 'Calldata spec probe');
assert.equal(v18.title, 'Calldata spec probe');
assert.equal(v18.bounty.state, 'Cancelled');

console.log(`feeBps=${await r.feeBps()} minDeposit(100 USDC)=${await r.minDeposit(100_000_000n)} blockTime=${await r.blockTime()}`);
console.log(`cached re-list: ${(await (async () => { const a = Date.now(); await r.listBounties(); return Date.now() - a; })())} ms`);
console.log('LIVE READ OK');
