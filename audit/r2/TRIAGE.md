# Round-2 auditcode swarm: parent triage (2026-11-25)

Swarm report: `audit/r2/swarm/REPORT.md`. PoCs: `audit/r2/swarm/*.t.sol` and `extra/`. All 51 pass, run with
`FOUNDRY_TEST=audit/r2/swarm forge test`.

Housekeeping: the swarm wrote 4 test files outside its sandbox (`periphery/test/EconAuditPoC.t.sol`,
`audit/test/ManualLens.t.sol`, `audit/r3/test/AdapterPoC{,2}.t.sol`). They were moved to `audit/r2/swarm/extra/`
and their imports re-pointed.

| Swarm ID | Parent verdict | Action |
|---|---|---|
| M-01 OnchainCheck resolve lacks Submitted check | Downgraded to Low. Core already reverts BadState, so no funds move early. "Instant accept when the check is already true" is the adapter's documented rule. | Add `_requireSubmitted` for a clean revert. Document that the check must be something only the work makes true. |
| L-01 agent can extendReview (delays worker ≤1 review window) | Accepted by design. Adapters cannot call extendReview, so the agent is the only party who can extend on adapter bounties (verifier-outage protection). One-shot and bounded. | Document. |
| L-02 fee-on-transfer token breaks _pull | Accepted. The core is USDC-only, and the check is intentional (catches short transfers). | Document. |
| L-03 reverting ERC-1271 signer blocks FallbackVerifier | **Refuted as stated.** The PoC relays the good signature at the bad signer's index. At index 0 it lands. OZ isValidERC1271SignatureNow uses staticcall → returns false, no revert. **Real related issue:** adapters use OZ `isValidSignatureNow`, which has the same EIP-7702 gap as core L-03. | Port core `_validSig` (ECDSA-then-1271) into Fallback + Multi. |
| L-04 adapters lack ERC-1271 so settleWithSig unusable | By design: adapters call `core.settle` directly. | Document. |
| L-05 stepTimeout 0 with n>1 | **Refuted.** `configure` already reverts `stepTimeout == 0` when n > 1. | none |
| L-06 TeeML parses FIRST VERDICT token | Valid Low. The worker controls the evidence the model may echo. | Parse the LAST token. Reject evidence containing `VERDICT`. |
| L-07 OnchainCheck 200k gas cap false-negative | Valid Low. | Raise CHECK_GAS (no interface change). |
| I-01..I-03 | Info | Document. |

Adapter fixes are held until the dedicated periphery-audit subagent finishes, so it doesn't audit a moving target.
