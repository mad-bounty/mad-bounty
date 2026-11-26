# Buyer-side demand & adoption barriers — agent-posted bounties (researched 2026-11-26)

Question: who actually needs an AI agent to pay a stranger (human or agent) for a task in late 2026, and would they use on-chain USDC escrow with worker deposits and burn-on-reject?

## 1. Real documented use cases with spend

### RentAHuman.ai — the only measured agent→human market (launched Feb 2026)
Source: Mehta, "Security Risks of AI Agents Hiring Humans: An Empirical Marketplace Study," arXiv:2602.19514 (Feb 23, 2026). https://arxiv.org/html/2602.19514
- 303 active bounty records over 14 days (Feb 5–20, 2026), 12,049 worker spots. Platform-reported cumulatives: 4.8M site visits, 539K registered workers, 100+ countries (within 2 weeks of launch).
- **32.7% of bounties posted via programmatic channels** (15.5% MCP `agent_*`, 17.2% API key) — a LOWER bound (automated browser sessions evade the prefix). 67.3% via web UI.
- **Pricing (per worker):** $1–$1,000 range, median $25; 37.5% of bounties under $10. Fixed-price 86.5%. **Currency: USD 278/303 (92%), EUR 12, ETH 8, USDC only 3, BTC 2** — even on a crypto-native platform, requesters overwhelmingly price/think in fiat.
- Documented agent-posted tasks (verbatim examples, prices):
  - $15 fixed × 15 spots: create fresh email account + register on a voice/verification service (credential farming; 87 applications, 841 views)
  - $60/hr × ~30 hrs: impersonate a professional profile through interview stages (identity proxy)
  - MCP agent "Clawdia": deliver a cold drink to a person at a Barcelona venue door at exactly 19:30 CET (physical delivery)
  - API-key bounty: call a public institution, confirm operating hours, submit via callback URL (recon/verification)
  - Social-media engagement: ~$1/worker × 500 spots ($500 total exposure)
  - Median abuse-class price $25/worker; abuse max exposure per bounty $60–$1,800.
- **Funnel reality check:** 568,948 views → 50,953 applications (5.3% view→app) → fill rate **0.8% overall (Web 1.1%, MCP 0.3%)**. 35 of 37 "completed" bounties had spotsFilled=0 — "engage-then-ghost" extraction. The market is a labor-pool interface, not a completed-transaction marketplace.
- WIRED (Mar 2026, https://www.wired.com/story/ai-agent-rentahuman-bots-hire-people): 518K+ registered workers vs only ~11.4K bounties ever posted (~50:1 worker:bounty ratio); one $10 bounty (video of a human hand) drew 7,578 applicants; founder claims "5,500 bounties successfully fulfilled" (self-reported, unverified). Paid verification $10/mo.
- WIRED reporter Reece Rogers earned **$0 after two days** of gig work; only independently confirmed paid task found in press coverage was a CEO checking API keys (theaifiles.app summary of Wired/BI coverage). Autopilot Index: RentAHuman self-reports **~$20K MRR (~$240K/yr run rate)**, 18% platform fee paid by requesters.
- RemoWork review (remowork.life): observed bounty prices median $12, most under $10, three at $0.50, top $100–$400; escrow released after review window; payout via Stripe (1–2 days) or platform wallet; terms disclaim contractor status, no background checks, no workers' comp.
- **Measured spend conclusion: no verified aggregate GMV exists.** ~5,500 claimed completions × ~$25 median ≈ low-six-figures total lifetime volume at best; independent verification is absent.

### Task-type demand (what buyers actually want)
From arXiv:2602.19514 taxonomy + YeckehZaare, "Measuring Proof Burden in Public Bounty Listings: A RentAHuman Case Study," HCOMP 2026, arXiv:2608.18547 (https://arxiv.org/html/2608.18547v1):
- 981-listing audit (May 31, 2026 snapshot; 779 after screening): **physical-world action 48.5% of listings, photo proof 37.1%, identity proof 30.9%**; 56.2% score 4–5 on a 0–5 proof-burden scale.
- Agent/bot-labeled requesters requested physical-world action, location proof, or recurring monitoring in 75.0% of listings vs 55.3% for human-labeled (exploratory, not confirmed).
- Demand clusters: (a) physical verification/photo proof of real-world state, (b) phone calls / "confirm operating hours" recon, (c) social-media engagement at volume ($1–$4/worker), (d) account creation and KYC-adjacent tasks ($13 median — the most active abuse class), (e) identity proxy for interviews ($60/hr), (f) physical deliveries ($110–$200 observed).
- **Data labeling** (Scale/Outlier/Surge-class work) remains human-hires-human at $18–$180/hr (Rest of World, https://restofworld.org/2026/ai-jobs-skills-gig-work/); no evidence yet of agents posting labeling bounties on-chain — agents post micro-tasks instead.
- **Agent-to-agent subcontracting exists but is micro-scale**: "Cursor Agent" MCP account posting coding subtask bounties (arXiv:2602.19514 §10); MCP registry has dedicated A2A bounty boards (com.brelsfordsoftware/agent-bounty-jobs; app.taskpush/taskford "hire other agents for data enrichment; pay from escrow only when machine checks pass"; io.github.0xdirectping/escrow "agent-to-agent escrow on Base, post quests with ETH/USDC bounties"; io.github.jdhart81/agent-escrow). Traffic/usage numbers are not published for any of these.

## 2. Developer / framework adoption signals (measured 2026-11-26)

npm downloads, last-month window 2026-10-26 → 2026-11-24 (api.npmjs.org), plus Aug 1–Nov 25 cumulative:
| Package | last-month | Aug 1–Nov 25 total |
|---|---|---|
| x402 (Coinbase) | **2,986,885** | 8,352,392 |
| x402-fetch | 63,036 | 329,378 |
| @coinbase/agentkit | 18,575 | 121,105 |
| rentahuman-mcp | 5,056 | 15,753 |
| @paymanai/payman-ask-sdk | (last-mo n/a) | 4,432 |
| @paymanai/payman-ts (Payman core SDK) | (last-mo n/a) | **291** |
GitHub stars: coinbase/x402 = 185; coinbase/agentkit = 1,364 (api.github.com). Payman has no notable public repo/star signal.

- **x402 is the dominant agent-payment rail by download volume** (~3M/month), but its usage is API-pay-per-call micropayments, not task escrow: 87% of transactions < $0.10 (Chainalysis, Sep 2026).
- **x402 measured spend vs headline**: 235.5M payments / $56.4M all-time value (May 2025–Oct 2026, Coinbase Agentic Market data via greyarealabs.co, 2026-11-24); but TRM Labs (Sep 9, 2026) estimates only **0.6–7.5% of screened value is actually AI agents**, i.e. agents move ~$5K–$11K/month. a16z (X, Nov 2026): after filtering wash trading, x402 processes **~$1.6M/month** in agent-driven payments — vs the $24M/month Bloomberg reported from x402.org. Much of the 2025 spike was PING pay-to-mint speculation (Chainalysis, "Inside x402: 100M Agentic Payments," Jun 3 2026, https://www.chainalysis.com/blog/x402-agentic-payments-adoption/).
- MCP registry (registry.modelcontextprotocol.io, searched 2026-11-26): "bounty" returns ~30 entries (mostly read-only bug-bounty searchers like yultrace-bounty-feed indexing Bountycaster/Dework/Superteam/Algora/GitHub); "escrow" returns ~25 incl. several USDC-on-Base agent escrow servers (io.github.0xdirectping/escrow, adamgraymon's ERC-8183 auditor-escrow family, iEscrow with human-2FA, jdhart81/agent-escrow). **No escrow/bounty MCP server publishes usage numbers; the niche is crowded with zero traction data.** Note: ChatGPT directory bans crypto-transfer apps; Smithery/PulseMCP not accepting submissions (internal GTM notes, consistent with registry being the only open listing path).
- Framework payment protocols competing for the same buyers: Google AP2 (stablecoin + cards), OpenAI+Stripe ACP (fiat), Stripe/Tempo MPP (Mar 2026), Visa CLI card payments (spark.money research roundup).

## 3. Adoption barriers

**Worker crypto onboarding (the biggest measured one):**
- RentAHuman launched crypto-wallet-only payouts; **only 13% of registrants ever connected a wallet**, excluding 87% of the workforce from payment until Stripe Connect + platform credits were added (theaifiles.app; builtin.com confirms payouts via "cryptocurrency, Stripe or platform credits"). MAD's USDC-only rails would hit the same wall on the worker side.
- Workers who most want borderless crypto pay (sanctioned/thin-banking countries) are exactly the ones compliance screening excludes (Jurist commentary, Jul 2026, https://www.jurist.org/commentary/2026/07/a-website-puts-human-labor-up-for-rent-and-the-law-isnt-ready/).

**Deposit friction:** 539K+ workers compete for ~11K bounties (≈50:1). A worker-side deposit (MAD: max($1, 2% of reward)) deters a pool already characterized by $0.50–$10 tasks and 7,578 applicants for one $10 bounty; the marginal worker has no wallet yet (see 13% stat). Deposit schemes are unproven in this market — no comparable live benchmark found.

**Burn-on-reject perception:** no direct survey data exists (nothing found). Adjacent evidence cuts against it: (a) the engage-then-ghost pattern shows requesters already extract work without pay and workers lack recourse (arXiv:2602.19514 §13); (b) crowd-work literature shows rejection risk already depresses participation (Toxtli 2021; Hara 2018, cited in arXiv:2608.18547); (c) burning *wages owed* after work performed is in tension with wage law — California Labor Code-style protections treat wages as irrevocably earned, and "burn" instead of refund-to-worker of the deposit could read as an unlawful deduction. MAD's REFUND rejectMode + worker-safety gate is the necessary mitigations, but BURN default will be a press/legal liability (consumer protection for burned wages). Confidence: medium — reasoned from adjacent sources, no direct measurement.

**Legal / classification:**
- No legal system recognizes the AI agent as a hiring party — no legal person to sue, no tax ID, can't hold a business license (Jurist, Jul 2026; slasify.com compliance analysis).
- Worker classification risk: the more precisely an algorithm specifies the task (which is MAD's whole premise — machine-readable specs + verifiers), the stronger the employment-relationship case under Uber v Aslam-style control tests (Jurist).
- US obligations cluster: classification, wage-and-hour, payroll tax withholding/reporting/1099 (Toku, https://www.toku.com/resources/ai-agents-hiring-humans). Payments to humans are 1099-reportable at $600+/yr; an immutable no-KYC protocol can't issue 1099s — the human operator behind the agent's wallet bears the obligation and probably doesn't know it.
- Money transmission: MAD holds USDC in escrow via an immutable contract — arguably decentralized/non-custodial (treasury fixed, no owner), the strongest fact against money-transmitter characterization post-GENIUS Act (stablecoin framework passed Jul 2025, per Galaxy). But BURN-to-0xdEaD of worker funds could still be framed as consumer harm.
- Liability void: workers as "moral crumple zones" for illegal tasks an agent orchestrates (arXiv:2602.13622, Shadow Boss paper); abuse demand is real (17.2% of RentAHuman bounties flagged security-relevant) — an immutable, permissionless escrow that can't refuse a bounty is a target for exactly the six abuse classes Mehta catalogs.

**Fiat preference:** 92% of RentAHuman bounties priced in USD (see §1); the entire agentic-commerce race (Stripe ACP/MPP, Visa, AP2) is building fiat-first rails because agents' principals want cards/banks; Wired/builtin reporting shows workers prefer Stripe payouts. USDC-only is a niche-within-niche.

## 4. Academic / analyst views on market size & timing

- **arXiv:2602.19514 (Mehta, Feb 2026)** — only empirical spend measurement: median $25/worker, near-zero fill rates, majority of programmatic demand is abuse-adjacent (credential farming, social-media manipulation, recon). Implies the *legitimate* agent→human spend in early 2026 was negligible.
- **arXiv:2608.18547 (YeckehZaare, HCOMP 2026)** — demand exists for proof-heavy physical tasks (48.5% physical, 37.1% photo), but studies listings, not paid transactions; no volume data.
- **Cambridge (Zhang, Liu, van der Schaar, arXiv:2505.20120)** — theoretical: agent labor markets need marketplace facilitation; demand side "will remain largely human-driven at least initially." Forecast, not measurement.
- **a16z "Big Ideas 2026"** (https://a16z.com/newsletter/big-ideas-2026-part-3/) — forecast: stablecoins ($46T 2025 volume) + x402 make agent payments a network behavior; predicts "KYA: Know Your Agent" identity emerges 2026. Their own measured caveat: x402 real agent volume ~$1.6M/month post-wash-filter. Counterpoint analyses (bex.co) call agent payments "experimental in 2026; regulatory clarity and liability frameworks years behind."
- **Galaxy Research** (Jan 2026 x402 report; Feb 2026 agentic capital markets; 2026 predictions) — forecast: x402 to reach 30% of Base daily txs and 5% of Solana non-vote txs in 2026; notes GENIUS Act + ERC-8004 identity/reputation as enabling hire-each-other primitives. Still forecast.
- **Circle (Q2 2026)** — 99.3% of x402 agent-payment volume settles in USDC (the one strong tailwind for MAD's USDC-on-Base choice).

## Bottom line (numbers, confidence)
- **Measured agent→human spend is tiny and mostly abuse-adjacent**: ~5,500 claimed completions at ~$12–25 median on the flagship platform, ~$20K MRR platform revenue, 0.8% fill rate; x402's genuine agent payment volume ~$1.6M/month, 87% of txs under $0.10 — none of it task escrow. (High confidence.)
- **Real buyer segments today**: agent operators needing physical-world verification/photo proof, phone-call recon, volume social engagement — plus agent-to-agent subcontracting at API-call prices. (High confidence these are the listings; medium confidence they map to MAD's $1–$1,000 escrow product.)
- **Adoption blockers ranked**: (1) worker wallet onboarding (13% wallet-connect rate measured); (2) fiat preference (92% USD pricing measured); (3) legal void on agent-as-employer + 1099/wage law (documented by Toku/Jurist, high confidence); (4) burn-on-reject perception (no direct data, medium confidence, likely a PR and wage-law liability); (5) crowded zero-traction MCP escrow niche (25+ servers, no usage data, high confidence).
- **Timing**: analysts (Galaxy, a16z) put agentic payments at forecast-stage in 2026 with identity (ERC-8004/KYA) as the gating primitive — exactly MAD's distribution bet; the one measured tailwind is that USDC-on-Base is where the (tiny) real agent spend settles.

*All npm/GitHub/registry numbers pulled live 2026-11-26 via api.npmjs.org, api.github.com, registry.modelcontextprotocol.io. Full-paper texts cached at ~/.hermes/cache/web/arxiv.org-588d1112e7.md and arxiv.org-f5566d9b10.md.*
