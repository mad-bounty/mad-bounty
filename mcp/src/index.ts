#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configFromEnv } from './config.js';
import { createServer, VERSION } from './server.js';

async function main() {
  const cfg = configFromEnv();
  const { server, runtime } = createServer(cfg);
  await server.connect(new StdioServerTransport());
  // stderr only: stdout is the MCP channel
  console.error(`madbounty-mcp ${VERSION} chain=${cfg.chainId} core=${cfg.core ?? 'UNSET'} signer=${runtime.signer ?? 'none (unsigned-tx mode)'}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
