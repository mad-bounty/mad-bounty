# MAD Bounty v1 Core: Independent Security Audit

Target: `src/MADBountyCore.sol` (358 lines; `MADBountyCore` + `BountyVault`), solc 0.8.34, via_ir, OZ v5.1.0.
Method: full manual read of every entrypoint, Slither 0.11.6 triage, Foundry PoCs, and a stateful invariant fuzz suite.
Scope note: `src/MADBounty.sol` (legacy contract, also picked up by Slither) is out of scope. Its detector hits are listed but not triaged.

## Result

No Critical, High or Medium findings. The fuzz suite found no break in fund conservation or the state machine.
Three Low findings are confirmed. Each comes with a PoC and a fix diff. All of them sit on paths where the
token is paused or frozen, where a signature gets reused, or where a key's account type changes.

| ID | Severity | Title | Status | PoC |
|---|---|---|---|---|
| L-01 | Low | `claimAuthorizer` signature can be replayed after `reclaimAbandoned` (no one-shot binding, no revocation) | CONFIRMED | `audit/test/AuditFindings.t.sol::test_L01_claimAuthSig_reusableAfterAbandon` |
| L-02 | Low | Burn transfers ignore the return value: while USDC is paused or a vault is frozen, `reclaimAbandoned`/`finalizeReject` emit burn events for burns that never happen and leave unaccounted funds in the vault | CONFIRMED | `test_L02_reclaimAbandoned_duringPause_silentlySkipsBurn`, `test_L02_finalizeRejectRefund_duringPause_depositStaysInVault`, `test_L02_finalizeRejectBurn_duringPause_reportsBurn` |
| L-03 | Low | Once a verifier address gets code (EIP-7702 delegation or a late-deployed counterfactual wallet), its ECDSA signatures stop being accepted, so a relayed REJECT fails and `payOnTimeout` pays the worker | CONFIRMED | `test_L03_verifierWithCode_ecdsaSigRejected_timeoutPaysWorker` |
| R-01 | – | Clone immutables (`core`, `token`) wrong because clones skip the constructor | REFUTED | `test_R_cloneImmutables` |
| R-02 | – | ERC-1271 verifier re-enters the core during `isValidSignatureNow` | REFUTED | `test_R_1271ReentrancyBlocked` |
| R-03 | – | Hook token (ERC-777-like) re-enters `withdraw`/`payOnTimeout` from the receive hook | REFUTED | `test_R_hookTokenReentrancy` |
| R-04 | – | Off-by-one at a deadline (overlap or gap between in-window and timeout actions) | REFUTED | `test_R_deadlineBoundaries` |
| R-05 | – | `extendReview` after the deadline revives a timed-out bounty or blocks `payOnTimeout` | REFUTED | `test_R_extendAfterDeadlineBlocked` |
| R-06 | – | A2 re-check: gas starvation diverts a push payout to `owed` (cancel, refundExpired, settle, settleWithSig, reverse, finalizeReject) | REFUTED | `test_R_A2_gasGrief_allEntrypoints` |
| R-07 | – | Gas starvation skips a burn while the outer tx succeeds | REFUTED (0 hits, 5k–200k gas) | `test_L02_gasStarvedBurn_probe` |
| R-08 | – | Signature malleability (high-s), Reverse sig used as Accept, cross-deployment replay | REFUTED | `test_R_sigMalleabilityAndCrossType` |
| R-09 | – | `owed` double-withdraw or cross-bounty withdraw | REFUTED | `test_R_owedIsolationAndSingleWithdraw` |
| R-10 | – | Frozen vault loses `owed` on a failed withdraw | REFUTED (reverts, so it can be retried) | `test_R_withdrawRetryableAfterFreeze` |
| R-11 | – | Accounting/conservation, fee, illegal transitions under random sequences | REFUTED (fuzz) | `audit/test/AuditInvariant.t.sol` |

### How to run

```
export PATH=$HOME/.foundry/bin:$PATH
FOUNDRY_TEST=audit/test forge test --match-path 'audit/test/*' -vv
```

`foundry.toml` leaves `test` at its default (`test/`). As a result, a bare `forge test --match-path 'audit/test/*'`
reports "No tests found", because forge only collects test contracts from the `test` dir. Either set
`FOUNDRY_TEST=audit/test`, pass `--contracts audit/test`, or have the parent add the dir in config. The full run takes
about 2 minutes.

---

## L-01 (Low): claim authorization signature can be replayed

**Code:** `claim()` L205-219. The digest is `Claim(id, worker, authDeadline)`. No nonce is used and nothing marks the
signature as spent. `reclaimAbandoned()` L233-242 sets the bounty back to `Open` and clears `worker`.

**Issue:** an authorizer signs one claim for worker W. Until `authDeadline`, W can claim, let the work window lapse,
get reclaimed, and claim again with the same bytes. Two problems follow:
- The authorizer cannot revoke an ECDSA authorization. Its only control is a short `authDeadline`.
- One authorized W can keep an authorizer-gated bounty locked in `Claimed` for up to `authDeadline`, one work window at
  a time. The authorizer meant to let W claim once.

**Cost to the attacker:** W loses `deposit` (≥ max($1, 2% of P)) on every cycle, so this is costly griefing and nobody
profits. It matters most for allowlist-style authorizers that issue long-lived authorizations. The PoC runs 6 claims
with one signature, and shows that a different worker is still rejected.

**Fix (one-shot authorization per (id, worker)):**
```diff
+    mapping(uint256 => mapping(address => bool)) public claimAuthUsed;
 ...
         if (b.claimAuthorizer != address(0)) {
             if (block.timestamp > authDeadline) revert TooLate();
+            if (claimAuthUsed[id][msg.sender]) revert BadSig();
+            claimAuthUsed[id][msg.sender] = true;
             bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, id, msg.sender, authDeadline)));
```
Alternative: put a per-bounty `claims` counter into the `Claim` struct as a nonce. That costs one storage field, and
the SDK must read the counter before signing. If neither change is wanted, document that authorizers should treat each
signature as valid "until authDeadline, any number of times" and keep `authDeadline` short.

## L-02 (Low): burns are fire-and-forget; events misreport them while the token is paused or a vault is frozen

**Code:** L240 `b.vault.send(BURN, d);`, L288 `b.vault.send(BURN, b.deposit);`, L294 `b.vault.send(BURN, amt);`.
`BountyVault.send` catches the failure and returns `false`. The core ignores that value (Slither `unused-return`).
The functions are permissionless.

**Issue:** while USDC is paused (Circle's `pause()`), or after the vault clone is blacklisted:
1. `reclaimAbandoned` sets the bounty back to `Open` and emits `Abandoned(id, w, d)`, but the deposit stays in the
   vault. Nothing in `owed` covers it, so no one can ever pull it out. Once the bounty later settles, the vault keeps
   `d` forever (PoC: 10 USDC stuck after a full accept).
2. `finalizeReject` (Refund) emits `Refunded(id, P, D)` and burns nothing. The agent's P lands in `owed`. D stays in
   the vault forever.
3. `finalizeReject` (Burn) emits `Burned(id, P+D)` and burns nothing.

Economically the funds are still gone, as the code comment at L294 says. The flaws are: (a) events and indexers
report burns that never happened, and (b) the per-vault invariant `balance == Σ owed` breaks for these vaults, which
breaks any SDK or MCP "solvency" or "stuck funds" check. Anyone can trigger this at no cost during a pause.
A frozen vault (T7) leaves the funds locked either way, so this is accepted only in that case.

The gas variant does not reproduce: the probe found no gas value at which the burn is skipped while the tx succeeds,
because the 1/64 rule leaves too little gas for the event (R-07).

**Fix (keep the funds accounted for and let anyone retry the burn later):**
```diff
-        b.vault.send(BURN, d);
+        _burn(id, b, d);
 ...
-            b.vault.send(BURN, b.deposit);
+            _burn(id, b, b.deposit);
 ...
-            b.vault.send(BURN, amt);
+            _burn(id, b, amt);
 ...
+    /// @dev Burn; on failure credit owed[id][BURN] so the burn can be retried by anyone.
+    function _burn(uint256 id, Bounty storage b, uint256 amt) internal {
+        if (amt == 0) return;
+        if (!b.vault.send(BURN, amt)) { owed[id][BURN] += amt; emit Owed(id, BURN, amt); }
+    }
+
+    function retryBurn(uint256 id) external nonReentrant {
+        uint256 amt = owed[id][BURN];
+        if (amt == 0) revert BadParam();
+        owed[id][BURN] = 0;
+        if (!bounties[id].vault.send(BURN, amt)) revert TransferFailed();
+        emit Withdrawn(id, BURN, amt);
+    }
```
With this fix, the invariant "vault balance == expected" becomes `balance == stateHeld + Σ owed (incl. BURN)` for
every state. That includes an `Open` bounty that went through a failed abandon. The handler in
`AuditInvariant.t.sol` would need that change if the fix lands.

## L-03 (Low): ECDSA signatures stop working once the verifier address gets code

**Code:** `settleWithSig` L253-258 and `reverseWithSig` L266-271, through OZ 5.1 `SignatureChecker.isValidSignatureNow`.
That function uses ECDSA only when `signer.code.length == 0`. Otherwise it relies on ERC-1271 alone.

**Issue:** suppose a verifier EOA later delegates through EIP-7702 to an implementation without `isValidSignature`, or
one that does not accept raw ECDSA over the digest. From then on its ECDSA verdicts revert with `BadSig`. If the
verifier relies on relayers (as `settleWithSig` invites), its REJECT never lands, and once the review deadline passes
anyone can call `payOnTimeout`, so the worker is paid for rejected work. The same applies to a counterfactual smart
wallet that is deployed mid-bounty. The address is fixed at `post` and the contract is immutable, so this cannot be
fixed later. The verifier can still call `settle()` directly, which caps the impact at Low.

The same logic gates `claimAuthorizer` in `claim()`. There, a valid authorization would be refused.

**Fix (accept either an ECDSA signature by the address's key or ERC-1271):**
```diff
+import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
+    function _validSig(address signer, bytes32 digest, bytes calldata sig) internal view returns (bool) {
+        (address rec, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
+        if (err == ECDSA.RecoverError.NoError && rec == signer) return true;
+        return signer.code.length != 0 && SignatureChecker.isValidERC1271SignatureNow(signer, digest, sig);
+    }
```
Use `_validSig` at the three call sites. Without 7702, a contract address has no private key, so checking ECDSA first
gives a pure contract verifier no new way in. With 7702, a valid signature by the EOA key is exactly what the
verifier controls.

---

## Refuted checks (details)

- **Clones and immutables (R-01).** `Clones.clone` deploys a proxy that DELEGATECALLs the impl. Immutables live in the
  impl's runtime code, so every clone reads `core = MADBountyCore` (the impl was deployed in the core's constructor,
  so `msg.sender` is the core) and `token = USDC`. `send` on a clone or on the impl reverts `"core"` for any other
  caller. The PoC asserts all of this.
- **ERC-1271 reentrancy (R-02).** OZ `isValidERC1271SignatureNow` uses `staticcall`. The re-entrant call fails (the
  `TSTORE` guard and any `SSTORE` are forbidden in a static context), and the outer settle completes with only the
  verifier's own verdict. `settleWithSig`/`reverseWithSig` are also `nonReentrant`.
- **Hook token (R-03).** All fund-moving functions are `nonReentrant`, and state is written before every `send`
  (CEI). A recipient hook that re-enters `withdraw` or `payOnTimeout` hits the guard and gets nothing. In the PoC the
  worker receives exactly P−fee+D once, and the vault ends empty with no `owed` left.
- **Deadlines (R-04, R-05).** Each pair uses `> deadline` for "too late" and `<= deadline` for "too early", so
  `t == deadline` is the last in-window second and `deadline+1` the first timeout second. This holds for
  claim/refundExpired (openUntil), submit/reclaimAbandoned, settle/payOnTimeout, reverse/finalizeReject. extendReview
  is allowed at `t == deadline` and adds `reviewWindow` exactly once. It is blocked after the deadline, so it cannot
  undo an accrued `payOnTimeout`. `extendReview` lacks `nonReentrant` but makes no external call.
- **Casts.** `uint64(block.timestamp) + uint32` cannot overflow before year 2^64. `reward`/`deposit` are `uint96`
  with ≤1e9 values. `openUntil` ≤ now+180d.
- **Fee rounding.** `fee = P*100/10000` floors. The worker gets `P - fee + D`. The sum equals the vault exactly, with
  no dust (fuzzed in invariant 3).
- **A2 re-verified (R-06).** The probe scanned 20k-400k gas in 250-gas steps on every paying entrypoint. It never
  produced a successful tx with a diverted `owed` credit.
- **Cancel vs claim race.** Both require `Open`. Whichever lands first wins, and the other reverts `BadState`.
  Neither ordering loses funds.

## Slither triage (`audit/slither.json`, 32 results; MADBountyCore only)

| Detector | Location | Verdict |
|---|---|---|
| arbitrary-send-erc20 (High) | `_pull` L348 | FP. `from` is always `msg.sender` (`post` L168, `claim` L217). |
| uninitialized-state (High) | `bounties` L110 | FP. It is a mapping, written in `post`. |
| reentrancy-no-eth (Medium) | `_accept` L330 | FP. State is set before the sends, and all callers are `nonReentrant`. |
| unused-return ×3 (Medium) | L240, L288, L294 burn sends | **TRUE → L-02** |
| reentrancy-events (Low) | `_accept` | Info. Events come after the external call. The order is fine under the guard. |
| timestamp ×11 (Low) | all deadline checks | By design. The boundaries are checked in R-04. |
| MADBounty.sol hits (divide-before-multiply, low-level-calls, naming, reentrancy-events, timestamp) | legacy file | Out of scope. |

## Invariant fuzzing (`audit/test/AuditInvariant.t.sol`)

Setup: `CoreHandler` with 5 actors (each can be agent or worker), 2 ECDSA verifiers, up to 20 bounties. The handler
covers: post (random P, D, windows, Burn/Refund), claim, submit, settle / settleWithSig (accept or reject), reverse /
reverseWithSig, payOnTimeout, finalizeReject, reclaimAbandoned, cancel (agent or stranger), refundExpired, extendReview
(agent or verifier), withdraw (actors and treasury), recipient blacklist toggling (worker, agent or treasury, which
exercises `owed`), random warps, and warps to deadline-1, deadline and deadline+1. Actions pick a bounty in the
matching state 3 times in 4. Vaults are never blacklisted here; L-02 covers that.

Invariants:
1. `invariant_vaultMatchesState`: Open → vault == P, Σowed == 0, worker == 0. Claimed/Submitted/Rejected → P+D.
   Terminal → vault == Σ owed for that id.
2. `invariant_conservation`: supply constant and equal to actors + vaults + treasury + BURN + core + impl.
3. `invariant_treasuryFee`: treasury balance + treasury owed == Σ floor(1% · P) over Paid bounties.
4. `invariant_terminalIsFinal`: a terminal state never changes.
5. `invariant_owedOnlyParties`: no `owed` entry for anyone other than that bounty's agent or worker (or treasury).

Config: runs 256, depth 200 (51,200 calls per invariant), fail-on-revert off.
Successful state-changing calls summed over all runs of the last invariant (cumulative COV line): post 8255, claim
2615, submit 1234, settle 341, settleSig 345, reverse 82, reverseSig 86, payOnTimeout 398, finalizeReject 135,
reclaimAbandoned 1042, cancel 3554, refundExpired 1627, extendReview 429, withdraw 127. 6166 bounties ended terminal.

Forge output tail:
```
[PASS] invariant_conservation() (runs: 256, calls: 51200, reverts: 0)
[PASS] invariant_owedOnlyParties() (runs: 256, calls: 51200, reverts: 0)
[PASS] invariant_terminalIsFinal() (runs: 256, calls: 51200, reverts: 0)
[PASS] invariant_treasuryFee() (runs: 256, calls: 51200, reverts: 0)
[PASS] invariant_vaultMatchesState() (runs: 256, calls: 51200, reverts: 0)
Suite result: ok. 5 passed; 0 failed; 0 skipped; finished in 121.88s (341.83s CPU time)
Ran 2 test suites in 121.89s (193.66s CPU time): 20 tests passed, 0 failed, 0 skipped (20 total tests)
  reclaimAbandoned burn skippable at gas (0 = never): 0
  finalizeReject burn skippable at gas (0 = never): 0
```

## Files

- `audit/test/AuditBase.sol`: `AuditUSDC` (blacklist + pause), `HookToken`, signing helpers.
- `audit/test/AuditFindings.t.sol`: PoCs for L-01..L-03 and the refuted checks (15 tests).
- `audit/test/AuditInvariant.t.sol`: handler and 5 invariants.
- `audit/slither.json`: raw Slither output.
