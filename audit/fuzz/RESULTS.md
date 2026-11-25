# Results: stateful fuzz + symbolic campaign (2026-11-25)

Target: src/MADBountyCore.sol sha256 369fa2e9...bbb7b. Every per-call check plus 6 global properties.
**No invariant violations found.** No reproducer tests needed.

## Tools run
| Tool | Config | Wall time | Calls | Result |
|---|---|---|---|---|
| medusa 1.5.1 (run 1) | 4 workers, seqLen 150 | 1517 s (25 min) | 363,883 | 6/6 properties pass, 2,880 branches |
| medusa (run 2) | 5 workers, seqLen 400 | 600 s | 141,536 | 6/6 pass |
| echidna 2.4.0 | 3 workers, seqLen 150 | 1249 s (21 min) | 62,700 | 6/6 pass, 21,297 instr |
| forge invariant_all | runs=1000 depth=500 | 2997 s | 500,000 | pass, 0 reverts |
| forge 5 split invariants + fuzz | runs 30x300 and 100x500 | see logs | | pass |
| GasGriefScan | gas 30k..200k step 250, 4 exits | | 2,720 | 0 owed diversions |
| halmos 0.3.x (bitwuzla) | 10 check_* | | | 9 PASS, 1 TIMEOUT (see below) |

Successful core calls in the 1000x500 run (by kind): cancel/expire 3142/3520, claim 2349, submit 1108,
reclaimAbandoned 885, settle(T/F) 211/165, settleWithSig(T/F) 158/145, payOnTimeout 385, reverse 89,
reverseWithSig 80, finalizeReject 110, extendReview 413, withdraw 210, retryBurn 13.

## Invariants (per invariant: no violations)
1. Conservation: global supply fully accounted (actors+treasury+BURN+vaults); each vault == escrow for state + sum owed;
   every successful call conserves value and moves exactly the expected amount to each party (balance + owed delta).
2. One terminal outcome per bounty; terminal states never left; transition table enforced per entry point.
3. Worker gain per bounty <= reward - fee + deposit; treasury gain == reward/100 exactly on Paid, 0 otherwise.
4. Rejected never reaches Paid via payOnTimeout (only reverse/reverseWithSig, or finalizeReject -> Burned/Refunded).
5. Griefer: privileged calls, direct vault.send, replay of every verifier signature on any id: never moves funds
   except to the designated recipients. Owed credited only when the recipient/vault/token is actually blocked.
6. owed withdrawn at most once (withdrawn <= credited; drains only via withdraw by owner or retryBurn for BURN).
7. cancel only by agent, cancel/refundExpired only from Open with worker == 0.
Extra: liveness (payOnTimeout/finalizeReject/refundExpired/reclaimAbandoned never revert once due, with full gas);
other bounties untouched by any call; 63/64 gas griefing can't divert a push into owed.

## Harness self-test (mutants in mut/)
- m1 payOnTimeout also from Rejected -> caught "transition k=9 from=4 to=5".
- m2 worker +1 unit when extended -> caught "value delta".
- m3 withdraw doesn't zero owed for reward <= $500 -> caught "value delta k=14".

## Halmos
PASS: check_feeSum, check_feeFloor, check_feeVsCore, check_minDepositSplit, check_minDeposit (full uint256 <= 1000e6),
check_postDepositFloor (post accepts iff reward in [1e6,1e6*1000] and deposit in [max(1e6, 2%), reward]),
check_acceptFlow, check_rejectFlow (end to end over all valid reward/deposit).
TIMEOUT: check_feeSplitExact (full uint96 range, unbounded), solver timeout at 300 s. Its content is covered by
check_feeSum + check_feeFloor on the reachable range (reward <= MAX_REWARD). Not a counterexample.
Note: default solver yices hangs on these queries; use `--solver bitwuzla` with HALMOS_ALLOW_DOWNLOAD=1.

## Observations (not violations)
- minDeposit floors 2%: for reward not a multiple of 50 above $50, deposit can be < 2% by < 1 unit (1e-6 USDC).

## Post-fix re-run (commit e8f4138, core sha256 a6f1ae67…)
- medusa, 600s, 4 workers: 354,854 calls, 2,946 branches, corpus 164. All 6 properties PASSED
  (conservation, fees, noGasGriefOwed, noViolation, owedParties, vaults). Log: logs/medusa-postfix.log
