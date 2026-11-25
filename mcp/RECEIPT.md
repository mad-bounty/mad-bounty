# MCP receipt — @madbounty/mcp 0.1.0

Date: 2026-11-25 (UTC 12:06). Node v22, @modelcontextprotocol/sdk 1.32.2, vitest 3.2.7, anvil (Foundry).
Setup: real `MADBountyCore` + `MockUSDC` from `forge build` on anvil; the built server (`dist/index.js`) is spawned 5 times over stdio (agent, worker, verifier, keeper keys + one keyless) via the MCP client SDK `StdioClientTransport`.
Command: `cd mcp && npm test` (builds sdk, builds server, vitest). Exit 0.

## Verbose results
```
✓ test/stdio.test.ts > madbounty MCP over stdio > lists all tools with descriptions and schemas 36ms
 ✓ test/stdio.test.ts > madbounty MCP over stdio > get_manual returns the repo llms-full.txt 99ms
 ✓ test/stdio.test.ts > madbounty MCP over stdio > post -> list -> safety -> claim -> submit -> sign verdict -> relay -> Paid 786ms
 ✓ test/stdio.test.ts > madbounty MCP over stdio > direct reject by verifier; non-verifier direct settle is refused 257ms
 ✓ test/stdio.test.ts > madbounty MCP over stdio > safety flags REFUND + agent-as-verifier as DANGER 93ms
 ✓ test/stdio.test.ts > madbounty MCP over stdio > keeper sweep pays on verifier timeout 232ms
 ✓ test/stdio.test.ts > madbounty MCP over stdio > without MADB_PRIVATE_KEY write tools return unsigned transactions 139ms
 ✓ test/stdio.test.ts > madbounty MCP over stdio > encrypt_for_agent produces a box 516ms
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

## npm test tail
```
 ✓ test/stdio.test.ts (8 tests) 4973ms
   ✓ madbounty MCP over stdio > post -> list -> safety -> claim -> submit -> sign verdict -> relay -> Paid  815ms
   ✓ madbounty MCP over stdio > encrypt_for_agent produces a box  442ms

 Test Files  1 passed (1)
      Tests  8 passed (8)
   Start at  20:05:48
   Duration  7.13s (transform 449ms, setup 0ms, collect 1.58s, tests 4.97s, environment 0ms, prepare 158ms)
```

Not covered: real Base RPC/USDC, host-wallet signing of `unsigned-typed-data`, withdraw of a non-zero owed balance. Not published to npm.
