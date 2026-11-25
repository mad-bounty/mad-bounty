# MAD Bounty verifier adapters (periphery)

Singleton contracts that a bounty names as its `verifier`. Each adapter checks a rule and calls
`core.settle(id, accept)` (or `core.reverse(id)`) directly. Shared rules (`AdapterBase.sol`):

- **No funds, no owner, no admin, no upgrade.** Core pays out of the per-bounty vault; adapters never hold USDC.
- **Config is set-once, agent-only, Open-only**, and only if the adapter is the bounty's verifier
  (`core.bounties(id).verifier == adapter`). Config must land before a worker claims, so the worker can read the
  rule before staking a deposit. **Workers: never claim a bounty whose adapter config is missing** — an
  unconfigured adapter is silent, which pays you on timeout, but it also means the agent misconfigured something.
- **Resolve is permissionless** (anyone can relay). Every config and resolution emits an event.
- **Silence still pays the worker.** If the adapter never fires, `core.payOnTimeout` works as usual (tested for
  every adapter).
- EIP-712 verdicts use the adapter's own domain (`MADBountyFallbackVerifier`/`MADBountyMultiVerifier`, version 1),
  type `Verdict(uint256 id,address worker,bytes32 evidenceHash,bool accept)` and
  `Reverse(uint256 id,address worker,bytes32 evidenceHash)`. Core-domain signatures are not valid here (tested).

Gas figures are `forge test` measurements (whole tx incl. core payout), Base L2.

## 1. FallbackVerifier — verifier outage protection

**When:** you want a primary human/agent verifier but don't want a dead verifier to force a timeout payout.
Up to 3 signers `[primary, backup1, backup2]` (EOA or ERC-1271) + `stepTimeout`. Signer `i` may decide from
`submittedAt + i*stepTimeout`; earlier signers remain valid; first verdict wins.
`submittedAt = deadline - reviewWindow` (or `- 2*reviewWindow` once extended — `extendReview` adds exactly one
window, so an extension does not shift the ladder, it only gives backups more time). Config requires
`stepTimeout*(n-1) < reviewWindow`. **Reverse** (during core's 24h cooling): primary signer only.

- **REFUND-safe:** only if every signer is independent of the agent.
- **Trust:** each signer, inside its time slot. A backup can override nobody — it only acts if the earlier
  signers haven't settled yet.
- **Gas (measured):** resolve ≈ 117k incl. core accept payout; configure (3 signers) ≈ 142k.

## 2. OnchainCheckVerifier — accept when an on-chain view returns the expected bytes

**When:** the deliverable is observable on-chain (contract deployed, balance reached, registry entry set).
Config `(target, calldata, expectedResultHash)`; passes when
`keccak256(returndata of target.staticcall{gas:200k}(calldata)) == expectedResultHash`. Revert / OOG = not passed.
Target must be a contract (an EOA staticcall would "succeed" with empty data).

- **Accept-only → REFUND-safe: yes.** It cannot reject; failing checks just leave the timeout to pay the worker.
- **Trust:** the target contract. If its state is cheaply manipulable by anyone (spot prices, donatable balances),
  anyone can make it pass momentarily — which only pays the worker early.
- **Gas (measured):** resolve ≈ 103k incl. payout, plus the target call (capped at 200k); configure ≈ 119k.

## 3. HashRevealVerifier — commit an answer, worker reveals it

**When:** puzzle/CTF/search tasks with a single verifiable answer.
Agent commits `keccak256(abi.encode(bytes answer))`. Only `bounty.worker` may `reveal(id, answer)`, after submit.

- **Accept-only → REFUND-safe: yes.**
- **Warning:** the answer becomes public on reveal. Use answers that are fine to publish, or commit to a hash of
  private data. Salt low-entropy answers or they can be brute-forced from the commitment.
- **Front-running is harmless:** a watcher copying the answer from the mempool can't reveal (not the worker) and
  core pays `bounty.worker` regardless. Don't reuse a commitment across bounties.
- **Gas (measured):** reveal ≈ 106k incl. payout; configure ≈ 69k.

## 4. TeeMLVerifier — 0G Compute TeeML LLM judge

**When:** an LLM judge is acceptable and you want the verdict signed inside a 0G TeeML enclave.
0G TeeML signs `hex(sha256(request)) ":" hex(sha256(response))` (129 chars, lowercase) with EIP-191; verified
against a real 0G signature (provider `0x2161…348c`, glm-5.3-flash, signer `0x878d…6c96`) in
`test_real0GSignatureVector`.

Config: 1..3 allowed enclave signer addresses (Base can't read 0G chain — pin them) + `prefixHash`, `suffixHash`.
`resolve(id, request, prefixLen, suffixLen, response, sig)` requires:
1. request = `prefix ‖ marker ‖ evidence ‖ suffix` with `keccak(prefix)`/`keccak(suffix)` as configured — the agent
   fixes model, `temperature: 0`, system prompt and rubric. Without this, anyone could ask the TEE "say VERDICT:Y".
2. `marker = "MADB:" ‖ hex(core) ‖ ":" ‖ id ‖ ":" ‖ 0x-hex(evidenceHash)` — a signature for one bounty can't be
   replayed on another.
3. `keccak(evidence) == bounty.evidenceHash`, and evidence is a valid JSON string body (no raw `"`, no control
   bytes, only valid escapes) so it cannot break out of the user-message string and inject messages/params.
   Workers commit `evidenceHash = keccak256(JSON-escaped evidence)`.
4. signature recovers to an allowed signer; verdict = first `VERDICT:Y` / `VERDICT:N` in the response body
   (neither → revert). The prompt should demand the token exactly once, at the end.

- **REFUND-safe:** conditionally — the agent doesn't control the enclave, but the agent writes the prompt. Workers
  must read the prefix/suffix preimages (published off-chain by the agent) before claiming.
- **Trust:** enclave signer key + model behaviour; prompt injection inside the evidence text remains an LLM risk;
  pinned signer addresses go stale if the provider rotates keys (then silence → worker paid).
- **Anti-grinding:** temperature 0 in the template; first valid resolve wins (core leaves Submitted). A party
  could still re-query a nondeterministic model hoping for a better verdict — and race to submit it.
- **Reverse:** not supported (a reject stands after cooling).
- **Gas (measured):** resolve ≈ 145k for a small request; ≈ 0.85M for a 2 KB request + 1 KB response, ≈ 2.9M for 8 KB + 2 KB (byte loops for the JSON
  check and verdict search dominate; sha256 precompile is cheap). Pennies on Base.

## 5. MultiVerifier — m-of-n panel

**When:** a panel of independent reviewers (humans, agents, 1271 wallets).
Config: ≤7 signers (strictly ascending), threshold m. `resolve(id, accept, signers[], sigs[])` with signers strictly
ascending (no duplicates), each a configured signer with a valid EIP-712 sig; ≥ m needed for accept or reject.
`reverse` needs m Reverse signatures.

- **REFUND-safe:** if fewer than m signers are agent-controlled. Use m > n/2: with 2m ≤ n both an accept and a
  reject quorum can exist and the first to land wins.
- **Gas (measured):** 3-of-5 resolve ≈ 140k incl. payout (~10k per extra ECDSA sig); configure (5 signers) ≈ 322k.

## Tests

`FOUNDRY_TEST=periphery/test forge test --match-path 'periphery/test/*'` (the repo's `foundry.toml` sets
`test = test` by default, so point `FOUNDRY_TEST` at the periphery folder). See `RECEIPT.md`.
