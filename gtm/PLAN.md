# MAD Bounty: go-to-market plan for AI-agent adoption

Researched 2026-11-25 (HKT). Every claim has a source and an access date. All sources were accessed 2026-11-25 unless noted.
Labels: **VERIFIED** means checked against the primary source or live data. **VENDOR CLAIM** means the vendor says it and nobody independently checked. **3RD-PARTY** means a community or secondary source.

Companion files: `SUBMISSIONS.md` (copy-paste texts), `ARTICLES.md` (content plan), `DONT.md` (tactics to avoid).

---
## 0. Gating facts (read first)

1. **Nothing is deployed or audited** (mad-bounty skill, state 11-25). Most registries index *working* artefacts: x402 Bazaar indexes only after a settled mainnet payment, the Base ecosystem form wants "live on Base mainnet", and Glama health-checks the server. A first listing that points at an undeployed contract wastes the one-time first impression. **Order of work: deploy and verify → publish the npm/MCP package → then list.**
2. **Names are still free (checked live 2026-11-25):**
   - npm `@madbounty/mcp` and `madbounty`: 404, so free. The npm org page returns 403, so availability is unclear. Claim the org before publishing.
   - GitHub user `madbounty` is taken. It is a dormant account from 2020 with 0 repos. `mad-bounty` and `madbountyxyz` are free.
   - Domains: RDAP returns 404 for madbounty.com, .ai, .org and .dev, so they look unregistered. madbounty.xyz is registered and parked at Afternic (for sale).
   - ENS `madbounty.eth`: the registry owner is 0x0, so it is unregistered.
   - **Action:** register `madbounty.org` or `.dev`, plus `madbounty.eth`, and create GitHub org `mad-bounty` today. Cost is about $15/yr plus about $5/yr for ENS (5+ char name). The ENS price is from ENS docs and was not re-checked today.
3. **Namespace choice for the MCP Registry is permanent-ish.** GitHub auth gives `io.github.<user>/*`. DNS auth gives `org.madbounty/*` (reverse-DNS). Org namespaces via `mcp-publisher login github` are currently broken (issue #1468); use GitHub Actions OIDC or a PAT with `read:org`. Recommendation: buy the domain first and publish as `org.madbounty/mcp` via DNS auth, so the identity survives any GitHub org rename. Source: https://raw.githubusercontent.com/modelcontextprotocol/registry/main/docs/modelcontextprotocol-io/authentication.mdx
4. **Policy blockers found:**
   - The **OpenAI ChatGPT plugin/app directory prohibits "Execution of money transfers, crypto transfers, or investment trades"** (guideline 5.2b item 06). A write-capable MAD Bounty app is not listable there. At most a read-only "browse bounties" app might be. Source: https://developers.openai.com/plugins/plugin-guidelines
   - The **Anthropic directory** applies the Usage Policy's high-risk rules ("finance") and requires human-in-the-loop plus disclosure for high-risk use. Submit only with explicit confirmation steps on every money-moving tool. Source: https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy

---
## 1. Discovery channels: exact submission process (verified 2026-11-25)

| # | Channel | How agents/devs find you | Exact process and requirements | Cost | Source |
|---|---|---|---|---|---|
| 1 | **Official MCP Registry** (registry.modelcontextprotocol.io) | Canonical upstream. Glama, PulseMCP and others ingest from it. PulseMCP says "publish to the Official MCP Registry… we will pick it up automatically". | (a) Publish the npm package with `"mcpName": "<namespace>/<name>"` in package.json. (b) Write `server.json` (schema `2025-12-11`). Required: `name` (3–200 chars, `^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$`), `description` (**max 100 chars**), `version`. Optional: `title` (≤100), `repository`, `packages[]` or `remotes[]`. (c) `mcp-publisher login github` or `login dns`. (d) `mcp-publisher publish`. Packages are checked against OSV malware records. dist-tags such as `next` are rejected. Status: **preview, data resets possible.** You can automate this with GitHub Actions OIDC (`id-token: write`). | Free | quickstart.mdx, authentication.mdx, github-actions.mdx in github.com/modelcontextprotocol/registry (commit 9432a0a, 2026-11-22); schema at static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json (fetched live). VERIFIED |
| 2 | **Glama** (glama.ai/mcp/servers, 129,861 servers as of 2026-11-25) | Search, MCP tools index, quality grades (license/quality/maintenance). awesome-mcp-servers *requires* a Glama listing backlink. | Servers page → **Add MCP Server**. Give the GitHub repo URL, display name and short description. Automated license detection, security scan and health test run; Glama must be able to start the server in Docker and introspect its tools. Claim the listing with `glama.json` at the repo root: `{"$schema":"https://glama.ai/mcp/schemas/server.json","maintainers":["<gh-user>"]}`. This is required for org-owned repos. A hosted server goes to **Connectors → Add Server → Hosted endpoint**. | Free | https://glama.ai/mcp/faq; https://glama.ai/blog/2025-07-08-what-is-glamajson; https://manycp.com/directories/glama (3RD-PARTY, 2026-10-01) |
| 3 | **awesome-mcp-servers** (punkpeye) | High-traffic GitHub list, crawled and in training data. | Fork, then add one line to README.md in the right category, in alphabetical order. **The PR must include a backlink to your Glama listing** (a badge in README is enough), and backlinks are checked before merge. Remote-only servers go to `awesome-remote-mcp-servers` instead. | Free | https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/CONTRIBUTING.md VERIFIED |
| 4 | **PulseMCP** | Directory and newsletter | **Submissions paused since 2026-09-03.** It auto-ingests from the Official MCP Registry. No action beyond #1. | Free | https://www.pulsemcp.com/submit VERIFIED |
| 5 | **Smithery** | Directory only | **The proxy, accounts, CLI and SDKs shut down on 2026-10-31.** It remains a public directory "powered by Arcade" with "a curated set of verified servers". No self-serve submission path was found. Skip it, or email if listing matters. | n/a | https://smithery.ai/docs/build/publish (redirect notice) VERIFIED |
| 6 | **mcp.so** | Directory with claimed 266K MAU (VENDOR CLAIM) | Form at mcp.so/submit: Repository URL plus Name. There is an **optional $39 paid tier** that sells a "dofollow project link" and skips review. Use the free path only (see DONT.md: paid dofollow links breach Google's link-spam policy). | Free | https://mcp.so/submit VERIFIED (form fields), traffic numbers VENDOR CLAIM |
| 7 | **Anthropic directory** (claude.ai/directory, plus Claude Code via account sync) | Claude.ai, Cowork, Claude Code users | Needs a paid claude.ai plan. Steps: `claude plugin validate ./plugin --strict`, then submit at **claude.ai/directory/manage**, then the portal validates, then a security scan runs. MCP connectors are auto-scanned and listed as "Community"; Anthropic may escalate to "Verified". You can't apply for the official `claude-plugins-official` marketplace (partner contact only). The Software Directory Policy applies (high-risk finance means human-in-the-loop). | Paid plan (~$20/mo) | https://code.claude.com/docs/en/plugins/publish; https://claude.com/docs/directory/publish; https://claude.com/docs/plugins/pre-submission-checklist VERIFIED |
| 8 | **Own Claude Code marketplace** | `/plugin marketplace add mad-bounty/skills` | Repo with `.claude-plugin/marketplace.json`. No approval needed. | Free | https://code.claude.com/docs/en/plugins/create-marketplace VERIFIED |
| 9 | **Hermes Agent skills** | `hermes skills install`, Hermes Marketplace, taps | Options: (a) **custom tap**: a public GitHub repo with `skills/<slug>/SKILL.md` (frontmatter `name`, `description`, optional `metadata.hermes.tags`); users run `hermes skills tap add mad-bounty/skills`. (b) **`optional-skills/`** PR to NousResearch/hermes-agent. CONTRIBUTING says a "paid service integration" belongs in optional-skills and gets "official" trust. Search issues/PRs first. (c) Publish on **ClawHub** or **skills.sh**; Hermes integrates both as community sources. (d) Serve `/.well-known/skills/index.json` on our domain (the well-known source). | Free | https://hermes-agent.nousresearch.com/docs/user-guide/features/skills; https://raw.githubusercontent.com/NousResearch/hermes-agent/main/CONTRIBUTING.md VERIFIED |
| 10 | **ClawHub** (OpenClaw registry, also indexed by Hermes) | `openclaw skills install`, clawhub.ai | `npm i -g clawhub`, `clawhub login`, then `clawhub skill publish ./mad-bounty --slug mad-bounty --name "MAD Bounty" --version 1.0.0`. The release stays pending until automated security checks pass. GitHub Actions OIDC trusted publishing is supported. | Free | https://docs.openclaw.ai/clawhub; https://docs.openclaw.ai/clawhub/publishing VERIFIED |
| 11 | **skills.sh** (Vercel) | Leaderboard ranked by anonymous install telemetry | No submission step: a public GitHub repo with SKILL.md works via `npx skills add mad-bounty/skills`. Ranking is from real installs. | Free | https://skills.sh/docs VERIFIED |
| 12 | **x402 Bazaar** (CDP) | Claimed "tens of thousands of agents" via CDP APIs, Bazaar MCP, Amazon Bedrock AgentCore, agentic.market; "more than 23,000 x402 resources" (VENDOR CLAIM) | **No registration form.** Use `createX402Server` from `@coinbase/cdp-sdk/x402` with a specific `"METHOD /path"` route (no wildcards). Add `declareDiscoveryExtension` input/output schemas. **Indexing triggers on the first settled paid call through the CDP Facilitator.** Curation (editorial) needs live mainnet payments, ≥99% 30-day availability, health probe, agent-ready metadata (when-to-use description, pricing, errors) and validation. Applies only if we expose a paid HTTP endpoint (see §3.2). | Free plus the cost of one test call | https://docs.cdp.coinbase.com/x402/seller/get-discovered VERIFIED |
| 13 | **ERC-8004 Identity Registry** | 8004scan.io shows **2,223,364 registered agents** across 29 chains (live 2026-11-25). Brief said 2.36M; the live number is lower. | Call `register(agentURI)` on IdentityRegistry **`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` (Base mainnet)**. agentURI resolves to the registration JSON (`type: https://eips.ethereum.org/EIPS/eip-8004#registration-v1`, `name`, `description`, `image`, `services[]` (web/MCP/A2A/ENS), `x402Support`, `active`, `registrations[]`, `supportedTrust`). Optional domain proof: `https://<domain>/.well-known/agent-registration.json`. 8004scan also has a "Create Agent" UI. | Gas, under $0.05 | https://eips.ethereum.org/EIPS/eip-8004; https://raw.githubusercontent.com/erc-8004/erc-8004-contracts/main/README.md; https://8004scan.io VERIFIED |
| 14 | **Virtuals ACP** (ERC-8183 reference impl, v2.0 Apr 2026, "2,000+ agents" VENDOR CLAIM) | Butler and ACP marketplace | app.virtuals.io/acp/join: connect wallet → Join ACP → Register New Agent (role Provider/Buyer/Hybrid/**Evaluator**, profile picture required), then X/Telegram auth. Agents are "ungraduated at 10 failures". Graduated agents are auto-registered on ERC-8004. ACP v2 is hook-based (`beforeAction/afterAction`), so a MAD hook is technically possible. | Free | https://whitepaper.virtuals.io/acp/acp-dev-onboarding-guide/set-up-agent-profile/register-agent; https://whitepaper.virtuals.io/acp/acp-changelogs VERIFIED |
| 15 | **A2A directories** | a2a-registry.org ("List agent free", auto-discovers from URL/GitHub agent-card.json, DNS-verified badge); agentpeering.com (254 agents); emissar.ai (crawls Tranco sites for agent cards) | Publish `/.well-known/agent-card.json` on our domain, then submit the URL. | Free | https://www.a2a-registry.org/submit; https://agentpeering.com; https://emissar.ai/directory (3RD-PARTY) |
| 16 | **Coinbase AgentKit** | Action providers ship to every AgentKit user | PR to coinbase/agentkit following CONTRIBUTING-TYPESCRIPT.md, "Adding an Action Provider" (Node ≥22, pnpm ≥10.7; a `generate-action-provider` script exists). Expect review for security and real usage. | Free, high effort | https://github.com/coinbase/agentkit/blob/main/CONTRIBUTING-TYPESCRIPT.md VERIFIED |
| 17 | **GOAT SDK** | Plugins for many frameworks | PR a plugin (fork → branch named `<issue#>--desc` → tests → PR). **Caveat: the last main commit is 2 Jul 2026**, so the repo looks low-activity. Low priority. | Free | https://raw.githubusercontent.com/goat-sdk/goat/main/CONTRIBUTING.md; github.com/goat-sdk/goat VERIFIED |
| 18 | **ElizaOS registry** | `elizaos plugins` | `elizaos publish` does npm publish, creates the GitHub repo and opens a PR to github.com/elizaos-plugins/registry (`index.json` mapping). | Free | https://docs.elizaos.ai/cli-reference/publish VERIFIED |
| 19 | **Vercel AI SDK Tools Registry** (ai-sdk.dev/resources/tools, about 28 tools, includes x402/defi tools) | AI SDK devs | PR to `vercel/ai`, editing `content/tools-registry/registry.ts` (recent example: PR #25136 Upstash). Needs a published `ai`-SDK tool package. | Free | https://github.com/vercel/ai/tree/main/content/tools-registry; https://ai-sdk.dev/resources/tools VERIFIED |
| 20 | **LangChain** | Integrations docs | **Don't PR the langchain repo.** Publish a standalone `langchain-madbounty` package, then follow "Publish an integration" to list it in docs. | Free | https://docs.langchain.com/oss/python/contributing/publish-langchain VERIFIED |
| 21 | **OpenAI Apps / ChatGPT directory** | ChatGPT | **Blocked for write actions** (5.2b-06 money/crypto transfers). Possible later: a read-only bounty-browser app. | n/a | https://developers.openai.com/plugins/plugin-guidelines VERIFIED |
| 22 | **Base ecosystem page** (base.org/ecosystem, "700+ companies") | Base users and press | The GitHub repo `base/web` was **archived 2026-03-17**; a submission form replaced it. Reported requirements: live on Base mainnet, HTTPS website, **Terms of Service + Privacy Policy**, active development, no ICO/airdrop farming, 192×192 logo, description under 200 chars, category (AI/Consumer/DeFi/Infra/Wallet/Onramp). Base also runs Friday office hours (forms.gle/iG1oWfGkuMPAp8HX7). | Free | https://github.com/base/web (archived, VERIFIED); requirements from https://x.com/ERIFAT826/status/2055652169517568129 (3RD-PARTY, 2026-05-16); https://docs.base.org/get-started/builders VERIFIED |
| 23 | **Basescan** | Every agent or human who inspects the address | Verify the source (forge `--verify` or basescan.org/verifyContract). After verification the page lets you "Suggest name tag & label… and link to website". Also verify on Sourcify (`forge verify-contract --verifier sourcify`). | Free | https://info.basescan.org/how-to-verify-contracts/; https://docs.sourcify.dev/docs/how-to-verify/ VERIFIED |
| 24 | **DefiLlama** | Analysts and dashboards, often quoted in LLM answers | TVL adapter PR to DefiLlama-Adapters (TVL must be computed on-chain; answer the PR template; enable maintainer edits). Fees/revenue go to `dimension-adapters`. **Do this only once there is real escrowed USDC.** An empty listing is noise. | Free | https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/README.md VERIFIED |

**Competitor presence (live check, 2026-11-25):** RentAHuman is in the Official MCP Registry as `io.github.rentahuman-ai/rentahuman` v1.29.0 (npm `rentahuman-mcp`), and its site shows live $1–$2 bounties. Registry search for "bounty" returns about 7 bounty-board servers, none of them escrow-enforced (brevium, brelsfordsoftware, websitesensei, Mimirs402…). Open Bounty's homepage shows **0 open bounties**. Source: `curl registry.modelcontextprotocol.io/v0/servers?search=bounty`; https://openbounty.app. **The niche "non-custodial, enforced escrow for agent→human work, MCP-native" is unoccupied in the registry.**

---
## 2. Training-data presence (LLM SEO / GEO): what actually gets in

**Mechanics (verified):**
- **Common Crawl** is "a sample of the web… a randomly selected subset". It honours robots.txt and nofollow, **does not execute JavaScript**, and uses sitemaps announced in robots.txt. Implication: we need a **static, server-rendered HTML site with a sitemap**. A JS-only SPA, IPFS-only docs and contract storage are mostly invisible to it. Source: https://commoncrawl.org/faq
- **Pretraining filters** (FineWeb/FineWeb-Edu, DCLM, Nemotron-CC) run dedup plus model-based quality/"educational value" classifiers over Common Crawl. Dense explanatory text survives. Boilerplate, near-duplicates and keyword-stuffed pages get dropped. So **one deep, original explainer beats 50 thin pages**, and mass-generated variants are deduped away. Sources: https://arxiv.org/html/2406.17557 (FineWeb), https://aclanthology.org/2025.acl-long.123.pdf (Nemotron-CC).
- **GitHub public repos** (README, code, docs, issues) are a staple of code corpora. Our repo's README, NatSpec and `docs/` are the highest-leverage text we control.
- **EIPs/ERCs and Ethereum Magicians** are canonical, heavily cited and crawled. ERC-8183's Magicians thread has 9.2k views, 472 posts and 60 users. Source: https://ethereum-magicians.org/t/erc-8183-agentic-commerce/27902. Adjacent drafts already exist and must be cited, not duplicated: **ERC-8412 Preregistered Acceptance Criteria** and **ERC-8505 Evaluated Work Records**.
- **ERC process:** an idea "MUST be thoroughly discussed on Ethereum Magicians or Ethereum Research" before the ERC PR. Source: https://github.com/ethereum/ERCs
- **arXiv:** since 2026-01-21 a new submitter needs an institutional email **and** prior arXiv authorship in that domain, **or** a personal endorsement from an established author in the domain (cs.GT / cs.CR / cs.MA). We need a co-author or endorser. Source: https://blog.arxiv.org/2026/01/21/attention-authors-updated-endorsement-policy/
- **Wikipedia:** company/org notability needs significant coverage in multiple independent reliable sources, and writing about your own project is a COI. **We don't qualify; don't try.** Wikidata needs "serious and publicly available references" or a structural need. That's possible later, after independent coverage. Sources: https://en.wikipedia.org/wiki/Wikipedia:Notability_(organizations_and_companies); https://www.wikidata.org/wiki/Wikidata:Notability
- **llms.txt** (llmstxt.org, v2): a markdown file at the site root with a required H1, then a blockquote summary, then H2 "file lists". It's used at inference time by agents and doc tools (Mintlify, CDP and Base docs all ship one), and it's retrieval-side, not pretraining-side. Source: https://llmstxt.org/
- **Stack Exchange:** generative-AI content is banned on Stack Overflow, and affiliated promotion without disclosure is spam. Answer only real questions, by hand, disclosing affiliation. Sources: https://meta.stackoverflow.com/help/gpt-policy; https://stackoverflow.com/legal/content-policy
- **dev.to:** AI-assisted posts must disclose, be fact-checked, and **must not promote a business**. Write there as an educational human-authored piece only. Source: https://dev.to/guidelines-for-ai-assisted-articles-on-dev
- **Medium:** AI-generated writing isn't distributed or paywalled in the Partner Program (Wired; BleepingComputer). Low value.
- **HuggingFace datasets:** a dataset card (README.md) is rendered and indexed. A real dataset (attack catalog test vectors; anonymised bounty outcomes once live) is legitimate. Source: https://huggingface.co/docs/hub/datasets-cards

**Ranking of venues by training-data value per hour (my judgement, from the mechanics above):** GitHub repo docs > Ethereum Magicians ERC thread + ERC PR > own static site with llms.txt > ethresear.ch analysis post > arXiv paper (needs endorser) > HF dataset > Paragraph/Mirror long-form > dev.to/HackerNoon > Medium.

---
## 3. Agent-native marketing

### 3.1 Bounty-funded seeding (the protocol markets itself)
The protocol's treasury, or Stephen's agent, posts the first real bounties **on MAD Bounty itself**, each paying for a genuinely useful public artefact:
- "Write a LangChain/ElizaOS/AI-SDK integration for MAD Bounty" ($100–300 each, verifier = CI hash/test-pass adapter)
- "Find a bug in MADBountyCore" (pre-audit bug bounty, multisig verifier)
- "Translate the manual into zh/es/ja" (human reviewer)
- "Independent write-up comparing agent escrow designs (must cite sources)". Disclose that it's sponsored. **No content requirement to praise.**

Why it works: every completed bounty is real on-chain usage (needed for DefiLlama, Base ecosystem and Bazaar curation) plus a real artefact plus a case study. Cost: about $1–2K in USDC rewards. Rules: disclose "sponsored by MAD Bounty" on any content produced. Never pay for reviews, stars or upvotes (see DONT.md).

### 3.2 x402 endpoint (optional, small)
Expose one paid read endpoint, e.g. `GET /bounties/search` at $0.001, or a "post-bounty-for-me" relayer, via `createX402Server`. One settled call indexes it in the Bazaar, which reaches CDP/Bedrock agents. Do it only if it's useful: a read API over the open-bounty index is useful to agents and ties us into the x402 volume (x402 ~$148K/30d and Base 46% of settlements per 402radar, figures from the brief; 402radar was unreachable today, so UNVERIFIED).

### 3.3 Public keeper bot
A permissionless keeper that calls `finalizeReject` after the 24h cooling, `refundExpired` after `openUntil`, and pays the worker on verifier silence. It's open-source, small and runs from one address. It proves liveness and shows up on Basescan as activity. Publish the code plus a "run your own keeper" doc.

### 3.4 Dashboard
A static page (or a Dune dashboard) with open bounties, $ escrowed, accept/reject/burn ratio, and median time to verdict. This is the data that analysts and LLM answers cite. It feeds DefiLlama later.

### 3.5 Agent-readable surfaces (all static)
- `/llms.txt` and `/llms-full.txt` at the domain root (docs/ already drafts these)
- `/.well-known/agent-card.json` (A2A)
- `/.well-known/agent-registration.json` (ERC-8004 domain proof)
- `/.well-known/skills/index.json` (Hermes well-known source, Mintlify pattern)
- `/.well-known/mcp/server.json`. Not a standard; optional mirror of the registry entry.
- `robots.txt` allowing CCBot, GPTBot, ClaudeBot and Google-Extended (deliberate opt-in), plus `sitemap.xml`
- ENS `madbounty.eth` with text records: url, `com.github`, `description`, and a contenthash pointing to the IPFS manual
- Basescan: verified source plus a name-tag suggestion ("MAD Bounty: Core") plus website link. The same on Sourcify (full match).

---
## 4. Website decision: yes, a minimal static site is needed

**Argument.** The contract exposes NAME/VERSION/TERMS/manualURI/manualHash, and the full manual sits on IPFS. That gives agents that already know the address a tamper-evident spec. But:
1. **Crawlers don't read contract storage or IPFS.** Common Crawl fetches HTTP(S) pages, honours robots.txt and does not execute JS. Pretraining corpora are built from that. No web page means no training-data presence.
2. **Registries require a URL:** Base ecosystem (HTTPS website, ToS, Privacy Policy), A2A directories (agent-card URL), ERC-8004 `services.web` and domain verification, MCP Registry DNS namespace, Glama/npm `homepage`.
3. **On-chain doc storage is cheap on Base but adds nothing for discovery.** Live numbers, 2026-11-25 ~11:58 UTC:
   - `cast gas-price` on Base = **0.006 gwei**; base fee 0.005 gwei; block 62,087,432
   - GasPriceOracle: l1BaseFee 0.0922 gwei, blobBaseFee 0.0054 gwei, Fjord active; `getL1FeeUpperBound(40960)` = 3.12e11 wei
   - ETH = **$1,642.59** (CoinGecko simple/price)

   | Method for a 40 KB manual | L2 gas | Cost |
   |---|---|---|
   | Plain SSTORE: 1,280 slots × 22,100 + calldata | ~29.9M gas (≈ 75% of one 40M-gas block) | **≈ $0.30** |
   | SSTORE2: 2 data contracts, 200 gas/byte code deposit, 24 KB code cap | ~9.9M gas | **≈ $0.10** |
   | Calldata/event only (40 gas/byte floor) | ~1.7M gas | **≈ $0.02** |

   L1 data fee is about 3e-7 ETH, so negligible. Conclusion: storing the full manual on-chain costs cents. It's a fine **integrity anchor**: keep `manualHash` and optionally SSTORE2 the text so it's permanent. It is **not a discovery channel**. Gas math uses EIP-2929/2200 cold SSTORE 22,100, CREATE code deposit 200 gas/byte and the EIP-7623 calldata floor. These are approximations, not a simulation.
4. **Costs:** domain about $15/yr. Hosting is free on GitHub Pages or Cloudflare Pages. No backend.

**Minimum viable web presence (static, no backend, no wallet connect):**
- `/`: one-page explainer: what it is, the game theory in five sentences, contract addresses (linked to Basescan), audit status (honest: "unaudited" until it isn't), links
- `/docs/`: HTML render of the manual, the same text as the IPFS manual with its hash shown
- `/llms.txt`, `/llms-full.txt`, `/.well-known/*` (above), `sitemap.xml`, `robots.txt`
- `/terms`, `/privacy` (required by the Base ecosystem form). Short, honest: no data collected, no custody.
- `/stats`: static page rebuilt by a cron from on-chain events (optional)
- Server-rendered or plain HTML (Astro/Hugo/plain), **no client-only rendering**.

---
## 5. RANKED ACTION LIST

Ranking = (reach × fit) / effort, with dependencies respected. "Pre-deploy" items can start now.

| Rank | Action | Why | Exact steps / requirements | Cost | Effort | Expected impact | Source |
|---|---|---|---|---|---|---|---|
| **1** | **Claim identity: domain, ENS, GitHub org, npm scope** | Everything else references these. madbounty.xyz is already taken by a domain parker. | Register madbounty.org or .dev (RDAP 404, so free), `madbounty.eth`, GitHub org `mad-bounty`, npm org `madbounty`. | ~$20/yr | 1h | Prerequisite | §0 live checks |
| **2** | **Public GitHub repo with excellent README, NatSpec, docs/, ATTACKS.md, llms.txt** | Highest training-data value we control; required by Glama, awesome lists and every registry. | Repo `mad-bounty/mad-bounty`. README: problem, mechanism, game theory, attack catalog summary, addresses, "unaudited" banner, MIT/Apache license, SECURITY.md. Add `glama.json`. | $0 | 1–2d | High, long-lived | §2 |
| **3** | **Deploy, verify (Basescan + Sourcify), suggest name tag** | Gate for 60% of the listings below. | `forge script … --verify`; `forge verify-contract --verifier sourcify`; on Basescan use "Suggest name tag & label" with the website link. | <$5 gas | 0.5d after deploy | Gate | info.basescan.org/how-to-verify-contracts |
| **4** | **Publish `@madbounty/mcp` to npm + Official MCP Registry** | Canonical upstream; Glama and PulseMCP auto-ingest. RentAHuman is already there and no escrow-enforced bounty server is. | Add `"mcpName":"org.madbounty/mcp"` (DNS auth) or `io.github.mad-bounty/mcp` (OIDC). Write server.json (description ≤100 chars, see SUBMISSIONS.md §1). Set up GitHub Action with `id-token: write`. Tag `v1.0.0`. | $0 | 0.5d | High (agent-facing) | registry docs |
| **5** | **Minimal static site** (§4) | Crawlability; ToS/Privacy for Base; agent-card, 8004 domain proof, llms.txt at root. | Astro/Hugo on Cloudflare Pages; pages listed in §4. | ~$0 | 1–2d | High | commoncrawl.org/faq |
| **6** | **Glama listing, then the awesome-mcp-servers PR** | 130K-server index; the awesome list is high-signal training text. | Glama → Add MCP Server (repo URL), make sure the Dockerfile starts the server; add the Glama badge to README; PR to punkpeye/awesome-mcp-servers with the backlink noted. | $0 | 2h | Medium-High | glama FAQ; CONTRIBUTING |
| **7** | **Skill pack: Hermes tap + ClawHub + skills.sh + own Claude marketplace** | Lets agents learn the protocol *as procedure*. Hermes, OpenClaw and Claude Code users install directly. | Repo `mad-bounty/skills` with `skills/mad-bounty/SKILL.md` + `.claude-plugin/marketplace.json`; `clawhub skill publish`; announce in the Nous Discord. | $0 | 0.5d | Medium-High | Hermes docs; ClawHub docs |
| **8** | **ERC-8004 registration on Base** | 2.2M-agent registry; 8004scan is browsed by agent builders; Virtuals syncs to it. | `register(agentURI)` on `0x8004A169…a432`. Host the registration JSON (SUBMISSIONS.md §5) on the site and IPFS; add `/.well-known/agent-registration.json`. | <$0.05 | 1h | Medium | EIP-8004 |
| **9** | **Ethereum Magicians post, then the ERC draft: "MAD extension to ERC-8183" (dual-deposit + burn-on-reject)** | Most durable, citable, high-signal text in this space. Fits as an 8183 *hook/extension*. Must cite ERC-8412 and ERC-8505. | Post in the ERCs category with tags agents/escrow/payments, then reply in the ERC-8183 thread linking to it. After discussion, PR to ethereum/ERCs following EIP-1. | $0 | 3–5d | High (long-term), high credibility | github.com/ethereum/ERCs; Magicians |
| **10** | **Bounty-funded seeding** (§3.1) | Real usage plus artefacts plus case studies, which unlocks curation-gated listings. | 5–10 bounties, $50–300 each, sponsored-content disclosure. | ~$1–2K | ongoing | High | n/a |
| **11** | **Anthropic directory submission** | Reach into claude.ai, Cowork and Claude Code. | Paid plan; `claude plugin validate --strict`; claude.ai/directory/manage. Every money-moving tool must need explicit user confirmation, with disclosure text. | ~$20/mo | 1d | Medium (review risk: high-risk finance) | claude.com/docs/directory/publish |
| **12** | **Base ecosystem form + Base office hours** | Official ecosystem page; Base team attention. | Needs live mainnet, site, ToS, Privacy, 192px logo, description under 200 chars, category "AI". Book office hours (forms.gle/iG1oWfGkuMPAp8HX7). | $0 | 1h | Medium | §1 row 22 |
| **13** | **Virtuals ACP: register a MAD-backed Evaluator/Provider agent, or ship an ACP v2 hook** | Tap ACP's 2,000+ agents (VENDOR CLAIM); ACP v2 hooks fit the MAD deposit. | app.virtuals.io/acp/join. Requires a profile pic and X/Telegram auth. Avoid the 10-failure ungraduation. | $0 | 2–5d | Medium | Virtuals whitepaper |
| **14** | **ethresear.ch post: "Dual-deposit escrow for agent labor: game theory and attack catalog"** | Research audience; strong training signal; feeds the arXiv paper. | Follow ethresear.ch/t/read-this-before-posting/8. | $0 | 3d | Medium-High | ethresear.ch |
| **15** | **arXiv paper** (cs.GT primary, cs.CR / cs.MA cross-list) | Durable academic citation. | Needs an endorser or co-author with prior cs.GT/cs.CR arXiv papers. Approach via the Magicians/ethresear.ch threads. | $0 | 2–3w | High long-term | arXiv blog 2026-01-21 |
| **16** | **x402 read endpoint into the Bazaar** (§3.2) | CDP/Bedrock agent discovery. | `createX402Server`, schemas, one settled call. Curation needs ≥99% uptime. | ~$5/mo | 1–2d | Medium | CDP docs |
| **17** | **A2A agent-card + a2a-registry.org / agentpeering** | Cheap extra discovery surfaces. | `/.well-known/agent-card.json`; submit the URL. | $0 | 1h | Low-Medium | a2a-registry.org |
| **18** | **ElizaOS plugin, AI SDK tool, LangChain package, AgentKit action provider** | Framework-native reach. Better done **via seeded bounties (#10)** than in-house. | See §1 rows 16–20. | bounty $ | days each | Medium | §1 |
| **19** | **HF dataset: attack-test vectors, later anonymised outcome data** | Legitimate, citable data artefact. | Dataset card with license, provenance and limitations. | $0 | 1d | Low-Medium | HF docs |
| **20** | **DefiLlama TVL/fees adapter** | Analyst visibility. Do it **only after real TVL**. | PR to DefiLlama-Adapters + dimension-adapters. | $0 | 0.5d | Low until usage | DefiLlama README |
| — | **Skip:** Smithery (no submission path), PulseMCP (paused, auto-ingests), OpenAI ChatGPT directory (policy bars money transfers), Wikipedia (not notable, COI), GOAT (inactive since Jul 2026), mcp.so paid tier (link scheme) | | | | | | §1 |

**Sequencing:** Week 0 (pre-deploy): ranks 1, 2, 5 and the draft of 9. Deploy week: 3, 4, 6, 7, 8. Weeks 2–4: 9 (post), 10, 11, 12, 14. Month 2+: 13, 15–20.

**Success metrics (measurable):** registry entries live (count); `npm` weekly downloads; skills.sh/ClawHub installs; distinct agent addresses posting bounties; $ escrowed; Magicians thread replies; inbound integrations built by third parties. **Do not** use stars/followers as KPIs (they're gameable; see DONT.md).
