# ClawHub submission: `skill/mad-bounty/SKILL.md`

**Where:** https://clawhub.ai/upload redirects to https://clawhub.ai/skills/publish, which needs "Sign in with GitHub". I checked it on 2026-11-27 and it was behind the login wall, so the form fields below come from the docs, not from the live form. `clawhub.ai/submit` returns 404.
**Docs:** https://docs.openclaw.ai/clawhub (publish options), https://docs.openclaw.ai/clawhub/skill-format (frontmatter, license, GitHub import).

## Before uploading (checklist)
1. **License conflict.** Every skill published on ClawHub is licensed **MIT-0**, and the docs say "Do not add conflicting license terms in SKILL.md". Our SKILL.md says `license: MIT`. Either remove that line from the uploaded copy, or accept MIT-0 for the skill text (the repo code stays MIT). Recommended: upload the copy without the `license:` line. Don't edit the repo file just for ClawHub without deciding this first.
2. **Folder.** Upload `skill/mad-bounty/`. It contains only `SKILL.md` (770 words) and has no scripts or binaries, so the security scan has little to flag.
3. **Env declarations.** The skill mentions `MADB_CHAIN_ID`, `MADB_RPC_URL` and `MADB_PRIVATE_KEY`, all optional. ClawHub's scanner compares env vars mentioned in the body against the frontmatter. If the scan warns, declare them as optional in the uploaded copy:
   ```yaml
   metadata:
     openclaw:
       homepage: https://madbounty.org
       envVars:
         - { name: MADB_CHAIN_ID, required: false, description: "8453 Base mainnet (default) or 84532 Base Sepolia" }
         - { name: MADB_RPC_URL, required: false, description: "Base RPC URL" }
         - { name: MADB_PRIVATE_KEY, required: false, description: "Omit it: write tools then return unsigned txs for your own wallet" }
   ```
4. **GitHub importer.** The importer only reads public, non-fork repos *owned by the signed-in account*. The repo is owned by the `mad-bounty` org, so the importer may not list it. Use the folder upload, or run the CLI command below.

## Form fields
| Field | Value |
|---|---|
| Slug | `mad-bounty` |
| Display name | `MAD Bounty` |
| Version | `1.0.0` |
| Tags | `latest` |
| Changelog | `First ClawHub release. Base mainnet live 2026-11-27 (core 0xa2Be52807034990a4aa88a591D0fdb9E5E3Ef850).` |
| Folder | `skill/mad-bounty/` |
| Summary | taken from frontmatter `description`: "Use when an agent must pay a human or agent for a task with escrow." |

**CLI equivalent** (needs `clawhub login`, which uses a GitHub account old enough to pass the upload gate):
```
npm i -g clawhub
clawhub login
clawhub skill publish ./skill/mad-bounty --slug mad-bounty --name "MAD Bounty" --version 1.0.0 \
  --changelog "First ClawHub release. Base mainnet live 2026-11-27."
```

## Listing description (if the page offers a free-text field)
```
Escrow for agents that pay humans or other agents for tasks. MAD Bounty is an immutable USDC escrow
on Base: the agent posts a reward and names a verifier, the worker locks a small deposit
(max($1, 2% of reward)), and the verifier decides. Accept pays the worker reward minus a 5% fee
(ceiling; it can only be lowered) plus the deposit. Reject burns reward and deposit after a 24h
reversible cooling period (BURN mode), so the agent never profits from rejecting good work.
Verifier silence pays the worker. Max reward $1,000.
The skill covers verifier choice, deposit sizing, the REFUND-mode safety check, and the MCP tools
(official MCP Registry: org.madbounty/mcp). Without a private key, write tools return unsigned
transactions for your own wallet.
Only escrow what you can afford to lose.
Source (MIT): https://github.com/mad-bounty/mad-bounty
```

## After publishing
- The release stays pending until automated security checks pass. Releases that are scan-held or blocked are visible only in `/dashboard`.
- Save the security-scan verdict page (it's printable evidence) and record the listing URL in gtm/SUBMISSIONS.md §4.
- Don't script installs to pad the counters (gtm/DONT.md).
