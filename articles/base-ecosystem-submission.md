# Base ecosystem listing: field-by-field copy

**Form:** https://forms.gle/hJhc2PqfAsQp86YL8, which resolves to the Google Form "Base Ecosystem Project Update Submission" ("This form was created inside of Coinbase").
**Fields read from the live form on 2026-11-27** (browser; nothing was submitted):
- Page 1: Project Name\*, Project Website/Main URL\*, Brief Project Description, Project Logo Image URL\* ("High Resolution, recommend using imgur"), Primary Category (AI / Wallet / DeFi / Consumer / Onramp / Infra / Other).
- Page 2 (branches on the category): with **AI** selected, the "AI Subcategory (Select One)" options are only `AI` and `Other (Specify Below)`. With Infra selected, the page-2 options were not observed (see the unverified notes below).

**Requirements (secondary sources, not the form itself):**
- The archived `base/web` README (archived 2026-03-17, https://github.com/base/web): description under 200 chars; live on Base for **at least 30 days**; Terms of Service and Privacy Policy; HTTPS with a 301 from HTTP; not a TGE, ICO, airdrop or claim; content follows the Base Editorial Style Guide.
- A community guide (x.com/ERIFAT826/status/2055652169517568129, 2026-05-16; third party): 192×192 PNG/WebP logo, social links, "show real usage/activity on Base".

## ⚠ Gate: don't submit yet
- **30 days live:** mainnet went live 2026-11-27, so the earliest date is **2026-12-27**.
- **Real usage:** `nextId()` on the core returned **1** on 2026-11-27, which means zero bounties have been posted on mainnet (cast call via base-rpc.publicnode.com). Submit after real, independent bounties complete. Wash or self-dealt bounties are banned (gtm/DONT.md).
- **Satisfied now:** HTTPS (`http://madbounty.org` → 301); `/terms` and `/privacy` both return 200.

---

## Page 1

**Project Name**
```
MAD Bounty
```

**Project Website/Main URL**
```
https://madbounty.org
```

**Brief Project Description** (170 chars; limit 200)
```
Non-custodial USDC bounty escrow on Base: AI agents post work, workers deposit, a chosen verifier decides. Rejects burn funds, so agents gain nothing by stiffing workers.
```
Shorter fallback (126 chars):
```
Non-custodial USDC bounty escrow on Base: AI agents post work, workers deposit, a chosen verifier decides. Rejects burn funds.
```

**Project Logo Image URL**
- No logo asset exists yet. `site/assets/` holds only `favicon.svg` and `og.png` (1200×630).
- To do: export a square 512×512 PNG (it downscales cleanly to 192×192) to `site/assets/logo-512.png`, deploy it, then paste `https://madbounty.org/assets/logo-512.png`. Host it on our own domain rather than imgur, so the URL stays stable.

**Primary Category**
```
AI
```
(Alternative: `Infra`. In the old `base/web` taxonomy, `infra` had the subcategories `ai` and `developer tool`. Pick AI, because buyers find agent tooling there.)

## Page 2 (AI branch)

**AI Subcategory**
```
Other (Specify Below)
```
Specify text:
```
Agent payments / escrow (agents hiring humans or agents for paid tasks)
```
(If a reviewer prefers the fixed option, choose `AI`.)

---

## Supporting facts (if asked, or for a follow-up email)
- Core contract (Base mainnet): `0xa2Be52807034990a4aa88a591D0fdb9E5E3Ef850`. All 8 deployed contracts are Sourcify exact_match; addresses are in `deployments/base-mainnet.json`.
- Fee: 5% ceiling on accepted bounties. The treasury can only lower it, and the rate is locked per bounty. Max reward $1,000. USDC only.
- **Not externally audited.** 3 internal audit rounds, fuzzing, and a live testnet sweep.
- Source (MIT): https://github.com/mad-bounty/mad-bounty
- Agent access: the official MCP Registry entry `org.madbounty/mcp`; `npx skills add mad-bounty/mad-bounty`.
- Public stats (no JS): https://madbounty.org/explorer/
- Socials: GitHub `mad-bounty`. **No X or Discord account exists yet** (none is linked on the site). Leave those blank; don't invent handles.

## Also from Base (optional)
- Base Builder office hours: forms.gle/iG1oWfGkuMPAp8HX7 (from gtm/PLAN.md §1 row 22; not re-checked today).

## Unverified
- The page-2 subcategory options for the `Infra` branch (only the AI branch was observed).
- Whether the "30 days live" and "real usage" rules still apply to the form. They come from the archived README and a third-party post, not from the form text. Treat them as binding anyway.
