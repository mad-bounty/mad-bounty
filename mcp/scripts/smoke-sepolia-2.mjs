import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const c = new Client({ name: 's', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['dist/index.js'], env: { ...process.env, MADB_CHAIN_ID: '84532', MADB_PRIVATE_KEY: '', ...(process.env.FROM_BLOCK ? { MADB_FROM_BLOCK: process.env.FROM_BLOCK } : {}) } }));
const { tools } = await c.listTools();
for (const n of ['madb_list_open_bounties', 'madb_keeper_sweep', 'madb_claim']) console.log(n, JSON.stringify(tools.find(t => t.name === n).inputSchema.properties));
for (const [n, a] of [['madb_list_open_bounties', {}], ['madb_keeper_sweep', {}], ['madb_claim', { id: '3' }]]) {
  const r = await c.callTool({ name: n, arguments: a }); console.log(`\n## ${n}${r.isError ? ' ERROR' : ''}\n` + String(r.content?.[0]?.text).slice(0, 700));
}
await c.close();
