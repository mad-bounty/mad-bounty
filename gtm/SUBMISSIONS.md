# MAD Bounty: copy-paste submission texts (top 10 targets)

Researched 2026-11-25; values filled 2026-11-27 (Base mainnet live). Requirements and sources are in PLAN.md §1. Final paste-ready copy for several targets lives in `articles/` (see the status table).
Values: core `0xa2Be52807034990a4aa88a591D0fdb9E5E3Ef850` (Base 8453), domain `madbounty.org`, GitHub org `mad-bounty` (repo https://github.com/mad-bounty/mad-bounty, PUBLIC). `<AGENT_ID>` = the ERC-8004 id after registration (not registered yet).
**Rule for every text:** say "NOT externally audited" until an audit report is public. No superlatives. Every number must be verifiable on-chain or in the repo.

## Status (2026-11-27)
| # | Target | Status |
|---|---|---|
| 1 | Official MCP Registry | **DONE.** `org.madbounty/mcp` v1.0.0, published as an MCPB bundle attached to GitHub release `mcp-v1.0.0` (HTTP domain auth on madbounty.org). Live: `curl "https://registry.modelcontextprotocol.io/v0/servers?search=org.madbounty"` |
| 2 | Glama | `glama.json` **added** at the repo root (maintainer GGBossman). Manual form submission still **TODO**: Glama does not auto-list from the MCP Registry |
| 3 | awesome-mcp-servers PR | TODO. Gated on the Glama listing URL |
| 4 | skills.sh | **DONE.** `skills.sh.json` in the repo root; `npx skills add mad-bounty/mad-bounty` |
| 4 | Claude Code plugin marketplace | **DONE.** `.claude-plugin/marketplace.json` in the repo |
| 4 | ClawHub | TODO (manual, needs a GitHub login). Copy: `articles/clawhub-submission.md` |
| 4 | Hermes tap | TODO |
| 5 | ERC-8004 registration | File live at `/.well-known/agent-registration.json` (`registrations: []`). On-chain `register()` TODO, from the long-lived agent wallet |
| 6 | Anthropic directory | TODO |
| 7 | Base ecosystem form | Copy ready: `articles/base-ecosystem-submission.md`. **Gated:** live ≥30 days (earliest 2026-12-27) plus real usage (0 mainnet bounties on 11-27) |
| 8 | Basescan name tags | Copy for all 8 contracts: `articles/basescan-nametag.md`. Ready to send (Sourcify exact_match ×8) |
| 9 | Virtuals ACP profile | TODO; only once a running service is behind it |
| 10 | Ethereum Magicians | Final post: `articles/magicians-erc-mad-extension.md`. Ready to post |
| — | Repo public | **DONE** (https://github.com/mad-bounty/mad-bounty, MIT) |

Character counts were checked with Python on 2026-11-25.

---
## Canonical copy (reuse everywhere)

**Name:** MAD Bounty
**One-liner (97 chars, fits the MCP Registry 100-char limit):**
`Post and work USDC bounties on Base. Non-custodial escrow; workers deposit, rejects burn, 5% fee.`

**Short (111 chars):**
`Immutable USDC bounty escrow on Base where AI agents hire humans or agents and can't profit from stiffing them.`

**Long (about 150 words):**
> MAD Bounty is an immutable escrow contract on Base for paid work between AI agents and the humans or agents they hire. An agent posts a bounty in USDC and names a verifier. The verifier can be the agent itself, a multisig, an on-chain check, a hash reveal, a TEE-hosted model (0G TeeML) or a fallback chain of these. A worker claims by posting a small deposit (the larger of $1 and 2% of the reward), then submits evidence. If the verifier accepts, the worker receives the reward plus their deposit, minus a 5% protocol fee (the cap; it can only be lowered). If the verifier rejects, after a 24-hour reversible cooling period both the reward and the deposit are burned. In REFUND mode with an independent verifier, the reward is returned and only the deposit burns. Because the agent can never recover money by rejecting good work, it has no reason to stiff workers. If the verifier stays silent, the worker is paid. There is no owner, proxy, pause or upgrade path. Rewards are capped at $1,000. The contract is NOT externally audited.

**Tags/keywords:** `bounty, escrow, usdc, base, ai-agents, agent-commerce, human-in-the-loop, erc-8004, erc-8183, x402-compatible, task-marketplace, verification, tee`
Only use `x402-compatible` if the x402 endpoint ships.

**Categories:** Finance / Payments; Agent commerce; Blockchain (Base).

---
## 1. Official MCP Registry: `server.json`
**DONE (2026-11-27).** Published as `org.madbounty/mcp` with `registryType: "mcpb"` (bundle on GitHub release `mcp-v1.0.0`, sha256 in `mcp/server.json`), HTTP domain auth on madbounty.org. No npm package was needed. The live file is `mcp/server.json`; the npm-based draft below is kept for reference only (its env var names are outdated: the real ones are `MADB_CHAIN_ID` and `MADB_RPC_URL`).

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "org.madbounty/mcp",
  "title": "MAD Bounty",
  "description": "Post and work USDC bounties on Base. Non-custodial escrow; workers deposit, rejects burn, 5% fee.",
  "version": "1.0.0",
  "websiteUrl": "https://madbounty.org/docs",
  "repository": { "url": "https://github.com/mad-bounty/mad-bounty", "source": "github", "subfolder": "mcp" },
  "packages": [
    {
      "registryType": "npm",
      "identifier": "@madbounty/mcp",
      "version": "1.0.0",
      "runtimeHint": "npx",
      "transport": { "type": "stdio" },
      "environmentVariables": [
        { "name": "MADBOUNTY_RPC_URL", "description": "Base RPC URL (default https://mainnet.base.org)", "isRequired": false },
        { "name": "MADBOUNTY_SIGNER", "description": "How to sign transactions: 'none' (read-only, default), 'walletconnect', or an external signer URL. Never paste a raw private key.", "isRequired": false }
      ]
    }
  ]
}
```
Publish: `mcp-publisher login dns --domain madbounty.org --private-key-file …` (or the OIDC workflow), then `mcp-publisher publish`. Verify with `curl "https://registry.modelcontextprotocol.io/v0/servers?search=org.madbounty"`.
Check the field names against the live schema before publishing; the registry is in preview.

---
## 2. Glama: Add MCP Server
- **Repository URL:** `https://github.com/mad-bounty/mad-bounty`
- **Display name:** `MAD Bounty`
- **Short description:** the one-liner above
- `glama.json` at the repo root (**added**; manual submission at glama.ai still TODO):
```json
{ "$schema": "https://glama.ai/mcp/schemas/server.json", "maintainers": ["GGBossman"] }
```
- Make sure a `Dockerfile` (or `mcp/Dockerfile`) starts the server **with no signer configured** (read-only mode), so Glama's health/introspection check passes without secrets.

---
## 3. awesome-mcp-servers PR (punkpeye)
Category: look for "Finance & Fintech" or the closest existing section. Keep alphabetical order. The PR description **must** link the Glama listing.

**Line:**
```
- [mad-bounty/mad-bounty](https://github.com/mad-bounty/mad-bounty) 📇 ☁️ - Post, claim and verify USDC bounties on Base through an immutable escrow: workers post a deposit, rejected work burns funds so agents can't profit from stiffing workers. Read-only by default.
```
(Match the list's current emoji legend: 📇 = TypeScript, ☁️ = cloud service. Check the README legend at PR time.)

**PR title:** `Add MAD Bounty (USDC bounty escrow on Base)`
**PR body:**
```
Adds MAD Bounty, an MCP server for an immutable USDC bounty escrow on Base.
Glama listing: https://glama.ai/mcp/servers/mad-bounty/mad-bounty (badge in README; confirm the exact URL after the Glama listing exists)
License: MIT. Read-only unless a signer is configured. Contract is NOT externally audited (stated in README).
```

---
## 4. Hermes / ClawHub / skills.sh / Claude Code: SKILL.md frontmatter
**Shipped in the main repo instead:** `skill/mad-bounty/SKILL.md` in `mad-bounty/mad-bounty`. skills.sh reads it via `skills.sh.json` (**done**); the Claude Code marketplace via `.claude-plugin/marketplace.json` (**done**). Draft frontmatter below kept for reference.
```yaml
---
name: mad-bounty
description: Use when an agent needs to hire a human/agent for paid work on Base.
version: 1.0.0
author: MAD Bounty
license: MIT
metadata:
  hermes:
    tags: [bounty, escrow, usdc, base, payments, agent-commerce]
---
```
Body outline: when to use it and when not (no rewards above $1,000, USDC only); how to choose a verifier (decision table); the REFUND-mode warning (attack A6: REFUND with the agent as verifier lets the agent take the work for free, so the agent must use BURN or an independent verifier); step-by-step post/claim/submit/verdict with the MCP tool names; failure modes (silence means the worker is paid; a missed work window reopens the bounty).

- ClawHub (TODO, manual): `clawhub skill publish ./skill/mad-bounty --slug mad-bounty --name "MAD Bounty" --version 1.0.0`. Full copy and the MIT-0 license caveat: `articles/clawhub-submission.md`
- Hermes: `hermes skills tap add mad-bounty/mad-bounty` (check that the tap accepts the `skill/` path). Announce in the Nous Discord skills channel.
- Claude Code marketplace `.claude-plugin/marketplace.json`:
```json
{
  "name": "mad-bounty",
  "owner": { "name": "MAD Bounty", "url": "https://madbounty.org" },
  "plugins": [
    { "name": "mad-bounty", "source": "./plugins/mad-bounty", "description": "Post and work USDC bounties on Base via the MAD Bounty escrow (skill + MCP server)." }
  ]
}
```
Check the marketplace.json fields against https://code.claude.com/docs/en/plugins/create-marketplace before publishing.

---
## 5. ERC-8004 registration file (`https://madbounty.org/agent.json`, mirrored to IPFS)
Live file: `site/agent.json`, plus `/.well-known/agent-registration.json` (5% fee text, `registrations: []`). The draft below is superseded by the live file.
```json
{
  "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  "name": "MAD Bounty",
  "description": "Immutable USDC bounty escrow on Base. Agents post bounties and pick a verifier; workers post a deposit; accept pays the worker reward minus a 5% fee (ceiling, can only be lowered) plus their deposit; reject burns reward and deposit after a 24h reversible cooling period, so agents can't profit from rejecting good work. Verifier silence pays the worker. Max reward $1,000. NOT externally audited. Core: 0xa2Be52807034990a4aa88a591D0fdb9E5E3Ef850 (Base).",
  "image": "https://madbounty.org/assets/og.png",
  "services": [
    { "name": "web", "endpoint": "https://madbounty.org/" },
    { "name": "MCP", "endpoint": "https://registry.modelcontextprotocol.io/v0/servers?search=org.madbounty/mcp", "version": "2025-06-18" },
    { "name": "A2A", "endpoint": "https://madbounty.org/.well-known/agent-card.json", "version": "0.3.0" },
    { "name": "ENS", "endpoint": "madbounty.eth", "version": "v1" }
  ],
  "x402Support": false,
  "active": true,
  "registrations": [
    { "agentId": <AGENT_ID>, "agentRegistry": "eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" }
  ],
  "supportedTrust": ["crypto-economic", "tee-attestation"]
}
```
Call: `cast send 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 "register(string)" "https://madbounty.org/agent.json" --rpc-url https://base-rpc.publicnode.com` from the long-lived agent wallet (NOT the one-time deployer). Check the exact `register` overload in the deployed ABI first. Then copy the file to `/.well-known/agent-registration.json`.
`tee-attestation` is OK: TeeML adapter deployed on mainnet (`0x4211ED6f52B76AC38E43Bf8BF059b22689e3De1B`).

---
## 6. Anthropic directory (claude.ai/directory/manage)
- **Name:** MAD Bounty
- **Tagline:** `Hire people or agents for paid tasks with USDC escrow on Base.`
- **Description:** the long text above, plus: "Every tool that moves funds asks for explicit user confirmation and shows the amount, recipient contract and reject-mode before signing. Read-only tools work without a wallet."
- **Category:** Finance / Productivity
- **Human-in-the-loop statement (needed for high-risk finance):** "MAD Bounty never holds keys. Write actions return an unsigned transaction for the user's wallet to sign. The plugin shows the reward, deposit, verifier and reject-mode, and states that rejected funds are burned, before every signature."
- **Before submitting:** `claude plugin validate ./plugins/mad-bounty --strict`

---
## 7. Base ecosystem form
**Final field-by-field copy (live form fields read 2026-11-27): `articles/base-ecosystem-submission.md`.** Gated: earliest 2026-12-27, plus real usage.
- **Project name:** MAD Bounty
- **Description (126 chars, under 200):** `Non-custodial USDC bounty escrow on Base: AI agents post work, workers deposit, a chosen verifier decides. Rejects burn funds.`
- **Website:** https://madbounty.org (/terms and /privacy both live, 200)
- **Category / subcategory:** AI / agent infrastructure (or Infra / developer tool)
- **Logo:** 192×192 PNG/WebP
- **Socials:** X, GitHub
- Submit only after mainnet deployment and at least a few real completed bounties (seeded bounties count if they are real).

---
## 8. Basescan name tag suggestion (after verification)
**Final copy for all 8 mainnet contracts: `articles/basescan-nametag.md`.**
- **Name tag:** `MAD Bounty: Core` (`0xa2Be52807034990a4aa88a591D0fdb9E5E3Ef850`)
- **Label:** `Escrow`
- **Website:** https://madbounty.org
- **Note to reviewers:** "Immutable bounty escrow (no owner/proxy). Source verified (Sourcify exact match); deployer 0xe29bcf26f87912ebd9A98ed7cFc8eFEd513F153F. Docs: https://madbounty.org/docs. Manual hash stored on-chain at manualHash()."

---
## 9. Virtuals ACP agent profile
- **Agent name:** MAD Bounty Escrow (or a concrete agent such as "MAD Bounty Integrations Desk")
- **Role:** Evaluator, or Provider if we offer "post-a-human-task" as a service
- **Description:** `Routes tasks that need a human to MAD Bounty, a non-custodial USDC escrow on Base where workers post a deposit and rejected work is burned, so the requester can't gain by rejecting. Max $1,000 per task.`
- **Note:** the agent must stay reliable (ungraduated at 10 failures). Only register once there is a running service behind it.

---
## 10. Ethereum Magicians: ERC discussion post (category: ERCs; tags: agents, escrow, payments, erc)
**Final post: `articles/magicians-erc-mad-extension.md`** (supersedes the opening below; ERC-8183/8004/8412/8505 references checked 2026-11-27).
**Title:** `ERC-XXXX: Mutually-Assured-Destruction (dual-deposit) extension for ERC-8183 jobs`

**Body (opening; the full outline is in ARTICLES.md #1):**
```
ERC-8183 lets a client fund a job and an evaluator complete or reject it. Its security
section notes that a malicious evaluator can reject arbitrarily and suggests reputation
or staking for high-value jobs. When the client is also the evaluator, or picks one, the
client can take delivered work and recover the budget by rejecting.

This proposal defines an optional extension (implementable as an 8183 hook or as a
standalone kernel) in which:
  1. the provider posts a deposit D at claim time (D >= max(floor, bps * budget));
  2. on Rejected, after a cooling window, budget + D are sent to a burn address (BURN mode)
     or budget returns to the client and D burns (REFUND mode, only with a verifier that
     is independent of the client);
  3. evaluator silence past the review window resolves in the provider's favour.

Result: the client's payoff is the same whether it accepts or rejects, so it gains nothing
by rejecting good work; the provider's deposit prices spam claims. We have a reference
implementation live on Base (Foundry: core 40, periphery 83, audit 97 tests incl. 6 attack proofs)
and an attack catalog. NOT externally audited.

Related: ERC-8412 (preregistered acceptance criteria) can fix what the evaluator checks
before funding; ERC-8505 (evaluated work records) can record outcomes. We'd like feedback on:
(a) hook vs. kernel, (b) the burn address vs. a public-goods sink, (c) silence semantics.
```
Follow-up: reply once in the ERC-8183 thread with a two-line pointer. **Don't cross-post to other ERC threads.**
