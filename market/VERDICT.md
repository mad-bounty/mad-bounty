# MAD Bounty market study: verdict (2026-11-26)

Sources: demand.md, competitors.md, buyers.md, economics.md (this folder). npm figures re-checked live 11-26.

## Measured demand (not signups)
- RentAHuman (category leader): ~$20K MRR self-reported at 18% fee -> implied GMV ~$1.3M/yr. Fill rate 0.8%. 202 eligible workers vs ~787K signups. 3/303 bounties priced in USDC. 13% of registrants connected a wallet. 17.2% of bounties flagged abuse-adjacent.
- Virtuals ACP v2: ~30-50 jobs/day; $329 USDC ever escrowed, $150 ever released (on-chain read via agenticfinancegraph, 11-22).
- Open Bounty: 16 bounties ever, 34 USDC listed. Execution Market: $958 paid across 7,194 tasks, operator self-dealing.
- x402: organic agent-services volume low six figures/month; 87% of txs < $0.10; none of it task escrow.
- ERC-8004: 2.36M registered, ~3-6% ever transact.
- npm last 30d: x402 2,986,885; @coinbase/agentkit 18,575; rentahuman-mcp 5,056.

## Competition
- Fees: ACP ~10% (admin-set), Open Bounty 10%, Execution Market ~13%, RentAHuman 15-20%, Amigo 5-8%.
- Nobody else offers burn-on-reject + worker deposit + silence-pays-worker. Mechanism is novel but MIT and forkable.
- 25+ escrow MCP servers in the registry, none with published usage.
- x402 issue #2222 (escrow scheme, open) = a standards channel to plug into.

## Fee math
- 1% of RentAHuman's whole implied GMV = ~$13K/yr. 1% of all ACP releases ever = $1.50.
- Break-even accepted GMV: $30K/yr (domain+infra only); $1.7M/yr (plus $30K audit over 2y); $5.7M/yr (plus 0.25 FTE).
- The fee cannot fund audit + maintenance at today's market size, even at 100% share.

## Verdict
- PMF today: no. The demand that exists is small, fiat-priced, mostly micro/abuse-adjacent, and workers lack wallets.
- Burn-on-reject + worker deposit add friction where the observed problem is fill rate and onboarding, not agents stiffing workers.
- Real asset: a novel, tested, deployed mechanism for agent-as-employer trust. Value is option value on 2027+ agent commerce, plus credibility.

## Recommendation
Freeze and keep the option (low cost), and test one buyer before any more spend:
1. Do: $25 identity grab (domains+ENS), make the repo public, one Ethereum Magicians / x402 #2222 post. Total < $50 + a few hours.
2. Don't: mainnet deploy, seeding $1-2K bounties, or registry campaign, until a gate passes.
3. Gate to resume: one marketplace or agent operator commits in writing to route real bounties through MAD (e.g. RentAHuman/Open Bounty as escrow backend, or an x402 escrow-scheme integration), or organic agent->human escrowed GMV anywhere passes ~$100K/month.
4. If pursued commercially: revenue must come from periphery (verifier service, interface fee, B2B escrow-as-a-service), not the 1% core fee.
