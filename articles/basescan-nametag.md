# Basescan public name tags: request copy for all 8 MAD Bounty mainnet contracts

**Where:** https://basescan.org/contactus. Set the subject to **"2.b. Add Name Tag/Label"**. The form takes one address per block, and **"Add more name tagging"** adds blocks, so all 8 fit in one ticket. Fields were read from the live form on 2026-11-27 (nothing submitted).

**Ownership proof:** the form has an optional "Verify Address Ownership" section (Address, Deployer, Signed Message). All 8 contracts were created by the one-time deployer `0xe29bcf26f87912ebd9A98ed7cFc8eFEd513F153F`; the receipts were checked on-chain on 2026-11-27, blocks 62801963–62802000. If Basescan asks for proof, sign their message template with that key. **Never paste a key into the form.** The deployer holds no on-chain powers.
**Verification:** all 8, plus the vault implementation, are Sourcify `exact_match` (checked 2026-11-27 via sourcify.dev/server/v2). Basescan may also want Etherscan-style verification; we have no Etherscan API key, so the Sourcify links are the evidence.

---

## Contact fields (once per ticket)
| Field | Value |
|---|---|
| Name | `<maintainer name>` |
| Email Address | `<maintainer email>` (use one on madbounty.org if one exists) |
| Company Name | `MAD Bounty` |
| Company Website | `https://madbounty.org` |
| Is this your address or someone else's address? | `This is my personal/project address` |

## Name-tag blocks
Every block uses Website = `https://madbounty.org`.

| # | Smart Contract / Address | Suggested Name Tag | Category Label | Short Description |
|---|---|---|---|---|
| 1 | `0xa2Be52807034990a4aa88a591D0fdb9E5E3Ef850` | `MAD Bounty: Core` | `Escrow` | MAD Bounty core: immutable USDC bounty escrow (post/claim/verdict/payout). No owner, proxy or pause. |
| 2 | `0x0e02866358fbCB186c1B6a520938400bdD8a2Dee` | `MAD Bounty: Fallback Verifier` | `Escrow` | MAD Bounty verifier adapter: ordered fallback chain of up to 3 signers with step timeouts. Holds no funds; no owner. |
| 3 | `0xBfC7F4145cbC09a79C2afb3F3170Fe211849cE1c` | `MAD Bounty: OnchainCheck Verifier` | `Escrow` | MAD Bounty verifier adapter: accepts when an on-chain view returns the expected result; anyone may reject after the check window. Holds no funds; no owner. |
| 4 | `0x40bD8730095B5925f7FA1Da9bec35F1B7243b74E` | `MAD Bounty: HashReveal Verifier` | `Escrow` | MAD Bounty verifier adapter: worker reveals the preimage of a committed answer. Holds no funds; no owner. |
| 5 | `0x4211ED6f52B76AC38E43Bf8BF059b22689e3De1B` | `MAD Bounty: TeeML Verifier` | `Escrow` | MAD Bounty verifier adapter: verdict from a 0G Compute TeeML (TEE-hosted model) signed response. Holds no funds; no owner. |
| 6 | `0x356ba86B972fe2ce3320DF390A8c2341A01cd601` | `MAD Bounty: Multi Verifier` | `Escrow` | MAD Bounty verifier adapter: m-of-n signer panel. Holds no funds; no owner. |
| 7 | `0x94bb7807484EeC7bCeF6e17a153621Fe439e6367` | `MAD Bounty: Receipts` | `Reputation` | MAD Bounty reputation: permissionless record() seals terminal bounty outcomes from core storage into per-address tallies. Holds no funds. |
| 8 | `0x1f870dd7f55f6CEd3cDb1e8C4d153492ccbDaBd9` | `MAD Bounty: Attest` | `Reputation` | MAD Bounty reputation: one rating in [-2,2] per party per recorded bounty, within 30 days. Holds no funds. |

Optional 9th block. Per-bounty vaults are minimal-proxy clones of this contract:
- Address `0x6744048485D52f508864d7c6B18bc0Be681168b5`
- Tag `MAD Bounty: Vault Implementation`
- Label `Escrow`
- Description: "Implementation behind per-bounty BountyVault clones; only the MAD Bounty core can move funds."

## Additional Comment (paste once)
```
MAD Bounty: an immutable USDC bounty escrow on Base (no owner, proxy, pause or upgrade path).
All 8 contracts were deployed 2026-11-27 by 0xe29bcf26f87912ebd9A98ed7cFc8eFEd513F153F
(deploy txs in https://github.com/mad-bounty/mad-bounty/blob/main/deployments/base-mainnet.json).
Source verified on Sourcify (exact match), e.g.
https://sourcify.dev/server/v2/contract/8453/0xa2Be52807034990a4aa88a591D0fdb9E5E3Ef850
The core self-describes on-chain: NAME(), VERSION(), TERMS(), manualURI() = https://madbounty.org/manual/v1.txt,
manualHash() = sha256 of that file. Docs: https://madbounty.org/docs .
```

## Notes
- "Category Label" is free text (the placeholder reads "e.g. DeFi"). Basescan keeps its own label list (see the Etherscan "Public Label" docs). If `Escrow` or `Reputation` isn't on the list, reviewers will map it; don't spend effort on it.
- Name tags are usually granted to projects "of public interest". With zero mainnet bounties so far (`nextId()` = 1 on 2026-11-27), the request may be deferred. Send it anyway, because it costs nothing.
- Sources: live form https://basescan.org/contactus (fields observed 2026-11-27); https://info.etherscan.com/explore-contract-address/ (Update Name Tag / Submit Label); https://info.basescan.org/how-to-remove-public-name-tag/ (signed-message ownership format).
