# Agent-Commerce Escrow / Bounty / Task-Verification — Competitive Landscape (late Nov 2026)

Compiled 2026-11-26 from live web sources (URLs cited per entry). Facts only as reported by sources; no fabrication.

## Summary matrix

| Competitor | What | Custody | Fee / take | Funding | Enforced escrow? | Chain |
|---|---|---|---|---|---|---|
| MAD Bounty (us) | Dual-deposit bounty escrow, burn-on-reject, verifier-silence-pays | Non-custodial per-bounty vault clones, immutable | 1% on accept | none | Yes (immutable, no owner) | Base |
| RentAHuman | Agents hire humans for physical tasks | Platform escrow (custodial flow: agent deposits → platform → worker) | 15–20% | bootstrapped (Risk Labs/UMA founder-adjacent) | No — platform-mediated | Off-chain, crypto payments |
| Virtuals ACP / ERC-8183 | Agent↔agent job escrow w/ evaluator attestation | On-chain escrow, admin-set fees | platformFeeBP=500 + evaluatorFeeBP=500 (~10% total, admin-set) | Virtuals token economy | Yes (smart contract) but admin fee keys | Base, Robinhood Chain, Solana |
| Open Bounty (openbounty.app) | x402-native marketplace, humans do real-world tasks | NOT prefunded; agent pays after quorum approval | 10% delivery fee (second x402 payment) | unknown | No — board + post-hoc payment | Base (Sepolia demo), x402 v2 |
| Payman | AI-agent payment orchestration (agents pay humans/banks) | Custodial platform | platform/SaaS | $13.77M total (Series A; Visa, Coinbase Ventures) | No — payments rails, not escrow | Off-chain |
| Execution Market | Universal execution layer, humans/agents hire each other | "Trustless escrow" via x402r EVM + NEAR escrow; but expired review → MANUAL team review | Worker keeps 87% (~13% take) | Ultravioleta DAO (unknown $) | Partial — escrow exists, silence unhandled | 12 networks (10 EVM, Solana, NEAR) |
| Amigo (amigo.run) | Insured physical-task marketplace, MCP dispatch | Custodial + insurance underwriting | 8%/task (Starter), 5%/task (Scale) + labor | unknown (private beta) | No — platform-insured | Off-chain API |
| Kleros Escrow V2 | P2P escrow w/ juror arbitration | Non-custodial contract | arbitration fees paid by losing/disputing party | PNK token | Yes | Arbitrum One |
| UMA OOv3-based | Optimistic-oracle assertions as verification layer (used by agent escrows like proof-market) | Non-custodial (integrator's contract) | bond + finality fee per assertion | UMA token | Yes (integrator-dependent) | EVM multi-chain |
| x402 escrow (issue #2222 + Boson x402B) | Open `scheme:"escrow"` wire standard; Boson Diamond reference impl | Non-custodial (Boson Diamond) | impl-defined (Boson charges protocol fees on its own) | Boson: prior raise | Yes (once shipped; PR open, in progress) | EVM (x402 neutral) |
| Stripe Bridge / MPP + AP2 | Machine payments for agents (pay-per-call) | Stripe custody | Stripe pricing | Stripe (public co) | No — instant settle, no escrow | Off-chain rails (x402/MPP support) |
| Skyfire | Agent payment network (wallets, spend limits) | Custodial wallets | spread/subscription | $9.5M (a16z CSX, Coinbase Ventures) | No | Base + off-chain |
| Nevermined | AI-to-AI payment protocol (usage-based) | Mostly non-custodial | protocol fees | $4M seed (Generative Ventures) | Partial — payment, not task escrow | EVM |
| Catena Labs | "AI-native bank" for agents | Regulated bank custody | bank/spread fees | $18M (2025) → $30M Series A-II (5/20/2026); OCC preliminary approval | No — custody, not escrow | USDC-centric |
| Gitcoin / Layer3 / Dework | Web3 bounty/task boards | Gitcoin: escrowed grants; Layer3: quests; Dework: board w/ payouts | 5–10% typical | VC-backed (various) | Mostly boards | Multi |
| Bountycaster | Farcaster/Twitter bounty board | None — bounties paid P2P | 0% ("We do not" charge) | none | No — pure board | Farcaster/social |
| Replit / Upwork AI-agent hiring | Agents as freelance labor on Upwork; humans hiring agent-built apps | Upwork escrow (client funds held) | Upwork ~10% freelancer fee | public/VC | Enforced via Upwork escrow | Off-chain |
| New 2026 entrants | Arbitova (open escrow + N=3 LLM arbitration, Base Sepolia, x402 issue #2001), Daydreams TaskMarket, BasedAgents, BountyBook, make.fun bounties, Agentizable (OSS), TessPay (arXiv), proof-market (NEAR, bonded verifiers), BNBAgent SDK (ERC-8183 on BNB) | varies | varies | varies | varies | varies |

## Differentiator scan: burn-on-reject / dual-deposit / verifier-silence-pays

- **Burn-on-reject:** Not found in any live commercial competitor. Closest is proof-market (NEAR) — *verifiers* lose a burned bond when their verdict contradicts settled truth, not workers (github.com/spragginsdesigns/proof-market). No platform burns worker deposit + reward on reject.
- **Dual-deposit (worker stakes):** Not found in mainstream platforms. ACP/ERC-8183 has no worker bond (buyer funds escrow only; the arXiv SoK 2610.01756 notes evaluator-controlled acceptance "lacks an established bounded alternative during refusal"). Small OSS/hackathon repos exist (e.g. agent-escrow variants on GitHub) but no traction. Amigo/Open Bounty/RentAHuman use platform reputation or insurance instead of skin-in-the-game.
- **Verifier-silence-pays-worker:** Not found anywhere. Execution Market explicitly says "an expired review window does not guarantee payment" — unresolved escrow goes to *manual review by the team* (execution.market homepage). Open Bounty: reviewer window expiry just reopens the review; publisher non-payment after approval leaves the worker unpaid (their FAQ). ACP: evaluator timeout → job expiry/refund path (backend "Expired Job Handling" per changelogs), not auto-pay.

**MAD's triple (burn-on-reject + worker dual-deposit + silence-pays-worker) appears unique in the market as of late Nov 2026.**

## Per-competutor detail

### RentAHuman (rentahuman.ai)
- Launched Feb 2, 2026 by Alexander Liteplo (Risk Labs / UMA ecosystem), built in a weekend. "Meatspace layer" — agents hire humans for physical tasks via MCP/REST. (rentahuman.biz/how-it-works; wired.com/story/ai-agent-rentahuman-bots-hire-humans)
- Custody: platform escrow — AI deposits, human paid on completion verification.
- Fee: 15–20% platform fee. Traction: 174k registered humans, 11,015 bounties, 2.7M site visits, but only 13% wallet-connect rate and documented incomplete tasks (rentahuman.biz).
- Enforced escrow: no — platform-mediated trust. Chain: off-chain w/ crypto payouts.

### Virtuals ACP / ERC-8183
- Open agent-commerce standard: job escrowed, evaluator attests, four states (Open→Funded→Submitted→Terminal). ACP v2.0 is the ERC-8183 reference implementation (eips.ethereum.org/EIPS/eip-8183; whitepaper.virtuals.io).
- Fees: platformFeeBP=500 + evaluatorFeeBP=500 (admin-set, per our fork tests and datawallet.com). Admin-controlled — mutable.
- Traction: 12.36M cumulative commerce memos on legacy Base contracts but daily memos fell to ~16/day by 2026-11-23; current contract ~36 jobs created/week (agenteconomy.to/virtuals-acp, 2026-11-25). Platform fee revenue peaked $345k (Mar 2026), $5.48 in Sept (chainward.ai).
- Enforced escrow: yes, but fees admin-gated; no worker deposit; evaluator refusal unbounded (arXiv SoK 2610.01756).

### Open Bounty (openbounty.app)
- "First x402-native marketplace for humans and agents." Quorum of 3 human reviewers, 2-of-3 approval. Worker paid via x402 only AFTER approval; bounties not prefunded.
- Fee: 10% delivery fee settled as a second x402 payment. Zero bounties live at time of check (site shows placeholder metrics). Base (Sepolia demo flow).
- Enforced escrow: no — approval is a board decision; payment is post-hoc; publisher can simply not pay (suspension is the only recourse; their FAQ).

### Payman (paymanai.com)
- Agent→human payment orchestration; now pivoted to deploying AI agents for banks/credit unions doing real banking transactions (paymanai.com/about-us; rootdata).
- Funding: $13.77M total, Series A; investors Visa, Coinbase Ventures, Spartan Group, Boost VC (fastaijobs.com; chaincatcher).
- Not task-verification or escrow — payment rails. Take rate: SaaS/platform. Off-chain.

### Execution Market (execution.market)
- "Universal Execution Layer — humans today, robots tomorrow." Humans, agents (and planned robots) hire each other; bounty locks in trustless escrow (x402r on EVM, dedicated escrow on NEAR, Solana Channels); ERC-8004 identity/reputation; staged humanity checks (VeryAI palm ≥$50, World ID Orb ≥$500).
- Fee: worker keeps 87% (~13% take). Traction: 7,194 total tasks, 3,509 completed, $958 total paid, 72 executors, 12 networks (site metrics, late Nov 2026). Tiny dollar volume.
- Enforced escrow: partially — expired review window → manual team review (explicit admission on homepage).

### Amigo (amigo.run)
- "First insured marketplace" for agents dispatching physical tasks to verified humans; MCP integration in 5 min; verification engine (calls, photos, GPS) + automatic insurance payouts.
- Fee: 8%/task (Starter, $500 insurance), 5%/task (Scale, $5k insurance) + labor cost. Private beta. Funding unknown.
- Enforced escrow: no — custodial + insurance model. Off-chain.

### Kleros Escrow V2
- P2P escrow with Kleros Court as arbitrator; V2 on Arbitrum One, any ERC-20, SafeERC20 (docs.kleros.io/products/escrow). Disputes: both parties pay arbitration fees, losing side reimbursed (github.com/kleros/kleros-docs).
- Fee: arbitration fees on dispute only, not ad-valorem on every job. Enforced escrow: yes. Chain: Arbitrum One.

### UMA-based verification
- UMA Optimistic Oracle V3: assertion + dispute window, disputed assertions go to UMA DVM voters (docs.uma.xyz). Used as the verification layer in agent escrow builds (e.g. proof-market on NEAR; TessPay paper, arxiv 2602.00213, proposes TLS-notary/TEE PoTE).
- Fee: bond + finality fee per assertion. Enforced: yes where integrated. EVM multi-chain.

### x402 escrow proposals (issue #2222)
- May 7, 2026: levalleux-ludo proposed `scheme:"escrow"` — an open, implementation-agnostic wire-format standard (non-custodial on-chain escrow between buyer/seller) with state machine COMMITTED→RELEASED/DISPUTED/REFUNDED; explicitly avoids canonizing any single contract (Coinbase AuthCapture PR #1425, Boson Diamond, cart.fun TrustEngine, x402r CREATE3 all first-class). Spec at bosonprotocol/x402-escrow-schema; reference impl bosonprotocol/x402B in progress (github.com/x402-foundation/x402/issues/2222, bosonprotocol.io).
- Fee: implementation-defined. Status: OPEN proposal, not adopted. If adopted, x402 becomes the dominant distribution channel for any escrow implementation — including a MAD adapter.
- Related: issue #2001 proposes N=3 LLM majority-vote arbitration for x402 escrow disputes.

### Stripe Bridge / agent payments
- Stripe launched Machine Payments Protocol (MPP), open standard for agent pay-per-call; Stripe docs now support MPP and x402 machine payments (docs.stripe.com/payments/machine; stripe.com/blog/machine-payments-protocol). Google's AP2 (ap2-protocol.org) is the parallel open effort.
- Instant settlement, no escrow, no task verification. Custody: Stripe. Take: Stripe pricing.

### Skyfire
- Payment network for AI agents (agent wallets, spend limits, KYC); $9.5M total raised (Coinbase Ventures, a16z CSX; theblock.co 2024-10-24; $8.5M earlier round). Base integration. Not escrow.

### Nevermined
- Decentralized AI-payment protocol ("PayPal for AI"), usage-based AI-to-AI payments; $4M seed led by Generative Ventures (Jan 2025; finextra/fintech.global). Payment rails, not enforced task escrow.

### Catena Labs
- Circle co-founder Sean Neville's "AI-native financial institution"; $18M out of stealth May 2025 (cointelegraph), $30M Series A-II May 20 2026 (cbinsights), Catena Trust Bank secured preliminary OCC approval for AI-agent financial infrastructure (yahoo finance). Custody/banking, not bounty escrow.

### Gitcoin / Layer3 / Dework
- Classic web3 bounty/grant/quest boards. Gitcoin: escrowed grant pools (protocol fees historically ~5%); Layer3: quest/credential platform; Dework: DAO task board with treasury payouts. Boards + light escrow, human review, web2-style UX. Volume declining with web3 gig market (web3vacancy.com guides 2026).

### Bountycaster
- Farcaster/Twitter bounty board via @bountybot; all bounties paid peer-to-peer, no platform fee ("We do not [charge]" — bountycaster.xyz/faq). Zero custody, zero enforcement — pure social board. Takes zero revenue; proves the "board" end of the spectrum.

### Replit / Upwork AI-agent hiring
- Upwork lists 64+ Replit-related freelance jobs (Nov 2026) and AI-agent jobs; Upwork escrow holds client funds (~10% freelancer service fee). Replit agents are being hired/managed via Upwork contracts — traditional marketplace escrow, off-chain, human-dispute. (upwork.com/freelance-jobs/replit/)

### New 2026 entrants worth tracking
- **Arbitova** (arbitova.com): open escrow + N=3 LLM majority-vote arbitration + reputation for the agent economy; EscrowV1 on Base Sepolia; MCP server + TS/Python SDKs (github.com/jiayuanliang0716-max/Arbitova; vibehackers.io). Closest architectural cousin to MAD's Multi/TeeML adapters, but testnet-stage.
- **Daydreams TaskMarket** (taskmarket.dev): standardizing agent-economy outsourcing (cryptobriefing).
- **BasedAgents** (basedagents.ai): task marketplace + reputation registry for agents.
- **BountyBook** (producthunt): agents earn USDC task marketplace.
- **make.fun** (make.fun): AI-agent coding bounties in USDC.
- **Agentizable** (github.com/NSPG13/agent-bounties) + Aigen Protocol AIP-1 "Open Agent Bounty Protocol": OSS wire specs.
- **TessPay** (arxiv 2602.00213): verify-then-pay with TEE/TLS-notary PoTE — academic.
- **BNBAgent SDK**: first live ERC-8183 implementation on BNB Chain (bnbchain.org blog).

## Moat assessment (what defends MAD's 1%?)

1. **Nobody else has the enforcement triple** — burn-on-reject, worker dual-deposit, and verifier-silence-pays-worker are absent from every funded competitor; ACP's evaluator model is unbounded on refusal, Open Bounty's is post-hoc and non-prefunded, Execution Market's falls back to manual review. The mechanism, not the code, is the differentiator.
2. **But the mechanism is visible in MIT code** — a fork can copy burn/dual-deposit/silence-default in weeks (RentAHuman was built in a weekend; Arbitova already ships most of the adapter pattern). Pure protocol novelty buys ~one hype cycle, not a moat.
3. **1% is defensible only vs. the fee ladder it undercuts** — ACP 10%, Open Bounty 10%, Execution Market 13%, RentAHuman 15–20%, Amigo 5–8% + insurance. MAD is the cheapest enforced product; its real competition on price is Bountycaster (0%, no escrow) and x402 `exact` (0%, no escrow), which win wherever buyers don't need enforcement.
4. **The durable moats are non-contractual**: (a) immutable, no-admin contracts vs. ACP's admin-set fees — verifiable neutrality an auditor/agent-integrator can check on-chain; (b) verifier-adapter ecosystem + SDK/MCP distribution and being the reference `escrow` implementation inside x402's open scheme if #2222 lands; (c) audit reputation and the self-describing agent docs (llms.txt/ERC-8004) that make MAD the default a fleet of agents already knows how to use.
5. **Endgame: fee compression toward infrastructure** — Catena/Stripe/Payman own regulated custody rails and will commoditize payments; escrow-as-mechanism gets standardized by x402. MAD's defensible sliver is being the cheapest, most neutral, machine-trustworthy *enforcement* layer — 1% survives only while integrations, audits, and agent-native docs (not the Solidity) are the switching cost.

## Sources
- rentahuman.biz (how-it-works, pricing, stats pages); wired.com/story/ai-agent-rentahuman-bots-hire-humans
- eips.ethereum.org/EIPS/eip-8183; whitepaper.virtuals.io/acp/*; agenteconomy.to/virtuals-acp; chainward.ai/decodes/virtuals-top-dog; fundstrat.com Virtuals Q2-2026 PDF
- openbounty.app (homepage, FAQ); execution.market (homepage, docs); amigo.run
- docs.kleros.io/products/escrow; docs.uma.xyz; github.com/x402-foundation/x402 issues #2222, #1425, #2001, #1645; bosonprotocol.io/docs-app/x402
- docs.stripe.com/payments/machine; stripe.com/blog/machine-payments-protocol; ap2-protocol.org
- theblock.co (Skyfire $9.5M); finextra/fintech.global (Nevermined $4M); cointelegraph.com + cbinsights.com (Catena $18M/$30M, OCC); fastaijobs.com/chaincatcher (Payman $13.77M)
- bountycaster.xyz/faq; upwork.com/freelance-jobs/replit/; github.com/spragginsdesigns/proof-market; arxiv.org/html/2610.01756; arxiv.org/html/2602.00213; arbitova.com
