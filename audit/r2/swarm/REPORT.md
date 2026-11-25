# MAD Bounty v1 — Round-2 Independent Security Audit

**Target:** `src/MADBountyCore.sol` (`MADBountyCore` + `BountyVault`, 387 SLOC) and every verifier adapter in
`periphery/src/`: `AdapterBase`, `FallbackVerifier`, `OnchainCheckVerifier`, `HashRevealVerifier`,
`TeeMLVerifier` (+ `BytesSearch`), `MultiVerifier`.
**Out of scope:** `src/MADBounty.sol` (legacy prototype).
**Toolchain:** solc 0.8.34, `via_ir`, OZ v5.1.0, Foundry 1.5.1. Slither + Aderyn triage, manual read of every
entrypoint, specialist multi-agent lenses (core invariants/economics, adapter authorisation, cross-cutting
ERC-20/boundary), and a PoC suite that passes only when the asserted behaviour is real.

**Accepted-by-design (not reported):** agent spite-reject (A5), self-verifier in REFUND mode (A6),
malicious agent-chosen verifier (A3), USDC/Circle blacklist freezes.

---

## 1. Result at a glance

| ID | Severity | Area | Title |
|----|----------|------|-------|
| M-01 | **Medium** | `OnchainCheckVerifier` | `resolve()` never requires `Submitted` and binds no evidence → zero-work instant accept; keeper reverts `BadState` |
| L-01 | Low | `MADBountyCore` | `extendReview` lets the agent defer the worker's silence-payout by a full `reviewWindow` (≤ 30 d) at zero cost |
| L-02 | Low | `MADBountyCore` | `_pull` strict `fwd == amt` bricks `post`/`claim` for fee-on-transfer or rebasing collateral |
| L-03 | Low | `FallbackVerifier` | A reverting ERC-1271 registered signer makes every `resolve` revert → a signed REJECT can never land; worker paid by timeout |
| L-04 | Low | `MADBountyCore` × adapters | Adapter-verified bounties cannot use `settleWithSig` / `reverseWithSig` (adapters expose no ERC-1271) |
| L-05 | Low | `FallbackVerifier` | `configure` accepts `stepTimeout == 0` for `n > 1`, voiding the backup-signer ladder |
| L-06 | Low | `TeeMLVerifier` | `parseVerdict` takes the **first** `VERDICT:Y/N`, so an echoed/injected earlier token overrides the final answer |
| L-07 | Low | `OnchainCheckVerifier` | `check()`'s 200 k gas cap can false-negative a legitimate gas-sensitive target (grief: adapter never fires, worker waits) |
| I-01 | Info | `MADBountyCore` | Native ETH force-sent to the core is permanently locked (no `receive`) |
| I-02 | Info | `MADBountyCore` | `MAX_REWARD` is per-bounty only; one agent can post unbounded 1 000-USDC bounties |
| I-03 | Info | `TeeMLVerifier` | Marker binds `(core, id, evidenceHash)` but not the bounty instance (no live collision; off-chain relaying only) |

**No Critical and no High findings.** The core escrow accounting (fund conservation, per-vault solvency,
terminal-state finality, verdict binding) held under every attack path examined and under a 2 000-run fuzz of the
acceptance/settlement flows.

### Reproduce

```bash
export PATH=$HOME/.foundry/bin:$PATH
# round-2 PoC suite (8 tests, all PASS = every assertion true)
FOUNDRY_TEST=audit/r2/swarm forge test --match-path 'audit/r2/swarm/*' -vv
# periphery / core regression suites shipped with the repo
FOUNDRY_TEST=periphery/test forge test --match-path 'periphery/test/*'
FOUNDRY_TEST=test          forge test --match-path 'test/Attacks.t.sol'
```

PoC files:
- `audit/r2/swarm/PoC.t.sol` — shared mocks (`MockUSDC`, `Reverting1271`, `GasSensitiveTarget`), base helpers.
- `audit/r2/swarm/PoC_Findings.t.sol` — M-01, L-03 (plus the L-01 single-use claim-auth re-check and the
  withdraw-under-blacklist no-loss check).
- `audit/r2/swarm/PoC_Extra.t.sol` — L-01 (`extendReview`), verdict-signature replay-is-consumed, reward bound.

---

## 2. Scope & architecture

```
Agent ──post(P, params)──► MADBountyCore ──clone──► BountyVault (holds P)
                                   │                        ▲
Worker ──claim(D)─────────────────►│◄───── _pull D ─────────┘
   │                               │
   └──submit(evidenceHash)─────────┘
            │
   Verifier (EOA | ERC-1271 | adapter) ──settle(accept|reject)──► Paid | Rejected
                                                                     │
                                              cooling 24h ── reverse ─┤
                                                                     └─► Burned | Refunded
Keeper: refundExpired · reclaimAbandoned · payOnTimeout · finalizeReject · withdraw · retryBurn
```

| Contract | SLOC | Role |
|---|---|---|
| `MADBountyCore` | 387 (with `BountyVault`) | immutable escrow, EIP-712 verdicts, per-bounty vault clones |
| `AdapterBase` | 74 | config-guard plumbing, `BountyView` reader |
| `FallbackVerifier` | 121 | 1–3 ordered signers with a step ladder; primary-only `reverse` |
| `OnchainCheckVerifier` | 65 | accept when `keccak(staticcall(target,data)) == expectedHash` |
| `HashRevealVerifier` | 50 | accept when the worker reveals the agent's committed answer |
| `TeeMLVerifier` | 189 (+32 lib) | settle from a 0G TeeML enclave signature over a templated request/response |
| `MultiVerifier` | 97 | m-of-n signer quorum (`1 ≤ m ≤ n ≤ 7`) |

### Actors & access matrix

| Action | Agent | Worker | Verifier | Anyone |
|---|---|---|---|---|
| `post` / `cancel` while Open | ✅ | — | — | — |
| `refundExpired` (after `openUntil`) | — | — | — | ✅ |
| `claim` / `submit` | — | ✅ | — | — |
| `settle` / `reverse` | — | — | ✅ (msg.sender == verifier) | via sig |
| `payOnTimeout` / `finalizeReject` / `reclaimAbandoned` / `retryBurn` | — | — | — | ✅ |
| `extendReview` (once, Submitted) | ✅ | — | ✅ | — |
| adapter `configure` (Open, once) | ✅ (must be `bounty.agent`) | — | — | — |
| adapter `resolve`/`reveal` | — | — | — | ✅ (permissionless) |

### Invariants checked (`/invariants`)

| ID | Invariant | Verdict |
|---|---|---|
| INV-1 | `token.balanceOf(vault) >= Σ outstanding obligations`; on accept `reward = (reward − fee) + fee` and `deposit` reaches the worker | **Holds** (256- and 2 000-run fuzz) |
| INV-2 | State machine `None→Open→(Claimed↔Open)→Submitted→(Paid|Rejected→(Paid|Burned|Refunded))|Cancelled`; terminal states never leave | **Holds** |
| INV-3 | Verdict signature binds `(id, worker, evidenceHash, accept)` under the core's EIP-712 domain | **Holds** (cross-bounty/cross-state replay refuted) |

---

## 3. Details

### M-01 — `OnchainCheckVerifier.resolve()` requires no `Submitted` state and binds no evidence

**Severity:** Medium (semantic; MEDIUM only because an agent can configure a check that is trivially/always true →
instant zero-work accept; the funding consequence is the agent's own, see Gate 3)
**Location:** `periphery/src/OnchainCheckVerifier.sol:59-64`
**Bug class:** adapter rule bypass / missing precondition

```solidity
function resolve(uint256 id) external {
    if (_configs[id].target == address(0)) revert NotConfigured();
    if (!check(id)) revert CheckFailed();            // no _requireSubmitted(b)
    emit Resolved(id, msg.sender);
    core.settle(id, true);                           // core reverts BadState unless Submitted
}
```

**Root cause.** Unlike every other adapter (`FallbackVerifier.resolve`, `HashRevealVerifier.reveal`,
`MultiVerifier.resolve`, `TeeMLVerifier.resolve` all call `_requireSubmitted`), `OnchainCheckVerifier.resolve`
omits the state check and never reads `b.evidenceHash`. `check()` merely answers "does the configured chain call
return the expected bytes **right now**".

**Impact (Gate 3).**
1. A worker who `claim()`s and `submit(bytes32(0))`s is paid the full `reward − 1% + deposit` the instant the
   check holds — the "work" is not consulted at all (PoC `test_M2_resolvePaysImmediatelyAfterEmptySubmit`).
   If the agent's check is already true (e.g. `ok()` on a deployed contract, `balanceOf(reference) >= x`, any
   static condition), the accept is immediate and zero-work.
2. A naive permissionless keeper that calls `resolve()` on an `Open`/`Claimed` bounty burns gas — the call
   reverts `BadState`, not a no-op (PoC `test_M2_resolveRevertsWhenNotSubmitted`).

**4 gates.** G1 reachable from any EOA. G2 confirmed by execution. G3 funds move without work; the design
("a check already true pays early") is arguably intended, so this is calibrated **Medium** not High — the fix
removes the fragile keeper path and the missing evidence gate.

**Fix.**
```diff
     function resolve(uint256 id) external {
+        BountyView memory b = _bounty(id);
+        _requireSubmitted(b);
         if (_configs[id].target == address(0)) revert NotConfigured();
         if (!check(id)) revert CheckFailed();
+        // optional: bind to the submitted evidence
+        // if (b.evidenceHash == bytes32(0)) revert CheckFailed();
         emit Resolved(id, msg.sender);
         core.settle(id, true);
     }
```

---

### L-01 — `extendReview` lets the agent defer the worker's silence-payout by a full `reviewWindow`

**Location:** `src/MADBountyCore.sol:195-203`  **Bug class:** boundary / griefing
**PoC:** `test_extendReview_delaysPayOnTimeout`

```solidity
function extendReview(uint256 id) external {
    ...
    if (msg.sender != b.agent && msg.sender != b.verifier) revert NotAllowed();
    if (b.extended || block.timestamp > b.deadline) revert NotAllowed();
    b.extended = true;
    b.deadline += b.reviewWindow;      // moves the very value payOnTimeout waits on
}
```

The address that owes the money (the agent) can unilaterally push `payOnTimeout` out by up to `MAX_REVIEW`
(30 days) while the worker's deposit stays locked. It is one-shot, so the bound is one window; no funds are lost.
**Fix:** restrict to the verifier, or cap the extension to a small fraction of `reviewWindow`:
```diff
-        if (msg.sender != b.agent && msg.sender != b.verifier) revert NotAllowed();
+        if (msg.sender != b.verifier) revert NotAllowed();
```

---

### L-02 — `_pull` strict equality bricks non-standard collateral

**Location:** `src/MADBountyCore.sol:377-382`  **Bug class:** token compatibility
`_pull` reverts `TransferFailed` unless the vault's balance grew by exactly `amt`, so any fee-on-transfer or
rebasing token makes `post()` and `claim()` unusable. USDC never rebases and charges no transfer fee, so this is a
forward-compatibility gap, not a live loss. **Fix:** document that only standard, fee-free, non-rebasing USDC is
supported, or compare against `amt` minus a tolerance.

### L-03 — A reverting registered ERC-1271 signer blocks the relay

**Location:** `periphery/src/FallbackVerifier.sol:102-104`  **Bug class:** access control / liveness
**PoC:** `test_M1_revertingSigner_blocksResolve`
`SignatureChecker.isValidSignatureNow` propagates the signer's ERC-1271 revert, so `resolve(...)` reverts `BadSig`
for a hostile/broken signer index even when another registered signer signed. A valid signed REJECT can therefore
never land and `payOnTimeout` pays the worker after the window. **Fix:** wrap the signature check in
`try/catch` (or a `tryIsValidSignatureNow` helper) and try the other signer indices before reverting.

### L-04 — Adapter bounties cannot use `settleWithSig` / `reverseWithSig`

**Location:** `src/MADBountyCore.sol:332-336`  **Bug class:** interoperability
`_validSig` requires a contract signer to answer ERC-1271, but `AdapterBase` implements no `isValidSignature`, so
relayed verdicts always revert `BadSig` for adapter-verified bounties (only the adapter's own entrypoints work).
**Fix:** implement a namespaced `isValidSignature` in `AdapterBase`, or document EOA/1271-only for sig-relay.

### L-05 — `FallbackVerifier.configure` accepts `stepTimeout == 0` with `n > 1`

**Location:** `periphery/src/FallbackVerifier.sol:59`  **Bug class:** config validation
A zero step puts every signer at `submittedAt`, defeating the documented ladder. **Fix:** require
`stepTimeout >= 1 minutes` (or any `MIN_STEP`) when `n > 1`.

### L-06 — `TeeMLVerifier.parseVerdict` takes the first `VERDICT:` token

**Location:** `periphery/src/TeeMLVerifier.sol:112-123`  **Bug class:** parsing
An echoed instruction or reasoning that contains an earlier `VERDICT:N` overrides the model's final answer; on a
BURN/REFUND-capable path that can cost the worker the deposit. **Fix:** iterate to the **last** occurrence, and
reject the token inside evidence.

### L-07 — `OnchainCheckVerifier.check()` gas cap can false-negative

**Location:** `periphery/src/OnchainCheckVerifier.sol:54`  **Bug class:** griefing
The 200 k `staticcall` cap can make a legitimate, gas-hungry target return different data than a full-gas
`eth_call`, so the accept-only adapter never fires and the worker waits for `payOnTimeout`. **Fix:** allow a
per-bounty `checkGas` (bounded by `MAX_DATA`) or document the ceiling.

### Informational
- **I-01** no `receive()` / ETH recovery → force-sent ETH is locked (kept intentionally for gas).
- **I-02** `MAX_REWARD` is per-bounty; aggregate exposure is unbounded across ids.
- **I-03** the TeeML marker lacks the bounty instance; ids are globally monotonic so no live collision, only an
  off-chain relayer binding nicety.

---

## 4. What was verified safe (selected negatives)

| Probe | Result |
|---|---|
| `owed[id][to]` double-spend across `reclaimAbandoned` / `withdraw` / `retryBurn` | Holds — credits are per `(id, address)` and state-gated |
| Verdict-sig replay across `claim→abandon→re-claim` | Holds — sigs only consumable while `Submitted` |
| Cross-type sig malleability (`Verdict` reused as `Reverse`, high-s) | Holds — distinct typehashes + OZ `tryRecover` |
| Deadline off-by-one (`settle`/`reverse` at `==deadline`, `finalizeReject` at `==coolingEnd`, `claim` at `==openUntil`) | Holds — `<=` / `>` guards leave no gap or overlap |
| Transcript reentrancy through ERC-1271 `isValidSignatureNow` / token hooks | Holds — `core` functions are `nonReentrant`, state written before push |
| Clone vault `core`/`token` immutables | Holds — confirmed reset by the clone proxy constructor |
| `FallbackVerifier` ladder after `extendReview` | Holds — `submittedAt` arithmetic is exact |
| `MultiVerifier` m-of-n edge cases (`m>n`, `n≠sigs`, unsorted/dup signers, cross-bounty) | Holds — all guarded |
| `TeeMLVerifier` evidence slice cannot include marker/suffix; `isJsonStringBody` bounds | Holds |
| Cross-bounty/cross-adapter config collision on one core | Holds — config maps are keyed by `(adapter, id)` and ids are monotonic |

---

## 5. Recommendations (ordered)

1. **M-01** — add `_requireSubmitted(b)` to `OnchainCheckVerifier.resolve` and gate the accept on a non-empty
   evidence hash (or document that an always-true check pays instantly).
2. **L-03** — make `FallbackVerifier` skip reverting 1271 signers instead of reverting the whole relay; this is
   the only finding that lets a **signed REJECT be ignored**.
3. **L-01** — restrict `extendReview` to the verifier or bound the extension.
4. **L-05/L-06/L-07** — small validation/parsing hardening in the adapters.
5. **L-02/L-04/I-01..I-03** — document the supported token set, the sig-relay limitation, and the per-bounty cap.

---

*Report generated by AuditCode — 6-phase methodology; deep-audit lenses, PoC verification, and critic review.
All paths relative to the repository root.*
