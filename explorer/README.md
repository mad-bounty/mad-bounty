# MAD Bounty explorer (static)

`build.py` turns the MADBountyCore contract's on-chain history into plain HTML pages under `site/explorer/`. The pages have no JavaScript, no cookies and no external assets, and are served by Cloudflare Pages at https://madbounty.org/explorer/. It uses only the Python 3.10+ standard library. `keccak.py` is a pure-Python Keccak-256, checked against `cast keccak`, so event topics and selectors are derived from the exact signatures in `src/MADBountyCore.sol`.

## Run

```sh
python3 explorer/build.py                       # mainnet -> site/explorer
python3 explorer/build.py --net sepolia --out /tmp/explorer-sepolia
MADB_RPC=https://my-node python3 explorer/build.py   # override the RPC
python3 explorer/build.py -v                    # scan range + RPC call count on stderr
```

The script prints one line, e.g. `17 bounties, 71 events, changed=no`, and exits 0. `changed` is `yes` only if some output's content differs from what is already on disk. HTML is compared without its `Last updated` line, and data.json without `generatedAt`/`block`. So a cron job can redeploy only when `changed=yes`.

## How it works

1. **Addresses.** They come from `deployments/base-<net>.json`: core, USDC, treasury, adapters and reputation contracts, plus `deployBlock`. Adapter addresses are mapped to names (e.g. "TeeML adapter"). Superseded sepolia contracts are labelled as superseded.
2. **Event scan.** `eth_getLogs` runs on the core from `deployBlock` to the head, in chunks that adapt to the RPC. publicnode caps a range at 50,000 blocks, and sepolia.base.org caps it at 200 (the build reads the limit from the error and shrinks the chunk). Raw logs and block timestamps are cached in `explorer/cache-<net>.json` (gitignored). A rerun only scans from `lastBlock - 30`, a reorg margin, and logs are de-duplicated by `(tx, logIndex)`. Delete the cache to rescan from scratch.
3. **Live state.** Batched `eth_call`s at the head block read `nextId`, `feeBps`, `bounties(id)` (15 fields, state at index 13), `feeBpsOf(id)` and USDC `balanceOf(vault)` for every bounty. The state shown is always the contract's own state, not one inferred from events.
4. **Outputs** (in `--out`):
   - `index.html`: stats, the latest 25 bounties, the last 50 events as sentences, and contract addresses with Basescan and Sourcify links. When there are no bounties it shows "No bounties yet" with links to the docs and llms.txt.
   - `bounties/index.html`: written only when there are more than 25 bounties.
   - `bounty/<id>/index.html`: every field, the vault balance, a "What happens next" line for the current state, the event timeline with tx links, and a warning for REFUND-mode bounties whose verifier is not a known adapter.
   - `address/<addr>/index.html`: one page per agent, worker or verifier that appears in a bounty, with totals and outcomes. The address is lowercase in the URL.
   - `data.json`: every bounty, its events, stats and per-address summaries. Amounts are USDC base units, written as strings.
   - `sitemap.xml`: every generated URL.

   Pages use the directory form `x/index.html`, which Cloudflare serves at `/x/`. Do not add a `_redirects` file, because it loops on Pages. Output files that a later build no longer produces are deleted, tracked per output directory in the cache.

### Stat definitions

| Stat | Definition |
|---|---|
| In escrow now | Sum of the bounty vaults' USDC balances. |
| Paid to workers | Sum of `Paid.toWorker`, which includes the returned worker deposit. |
| Burned | `Burned.amount` + `Refunded.depositBurned` + `Abandoned.depositBurned` − burns that failed and were recorded as `Owed` to 0x…dEaD. |
| Returned to agents | Reward of each Cancelled/Expired bounty + `Refunded.toAgent`. |
| Fees | Sum of `Paid.fee`. |

## Cron

Rebuild every 10 minutes and deploy only when something changed. The wrangler command is the one from the site deploy notes.

```cron
*/10 * * * * cd ~/projects/mad-bounty && python3 explorer/build.py --net mainnet | grep -q 'changed=yes' && npx wrangler pages deploy site --project-name=madbounty --branch=main --commit-dirty=true >> explorer/cron.log 2>&1
```

Also add `https://madbounty.org/explorer/sitemap.xml` to `robots.txt` (as another `Sitemap:` line) or link it from the main `site/sitemap.xml`. The explorer does not edit either file.

## Limits

- Timestamps shown are block times at the head block. "What happens next" is correct as of the last build, not live.
- Address pages exist only for agents, workers (including past, abandoned claimers) and verifiers. Other addresses link to Basescan.
- The spec text and evidence are off-chain. Only their hashes are shown.
