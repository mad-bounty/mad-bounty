# LIVE demand: agent→human & agent→agent paid task markets — late Nov 2026

Collected 2026-11-26. Raw JSON saved: `agenteconomy_data.json` (agenteconomy.to, updated 2026-11-25T06:08Z). RentAHuman/Open Bounty read live in headless browser same day.

---

## (a) RentAHuman (rentahuman.ai)

| Metric | Value | Date | Source | Type |
|---|---|---|---|---|
| Registered humans ("meatworkers") | ~787k+ profiles claimed; ">750,000 humans across 100+ countries" per platform data | Oct 2026 / live site meta 2026-11-26 | rentahuman.ai (site), El País 2026-10-18 (https://english.elpais.com/technology/2026-10-18/hire-a-human-the-future-where-ais-get-people-to-do-physical-labor-is-upon-us.html) | **Vendor-claimed** |
| Growth: signups | 130 day 1 → ~1k day 2 → 145k day 3 → 200k week 1 → 518k (Feb 18) → ~600k (Mar) → 633k (mid-Mar) → 650k (Jun) → 750k+ (Oct) | Feb–Oct 2026 | arXiv:2608.18547; Wired 2026-02-18; Business Insider 2026-02; LinkedIn roundup Jun 2026 | Third-party (press/paper) |
| **Eligible supply (live, actually hirable)** | **202 humans** ("eligible supply", = recently-active + eligible, US-prioritized view) | 2026-11-26 (live browser read of /browse) | rentahuman.ai/browse | On-platform verified read |
| Open bounties (live feed) | ≥45 bounty cards loaded via infinite scroll on /bounties; sizes in visible feed: **$1, $1.50, $8, $30 fixed** (typical $1–$30; historical range $1–$110) | 2026-11-26 (live browser read) | rentahuman.ai/bounties | On-platform verified read |
| Cumulative bounties posted | 11,367 (as of ~Feb 18 Wired reporting; ~11,300 per Built In March) | Feb–Mar 2026 | Wired 2026-02-18; Pebblous/blog.pebblous.ai | Third-party |
| Completed bounties | ~5,500 fulfilled (founder Tani claim, Feb 2026); "~1,000" (founder Liteplo, Feb 2026, pre-count-tool) | Feb 2026 | Wired; Business Insider | **Vendor-claimed, no public counter** |
| GMV / payout totals | **Not published.** No dashboard, no on-chain ledger (payments via Stripe/crypto/credits; escrow off-chain). One observed real job: $70 for 2h Budapest sign-holding (Oct 2026, El País) | — | — | Not found |
| Take rate | Platform "service fee" exists (checkout shows "total incl. service fee") but % not publicly stated; human verification costs $10/mo | 2026-11-26 | site; Wired | Not found (rate) |
| Funding | **No announced round found.** Founders were "rizzing VCs" Feb 2026 (Wired); no disclosed raise through Nov 2026 | — | Wired 2026-02-18 | Not found |
| Quality caveats | MIT study of 779 listings (May 31 snapshot): 87% labeled posted by "human" not agents (labels unverifiable); 7,578 applicants for one $10 bounty = labor surplus ~50:1; El País: workers report unpaid tasks; "success is symbolic for now" | Aug–Oct 2026 | arXiv:2608.18547 (2026-08-19); El País 2026-10-18 | Third-party (academic/press) |

**Read:** signup counts (750–800k) are marketing; the *live actionable market* is ~200 eligible workers and dozens of open bounties mostly $1–$30, many social-media-engagement gigs (astroturf-ish, e.g. "comment on 50 YouTube videos").

---

## (b) Virtuals ACP

| Metric | Value | Date | Source | Type |
|---|---|---|---|---|
| Cumulative commerce memos (legacy Base contracts) | 12,363,735; latest daily 16 memos / 5 unique senders (2026-11-23) | 2026-11-25 | https://agenteconomy.to/virtuals-acp + /data.json (raw file saved) | On-chain verified (Dune-derived) |
| Trend | ~140–150 memos/day Sep, decayed to 73–97/day late Oct, then **collapsed to ~1/day Nov 3–18**, brief 68/145 spikes Nov 21–22, 16 on Nov 23 | 2026-11-25 | agenteconomy.to/stats/virtuals-acp-activity | On-chain verified |
| Current ACP contract (v2) jobs | 36–50 jobs created/7d (21–23 completed); ~31–32/day average since Oct 1; 1,690 jobs in series Oct 1–Nov 22 | 2026-11-22/24 | agenteconomy.to; satohub.ai/agent-economy/virtuals_acp | On-chain verified |
| Sato Hub (Base, ACP v2 job funnel) | **10 jobs created in 7 days to 2026-11-17** | 2026-11-17 | https://satohub.ai/agent-economy/virtuals_acp | On-chain verified |
| Job rail funnel (agenticfinancegraph.com, direct Base read) | Jobs indexed 10,305; funded into escrow 5,437; marked completed 3,373; **jobs that actually paid anything: 1,110; USDC into escrow $329.45; USDC actually released to providers $150.68**; 67.1% of payout events released nothing; 130 distinct providers ever paid | 2026-11-22 | https://agenticfinancegraph.com/virtuals-protocol-agent-commerce-protocol-acp-explained | On-chain verified |
| Virtuals' own dashboard claims | 2.55M total jobs, $481M aGDP, 36,637 unique active wallets | Oct 2026 | https://app.virtuals.io/acp | **Vendor-claimed** — contradicted by direct contract reads above |
| Fee reality | Lifetime platform fees ~$1.24M; Sept 2026 fees: **$5.48**; ACP v2 ~$2,660 total stablecoin volume in 6 months; of 44,052 registered agents only 2,470 ever had a job, 151 earned >$1k; Revenue Network subsidy ($1.02M over 5 epochs) ended Mar 2026 → fees fell 98.6% | Oct 2026 | Dosbox420/agent-chain landscape.md (github.com/Dosbox420/agent-chain/blob/main/docs/landscape.md) | Third-party from on-chain |
| Take rate | 20% platform fee (cut from 40% on 2026-02-12); +5% evaluator on v2 | 2026 | landscape.md; shaduf.ai | Third-party |
| Self-dealing | ~66% of ACP v2 provider payouts self-dealing in a 14-day sample (Shaduf, Oct 2026); app feed shows "TF Test Buyer" test jobs | 2026-10 | https://shaduf.ai/p/agentic-freelance/opportunities/ | Third-party |

**Read:** headline "12.36M memos" is lifecycle spam on legacy contracts now near zero; real current activity is **~30-50 jobs/day on v2, ~$150–330 total USDC ever actually released** to providers on the measured rail. Vendor 2.55M-jobs claim is not credible.

---

## (c) x402 — last 90d (≈Sep 25 → Nov 25, 2026)

Sources disagree ~100x; all below with attribution:

| Ledger | Volume 30d | Tx 30d | Date | Type |
|---|---|---|---|---|
| 402radar.io/stats (attributed economy) | **$153,047**, ▼ from $254,307 prior window | 3,902,742, ▼52.7% | 2026-11-24 | On-chain (facilitator-attributed) |
| agenteconomy.to (data.json, saved) | Nov MTD: $1,384,792 / 10.44M txs (through ~Nov 24); Oct: $274,220 / 5.09M; Sep: $417,033 / 13.0M |  | 2026-11-25 | On-chain (18 facilitator addrs, 12 chains) |
| DefiLlama (via castlelabs.io) | **$17.8M** 30d to Nov 23 (Base 77.7%, Arc 19.9%); prior 30d $1.8M; busiest week ever = week of Nov 2 ($11.2M; Base $8.74M), then **week of Nov 23 collapsed to ~$123K total** | 2026-11-23 | https://castlelabs.io/research/topics/ai | On-chain (all transfers) |
| Agent GDP | $262,598 organic vs $433,130 gross (Oct 19–Nov 17) | 2026-11-20 | hum.pub four-ledger analysis | Third-party |
| Coinbase (Brian Armstrong) | x402 activity "$372K in October, down from $29.11M Nov 2025" | Nov 2026 | tilt.news summary of Armstrong remarks | Vendor-claimed |

- Cumulative (agenteconomy): 206.4M txs / $43.66M across 12 chains since inception. Daily txs rose Oct→Nov (85k–100k/day mid-Oct → 400–670k/day mid-Nov), i.e. **count up, value per tx sub-cent**.
- **Wash/subsidy confounds (severe):**
  - DefiLlama's $17.8M spike is one week (Nov 2) of large Base settlements ($8.74M), gone the next week — concentrated large flows, likely a few operators, not broad demand (castlelabs, hum.pub).
  - One operator carries $380,946 of 402radar's Base table; x402 Bazaar: 37,352 listings but ~2 wallets account for ~half of 2.7M paid calls/30d (hum.pub, 2026-11-20).
  - Coinbase facilitator: 88.9% of tx share, 13.3% of value; median transaction ~$0.001; settlement is often gas-subsidized (hum.pub "Gas Is the Subsidy", 2026-11-20).
  - 402radar vs agenteconomy vs DefiLlama use different denominators; treat any single figure as ±10x.

**Read:** organic x402 *agent-services* volume is plausibly **low six figures per month** ($150K–$260K/30d); the $17.8M DefiLlama print is a concentration artifact. Tx counts (millions/mo) are mostly sub-cent API calls.

---

## (d) Agent-posts-bounty-for-human platforms

| Platform | Live activity | Date | Source | Type |
|---|---|---|---|---|
| **Open Bounty (openbounty.app, x402-native)** | **7 open bounties, 16 tasks published ever, 34 USDC total listed bounty value**, 0 open on the board at read; "No open bounties yet" on explore tab | 2026-11-26 | live browser read of openbounty.app | On-platform verified read |
| **Execution Market (execution.market)** | 470 new tasks/30d (Oct 12) — **100% from operator's own 21 swarm wallets, 0 outside posters, 0 open**; median payout $0.02/job; graded "avoid"; awesome-molt list: 75 workers, 961 tasks, 283 completed; $36.49 paid in 30d (Shaduf, Oct 14) | Oct–Nov 2026 | shaduf.ai; gist.github.com/ciperx; github.com/eltociear/awesome-molt-ecosystem | Third-party/on-chain |
| **Payman** | Pivoted away from agent-pays-humans marketplace → enterprise agentic banking for banks/credit unions; raised from Coinbase Ventures/Visa (amount undisclosed); no public task volume | reviewed 2026-08-28 | therundown.ai/tools/payman; rootdata | Third-party |
| TaskMarket (Daydreams) | 7 open tasks; 80.6% of gross from one funder; ~$0.07/day earned mid-tier | 2026-10 | shaduf.ai | On-chain/third-party |
| MoltJobs | 122 jobs via MoltEscrowV2; every deposit from founder wallet | 2026-10 | shaduf.ai | On-chain |
| Human API | Raised $65M (Polychain, Delphi); no public volume | May 2026 | techtimes.com | Vendor-claimed |
| DeskCrew Arena | ~$1 support-ticket bounties; 1 open bounty Oct 7; $5.56 total settled to 6 wallets historically | Aug–Oct 2026 | shaduf.ai; github.com/webmilmind1/x402-bounty-hunter | On-chain |
| GitHub open bounty boards (agent-visible) | Entire visible open market ≈ **$1,204** | Oct 2026 | github.com/AsherKasper/agent-marketplace-field-report | Third-party |

**Read:** outside RentAHuman, agent→human bounty markets are effectively **zero-to-negligible**; most are operator-self-funded demos.

---

## (e) ERC-8004 registrations vs ACTIVE agents

| Metric | Value | Date | Source | Type |
|---|---|---|---|---|
| Total registered agents | **2,363,083** across 24 chains (Base 1,230,788; Arc 491,622; BNB 417,830; Ethereum 74,601) | 2026-11-25 | agenteconomy.to/data.json (saved) | On-chain verified |
| Registration growth | 55,169 in 7 days to Nov 22 — **92.8% from one source (centralcity.ai)**; excl. it: 3,958/week | 2026-11-23 | agenteconomy.to/stats/erc-8004-agents | On-chain verified |
| Valid/activated share | Only 3% (Ethereum), 4% (BSC), 15% (Base) have a valid registration file with a live service endpoint; 53% ETH / 37% Base never activated | to May 2026 | arXiv:2606.26028 | Academic, on-chain |
| Feedback (proxy for transacting) | 6.05% of identities ever received feedback (31,444/519,437, Sep 13) | 2026-09-13 | turnkey.com/blog/erc-8004 | Third-party from on-chain |
| Agents that ever paid money | 9,593 of 320,491 Base registrations ≈ **3.0%** | 2026-10-20 | Agentic Finance Graph via stablecoininsider.org/erc-8004 | Third-party from on-chain |
| Operationally shallow | Of first 10,000 Ethereum agents: 67 expose services, 628 got feedback, **19 fully operational** | to Apr 2026 | arXiv:2606.12128 | Academic, on-chain |

**Read:** ~2.36M registrations, but **~3–6% ever transact**, and current weekly registration growth is ~93% one airdrop-farming source. Active-agent base is plausibly in the low tens of thousands, not millions.

---

## Bottom line (for MAD Bounty sizing)

- **Agent→human paid tasks:** real but tiny. RentAHuman is the only venue with meaningful live inventory (dozens of open bounties, $1–$30 typical, ~200 active eligible workers) and unverifiable ~5.5k lifetime completions; everything else is sub-$100/month or self-dealt.
- **Agent→agent commerce:** x402 does millions of sub-cent settlements/month worth low-six-figures USD organic; ACP v2 does ~30–50 jobs/day with ~$150–330 USDC ever actually released. High wash/subsidy contamination everywhere.
- **Signups ≠ demand:** 787k RentAHuman signups, 2.36M ERC-8004 registrations, 44k ACP agents — all collapse to ~10⁴ or fewer genuinely active participants.
