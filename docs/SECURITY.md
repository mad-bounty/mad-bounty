# MAD Bounty v1: security and threat model

Scope: `src/MADBountyCore.sol` (`MADBountyCore` + `BountyVault`). Status: **live on Base mainnet (`0xa2Be52807034990a4aa88a591D0fdb9E5E3Ef850`) and Base Sepolia testnet** (3 review rounds + fuzzing + live testnet sweep; see `audit/`). Periphery verifier adapters (`periphery/`) are out of scope here; see `periphery/README.md`.
Attack proofs: `test/Attacks.t.sol` (A1–A6) and `test/ForkCore.t.sol` (A2 against real Base USDC). Catalog source: ATTACKS.md / GAME-THEORY.md in the design notes.

## 1. Design properties
- Immutable: no owner, no proxy, no pause, no admin functions. `usdc`, `treasury`, `vaultImpl`, `manualHash` are immutable; `manualURI` is set once in the constructor.
- Per-bounty vaults (OZ `Clones` minimal proxies of `BountyVault`). Only the core can call `send`. A freeze touches one bounty.
- `send` returns false instead of reverting. Failed pushes are credited to `owed[id][to]` and withdrawn with `withdraw(id)`, so a blacklisted worker, agent or treasury can't stall settlement.
- Pulls check the balance difference (`_pull`), which catches fee-on-transfer or short transfers if USDC ever changes.
- `ReentrancyGuardTransient` on every function that moves funds.
- EIP-712 domain `MADBounty`/`1` with chainId + verifyingContract. Verdicts are bound to id, worker and evidenceHash. Signature checks use OZ `SignatureChecker` (ECDSA without malleability, plus ERC-1271).
- Money-neutral agent: no agent bond. In Burn mode a reject costs the agent P, the same as accepting, so it never profits from rejecting. Fakes are deterred by the worker deposit and a pre-committed verifier, not by the agent's discretion.

## 2. Proven attacks (on the code)
| # | Attack | Status |
|---|---|---|
| A1 | Zero-deposit claim lock: claim, abandon, re-claim to DoS a bounty | **Mitigated.** Deposit floor `max(MIN_DEPOSIT=1e6, MIN_DEPOSIT_BPS=2%)` and `MIN_REWARD`. Each lock burns ≥ $1 of the griefer's money. Test `test_A1_claimLock_nowCostsGriefer` |
| A2 | Gas grief: starve the inner USDC transfer so the payout diverts to `owed` | **Fails** (EIP-150 63/64 rule), on mock and on real Base USDC at 30k–400k gas. Test `test_A2_gasGriefPayOnTimeout`, fork `test_A2_realUSDC_gasGrief` |
| A3 | Permissive ERC-1271 verifier: worker self-accepts a fake | **Works, by design.** Choosing the verifier is the agent's responsibility. Interfaces should list audited verifiers only. Test `test_A3_permissiveVerifier_raceToSettle` |
| A4 | Any ACCEPT signature overrides a REJECT during cooling (verdict grinding) | **Mitigated.** Reversal needs a distinct `Reverse(id,worker,evidenceHash)` intent; Verdict sigs are only valid while Submitted. Test `test_A4_acceptSigCannotFlipReject` |
| A5 | Agent (as verifier) spite-rejects honest work | **Inherent.** Costs the agent P in Burn mode, no gain. The worker loses D and effort. Mitigations: public reject stats, committed verifiers. Test `test_A5_spiteCostsAgentP` |
| A6 | Refund mode + agent-controlled verifier: agent rejects, keeps the work and recovers P | **Works, by design.** The contract can't verify verifier independence. Workers MUST NOT claim Refund bounties whose verifier is the agent or unknown; interfaces must flag them. Test `test_A6_refundModeSelfVerifier_agentKeepsReward` |

## 3. Reasoned risks (not profitable, or outside contract scope)
- B1 Competitor griefing: a fake worker makes the agent's verifier reject, and the agent loses P (Burn). Damage ratio P:D. Mitigations: higher D, `claimAuthorizer`, Refund mode with an independent verifier.
- B3 / T13 Sequencer censorship or outage: Base forced inclusion via L1 takes up to ~12h. `MIN_REVIEW = 12h`, `COOLING = 24h`. Verifiers must settle early, and workers must submit early (B4: a late submit risks the work deadline).
- B6 Circle blacklists the core: real USDC `transferFrom` checks `msg.sender`, so `post` and `claim` stop. Existing vaults still settle. Recovery = redeploy.
- T7 Circle freezes a vault: that bounty's funds are locked. Others are unaffected.
- B8 Evidence plagiarism: off-chain. Bind the manifest to core, id and worker (convention in llms-full.txt §8).
- B9 / T11 Verifier or agent key compromise: every bounty naming that verifier can be accepted for colluders, up to $1,000 each. No rotation. Use adapters with their own key management (MultiVerifier, FallbackVerifier) and separate funding and verifier keys.
- B10 Max approval on the agent wallet: approve exact amounts.
- B11 / T14 Wash volume for fake stats: costs the fee (≤ 5%) per loop. Score reputation off-chain by distinct counterparties.
- B13 Dust: `reward < 100` base units pays fee 0. Unreachable in practice (`MIN_REWARD = 1e6`).
- B14 Treasury key loss: fees go to an unreachable address forever. The treasury should be a multisig.
- T3 Adaptive fakers against a deterministic public judge: hide the rubric (commit a hash, encrypt it to the enclave), issue a nonce after claim, run random audits.
- T4 Prompt injection in evidence: fence evidence as untrusted. Two model families must agree; disagreement → reject/escalate.
- T5 Verifier outage + "silence pays": fakers target dead-verifier bounties. Use `extendReview` (once) and FallbackVerifier.
- T15 Immutable bug: permanent. Mitigations: small core, fuzz/invariant tests, $1,000 cap, audits. v2 = a new deployment (escrows are short-lived; no migration).
- T17 Harmful bounties: moderation at the interface/indexer layer; vault isolation limits the blast radius.
- B15 Checked, no issue: clone/impl separation, signature malleability, cross-chain replay, timestamp drift.

## 4. Trust assumptions
| Component | You trust it to | If it fails |
|---|---|---|
| USDC (Circle, upgradeable proxy) | not freeze your vault or address; keep standard transfer semantics | frozen vault = stuck bounty; blacklisted recipient = `owed` until unblocked; frozen core = no new bounties |
| Base sequencer / L1 | include transactions within ~12h (forced inclusion) | deadlines can lapse; the default outcome of the stalled phase applies |
| Verifier | decide honestly, on time, per the spec | it is the judge; the contract checks signatures only |
| claimAuthorizer | sign claims as advertised | can gate who claims; cannot move funds |
| Treasury | — | receives fees; one power: `lowerFee` (strictly decreasing, new bounties only, never raises, never touches escrow) |
| Deployer | nothing after deploy | no privileged functions exist |

Default outcomes when parties disappear: agent gone → bounty proceeds; verifier gone → worker paid by timeout; worker gone → deposit burned, bounty reopens; nobody claims → reward returns to the agent after `openUntil`.

## 5. Invariants (intended)
- A vault's balance always equals what is still owed for its bounty (reward + deposit if claimed, minus settled payouts, plus `owed` credits).
- Terminal states (Paid, Burned, Refunded, Cancelled) are final. No function leaves them, and each bounty pays out at most once.
- Only the verifier, or a signature by it, can produce Paid before the timeout. Only `reverse`/`reverseWithSig` leave Rejected toward Paid.
- Nobody but the core can move vault funds.

## 6. Disclosure
Report vulnerabilities privately to `<SECURITY_CONTACT>` (placeholder: email / PGP key to be published before deploy). Do not open public issues for exploitable bugs. No bounty program yet. Because the contract is immutable, the only response to a critical bug is to warn users and deploy a new version. Funds in existing bounties cannot be rescued by anyone.
