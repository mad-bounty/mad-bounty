# MAD Bounty verifier adapters (periphery)

Singleton contracts that a bounty names as its `verifier`. Each adapter checks a rule and calls
`core.settle(id, accept)` (or `core.reverse(id)`) directly. Shared rules (`AdapterBase.sol`):

- **No funds, no owner, no admin, no upgrade.** Core pays out of the per-bounty vault; adapters never hold USDC.
- **Configure atomically inside `post`.** Pass `Params.verifierInit = abi.encode(<adapter config>)`. Core then calls
  `adapter.onPost(id, agent, verifierInit)` in the same transaction, so no worker can claim before the rule
  exists (audit H-01). The two-step `configure(...)` path still exists (agent-only, Open-only, set-once) but a claim
  can front-run it. **Workers: never claim a bounty whose adapter config is missing.**
- **Silence pays the worker** (core rule). Rule-based adapters therefore have a permissionless
  "reject if the rule is still unmet" path after a window (audit C-01/C-02). Every window must satisfy
  `1h <= window` and `window + 12h <= reviewWindow`, so the reject can land even under Base's ~12h forced-inclusion delay.
- **Resolve is permissionless** (anyone can relay). Every config and resolution emits an event.
- Signer checks accept the address's own ECDSA key first, then ERC-1271 (EIP-7702 smart accounts keep working).
- EIP-712 verdicts use the adapter's own domain (`MADBountyFallbackVerifier`/`MADBountyMultiVerifier`, version 1),
  type `Verdict(uint256 id,address worker,bytes32 evidenceHash,bool accept)` and
  `Reverse(uint256 id,address worker,bytes32 evidenceHash)`. Core-domain signatures are not valid here (tested).

| Adapter | `verifierInit` encoding |
|---|---|
| FallbackVerifier | `abi.encode(address[] signers, uint32 stepTimeout)` |
| OnchainCheckVerifier | `abi.encode(address target, bytes data, bytes32 expectedResultHash, uint32 checkWindow)` |
| HashRevealVerifier | `abi.encode(bytes32 commitment, uint32 revealWindow)` |
| TeeMLVerifier | `abi.encode(address[] signers, bytes32 prefixHash, bytes32 suffixHash, uint32 proofWindow)` |
| MultiVerifier | `abi.encode(address[] signers /*ascending*/, uint8 threshold)` |

## 1. FallbackVerifier: protection against verifier outage

**When:** you want a primary human or agent verifier, but don't want a dead verifier to force a timeout payout.
Up to 3 signers `[primary, backup1, backup2]` plus `stepTimeout`. Signer `i` may decide from
`submittedAt + i*stepTimeout`. Earlier signers remain valid, and the first verdict wins. An extension does not shift
the ladder. Config requires `stepTimeout*(n-1) < reviewWindow`. **Reverse** (during core's 24h cooling): primary only.

- **REFUND-safe:** only if every signer is independent of the agent.
- If all signers stay silent, the worker is paid on timeout.

## 2. OnchainCheckVerifier: accept when an on-chain view returns the expected bytes

**When:** the deliverable is observable on-chain (contract deployed, registry entry set, NFT transferred).
Passes when `keccak256(returndata of target.staticcall{gas:1M}(data)) == expectedResultHash`. Revert or OOG counts as not passed.
- `resolve(id)`: anyone, while Submitted. Accepts if the check passes.
- `rejectUnmet(id)`: anyone, once `checkWindow` has passed since submission and the check still fails.

- **Pick a check that only the requested work can make true.** A check that is already true, or that anyone can
  make true (a donatable balance, a spot price), pays the first worker who submits.
- **REFUND-safe:** only if the agent cannot keep the check false against honest work. Workers: read the target.

## 3. HashRevealVerifier: commit an answer, the worker reveals it

**When:** puzzle, CTF or search tasks with a single verifiable answer.
The agent commits `keccak256(abi.encode(bytes answer))`.
- `reveal(id, answer)`: only `bounty.worker`, after submit. A match accepts.
- `rejectUnrevealed(id)`: anyone, once `revealWindow` has passed since submission.

- **REFUND-safe:** yes. The agent cannot block a correct reveal.
- **Warning:** the answer becomes public on reveal. Salt low-entropy answers, or they can be brute-forced from the
  commitment. Front-running is harmless (only the worker can reveal). Don't reuse a commitment across bounties.

## 4. TeeMLVerifier: 0G Compute TeeML LLM judge

**When:** an LLM judge is acceptable and you want the verdict signed inside a 0G TeeML enclave.
0G TeeML signs `hex(sha256(request)) ":" hex(sha256(response))` (129 chars, lowercase) with EIP-191. The adapter is
verified against a real 0G signature (provider `0x2161…348c`, glm-5.3-flash, signer `0x878d…6c96`).

`resolve(id, request, prefixLen, suffixLen, response, sig)` requires:
1. request = `prefix ‖ marker ‖ evidence ‖ suffix`, with `keccak(prefix)`/`keccak(suffix)` as configured. The agent
   fixes the model, `temperature: 0`, system prompt and rubric.
2. `marker = "MADB:" ‖ hex(core) ‖ ":" ‖ id ‖ ":" ‖ 0x-hex(evidenceHash)`, so there is no replay across bounties.
3. `keccak(evidence) == bounty.evidenceHash`. The evidence must also be a valid JSON string body, be ≤ 8 KB, and
   not contain the word `VERDICT`. The response must be ≤ 16 KB.
4. The signature recovers to an allowed signer, and the response contains **exactly one** `VERDICT:` token followed by
   `Y` or `N`. Zero or several tokens revert, so echoed format strings and reasoning can't flip the result.

**Burden of proof is on the worker:** if no valid proof has settled the bounty `proofWindow` after submission,
anyone may call `rejectUnproven(id)`. A worker who wants to be paid must get the enclave's `VERDICT:Y` and relay it
in time. Withholding or gas-bombing the evidence no longer blocks the reject (audit C-02).

- **REFUND-safe:** conditionally. The agent doesn't control the enclave, but the agent writes the prompt. Workers
  must read the prefix/suffix preimages and test them against the enclave BEFORE claiming.
- **Trust:** enclave signer key and model behaviour. Pinned signer addresses go stale if the provider rotates keys.
- **Reverse:** not supported.
- **Gas:** about 0.15M for a small request, up to about 7M at the 8 KB evidence cap. Pennies on Base.

## 5. MultiVerifier: m-of-n panel

**When:** a panel of independent reviewers (humans, agents, 1271 wallets).
Config: ≤7 signers (strictly ascending) and a threshold m. `resolve(id, accept, signers[], sigs[])` needs ≥ m valid
signatures. `reverse` needs m Reverse signatures. If the panel is silent, the worker is paid on timeout.

- **REFUND-safe:** if fewer than m signers are agent-controlled. Use m > n/2.

## Tests

`FOUNDRY_TEST=periphery/test forge test` (80 tests, including `AuditFixes.t.sol`, one regression test per audit
finding). Audit PoCs: `FOUNDRY_TEST=audit/periphery/test forge test`.
