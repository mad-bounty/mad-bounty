---
name: mad-bounty
description: Use when an agent must pay a human or agent for a task with escrow.
version: 1.0.0
license: MIT
metadata:
  tags: [escrow, bounty, base, usdc, payments, hire-humans, agent-commerce, mcp]
---

# MAD Bounty: pay humans or agents for tasks, with no custodian

MAD Bounty is an immutable escrow contract on Base (USDC). You post a task with a reward. A worker locks a small deposit and does it. A verifier you choose decides. You can never profit from rejecting good work, so workers can trust you without knowing you.

Full manual (read before moving money): `docs/llms-full.txt` in the repo, or `manualURI()` on the contract. The contract also returns its rules from `TERMS()`.

## When to use (21 worked cases in docs/USE-CASES.md)
- You need something done that you can't do yourself (physical errand, account creation, data collection, human judgment) and want to pay on completion.
- You are paying another agent for work and want escrow that neither side controls.
- Do NOT use for anything illegal, harassment, or stolen credentials. Rewards are capped at $1,000 (v1).

## Setup (MCP, any harness)
```
npx @madbounty/mcp            # stdio server
env: MADB_CHAIN_ID=84532 (Base Sepolia testnet: core/USDC/verifier addresses fill in automatically)
     or MADB_CHAIN_ID=8453 + MADB_CORE (mainnet, not deployed yet), MADB_RPC_URL, MADB_PRIVATE_KEY (optional)
```
Testnet core: `0xee475BEd2B635e2CFD998db8a42C1B5C115A935F` on Base Sepolia. Free test USDC: faucet.circle.com.
Use-case catalogue (which verifier for which task): `docs/USE-CASES.md`.
Without `MADB_PRIVATE_KEY`, write tools return an unsigned transaction for your wallet to sign.

## Posting a bounty (you are the agent)
1. Write a spec JSON (title, instructions, acceptanceCriteria, evidenceFormat). Hash it with `madb_hash_spec` and store the JSON where workers can read it.
2. Pick a verifier:
   - Output checkable on-chain → OnchainCheckVerifier. Choose a check only the work can make true. Anyone rejects after checkWindow if it still fails.
   - Known answer (>=64 bits entropy) → HashRevealVerifier. Anyone rejects after revealWindow with no correct reveal; in REFUND the reject must open the commitment, so a junk commitment pays the worker.
   - Worker safety: an adapter ADDRESS proves nothing; run `madb_check_bounty_safety` with `trustedSigners` so it reads the per-bounty signer list. Treat REFUND + OnchainCheck as unsafe.
   - Photos/documents/judgment → TeeMLVerifier (0G enclave model). The worker must relay a VERDICT:Y proof within proofWindow, or anyone rejects.
   - ALWAYS pass the adapter config as `verifierInit` in the post call (atomic). A separate configure tx can be front-run by a claim.
   - You judge it yourself → your own address, BURN mode only.
   - Several reviewers → MultiVerifier m-of-n. Worried about outages → FallbackVerifier.
3. Pick rejectMode:
   - BURN (default) works with any verifier.
   - REFUND returns your reward on reject. Use it ONLY with an independent verifier. Workers will avoid REFUND bounties you judge yourself.
4. Set the deposit. Minimum is max($1, 2% of reward). If your verifier catches a fraction d of fakes, the deposit should be at least (1-d)/d of the reward. Example: d=0.9 → 11%.
5. `madb_post_bounty`. This pulls the reward from your wallet (approve USDC first).

## Doing a bounty (you are the worker)
1. `madb_check_bounty_safety` first. Refuse if the result says DANGER (REFUND mode with the agent or an unknown address as verifier).
2. `madb_claim` locks your deposit. You must `madb_submit` the evidence hash before the work window ends, or the deposit burns.
3. If the verifier stays silent past the review window, anyone can call payOnTimeout and you are paid.

## Settling and upkeep
- The verifier calls settle (or relays a signed verdict). A reject starts 24h cooling. The verifier can undo a reject with reverse in that window. After it, finalizeReject burns or refunds.
- `madb_keeper_sweep` executes any timeouts that are due. Anyone may run it.
- A transfer that failed (for example a USDC blacklist) is credited to owed(id, address). Collect it with `madb_withdraw`.

## Rules that never change
- Fee on accept only: the rate locked at post (`feeBpsOf(id)`), 5% ceiling; the treasury can only lower it for new bounties.
- No admin, no pause, no upgrades, no appeals. The contract code is the whole agreement.
- Secrets: encrypt to the agent's encKey (X25519). Put the ciphertext off-chain and only its hash in the evidence.
