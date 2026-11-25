# Audit r3 triage (parent verdicts, 2026-11-26)

Source: `REPORT.md` (fresh-eyes cheat hunt on commit c05c596). PoCs: `R3Cheats.t.sol`. All findings were reproduced
(15/15 PoCs passed before the fixes). Fixed findings keep their PoC as a `*_FIXED_*` test that now proves the cheat fails.

| ID | Sev | Verdict | Fix |
|---|---|---|---|
| F-1 | High | **Confirmed.** The safety gate trusted an adapter's address; the agent writes each bounty's config. | SDK `assessBounty` reads the per-bounty config: Fallback/TeeML signers must be on the worker's `trustedSigners`, a Multi quorum must be trusted, REFUND + OnchainCheck is DANGER, a REFUND adapter with an unread config is DANGER. MCP `madb_check_bounty_safety` passes `adapters` + `trustedSigners` (env `MADB_TRUSTED_SIGNERS`). 5 unit tests. |
| F-1c | High (part of F-1) | **Confirmed, fixed in contract.** | `HashRevealVerifier.rejectUnrevealed(id, opening)`: in REFUND mode the reject must open the commitment. A junk commitment can't be opened, so silence pays the worker. BURN unchanged. PoC → `test_F1c_FIXED_…_paysWorker`. |
| F-1a/b/d/e | High (part of F-1) | **Confirmed; by design at contract level** (the agent chooses signers/targets/templates). | Defended in the SDK/MCP gate and docs (worker reads the config; REFUND + OnchainCheck treated as unsafe; TeeML needs real 0G signers + a tested template). PoCs stay as passing "cheat works on-chain" tests: they document why the off-chain gate is mandatory. |
| F-2 | Medium | **Confirmed, fixed.** | `OnchainCheckVerifier.rejectUnmet`: `if (gasleft() < CHECK_GAS*64/63 + 20_000) revert LowGas();`. Scan 20k-1.1M gas finds no false reject (`test_F2_FIXED_*`). |
| F-3 | Low | **Confirmed; docs.** | Docs + NatSpec: the check must be one nobody can make false after delivery (monotonic). PoC stays as a passing cheat test. |
| I-1 | Info | **Confirmed, fixed.** | TeeML evidence refuses `\u00HH` escapes of printable ASCII (single pass inside the JSON-body scan; non-ASCII/control escapes still allowed). Gas for a 2KB request: 1.06M → 1.23M. `test_I1_FIXED_…`, `test_r3_I1_asciiUnicodeEscape`. |
| I-2 | Info | **Confirmed; docs.** | Docs: HashReveal only for answers with ≥64 bits of entropy; a salt is revealed with the answer and does not help. |

Refuted ideas: see REPORT.md "Refuted" (14 items, 3 with regression tests R-A/R-B/R-C).

Deployment: the three changed adapters were redeployed on Base Sepolia (`script/DeployAdaptersR3.s.sol`, Sourcify
exact_match); old instances are listed under `supersededAdapters` in `deployments/base-sepolia.json`. Core unchanged.
Live check: bounty #26 (REFUND + junk commitment on the new HashReveal) is tracked by `e2e_full.py later`: the reject
without an opening must revert `WrongAnswer`, then `payOnTimeout` must pay the worker.
