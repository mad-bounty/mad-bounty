// Live MCP smoke test against Base Sepolia (read-only + unsigned-tx mode; no private key).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node', args: ['dist/index.js'],
  env: { ...process.env, MADB_CHAIN_ID: '84532', MADB_PRIVATE_KEY: '', MADB_FROM_BLOCK: process.env.FROM_BLOCK ?? '0' },
});
const client = new Client({ name: 'smoke', version: '0' });
await client.connect(transport);
const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));
const short = (r) => JSON.stringify(r.content?.[0]?.text ?? r).slice(0, 420);
const tryTool = async (name, args) => {
  try { const r = await client.callTool({ name, arguments: args }); console.log(`\n## ${name}${r.isError ? ' (ERROR)' : ''}\n${short(r)}`); }
  catch (e) { console.log(`\n## ${name} THREW ${e.message.slice(0, 200)}`); }
};
const ids = JSON.parse(process.env.IDS ?? '[1,3,4,8]');
for (const t of tools) {
  const props = Object.keys(t.inputSchema?.properties ?? {});
  if (t.name === 'madb_get_bounty' || t.name === 'madb_check_bounty_safety') for (const id of ids) await tryTool(t.name, { id: String(id) });
  else if (props.length === 0) await tryTool(t.name, {});
}
await tryTool('madb_hash_spec', { spec: { title: 'smoke', instructions: 'x', acceptanceCriteria: ['y'], evidenceFormat: 'z' } });
await client.close();
