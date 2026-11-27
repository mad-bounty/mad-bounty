# Ethereum Magicians post: dual-deposit, burn-on-reject extension for agent jobs

<!-- Posting notes (not part of the post)
- Venue: https://ethereum-magicians.org/c/ercs/57 . Required before any ethereum/ERCs PR.
- After posting, reply ONCE in the ERC-8183 thread (https://ethereum-magicians.org/t/erc-8183-agentic-commerce/27902)
  with a two-line pointer. Do not cross-post to other ERC threads (gtm/DONT.md).
- Number: none yet. Editors assign it at PR time. Rename the thread to "ERC-NNNN: ..." once assigned.
- Every number below was checked on 2026-11-27 against src/MADBountyCore.sol, deployments/base-mainnet.json,
  Sourcify, and eips.ethereum.org. Re-check the test counts if the repo changes before posting.
-->

**Title:** `[Pre-ERC] Dual-deposit escrow with burn-on-reject for agent jobs (ERC-8183 companion)`

**Category:** ERCs

**Tags:** `agents`, `escrow`, `payments`, `erc`

---

## Abstract

An escrow pattern for paid work where the client cannot profit by rejecting delivered work. The client escrows reward R; the provider (worker) escrows deposit D at claim; a verifier named at creation decides. Accept: worker gets R − fee + D. Reject, after a reversible cooling period: R + D burn (BURN), or R returns to the client and D burns (REFUND, safe only with an independent verifier). Verifier silence pays the worker. A reference implementation is live on Base and is **NOT externally audited**.

Disclosure: I maintain the reference implementation (MAD Bounty). It charges a protocol fee on accepted jobs.

## Motivation

ERC-8183 defines a job with an escrowed budget and an evaluator who completes or rejects it. On Rejected or Expired, the escrow is refunded to the client. The spec allows `evaluator = client`. Its Security Considerations say: "a malicious evaluator can complete or reject arbitrarily. Use reputation (e.g. ERC-8004) or staking for high-value jobs."

When the client is the evaluator (or picks one it can influence) and the deliverable is observable before the verdict, rejecting lets the client keep the work and the budget. Reputation only disciplines identities that are costly to replace; ERC-8004 lists Sybil attacks as possible, and an agent posting from throwaway addresses plays no repeated game. Expiry has the same shape: `claimRefund` refunds the client from Submitted, so evaluator silence favours the client.

Goal: rejecting is never profitable for the payer, with no arbiter.

## Specification sketch

States: `Open → Claimed → Submitted → Paid`, or `Submitted → Rejected → Burned | Refunded`. Also `Cancelled` (from Open).

1. **Post:** client escrows R; fixes verifier, `rejectMode`, work/review windows, `openUntil`; fee rate locked per job.
2. **Claim:** worker escrows `D ≥ minDeposit(R)` (reference: `max(1 USDC, 2% of R)`).
3. **Submit** `evidenceHash` within the work window; otherwise anyone burns D and the job reopens.
4. **Verdict** (verifier, while Submitted). Accept: worker gets `R − fee + D`. Reject: `Rejected` for a cooling period (24h), during which the verifier may undo it with a separate typed `Reverse` intent; then anyone finalizes. BURN sends `R + D` to a burn address; REFUND sends R to the client and burns D.
5. **Silence:** no verdict by the review deadline → anyone triggers payment to the worker.
6. **Expiry:** unclaimed after `openUntil` → anyone returns R to the client.

Interface (reference implementation, abbreviated):

```solidity
interface IDualDepositEscrow {
    enum RejectMode { Burn, Refund }
    struct Params {
        address verifier; address claimAuthorizer; uint96 reward; uint96 deposit;
        uint32 workWindow; uint32 reviewWindow; uint64 openUntil; RejectMode rejectMode;
        bytes32 specHash; bytes encKey; bytes verifierInit;
    }
    function post(Params calldata p) external returns (uint256 id);
    function claim(uint256 id, uint256 authDeadline, bytes calldata authSig) external;
    function submit(uint256 id, bytes32 evidenceHash) external;
    function settle(uint256 id, bool accept) external;                          // verifier
    function settleWithSig(uint256 id, bool accept, bytes calldata sig) external; // EIP-712 / ERC-1271
    function reverse(uint256 id) external;                                      // verifier, during cooling
    function payOnTimeout(uint256 id) external;     // anyone: verifier silent
    function finalizeReject(uint256 id) external;   // anyone: cooling over
    function reclaimAbandoned(uint256 id) external; // anyone: work window missed
    function minDeposit(uint256 reward) external view returns (uint256);
}
// Verdict(uint256 id,address worker,bytes32 evidenceHash,bool accept)
// Reverse(uint256 id,address worker,bytes32 evidenceHash)
```

## Rationale

**Payoffs.** Let V be the work's value to the client and f the fee rate. In the reference, the fee is taken from R on accept only.

| Outcome | Client | Worker |
|---|---|---|
| Accept, or verifier silent | V − R | R(1−f) |
| Reject, BURN | V − R (work already observed) | −D |
| Reject, REFUND | V | −D |

In BURN mode the client's payoff is identical under accept and reject, so a false reject gains it nothing. Spite remains possible (A5) but costs exactly what paying would. In REFUND mode rejecting is better for the client by R, which is why REFUND needs a verifier the client cannot influence.

**Worker deposit.** If junk is caught with probability d, faking has negative expected value when `D/R ≥ (1−d)(1−f)/d` (≈10.6% at d = 0.9, f = 5%). The 2% floor only prices spam claims (A1); clients size D to their verifier.

**Burn, not pay someone.** Any recipient the client can be or bribe restores the incentive to reject. Cost: honest rejects destroy value.

**No client bond.** A bond burned on reject would penalize rejecting genuine junk. The client stays money-neutral; fakes are deterred by D and a verifier committed at post.

**Silence pays the worker.** The worker is the only party that has already performed. The 12h minimum review window covers Base's sequencing window (3,600 L1 blocks ≈ 12h, docs.base.org "Reliability and Liveness"), so a censored verifier can still force-include its verdict via L1.

**Separate Reverse intent.** Otherwise any old Accept signature could override a Reject during cooling (A4).

**Prior art.** Two-party double-deposit "MAD" escrow (BitHalo 2014, BitBay, Particl). The difference here: one-sided worker deposit, a third-party verifier, burn on its verdict.

## Relation to ERC-8183 (open design question)

8183 refunds the client inside the core on `reject`/`claimRefund`, and `claimRefund` is deliberately not hookable, so burn-on-reject and silence-pays-provider cannot be a plain `IACPHook`. Options: (a) a standalone interface as above; (b) an 8183 profile where `client` is a wrapper that burns any refund, plus a hook pulling the provider deposit at `submit` (like 8183's FundTransferHook); expiry still favours the client; (c) a small optional 8183 extension fixing a job's reject destination at creation.

Related drafts: ERC-8412 (preregistered acceptance criteria) fixes what the verifier checks before evidence exists; ERC-8505 (evaluated work records) records settled outcomes as ERC-8004 feedback rebuilt from the escrow's logs.

## Security considerations

Attack catalog with Foundry proofs (`test/Attacks.t.sol`, `docs/SECURITY.md`): **A1** zero-cost claim lock (mitigated: deposit floor); **A2** payout gas-grief (fails: 63/64 rule, tested on real Base USDC); **A3** permissive ERC-1271 verifier self-accepts (by design: verifier choice is the client's); **A4** verdict grinding (mitigated: Reverse typehash); **A5** spite reject (inherent; costs the client R); **A6** REFUND + client-controlled verifier keeps work and R (by design). Failed pushes (e.g. blacklisted recipient) go to a withdrawable `owed` balance, so settlement never stalls. No owner, proxy, pause or upgrade.

**REFUND caveat.** The contract cannot verify independence, and a verifier *address* proves nothing. Our third internal round (audit/r3) stole work through audited adapters purely via the client-written per-job config: own key as signer, unopenable hash commitment, unsatisfiable TEE prompt template, client-falsifiable on-chain check. Workers must evaluate the config. Adapters whose reject path runs an on-chain check need a gas floor, or 63/64 starvation forces a false reject (r3 F-2, fixed).

## Reference implementation

- Repo (MIT): https://github.com/mad-bounty/mad-bounty
- Base mainnet core: `0xa2Be52807034990a4aa88a591D0fdb9E5E3Ef850`, plus five verifier adapters (fallback chain, on-chain check, hash reveal, 0G TeeML, m-of-n). All are Sourcify exact match.
- Parameters: USDC only, $1,000 maximum reward, 5% fee ceiling that the treasury can only lower, rate locked per job.
- **Not externally audited.** Three internal audit rounds, medusa/echidna/Foundry invariant fuzzing, halmos, and a 157/157 live testnet function sweep. Foundry suites: core 40, periphery 83, audit r2 57, audit r3 40, fork 5.

## Questions for reviewers

1. Standalone interface, 8183 profile, or 8183 extension?
2. Burn address or a neutral sink (for example, a public-goods address nobody in the job controls)?
3. Should silence-pays-worker be normative, or a per-job parameter?
4. Should REFUND be in the standard at all, given A6 and r3?
5. Should the deposit floor be normative, or implementation-defined?
