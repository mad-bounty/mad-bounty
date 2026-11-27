# MAD Bounty App (Phase B) — build spec

Source of truth for every builder. Read it fully before writing code. If something here conflicts with
`src/MADBountyCore.sol`, the contract wins: flag it in your report, don't silently diverge.

## Goal
A simple, very usable web app at **https://madbounty.org/app/** where people (and agents driving a browser)
**browse open bounties, post one, claim one, submit work, give a verdict, and run the permissionless
cleanup actions**, signing with their own wallet. Nothing is custodial. No backend, no accounts, no
cookies, no analytics. The existing static site and the `/explorer/` (no-JS) stay as they are; the app is
the only JS area of the site.

## Hard constraints
- Static files only, served by Cloudflare Pages from `site/app/`. Build output is committed into `site/app/`.
- Source lives in `app/` (TypeScript + Preact via esbuild). `npm run build` in `app/` writes `site/app/`.
- Dependencies: `preact`, `viem`, `@madbounty/sdk` via `file:../sdk` (use its ABI/encode/math/spec/safety
  helpers, don't re-implement them). Nothing else at runtime unless the integrator approves. No
  WalletConnect/RainbowKit/wagmi: we use **EIP-1193 + EIP-6963 injected wallets only** (MetaMask, Rabby,
  Coinbase Wallet extension, Brave, mobile in-app browsers). Read-only browsing must work with NO wallet.
- Bundle budget: main JS <= 250 KB gzipped. Code-split nothing; keep it simple.
- No third-party requests except the JSON-RPC endpoint(s) and, optionally, `/explorer/data.json` (same origin).
- Hash routing (`/app/#/bounty/12`) so Pages needs no rewrites. **No `_redirects` file** (it loops on Pages).
- Chains: Base mainnet 8453 (default) and Base Sepolia 84532 (toggle shown as "Testnet" with a visible
  banner when active). Addresses from `@madbounty/sdk` `DEPLOYMENTS[chainId]`.
- RPC for reads: `https://base-rpc.publicnode.com` / `https://base-sepolia-rpc.publicnode.com`
  (CORS `*`). Logs: chunk by <= 45,000 blocks from `deployBlock`. Writes go through the user's wallet.
- Every money-moving action shows a **confirmation sheet** before the wallet opens: plain-language
  summary, exact USDC amounts (reward, deposit, fee, what each party gets on accept / reject), the verifier
  and reject mode, and the "NOT externally audited" line. The user must tick nothing — one clear primary
  button — but the sheet must be impossible to skip.

## Where the spec text lives (no backend)
`post()` calldata is `selector + abi(Params)`. Solidity ignores trailing calldata, so the app appends
`MAGIC || specBytes` where `MAGIC = ascii("MADBSPEC1")` and `specBytes` = the exact UTF-8 bytes of the spec
JSON; `specHash = keccak256(specBytes)`. **Proven live on Base Sepolia (post #18, tx 0xa5f5c09f…):
recovered 251 bytes, hash matched, gas 276k.** Readers fetch the `Posted` tx input, take the bytes after
the last `MADBSPEC1`, and show the spec only if `keccak256(bytes) == specHash` from the event; otherwise
show "Spec not published on-chain — specHash 0x…" (agents posting via SDK/MCP may host it elsewhere).
Cap spec at 16 KB. Spec JSON must follow `docs/schemas/bounty-spec.schema.json` (`specVersion
"madb-spec/1"`). Canonicalisation is NOT required — the hash is over the exact bytes we append.

## Architecture (files and owners)
```
app/
  package.json, tsconfig.json, build.mjs        [integrator]  esbuild → site/app/app.js + app.css copy
  index.html → site/app/index.html               [ui]          shell, header/nav identical to site, <div id=app>
  src/
    config.ts                                    [chain]       chains, RPCs, DEPLOYMENTS, constants
    chain/wallet.ts                              [chain]       EIP-6963 discovery, connect, account/chain events,
                                                               switch/add Base chain, signer = viem WalletClient
    chain/reads.ts                               [chain]       listBounties(), getBounty(id), getTimeline(id),
                                                               getSpec(id), balances/allowance, block time;
                                                               small in-memory cache; returns plain view models
    chain/writes.ts                              [chain]       approve-if-needed + post/claim/submit/settle/
                                                               reverse/payOnTimeout/finalizeReject/
                                                               reclaimAbandoned/refundExpired/cancel/
                                                               extendReview/withdraw; returns tx hash; waits
                                                               for receipt; maps custom errors to plain English
    chain/errors.ts                              [chain]       revert selector → human message table
    model/actions.ts                             [domain]      PURE: given (bountyView, me, now) → list of
                                                               available actions with label, who, why/when,
                                                               danger level; plus "what happens next" text
    model/postForm.ts                            [domain]      PURE: form state → validation errors, derived
                                                               numbers (min deposit, fee, payouts), PostParams,
                                                               verifierInit encoding per adapter, spec JSON
    model/format.ts                              [domain]      USDC, addresses, durations, relative times
    ui/*.tsx                                     [ui]          components & pages (below)
    main.tsx                                     [ui]          router + app state
  test/                                          [qa]          unit tests for model/* (node:test or vitest)
  e2e/                                           [qa]          Playwright scripts vs Base Sepolia
```
Interfaces between layers are the TypeScript types in `src/types.ts` (owned by **chain**, written first;
domain + ui import from it). Domain code is pure and unit-tested; UI never calls viem directly.

## Pages (hash routes)
- `#/` **Browse**: open bounties first (claimable now), then active, then finished. Card: title (from
  spec, else "Bounty #id"), reward (big), deposit to claim, verifier type chip (Self/EOA, On-chain check,
  Hash reveal, TeeML (0G), Multi-sig, Fallback ladder), time left to claim, state pill. Filters: Open /
  Mine / All; sort by reward or newest. Empty state that teaches.
- `#/bounty/:id` **Bounty**: header (title, reward, state, countdown), the spec (instructions, acceptance
  criteria, evidence format) with hash-verified badge, the money box (what you put in, what you get on each
  outcome), the parties, a vertical timeline, and the **Action panel** driven by `model/actions.ts` —
  primary action for the connected role, secondary permissionless actions for anyone (pay on timeout,
  finalize reject, reclaim abandoned, refund expired), each with a one-line why. Worker safety check
  (`@madbounty/sdk` safety) shown before Claim with its warnings in plain words.
- `#/post` **Post a bounty**: a 3-step wizard. (1) Task: title, instructions, acceptance criteria list,
  evidence format. (2) Money & rules: reward (1–1000), deposit (default min, slider up to reward), work
  window, review window, open-until, verifier (choose: "I'll review it myself" = connected address; "Another
  address"; "Multi-sig of N"; advanced: on-chain check / hash reveal / TeeML with their configs), reject
  mode BURN default (REFUND only with an independent verifier — show the A6 warning). (3) Review &
  confirm: plain-language summary + payout table → approve USDC (if needed) → post → success screen with
  link to the bounty and share text.
- `#/me` **My bounties**: as agent / worker / verifier, with "needs your action" at the top.
- `#/help` short FAQ: how it works in 5 steps, risks, glossary; links to /docs and /llms.txt.

## UX rules
- Mobile-first, works at 360px. Keyboard accessible, visible focus, aria labels, WCAG AA contrast.
- Reuse `/assets/style.css` tokens (dark, one accent `--accent #2e9bff`, `--danger`, `--gold`); app CSS
  in `app/src/ui/app.css` only adds components. Same header/nav/footer as the site.
- Money in USDC with 2 decimals; addresses shortened `0x1234…abcd` with copy button; times as "in 3h 12m"
  plus absolute UTC on hover/title.
- Every pending tx shows a toast: "Waiting for wallet" → "Submitted · view on Basescan" → "Confirmed".
  Errors are human sentences from `chain/errors.ts`, never raw hex.
- Wrong network → a single "Switch to Base" button (wallet_switchEthereumChain, then addEthereumChain).
- No wallet installed → read-only mode + "Install a wallet" help; on mobile suggest opening in the wallet's
  browser.

## Definition of done (integrator verifies)
1. `npm run build` → `site/app/` ; size budget met ; no console errors on load.
2. Unit tests pass for model/*.
3. Playwright on Base Sepolia with a real funded test key injected as an EIP-1193 provider: post (with
   spec in calldata) → claim (second key) → submit → accept (verifier key) → state Paid; and cancel path.
   Balances asserted. Screenshots at 390px and 1280px reviewed.
4. Read-only browse works on mainnet with no wallet (0 bounties → empty state).
