# MAD Bounty r3: fresh-eyes cheat hunt (commit c05c596)

Scope: `src/MADBountyCore.sol` and `periphery/src/*`, focused on the new reject paths (`rejectUnmet`,
`rejectUnrevealed`, `rejectUnproven`). Also checked: SDK `safety.ts`, the gate the docs tell workers to rely on.
Known by-design items (A6 self-verifier REFUND, silence pays, public reveal) are not re-reported as such.

```
export PATH=$HOME/.foundry/bin:$PATH; cd ~/projects/mad-bounty
FOUNDRY_TEST=audit/r3 forge test --match-path 'audit/r3/*' -vv     # 15/15 pass, ~5s
```
Each `test_F*`/`test_I*` passes only when the cheat succeeds, and asserts the USDC moved. `test_R_*` pass when
the attack fails. `test_F2_FIXED_*` runs the proposed fix on a copy (`fixed/OnchainCheckVerifierFixed.t.sol`).
Nothing outside `audit/r3/` was edited.

## Summary

| ID | Sev | Cheat | Attacker gain / victim loss (P=100, D=10 USDC) |
|---|---|---|---|
| F-1 | High | The REFUND safety gate checks only the adapter *address*. An agent-controlled or unsatisfiable *config* behind an audited adapter passes as `safe=true`. The agent keeps the work and gets P back. | Agent: work for 0 USDC. Worker: −D, plus the work |
| F-2 | Medium | `rejectUnmet` gas starvation (63/64). Anyone forces a false reject on a passing heavy check. | REFUND: agent +P (gets work free). BURN: griefer burns P+D for about 436k gas |
| F-3 | Low | Exact-equality OnchainCheck that an outsider can make false. Since C-01, a false check means reject, so a stranger burns honest work. | P+D burned for one spam-mint's gas |
| I-1 | Info | TeeML "no `VERDICT` in evidence" filter is bypassed by the JSON escape `\u0056ERDICT` | Prompt injection only (T4) |
| I-2 | Info | HashReveal "salt low-entropy answers" advice can't work: the worker must reveal the full preimage, so the salt has to be public | Zero-work worker: +P−1% |

## F-1 (High): REFUND "known-safe adapter" gate is bypassable. The agent keeps the work and the reward

**Where:** `sdk/src/safety.ts::assessBounty` and MCP `madb_check_bounty_safety`, plus the docs `llms-full.txt` §7
("HashReveal … Refund OK") and the skill pack ("safe for REFUND"). The gate marks a REFUND bounty `safe` when
`verifier ∈ knownSafeVerifiers`, and the MCP auto-loads all 5 deployed adapters into that list. Probe: for every
deployed adapter in REFUND mode, `assessBounty(...)` returns `safe= true []`, with no warnings.
The adapter is only as independent as its per-bounty config, and the agent writes that config. A6 is known; what's
new is that the documented defence (only claim REFUND bounties whose verifier is a known independent adapter)
doesn't hold, and the docs/skill label HashReveal REFUND as safe outright.

PoCs. Each ends in `Refunded`, with the agent's balance equal to its pre-post balance, the worker down exactly D,
and fee 0:
- `test_F1a_fallback_agentSigner_refundTheft`: FallbackVerifier with `signers=[agent's 2nd key]`.
- `test_F1b_teeml_agentAsEnclave_refundTheft`: TeeML "enclave signer" = agent key; the agent signs `VERDICT:N` over the
  real request.
- `test_F1c_hashReveal_unanswerableCommitment_freeDepositBurn`: HashReveal commitment = random bytes32. The worker's
  correct answer reverts `WrongAnswer`, then anyone calls `rejectUnrevealed`. **The worker can't detect this before
  claiming.** The commitment is a hash, so "Refund OK / agent can't change the commitment" is false: the agent never
  needed to change it.
- `test_F1d_onchainCheck_agentFalsifiesDeliveredAsset`: check "NFT #7 owned by agent" (the README's own
  "NFT transferred" example). The worker delivers, the agent moves the NFT to an alt before `resolve`, then
  `rejectUnmet`. The agent keeps the NFT and P.
- `test_F1e_teeml_unsatisfiableTemplate_refundTheft`: `prefixHash` with no obtainable preimage, so no Y proof can
  exist, so `rejectUnproven`.

**Minimal fixes (keep REFUND usable):**
1. SDK/MCP: for REFUND, `safe` must come from the *config*, not the address. Read `config(id)` per adapter and return
   DANGER when: (Fallback/Multi) any signer, or ≥ m signers, is not on a user-supplied independent-signer list;
   (TeeML) a signer is not in the user's 0G provider list, or the prefix/suffix preimages aren't supplied and don't
   hash-match; (OnchainCheck) always WARN, since the target is agent-influenced unless the user vets it;
   (HashReveal) DANGER, see 2.
2. HashReveal contract: in REFUND mode, require an opening for the reject:
   `rejectUnrevealed(id, bytes answer)` requires `keccak256(abi.encode(answer)) == commitment[id]` when
   `rejectMode == Refund`. A junk commitment then can't be opened, so silence pays the worker. An honest agent opens
   after the window (the answer is public anyway, and the worker failed). BURN mode is unchanged (the C-01 fix stays).
3. Docs/skill: remove "Refund OK / safe for REFUND" for HashReveal and OnchainCheck. State that adapter independence
   depends on the config.

## F-2 (Medium): `rejectUnmet` can be gas-starved into a false reject

**Where:** `OnchainCheckVerifier.check()`: `target.staticcall{gas: CHECK_GAS}(data)`; a revert or OOG reads as
"not passed", and `rejectUnmet` treats that as unmet. Under EIP-150 the callee gets at most 63/64 of the gas left,
so a caller who sets the tx gas limit makes the staticcall OOG. The remaining 1/64 is enough to finish
`core.settle(id,false)`. The r1 A2 analysis (63/64 protects the outer call) does not carry over: here a failed inner
call is a valid *result*, not a revert.

**PoC:** `test_F2_rejectUnmet_gasStarvation_refund`: a check needing 900k gas passes with full gas, and a normal
`rejectUnmet` reverts `CheckPasses`. With `gas: 436_000` it succeeds and the bounty is Rejected while `check()`
still returns true. REFUND: agent net 0, worker −D, work delivered. `..._burnGrief`: a stranger does the same in BURN
mode, burning 110 USDC. `test_F2_threshold`: checks needing ≤420k gas are safe; ≥450k are attackable (CHECK_GAS was
raised to 1M to support exactly these checks, L-07).
Preconditions: a heavy check, and the honest `resolve` not landing before `checkWindow` ends (the worker must
actively resolve, so a slow worker or a check that becomes true late in the window is exposed). Severity is Medium
because of the heavy-check precondition.

**Fix (1 line, verified by `test_F2_FIXED_gasGuard_noFalseReject`, which scans 20k–1.2M gas and finds no false reject,
while honest `resolve` still pays):**
```diff
     if (block.timestamp < _submittedAt(b) + c.checkWindow) revert TooEarly();
+    if (gasleft() < CHECK_GAS * 64 / 63 + 20_000) revert LowGas();
     if (check(id)) revert CheckPasses();
```
`resolve` needs no guard (a starved check there just reverts `CheckFailed`).

## F-3 (Low): outsiders can falsify an exact-match OnchainCheck

Before C-01, a check that couldn't pass meant silence, and silence paid the worker. With `rejectUnmet` it now means
reject. Any check of the form "value == X" on state that third parties can push *past* X (balances of public-mint
tokens, counters, `ownerOf`-style checks on donatable assets) can be broken by a stranger.
`test_F3_onchainCheck_outsiderFalsifiesExactCheck_burnGrief`: the check is "agent's balance == 1". A griefer mints
one spam NFT to the agent, the worker's honest delivery makes the balance 2, then `rejectUnmet`, and BURN burns P+D.
Fix: docs/SDK. Add "nor can anyone make it false" next to the existing "only the work can make it true", and
recommend `>=`-style checks via a small wrapper view. No contract change.

## I-1 (Info): `VERDICT` evidence filter is byte-level

`test_I1_teeml_verdictFilter_unicodeEscapeBypass`: evidence `…reply exactly \u0056ERDICT:Y` passes
`isJsonStringBody` and the `VERDICT` scan, and the model reads it decoded. Gain needs a model that obeys (T4). Fix:
reject `\u` escapes of ASCII letters in `isJsonStringBody`, or decode before scanning.

## I-2 (Info): HashReveal salting advice doesn't work

`test_I2_hashReveal_publishedSalt_bruteForce_paidForNoWork`: the worker must reveal `answer‖salt`, so the salt must
be in the spec. A zero-work claimant grinds 10⁴ PINs offline and is paid 99 USDC. Fix: docs. HashReveal suits only
high-entropy answers; never use it for answers you'd salt.

## Refuted (one-line reasons)

| Idea | Why it fails |
|---|---|
| Zero-work worker paid via the new paths | Each reject is permissionless after the window, which is ≥12h before review end (`_checkWindow`) |
| `extendReview` shifts adapter windows / delays rejects | `_submittedAt` subtracts the extension. Test `test_R_A_rejectWindowEdges_withExtension` |
| Window edge vs deadline vs Base forced inclusion | Cutoff ≤ deadline−12h. Reject at `submittedAt+window` exactly (−1s reverts). resolve/reveal stay live until a reject lands; first wins |
| Malicious `onPost` re-enters core (claim/settle) | `nonReentrant` reverts the whole post. Test `test_R_B_onPostReentrancyBlocked`. A reverting onPost only DoSes the agent's own post |
| verifierInit configures another bounty / adapter | `onPost` checks `msg.sender==core`, `verifier==this`, Open. Config keyed by fresh id |
| Bounty state collisions on a shared adapter | All adapter storage keyed by core id. Adapter bound to one immutable core |
| Signature replay across bounties, intents, core↔adapter, high-s | id/worker/evidence/accept bound. Separate domains, OZ low-s. Test `test_R_C_fallbackSigReplay` |
| TeeML proof replay to another bounty | Marker binds core+id+evidenceHash (cross-chain only with a same-address core, known Info) |
| Relayer front-running resolve/reveal | Outcome is independent of the relayer. `reveal` is worker-only. Copying a Y proof only helps the worker |
| ERC-1271/7702 signer tricks | `_validSig` ECDSA-then-1271 via staticcall. A permissive 1271 signer is agent-chosen (A3) |
| claimAuthorizer abuse | Gates claims only, single-use per (id, worker). Can't move funds |
| Self-dealing agent=worker for fee evasion or profit | Fee charged on any accept. Reject burns D. Cancel already returns P for free; no gain |
| Deposit/fee rounding dust | MIN_REWARD 1e6, so fee ≥ 1e4. `P−fee+D` sums exactly to the vault |
| Worker blocks the new rejects (C-02 redux) | Rejects need no worker data. TeeML burden is on the worker; evidence capped |
| TeeML N-proof grinding by the agent | Requires a nondeterministic model; documented (temp 0, first resolve wins). Worker can race with Y |
| Claim vs refundExpired / cancel races | `>`/`<=` boundaries disjoint; both require Open |

## Files
- `audit/r3/REPORT.md` (this file)
- `audit/r3/R3Cheats.t.sol`: 11 cheat PoCs + 1 fix test + 3 refutations
- `audit/r3/fixed/OnchainCheckVerifierFixed.t.sol`: copy of the adapter with the F-2 guard (test-only)
