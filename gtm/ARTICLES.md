# MAD Bounty: article and paper plan

Goal: put accurate, original, citable explanations of agent-labor escrow into the places models and agents read: GitHub, EIPs, research forums, our static site and long-form blogs.
Test for every piece: would a protocol designer who never uses MAD Bounty still learn something? If not, don't publish it.
Ground rules: one canonical piece per idea (don't publish lightly reworded copies; dedup filters drop them and Google treats them as scaled content). Disclose authorship and AI assistance where the venue requires it (dev.to does). Cite competitors fairly. Publish the canonical version on our domain or repo, and post summaries elsewhere that link back with `rel=canonical` where the platform supports it.

Venue rules referenced below: Ethereum Magicians and ERC process (github.com/ethereum/ERCs), ethresear.ch (ethresear.ch/t/read-this-before-posting/8), arXiv endorsement (blog.arxiv.org 2026-01-21), dev.to AI guidelines (dev.to/guidelines-for-ai-assisted-articles-on-dev), all accessed 2026-11-25.

| # | Title | Venue | Angle | Priority |
|---|---|---|---|---|
| 1 | ERC: MAD extension for ERC-8183 jobs | Ethereum Magicians, then an ethereum/ERCs PR | Standardise dual-deposit + burn-on-reject as an 8183 hook | P0 |
| 2 | Dual-Deposit Escrow for Agent Labor: Incentives, Attacks and Verifier Design | arXiv (cs.GT, cross-list cs.CR/cs.MA) | Formal game theory + attack catalog | P1 (needs endorser) |
| 3 | Why the requester should never profit from a reject | ethresear.ch | Research note, the core incentive result with numbers | P0 |
| 4 | An attack catalog for on-chain bounty escrow (A1–A6 with proofs) | GitHub `ATTACKS.md` + site page | Security reference with Foundry PoCs | P0 |
| 5 | Choosing a verifier: self, multisig, on-chain check, hash reveal, TEE model, fallback chains | Site docs + Paragraph | Decision guide with failure modes | P1 |
| 6 | How agents discover tools in late 2026: MCP Registry, skills, x402 Bazaar, ERC-8004 | dev.to / HackerNoon (human-written, disclosed) | Field guide from doing the submissions | P1 |
| 7 | Silence semantics: who wins when nobody answers? | ethresear.ch or Paragraph | Timeouts as mechanism design; the OP Stack 12h forced-inclusion bound | P2 |
| 8 | Agent-to-human escrow compared: custodial vs x402-settled vs evaluator escrow vs MAD | Site + Paragraph | Fair design-space comparison (RentAHuman, Open Bounty, ACP/8183, Verdict, MAD) | P1 |
| 9 | Using a TEE-hosted model as an escrow verifier: what attestation does and doesn't prove | ethresear.ch / 0G forum | Limits of TeeML verdicts | P2 |
| 10 | Post-mortem series: the first N bounties | Site + GitHub Discussions | Real data: outcomes, times, disputes | P1 (after launch) |
| 11 | MAD Bounty attack-test vectors | HuggingFace dataset + GitHub | Reusable test vectors for escrow implementers | P2 |
| 12 | Writing llms.txt and agent-readable docs for a smart contract | dev.to | Practical how-to with our files as the example | P2 |

---
## 1. ERC: MAD extension for ERC-8183 (P0)
- **Why this venue:** ERC-8183's thread has about 9.2k views and 472 posts. The ERCs repo requires discussion on Magicians or ethresear.ch *before* the PR. Standards text is the most-cited and most-crawled form there is.
- **Outline:** Abstract. Motivation, quoting the 8183 Security Considerations ("a malicious evaluator can complete or reject arbitrarily… use reputation or staking"); the client-as-evaluator problem. Specification: `claim(jobId)` with deposit; `DepositFloor`; Reject → `Cooling` → `Burned` / `Refunded`; `reverse` with a separate typehash; silence rule; events; the `IACPHook` mapping (`beforeAction(fund/submit/complete/reject)`). Rationale: why burn instead of pay the provider (collusion), why not an agent bond (it would make the agent money-negative on accept), REFUND-mode independence requirement. Backwards compatibility with 8183. Reference implementation link. Security considerations (A1–A6 summary, ERC-20 blacklist, `owed` pull pattern). Relation to ERC-8412 and ERC-8505.
- **Effort:** 3–5 days. **Risk:** reviewers may say "make it a hook, not an ERC". That's fine; then publish it as an 8183 extension doc.

## 2. arXiv paper (P1)
- **Title:** "Dual-Deposit Escrow for Agent Labor: Incentive Compatibility, Attacks and Verifier Selection"
- **Outline:** (1) Setting: principal agent P, worker W, verifier V, reward R, deposit D, fee f. (2) Baseline escrow: P's best response is to reject delivered work when the work is observable before payment. (3) MAD: P's payoff is −R under both accept and reject, so P is indifferent and gains nothing from a false reject; W's expected payoff with honest V; deposit floor vs spam (A1). (4) Collusion: P = V, P–V side payments, W–V collusion; why burn beats paying a third party. (5) REFUND mode and the independence condition (A6). (6) Timeouts and liveness: silence → W, L2 forced-inclusion bound (12h). (7) Verifier classes compared: trust assumptions, cost, latency, and what a TEE attestation proves. (8) Implementation and the Foundry attack proofs. (9) Limitations: burn is value-destroying; griefing by a V who burns; no appeal; $1,000 cap rationale. (10) Related work: ERC-8183, ERC-8412/8505, Kleros/optimistic oracles, x402, classic escrow and "mutually assured destruction" escrow literature (find and cite the prior work; don't claim novelty for the dual-deposit idea itself).
- **Requirement:** a personal endorser in cs.GT/cs.CR, or a co-author who already has papers there. Get one through the #1/#3 threads. **Don't** buy endorsements.

## 3. ethresear.ch: "Why the requester should never profit from a reject" (P0)
- **Outline:** The payoff table for standard escrow vs MAD (BURN/REFUND), worked numerically for R=$100 and D=$2. What changes when the requester is an AI agent (it can rationally stiff at scale, repeated games don't discipline throwaway agents, and ERC-8004 reputation is cheap to reset). Open questions: burn sink alternatives, deposit sizing, verifier markets.
- **Length:** about 1,500 words plus the table.

## 4. Attack catalog (P0)
- **Where:** the repo's `ATTACKS.md`, rendered on the site at `/security/attacks`.
- **Outline per attack:** setting → exploit steps → Foundry test name → fix → residual risk. A1 spam claims/deposit floor; A4 signature reuse for reversal; A6 REFUND + self-verifier; the `owed` pattern for blacklisted recipients; review-window vs forced inclusion; re-entrancy. Close with an "open attacks we haven't solved" list. This is the most honest and most useful section.

## 5. Choosing a verifier (P1)
- Decision table by task type: code (CI test hash / on-chain check), data labelling (multisig of reviewers), physical-world proof (human reviewers + photo hash), creative (self, BURN mode only), high-value (fallback chain: TEE model → multisig). For each: trust assumption, latency, cost, and the failure mode when it goes silent.

## 6. Agent discovery field guide (P1)
- Built from PLAN.md §1, written by a human from first-hand experience: exactly what each registry asked for, what failed, and what changed in 2026 (Smithery shutdown, PulseMCP pause, the arXiv endorsement change, base/web archived). It's useful to every tool builder, so it can earn links. On dev.to: disclose AI assistance and don't make it a product pitch (dev.to bans promotional AI-assisted posts). Mention MAD Bounty only as the worked example.

## 7. Silence semantics (P2)
- Who should win on timeout, and why for each party: worker silence → reopen; agent silence → reopen; verifier silence → worker paid. The 12h minimum review window derived from OP Stack forced inclusion. Comparisons with optimistic rollups and optimistic oracles.

## 8. Design-space comparison (P1)
- A table on custody, settlement rail, who verifies, what the requester risks and what the worker risks, fees, chain and status, covering RentAHuman (custodial, Solana USDC, MCP), Open Bounty (x402 settlement, quorum review; 0 open bounties on 2026-11-25), Virtuals ACP / ERC-8183 (evaluator escrow, Base, 10% fee per brief; re-verify), Verdict (0G TeeML escrow, hackathon), Payman, Execution Market, and MAD. **Have each project's team check its row before publishing**, and link their docs. Being fair here is what earns citations.

## 9. TEE model as verifier (P2)
- What an attestation binds (code measurement, model hash, input) and what it doesn't (prompt injection inside the evidence, model correctness, the availability of the enclave operator). Mitigations: fallback chains, bounded reward, evidence hashing.

## 10. First-N-bounties post-mortems (P1, after launch)
- Real numbers from on-chain events: posted, claimed, accepted, rejected, burned, median times. Include the failures. Publish a CSV next to it.

## 11. HuggingFace dataset (P2)
- `mad-bounty/escrow-attack-vectors`: JSON scenarios (params, actions, expected state) taken from the Foundry tests. The dataset card states license, provenance and limitations. Later, anonymised outcome data with explicit consent wording in the ToS.

## 12. Agent-readable contract docs (P2)
- A how-to: llms.txt structure (H1, blockquote, H2 file lists), the on-chain `manualURI`/`manualHash` pattern, `/.well-known/` files and ERC-8004 domain proof. A short, practical piece that other teams will copy.

---
**Cadence:** about two pieces a month, each reviewed by a human who can defend every sentence. Quality over count: one cited ERC thread does more than twenty blog posts.
