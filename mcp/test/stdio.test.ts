// Integration: launch the built server over stdio with the MCP client SDK, against anvil + real forge artifacts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { privateKeyToAccount } from 'viem/accounts';
import { startChain, KEYS, type Chain } from '../../sdk/test/anvil.js';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
let chain: Chain;
const clients: Client[] = [];
const A = privateKeyToAccount(KEYS.agent).address;
const W = privateKeyToAccount(KEYS.worker).address;
const V = privateKeyToAccount(KEYS.verifier).address;

async function connect(key?: `0x${string}`): Promise<Client> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '', MADB_RPC_URL: chain.rpcUrl, MADB_CORE: chain.core, MADB_USDC: chain.usdc, MADB_CHAIN_ID: '31337',
  };
  if (key) env.MADB_PRIVATE_KEY = key;
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: 'ignore' });
  const c = new Client({ name: 'madb-test', version: '0.0.0' });
  await c.connect(transport);
  clients.push(c);
  return c;
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  const text = r.content[0]?.text ?? '';
  if (r.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}

let agent: Client, worker: Client, verifier: Client, keeper: Client, readonly: Client;

beforeAll(async () => {
  chain = await startChain();
  await chain.mint(A, 10_000_000_000n);
  await chain.mint(W, 10_000_000_000n);
  [agent, worker, verifier, keeper, readonly] = await Promise.all([
    connect(KEYS.agent), connect(KEYS.worker), connect(KEYS.verifier), connect(KEYS.keeper), connect(),
  ]);
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  await chain?.stop();
});

const EXPECTED_TOOLS = [
  'madb_get_manual', 'madb_list_open_bounties', 'madb_get_bounty', 'madb_check_bounty_safety', 'madb_post_bounty',
  'madb_claim', 'madb_submit', 'madb_settle', 'madb_keeper_sweep', 'madb_withdraw', 'madb_hash_spec', 'madb_encrypt_for_agent',
];

describe('madbounty MCP over stdio', () => {
  it('lists all tools with descriptions and schemas', async () => {
    const { tools } = await readonly.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const t of tools) {
      expect(t.description!.length).toBeGreaterThan(80);
      expect(t.inputSchema.type).toBe('object');
    }
    expect(tools.find((t) => t.name === 'madb_claim')!.description).toMatch(/MONEY AT RISK/);
  });

  it('get_manual returns the repo llms-full.txt', async () => {
    const m = await call(readonly, 'madb_get_manual');
    expect(m.source).toMatch(/llms-full\.txt$/);
    expect(m.manual).toMatch(/MAD Bounty v1/);
    expect(m.onchainPointer.uri).toBe('ipfs://test/llms.txt');
  });

  it('post -> list -> safety -> claim -> submit -> sign verdict -> relay -> Paid', async () => {
    const spec = { task: 'translate README to French', acceptance: 'native speaker review' };
    const { specHash } = await call(readonly, 'madb_hash_spec', { spec });
    const posted = await call(agent, 'madb_post_bounty', {
      verifier: V, reward: '50', workWindowSeconds: 86400, reviewWindowSeconds: 43200, openUntilDays: 7, spec,
    });
    expect(posted.mode).toBe('sent');
    expect(posted.params.specHash).toBe(specHash);
    const id = posted.id as string;

    const open = await call(worker, 'madb_list_open_bounties', {});
    const row = open.bounties.find((b: { id: string }) => b.id === id);
    expect(row.rewardUsdc).toBe('50');
    expect(row.depositUsdc).toBe('1');
    expect(row.specHash).toBe(specHash);

    const safety = await call(worker, 'madb_check_bounty_safety', { id, knownSafeVerifiers: [V] });
    expect(safety.safe).toBe(true);

    const claimed = await call(worker, 'madb_claim', { id });
    expect(claimed.mode).toBe('sent');
    let b = await call(readonly, 'madb_get_bounty', { id });
    expect(b.state).toBe('Claimed');
    expect(b.worker).toBe(W);

    const sub = await call(worker, 'madb_submit', { id, evidence: 'ipfs://bafy-translation' });
    expect(sub.mode).toBe('sent');
    b = await call(readonly, 'madb_get_bounty', { id });
    expect(b.state).toBe('Submitted');

    const signed = await call(verifier, 'madb_settle', { id, verdict: 'accept', mode: 'sign' });
    expect(signed.signerIsVerifier).toBe(true);
    const relayed = await call(keeper, 'madb_settle', { id, verdict: 'accept', mode: 'relay', signature: signed.signature });
    expect(relayed.state).toBe('Paid');
  });

  it('direct reject by verifier; non-verifier direct settle is refused', async () => {
    const p = await call(agent, 'madb_post_bounty', {
      verifier: V, reward: 10, workWindowSeconds: 3600, reviewWindowSeconds: 43200, openUntilDays: 1, specHash: '0x' + 'ab'.repeat(32),
    });
    await call(worker, 'madb_claim', { id: p.id });
    await call(worker, 'madb_submit', { id: p.id, evidenceHash: '0x' + 'cd'.repeat(32) });
    await expect(call(keeper, 'madb_settle', { id: p.id, verdict: 'reject' })).rejects.toThrow(/not the verifier/);
    const r = await call(verifier, 'madb_settle', { id: p.id, verdict: 'reject' });
    expect(r.state).toBe('Rejected');
  });

  it('safety flags REFUND + agent-as-verifier as DANGER', async () => {
    const p = await call(agent, 'madb_post_bounty', {
      verifier: A, reward: '20', workWindowSeconds: 86400, reviewWindowSeconds: 43200, openUntilDays: 3,
      rejectMode: 'Refund', spec: { x: 1 },
    });
    const s = await call(worker, 'madb_check_bounty_safety', { id: p.id });
    expect(s.safe).toBe(false);
    expect(s.warnings.map((w: { code: string }) => w.code)).toContain('REFUND_SELF_VERIFIED');
  });

  it('keeper sweep pays on verifier timeout', async () => {
    const p = await call(agent, 'madb_post_bounty', {
      verifier: V, reward: '5', workWindowSeconds: 3600, reviewWindowSeconds: 43200, openUntilDays: 1, spec: { y: 2 },
    });
    await call(worker, 'madb_claim', { id: p.id });
    await call(worker, 'madb_submit', { id: p.id, evidence: 'done' });
    await chain.increaseTime(43200 + 1);
    const dry = await call(keeper, 'madb_keeper_sweep', { dryRun: true });
    expect(dry.found.payOnTimeout).toContain(p.id);
    const sweep = await call(keeper, 'madb_keeper_sweep', { ids: [p.id] });
    expect(sweep.results[0].action).toBe('payOnTimeout');
    expect(sweep.results[0].hash).toMatch(/^0x/);
    expect((await call(readonly, 'madb_get_bounty', { id: p.id })).state).toBe('Paid');
  });

  it('without MADB_PRIVATE_KEY write tools return unsigned transactions', async () => {
    const r = await call(readonly, 'madb_post_bounty', {
      verifier: V, reward: '25', workWindowSeconds: 86400, reviewWindowSeconds: 43200, openUntilDays: 2, spec: { z: 3 },
    });
    expect(r.mode).toBe('unsigned');
    expect(r.transactions).toHaveLength(2);
    expect(r.transactions[0].to.toLowerCase()).toBe(chain.usdc.toLowerCase());
    expect(r.transactions[1].to.toLowerCase()).toBe(chain.core.toLowerCase());
    expect(r.transactions[1].data).toMatch(/^0x/);
    // host wallet signs and sends them: the bounty appears on-chain
    const wc = chain.wallet(KEYS.agent);
    for (const tx of r.transactions) {
      const hash = await wc.sendTransaction({ to: tx.to, data: tx.data, account: wc.account!, chain: wc.chain });
      await chain.publicClient.waitForTransactionReceipt({ hash });
    }
    const open = await call(readonly, 'madb_list_open_bounties', {});
    expect(open.bounties.some((b: { rewardUsdc: string; agent: string }) => b.rewardUsdc === '25' && b.agent === A)).toBe(true);

    const typed = await call(readonly, 'madb_settle', { id: open.bounties[0].id, verdict: 'accept', mode: 'sign' }).catch((e) => e);
    expect(String(typed)).toMatch(/needs Submitted/);
    const w = await call(readonly, 'madb_withdraw', { id: 1, account: W, owedOnly: true });
    expect(w.owed).toBe('0');
  });

  it('encrypt_for_agent produces a box', async () => {
    const { generateEncryptionKeyPair, decryptAsAgentString } = await import('@madbounty/sdk');
    const kp = generateEncryptionKeyPair();
    const { box } = await call(readonly, 'madb_encrypt_for_agent', { agentPubKey: kp.publicKey, plaintext: 'token=abc' });
    expect(decryptAsAgentString(kp.privateKey, box)).toBe('token=abc');
  });
});
