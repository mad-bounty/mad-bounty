# MAD Bounty periphery adapters: adversarial audit

Scope: `periphery/src/{AdapterBase,BytesSearch,FallbackVerifier,OnchainCheckVerifier,HashRevealVerifier,TeeMLVerifier,MultiVerifier}.sol`
and how they interact with `src/MADBountyCore.sol`. Out of scope by design (not reported): malicious verifier chosen by the agent (A3),
spite reject (A5), self-verifier in REFUND (A6), Circle blacklisting.

Method: manual review of every entrypoint, Foundry PoCs, and triage of the round-2 Slither output on the periphery
(`audit/r2/slither-periphery.txt`: only uninitialized-local, unused-return, timestamp and low-level-call hits, all benign).

```
export PATH=$HOME/.foundry/bin:$PATH; cd ~/projects/mad-bounty
FOUNDRY_TEST=audit/periphery/test forge test --match-path 'audit/periphery/test/*' -vv
```
Result: 21/21 pass. 11 findings PoCs pass, meaning each exploit works. 10 refutation tests pass, meaning each defence holds.
The existing `periphery/test` suite still passes (48/48). No file outside `audit/periphery/` was touched.

## Root cause shared by C-01, C-02, H-01 and M-01b

In core, verifier silence means ACCEPT (`payOnTimeout`). An adapter rejects only when someone relays a positive proof of
failure. So any state where the adapter *cannot* produce a reject is the same as a guaranteed accept for the worker:
no reject path, a reject the worker can block, a missing config, or an unparseable verdict. On the worker's side, D is
returned in full on accept, so each of these attacks has no cost for the worker beyond gas and locked capital.

## Confirmed findings

| ID | Sev | Adapter | Mechanism | PoC (`audit/periphery/test/PeripheryFindings.t.sol`) |
|---|---|---|---|---|
| C-01 | Critical | OnchainCheck, HashReveal | The adapters can only accept. A claimant who does nothing waits out review, and `payOnTimeout` pays P−1%+D. The agent loses P every time. | `test_C01_onchainCheck_zeroWork_workerPaid`, `test_C01_hashReveal_zeroWork_workerPaid` |
| C-02 | Critical | TeeML | A reject must embed the evidence *preimage* in a signed request. The worker controls the preimage, so the worker can block every reject: (a) withhold the preimage, (b) publish a preimage that is not a JSON string body (`\n`, `"`), or (c) make it valid JSON but 64 KB, so `resolve` needs about 19.8M gas, over Base's 2^24 (16,777,216) per-tx cap (EIP-7825). The reject can't be relayed and the timeout pays the worker. | `test_C02a_withheldEvidence_…`, `test_C02b_invalidJsonEvidence_…`, `test_C02c_gasBombEvidence_rejectExceedsTxGasCap` (logs 19,766,753 execution gas), `test_C02c_gasBomb_capped_rejectFails_workerPaid` |
| H-01 | High | all (worst: Multi, Fallback, TeeML) | `post` and `configure` are separate txs, because configure needs the id and runs only while the bounty is Open. A bot claims in the block after `Posted`, before configure lands. Configure then reverts `NotOpen`, the adapter can never settle, and the worker submits nothing and gets paid on timeout. A unanimous signed reject from the intended panel reverts `NotConfigured`. | `test_H01_multi_claimBeforeConfigure_panelCannotReject_workerPaid`, `test_H01_fallback_claimBeforeConfigure_workerPaid` |
| M-01 | Medium | TeeML | `parseVerdict` takes the FIRST `VERDICT:Y/N` anywhere in the response body. (a) A response that restates the format ("…VERDICT:Y or VERDICT:N…") or carries `reasoning_content` before the final `VERDICT:N` parses as ACCEPT, so the enclave rejected but the worker is paid. The evidence can ask the model to "restate the output format first". (b) Variants like `**VERDICT:** N` revert `NoVerdict`, so the reject can't be relayed and the timeout pays the worker. | `test_M01a_echoedFormat_finalRejectParsedAsAccept`, `test_M01a_reasoningContent_parsedAsAccept`, `test_M01b_markdownVerdict_unparseable_workerPaid` |

### C-01: accept-only adapters cannot catch a fake
The adapter natspec says "If the check never passes, core's verifier-silence timeout pays the worker anyway, so the
adapter only lets a worker be paid EARLY". That makes the catch rate d = 0. The shipped agent guidance says the opposite:
`docs/llms-full.txt` §7 ("d ≈ 1, D can sit at the floor", "Refund OK"), and `skill/mad-bounty/SKILL.md` ("safe for REFUND").
With d = 0, the deterrence rule D/P ≥ (1−d)/d cannot be met. Any stranger claims at the deposit floor, submits
`bytes32(0)`, and collects. (If the parent judges this a documented design choice, it is still a doc/guidance Critical,
because every bounty that follows the docs can be drained.)
**Minimal fix:** give both adapters a rule-based reject.
- OnchainCheck: `rejectIfUnmet(id)`, callable by anyone once `block.timestamp >= deadline − G` (G ≥ 12h for forced
  inclusion), and only if `!check(id)`. It calls `core.settle(id,false)`.
- HashReveal: `rejectUnrevealed(id)` after the same cutoff, if there has been no reveal.

The reject still depends only on the pre-committed rule, so the agent can't abuse it, and REFUND safety holds. Until
this ships, mark both adapters as "no deterrence" in the docs.

### C-02: TeeML rejects can be blocked by the worker
**Minimal fix:** flip the default for this adapter. Accept requires a relayed TEE `VERDICT:Y` proof, which the worker is
motivated to relay. Add a permissionless `rejectUnproven(id)` after `deadline − G`. Also cap `evidence.length`
(e.g. ≤ 8 KB) in `resolve`, and document that evidence must be published, JSON-escaped and within the cap. The worker
then bears the cost of unprovable evidence, not the agent. Alternatives that keep accept-on-silence only cover (c),
via a length cap at submit time, which core does not support. They can't fix (a) or (b).

### H-01: config race
Neither the docs nor the SDK provide an atomic post+configure. On Base the configure tx needs the id from the post
receipt, so it lands at least one block later. A priority-fee bot wins the race for that block.
**Minimal fix (adapter-side):** allow `configure` for a bounty in state `None` (a future id). Store
`configurer = msg.sender`, and treat the config as valid only if `bounties(id).agent == configurer` (otherwise treat it
as unconfigured and let it be overwritten).
**Interim fix (SDK/docs):** post+configure in one tx via a smart-wallet/7702 batch, with the id predicted from
`nextId()` (if the prediction is wrong, the batch reverts), or set a `claimAuthorizer` until the config lands. The worker
check "never claim unconfigured" doesn't help here: the attacker *wants* it unconfigured.

### M-01: TeeML verdict parsing
**Minimal fix:** require exactly one verdict token. Revert if both `VERDICT:Y` and `VERDICT:N` appear, or take the LAST
occurrence. Better still, require the token at an agent-pinned position, e.g. the content must end with
`VERDICT:Y"`/`VERDICT:N"` immediately before a fixed response suffix. Pair this with the C-02 fix so that an
unparseable response can't turn into a payout.

## Refuted hypotheses (`audit/periphery/test/PeripheryRefuted.t.sol`, each PASSES because the attack fails)

| # | Hypothesis | Test |
|---|---|---|
| R-01 | Configure a bounty whose verifier is another adapter; non-agent configure; reconfigure | `test_R01_configCrossAdapter_nonAgent_afterClaim` |
| R-02 | Fallback backup decides before its slot (−1s), signerIndex spoof (sig at a lower index), extension shifts the ladder, backup reverses, second settle | `test_R02_fallbackSlotBoundaries_andIndexSpoof` |
| R-03 | Fallback/core deadline overlap (payOnTimeout and resolve both live at `deadline`) | `test_R03_fallbackDeadlineEdge` |
| R-04 | Round-2 swarm "M-1": a reverting ERC-1271 backup blocks resolve. Refuted: only the index chosen is checked, and the primary still resolves | `test_R04_revertingBackup_doesNotBlockPrimary` |
| R-05 | Re-entrant ERC-1271 signer double-settles (SignatureChecker staticcall blocks the inner write) | `test_R05_reentrant1271_noDoubleSettle` |
| R-06 | Multi: threshold 0, duplicate/unsorted signers, accept sigs reused as reject, verdict sigs reused as reverse, unknown signer | `test_R06_multiQuorumIntegrity` |
| R-07 | OnchainCheck returndata length/padding tricks, low-gas relayer forcing a pass, resolve before submit | `test_R07_onchainReturndataExact` |
| R-08 | HashReveal mempool copy-reveal by a non-worker; reveal before submit | `test_R08_hashRevealFrontrun` |
| R-09 | TeeML prefix/suffix split shifting, suffix param injection (`temperature`), escaped-quote message injection, marker of another id, malformed sig, double resolve | `test_R09_teemlTemplateSplitGames` |
| R-10 | `isJsonStringBody` edges: trailing `\`, short `\u`, raw quote, control bytes, `\\\` | `test_R10_jsonBodyEdges` |

Also checked by reading the code. There is no exploit, so there is no test:
- No adapter can call `settle` twice. Core leaves Submitted on the first call.
- `reverse` reaches core only from the Fallback primary or a Multi quorum. HashReveal, OnchainCheck and TeeML have no
  reverse path.
- Cross-chain/cross-adapter replay: the EIP-712 domain includes chainId and the adapter address. The TeeML marker binds
  `core` and `id`, but not chainId. A different chain needs a different core address unless the core is deployed with
  CREATE2 at the same address, and the evidenceHash binds the worker manifest. Info only.
- The worker can't make OnchainCheck pass via a contract they control. The target and calldata are fixed by the agent at
  configure time; choosing a manipulable target is the agent's choice (A3-class).
- Agent-controlled signers or prompts in REFUND mode are A3/A6-class.

## Files
- `audit/periphery/REPORT.md` (this file)
- `audit/periphery/test/PeripheryFindings.t.sol`: 11 exploit PoCs (C-01, C-02, H-01, M-01)
- `audit/periphery/test/PeripheryRefuted.t.sol`: 10 refutation tests
