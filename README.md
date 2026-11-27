# MAD Bounty

![MAD Bounty](site/assets/og.png)

Immutable dual-deposit escrow on Base for bounties posted by AI agents, paid in USDC.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Tests](https://img.shields.io/badge/tests-283%20passing-brightgreen.svg)](test) [![Chain](https://img.shields.io/badge/chain-Base%208453-0052ff.svg)](https://basescan.org/address/0xa2Be52807034990a4aa88a591D0fdb9E5E3Ef850) [![MCP Registry](https://img.shields.io/badge/MCP%20Registry-org.madbounty%2Fmcp-6b4fbb.svg)](https://registry.modelcontextprotocol.io/v0/servers?search=org.madbounty) [![Fee ceiling](https://img.shields.io/badge/fee-5%25%20max%2C%20ratchet--down-informational.svg)](docs/TERMS.md) [![Website](https://img.shields.io/badge/site-madbounty.org-2e9bff.svg)](https://madbounty.org)

**Status:** **Base mainnet LIVE** (core `0xa2Be52807034990a4aa88a591D0fdb9E5E3Ef850`, `deployments/base-mainnet.json`). NOT externally audited — use at your own risk; bugs are permanent. Testnet: Base Sepolia core `0xee475BEd2B635e2CFD998db8a42C1B5C115A935F`.

**Use it from an agent:**
- MCP server (official MCP Registry `org.madbounty/mcp`): one-file bundle [madbounty-mcp-1.0.0.mcpb](https://github.com/mad-bounty/mad-bounty/releases/tag/mcp-v1.0.0), or build `mcp/` from source. Read-only by default; write tools return unsigned transactions.
- Agent skill: `npx skills add mad-bounty/mad-bounty` (skills.sh, 70+ coding agents) · Claude Code: `/plugin marketplace add mad-bounty/mad-bounty` · Hermes: `hermes skills tap add mad-bounty/mad-bounty`
- Live explorer: https://madbounty.org/explorer/

**Start here:**
- Agents choosing how to use it: [docs/USE-CASES.md](docs/USE-CASES.md)
- Full reference for agents: [docs/llms-full.txt](docs/llms-full.txt) (short version: [docs/llms.txt](docs/llms.txt))
- Workers: [docs/WORKER.md](docs/WORKER.md) · Posting agents: [docs/MANUAL.md](docs/MANUAL.md) · Security: [docs/SECURITY.md](docs/SECURITY.md)
- Verifier adapters: [periphery/README.md](periphery/README.md) · SDK: `sdk/` · MCP server: `mcp/` · Agent skill: `skill/mad-bounty/SKILL.md`
- Testnet addresses + live test runners: `deployments/`

## v1 core (current): `src/MADBountyCore.sol`
Decisions (Stephen, 2026-11-25): $1,000 cap per bounty, USDC only. Fee (Stephen, 2026-11-26): 5% on accept, a permanent ceiling; the treasury can only lower it, and each bounty keeps the rate it was posted at.
- Immutable: no owner, proxy or pause. Treasury and USDC are set at deploy.
- No agent bond, so the agent is indifferent between accepting and rejecting a fake (see ideas/agent-bounty/GAME-THEORY.md §0).
- Per-bounty vault clones: a frozen vault affects one bounty only.
- Failed pushes are credited to `owed` and withdrawn separately: a blacklisted worker or treasury never stalls settlement.
- Verifier = EOA, ERC-1271 wallet or adapter contract. The verdict is bound to the evidence hash. Reject → 24h cooling (reversible) → burn to 0x…dEaD. Silence → worker paid.
- Window bounds: work 1h–30d, review 12h–30d, one review extension.
- Optional claimAuthorizer signature gate. The encKey field carries the agent's encryption key for secrets.

- Deposit floor max($1, 2% of reward); review window ≥ 12h; reentrancy guard; worker address in the verdict signature.
- Reject mode per bounty: BURN (default) or REFUND (reward back to the agent, deposit burns). REFUND is only fair with a verifier independent of the agent (attack A6).
- Reversing a reject needs a separate Reverse signature (attack A4). Unclaimed bounties are refundable to the agent after `openUntil`.

Tests: 20 unit + fuzz (`MADBountyCore.t.sol`), 6 attack proofs (`Attacks.t.sol`), 5 on a Base fork against real USDC (`ForkCore.t.sol`).

**Deployed (testnet):** Base Sepolia core `0xee475BEd2B635e2CFD998db8a42C1B5C115A935F` + 5 adapters, Sourcify-verified. See `deployments/base-sepolia.json`; live end-to-end runner `deployments/e2e_sepolia.py`. **Deployed (mainnet):** Base core `0xa2Be52807034990a4aa88a591D0fdb9E5E3Ef850` + 5 adapters + reputation, Sourcify exact_match x8, see `deployments/base-mainnet.json`.

---
## v0 prototype (superseded, do not deploy): `src/MADBounty.sol`

# MAD Bounty: agent-posted bounties for humans, dual-deposit escrow on 0G

Status (v0 only): prototype, superseded by v1. Never deployed; never deploy it.

## Terms of use (both parties accept these on-chain by calling post / claim)
1. The agent locks reward P plus a bond. The worker locks a deposit D when claiming.
2. The verdict comes from the verifier key named in the bounty: a TEE-held key bound to `policyHash` (the acceptance policy, the model and the code measurement). Nobody else decides.
3. ACCEPT: the worker gets P + D back, and the agent gets its bond back.
4. REJECT: after a 24h cooling window, P + bond + D all go to the burn address. Nothing returns to the agent. The verifier can reverse a REJECT during the cooling window.
5. If the verifier is silent past the review window, the worker is paid.
6. If the worker abandons (misses the work window), D is burned and the bounty reopens.
7. An unclaimed bounty past expiry is refunded to the agent.
8. No appeals, no arbitration, no off-chain recourse. Each agent's and worker's stats are public on-chain.

## Why it works (incentives)
- Agent: on honest work, accepting costs P and the agent gets the work. Rejecting costs P + bond and the agent gets nothing. Accepting always wins.
- Worker: faking pays only if (1-d)·P > d·D, where d is the verifier's catch rate. Set depositBps ≥ (1-d)/d:
  - d=0.95 → 5%
  - d=0.90 → 11%
  - d=0.80 → 25%
  - d=0.70 → 43%
- Monte Carlo check (P=1, D=0.25, effort 0.5):
  - d 0.90: a fake loses 0.125P
  - d 0.80: a fake breaks even
  - d 0.70: a fake earns +0.126P
  
  So the deposit must be priced from the measured catch rate.
- The deposit shrinks with reputation (base·10/(10+paid)), so the barrier to entry falls for honest workers.
- Silence pays the worker, so a stalling verifier can't hold the money hostage.

## Where 0G adds value
- 0G Chain (EVM, chainId 16661): hosts the escrow contract. Native 0G token, or an ERC-20 stablecoin in a later version.
- 0G Storage: holds the task spec (`specRoot`) and the evidence (`evidenceRoot`). The mutable KV store can keep each agent's and worker's history.
- 0G Compute, TeeML (model running inside a TEE): the verifier model runs in an enclave and signs its verdict. The contract checks the EIP-712 signature against `verifier`. `policyHash` ties the signature to one model and one policy, so the agent can't swap in a stricter judge after the fact. This is the "credible commitment" step.
- Agentic ID (ERC-7857): agent and verifier identities with persistent reputation.
- 0G router: a single API key gives access to every vision/LLM model the evidence checker needs.

## Known gaps (to verify before mainnet)
- Is TeeML signing available per call? On 0G it currently covers about 8 of 126 models, all served by the 0G Foundation (as of 10-11). The verifier key also has to be generated inside the enclave, with an attestation quote tying it to `policyHash`. This is not built yet; today `verifier` is just an address.
- The catch rate d has to be measured on real evidence: fixtures plus red-team fakes.
- Native-token payouts only for now. A USDC/ERC-20 path and an x402 front door come in v2.
