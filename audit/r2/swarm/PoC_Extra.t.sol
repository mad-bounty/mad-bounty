// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./PoC_Findings.t.sol";

// ===================================================================================================
// CORE: verdict-signature replay across the SAME bounty via {Claimed -> submit -> Submitted} with the
// SAME evidenceHash. settleWithSig signs (id, worker, evidenceHash, accept). After a reject + reverse
// the verifier signature is still valid because the evidenceHash is unchanged and the state is
// Submitted again. This is by design (a verdict is a function of the data), but it means one REJECT
// signature can only be *used* once per Submitted epoch because core moves state. Verify that the
// signature is NOT replayable while the state is not Submitted (so no double payout).
// ===================================================================================================
contract PoC_VerdictReplay is Base {
    uint256 key = 0xFEED;
    address verifier;

    function setUp() public override {
        super.setUp();
        verifier = vm.addr(key);
    }

    function test_verdictSig_consumedOnceByStateMachine() public {
        uint256 id = _post(verifier, 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        _claimSubmit(id, worker);
        bytes memory acc = _vSig(key, id, worker, ev, true);
        core.settleWithSig(id, true, acc);
        assertEq(uint8(_state(id)), uint8(MADBountyCore.State.Paid));
        // replay after Paid -> BadState, not a second payout
        vm.expectRevert(MADBountyCore.BadState.selector);
        core.settleWithSig(id, true, acc);
    }

    /// extendReview grief: the verifier can add a review window so that payOnTimeout runs one window
    /// later. The worker's "silence pays" guarantee is delayed by up to MAX_REVIEW (30 days).
    function test_extendReview_delaysPayOnTimeout() public {
        uint256 id = _post(verifier, 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        _claimSubmit(id, worker);
        (, , , , , , , , uint32 rw, , uint64 dl0, , , , ) = core.bounties(id);
        vm.prank(verifier);
        core.extendReview(id);
        (, , , , , , , , , , uint64 dl1, , , , ) = core.bounties(id);
        assertEq(dl0, 86401); assertEq(dl1, dl0 + rw, "extend adds one reviewWindow");
        // past original deadline, but not the extended one
        vm.warp(dl0 + 1);
        vm.expectRevert(MADBountyCore.TooEarly.selector);
        core.payOnTimeout(id);
    }
}

// ===================================================================================================
// CORE: post() has no upper bound on reward relative to the vault's lifetime; every bounty is capped
// at MAX_REWARD by design, so no single-bounty cap bypass is possible. The only cap bypass is via
// multiple bounties (by design, ids increment). Verify MAX_REWARD bound is exact (inclusive).
// ===================================================================================================
contract PoC_RewardBound is Base {
    function test_rewardBound_exact() public {
        // 1_000e6 accepted
        vm.prank(agent);
        core.post(_params(address(0x1111), 1_000e6, 1_000e6, MADBountyCore.RejectMode.Burn));
        // 1e6 + 1 rejected
        vm.prank(agent);
        vm.expectRevert(MADBountyCore.BadParam.selector);
        core.post(_params(address(0x1111), 1_000e6 + 1, 1_000e6, MADBountyCore.RejectMode.Burn));
    }
}

// ===================================================================================================
// CORE: treasury == address(this)/core? treasury is arbitrary and only receives 1%. Not exploitable.
// ===================================================================================================
