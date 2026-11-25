// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MADBountyCore, BountyVault, IERC20} from "../src/MADBountyCore.sol";

/// Minimal USDC-like token with a blacklist (reverts on transfer to/from blacklisted, like Circle's FiatToken).
contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blacklisted;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function blacklist(address a) external { blacklisted[a] = true; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { _move(msg.sender, to, a); return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a; _move(f, to, a); return true;
    }
    function _move(address f, address to, uint256 a) internal {
        require(!blacklisted[f] && !blacklisted[to] && !blacklisted[msg.sender], "Blacklistable: account is blacklisted");
        balanceOf[f] -= a; balanceOf[to] += a;
    }
}

/// Shared helpers for tests that use the v1 core.
abstract contract CoreHelpers is Test {
    MADBountyCore core;

    function _params(address verifier, uint96 p, uint96 d, MADBountyCore.RejectMode m)
        internal view returns (MADBountyCore.Params memory)
    {
        return MADBountyCore.Params({
            verifier: verifier, claimAuthorizer: address(0), reward: p, deposit: d,
            workWindow: 1 days, reviewWindow: 1 days, openUntil: uint64(block.timestamp + 30 days),
            rejectMode: m, specHash: keccak256("spec"), encKey: ""
        });
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", core.domainSeparator(), structHash));
    }

    function _verdictSig(uint256 key, uint256 id, address w, bytes32 e, bool accept) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, _digest(keccak256(abi.encode(core.VERDICT_TYPEHASH(), id, w, e, accept))));
        return abi.encodePacked(r, s, v);
    }

    function _reverseSig(uint256 key, uint256 id, address w, bytes32 e) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, _digest(keccak256(abi.encode(core.REVERSE_TYPEHASH(), id, w, e))));
        return abi.encodePacked(r, s, v);
    }

    function _vault(uint256 id) internal view returns (address) {
        (, , , , BountyVault v, , , , , , , , , ,) = core.bounties(id);
        return address(v);
    }
}

contract MADBountyCoreTest is CoreHelpers {
    MockUSDC usdc;
    address treasury = makeAddr("treasury");
    address agent = makeAddr("agent");
    address worker = makeAddr("worker");
    address BURN = 0x000000000000000000000000000000000000dEaD;
    uint256 vk = 0xA11CE;
    address verifier;
    bytes32 ev = keccak256("evidence");

    function setUp() public {
        usdc = new MockUSDC();
        core = new MADBountyCore(IERC20(address(usdc)), treasury, "ipfs://manual", bytes32(0));
        verifier = vm.addr(vk);
        usdc.mint(agent, 100_000e6); usdc.mint(worker, 100_000e6);
        vm.prank(agent); usdc.approve(address(core), type(uint256).max);
        vm.prank(worker); usdc.approve(address(core), type(uint256).max);
    }

    function _post(uint96 p, uint96 d) internal returns (uint256) {
        return _postMode(p, d, MADBountyCore.RejectMode.Burn);
    }

    function _postMode(uint96 p, uint96 d, MADBountyCore.RejectMode m) internal returns (uint256 id) {
        vm.prank(agent);
        id = core.post(_params(verifier, p, d, m));
    }

    function _claimSubmit(uint256 id) internal {
        vm.prank(worker); core.claim(id, 0, "");
        vm.prank(worker); core.submit(id, ev);
    }

    // ---- happy paths

    function test_accept_paysWorker_1pctFee() public {
        uint256 id = _post(100e6, 25e6); _claimSubmit(id);
        core.settleWithSig(id, true, _verdictSig(vk, id, worker, ev, true));
        assertEq(usdc.balanceOf(worker), 100_000e6 + 99e6);
        assertEq(usdc.balanceOf(treasury), 1e6);
        assertEq(usdc.balanceOf(agent), 100_000e6 - 100e6);
    }

    function test_rejectBurnMode_burnsRewardAndDeposit() public {
        uint256 id = _post(100e6, 25e6); _claimSubmit(id);
        vm.prank(verifier); core.settle(id, false);
        vm.expectRevert(MADBountyCore.TooEarly.selector); core.finalizeReject(id);
        vm.warp(block.timestamp + 24 hours + 1);
        core.finalizeReject(id);
        assertEq(usdc.balanceOf(BURN), 125e6);
        assertEq(usdc.balanceOf(agent), 100_000e6 - 100e6);
        assertEq(usdc.balanceOf(treasury), 0);
    }

    function test_rejectRefundMode_refundsAgent_burnsDeposit() public {
        uint256 id = _postMode(100e6, 25e6, MADBountyCore.RejectMode.Refund); _claimSubmit(id);
        vm.prank(verifier); core.settle(id, false);
        vm.warp(block.timestamp + 24 hours + 1);
        core.finalizeReject(id);
        assertEq(usdc.balanceOf(agent), 100_000e6);
        assertEq(usdc.balanceOf(worker), 100_000e6 - 25e6);
        assertEq(usdc.balanceOf(BURN), 25e6);
        assertEq(usdc.balanceOf(treasury), 0);
    }

    function test_reverseInCooling_needsReverseIntent() public {
        uint256 id = _post(100e6, 25e6); _claimSubmit(id);
        core.settleWithSig(id, false, _verdictSig(vk, id, worker, ev, false));
        // a plain ACCEPT verdict can no longer flip a REJECT (A4)
        bytes memory acc = _verdictSig(vk, id, worker, ev, true);
        vm.expectRevert(MADBountyCore.BadState.selector); core.settleWithSig(id, true, acc);
        core.reverseWithSig(id, _reverseSig(vk, id, worker, ev));
        assertEq(usdc.balanceOf(worker), 100_000e6 + 99e6);
    }

    function test_reverseDirect_onlyVerifier() public {
        uint256 id = _post(100e6, 25e6); _claimSubmit(id);
        vm.prank(verifier); core.settle(id, false);
        vm.prank(agent); vm.expectRevert(MADBountyCore.NotAllowed.selector); core.reverse(id);
        vm.prank(verifier); core.reverse(id);
        assertEq(usdc.balanceOf(worker), 100_000e6 + 99e6);
    }

    function test_noReverseAfterCooling() public {
        uint256 id = _post(100e6, 25e6); _claimSubmit(id);
        vm.prank(verifier); core.settle(id, false);
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(verifier); vm.expectRevert(MADBountyCore.TooLate.selector); core.reverse(id);
    }

    function test_silencePaysWorker() public {
        uint256 id = _post(100e6, 25e6); _claimSubmit(id);
        vm.warp(block.timestamp + 1 days + 1);
        core.payOnTimeout(id);
        assertEq(usdc.balanceOf(worker), 100_000e6 + 99e6);
    }

    function test_lateVerdictRejected_afterReview() public {
        uint256 id = _post(100e6, 25e6); _claimSubmit(id);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(verifier); vm.expectRevert(MADBountyCore.TooLate.selector); core.settle(id, false);
    }

    function test_extendReviewOnce() public {
        uint256 t0 = block.timestamp;
        uint256 id = _post(100e6, 25e6); _claimSubmit(id);
        vm.prank(agent); core.extendReview(id);
        vm.prank(agent); vm.expectRevert(MADBountyCore.NotAllowed.selector); core.extendReview(id);
        vm.warp(t0 + 1 days + 1);
        vm.expectRevert(MADBountyCore.TooEarly.selector); core.payOnTimeout(id);
        vm.warp(t0 + 2 days + 1);
        core.payOnTimeout(id);
    }

    function test_abandon_burnsDeposit_reopens_thenCancel() public {
        uint256 id = _post(100e6, 25e6);
        vm.prank(worker); core.claim(id, 0, "");
        vm.warp(block.timestamp + 1 days + 1);
        core.reclaimAbandoned(id);
        assertEq(usdc.balanceOf(BURN), 25e6);
        vm.prank(agent); core.cancel(id);
        assertEq(usdc.balanceOf(agent), 100_000e6);
    }

    function test_cancelOnlyWhenOpen() public {
        uint256 id = _post(100e6, 25e6);
        vm.prank(worker); core.claim(id, 0, "");
        vm.prank(agent); vm.expectRevert(MADBountyCore.BadState.selector); core.cancel(id);
    }

    function test_refundExpired_unclaimed() public {
        uint256 id = _post(100e6, 25e6);
        vm.expectRevert(MADBountyCore.TooEarly.selector); core.refundExpired(id);
        vm.warp(block.timestamp + 30 days + 1);
        vm.prank(worker); vm.expectRevert(MADBountyCore.TooLate.selector); core.claim(id, 0, "");
        core.refundExpired(id);                                // anyone can trigger
        assertEq(usdc.balanceOf(agent), 100_000e6);
    }

    // ---- guards

    function test_paramBounds() public {
        vm.startPrank(agent);
        MADBountyCore.Params memory p = _params(verifier, 1_000e6 + 1, 100e6, MADBountyCore.RejectMode.Burn);
        vm.expectRevert(MADBountyCore.BadParam.selector); core.post(p);           // over cap
        p = _params(verifier, 0.5e6, 0.5e6, MADBountyCore.RejectMode.Burn);
        vm.expectRevert(MADBountyCore.BadParam.selector); core.post(p);           // under $1 reward
        p = _params(verifier, 10e6, 0, MADBountyCore.RejectMode.Burn);
        vm.expectRevert(MADBountyCore.BadParam.selector); core.post(p);           // zero deposit (A1)
        p = _params(verifier, 500e6, 9e6, MADBountyCore.RejectMode.Burn);
        vm.expectRevert(MADBountyCore.BadParam.selector); core.post(p);           // below 2% floor
        p = _params(verifier, 10e6, 11e6, MADBountyCore.RejectMode.Burn);
        vm.expectRevert(MADBountyCore.BadParam.selector); core.post(p);           // deposit > reward
        p = _params(verifier, 10e6, 1e6, MADBountyCore.RejectMode.Burn); p.workWindow = 30 minutes;
        vm.expectRevert(MADBountyCore.BadParam.selector); core.post(p);
        p = _params(verifier, 10e6, 1e6, MADBountyCore.RejectMode.Burn); p.reviewWindow = 11 hours;
        vm.expectRevert(MADBountyCore.BadParam.selector); core.post(p);           // below 12h review
        p = _params(verifier, 10e6, 1e6, MADBountyCore.RejectMode.Burn); p.openUntil = uint64(block.timestamp + 181 days);
        vm.expectRevert(MADBountyCore.BadParam.selector); core.post(p);
        vm.stopPrank();
        assertEq(core.minDeposit(10e6), 1e6);
        assertEq(core.minDeposit(500e6), 10e6);
    }

    function test_sigBinding_signer_evidence_worker_intent() public {
        uint256 id = _post(100e6, 25e6); _claimSubmit(id);
        bytes memory wrongKey = _verdictSig(0xBAD, id, worker, ev, true);
        bytes memory wrongEv = _verdictSig(vk, id, worker, keccak256("other"), true);
        bytes memory wrongWorker = _verdictSig(vk, id, makeAddr("someoneElse"), ev, true);
        bytes memory wrongIntent = _verdictSig(vk, id, worker, ev, false);
        vm.expectRevert(MADBountyCore.BadSig.selector); core.settleWithSig(id, true, wrongKey);
        vm.expectRevert(MADBountyCore.BadSig.selector); core.settleWithSig(id, true, wrongEv);
        vm.expectRevert(MADBountyCore.BadSig.selector); core.settleWithSig(id, true, wrongWorker);
        vm.expectRevert(MADBountyCore.BadSig.selector); core.settleWithSig(id, true, wrongIntent);
    }

    function test_claimAuthorizer() public {
        uint256 ak = 0xA0;
        MADBountyCore.Params memory p = _params(verifier, 10e6, 1e6, MADBountyCore.RejectMode.Burn);
        p.claimAuthorizer = vm.addr(ak);
        vm.prank(agent); uint256 id = core.post(p);
        vm.prank(worker); vm.expectRevert(MADBountyCore.BadSig.selector); core.claim(id, block.timestamp + 1 hours, hex"00");
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(ak, _digest(keccak256(abi.encode(core.CLAIM_TYPEHASH(), id, worker, block.timestamp + 1 hours))));
        vm.prank(worker); core.claim(id, block.timestamp + 1 hours, abi.encodePacked(r, s, v));
    }

    // ---- tail events

    function test_T6_blacklistedWorker_creditsOwed_notStuck() public {
        uint256 id = _post(100e6, 25e6); _claimSubmit(id);
        usdc.blacklist(worker);
        vm.prank(verifier); core.settle(id, true);
        assertEq(usdc.balanceOf(treasury), 1e6);
        assertEq(core.owed(id, worker), 124e6);
        vm.prank(worker); vm.expectRevert(MADBountyCore.TransferFailed.selector); core.withdraw(id);
    }

    function test_T6_blacklistedTreasury_doesNotBlockWorker() public {
        uint256 id = _post(100e6, 25e6); _claimSubmit(id);
        usdc.blacklist(treasury);
        vm.prank(verifier); core.settle(id, true);
        assertEq(usdc.balanceOf(worker), 100_000e6 + 99e6);
        assertEq(core.owed(id, treasury), 1e6);
    }

    function test_T6_blacklistedAgent_refundModeCreditsOwed() public {
        uint256 id = _postMode(100e6, 25e6, MADBountyCore.RejectMode.Refund); _claimSubmit(id);
        usdc.blacklist(agent);
        vm.prank(verifier); core.settle(id, false);
        vm.warp(block.timestamp + 25 hours);
        core.finalizeReject(id);
        assertEq(core.owed(id, agent), 100e6);
        assertEq(usdc.balanceOf(BURN), 25e6);
    }

    function test_T7_frozenVault_isolatedToOneBounty() public {
        uint256 a = _post(100e6, 25e6); _claimSubmit(a);
        uint256 b = _post(100e6, 25e6); _claimSubmit(b);
        usdc.blacklist(_vault(a));
        vm.prank(verifier); core.settle(a, true);
        vm.prank(verifier); core.settle(b, true);
        assertEq(usdc.balanceOf(worker), 100_000e6 - 50e6 + 124e6);
    }

    // ---- fuzz: conservation. Every unit escrowed ends in exactly one sink.

    function testFuzz_conservation(uint96 p, uint96 d, uint8 path) public {
        p = uint96(bound(p, 1e6, 1_000e6)); d = uint96(bound(d, core.minDeposit(p), p));
        path = path % 4;
        MADBountyCore.RejectMode m = path == 3 ? MADBountyCore.RejectMode.Refund : MADBountyCore.RejectMode.Burn;
        uint256 id = _postMode(p, d, m); _claimSubmit(id);
        if (path == 0) { vm.prank(verifier); core.settle(id, true); }
        else if (path == 1) { vm.warp(block.timestamp + 1 days + 1); core.payOnTimeout(id); }
        else { vm.prank(verifier); core.settle(id, false); vm.warp(block.timestamp + 25 hours); core.finalizeReject(id); }
        uint256 total = usdc.balanceOf(agent) + usdc.balanceOf(worker) + usdc.balanceOf(treasury) + usdc.balanceOf(BURN);
        assertEq(total, 200_000e6);
        assertEq(usdc.balanceOf(_vault(id)), 0);
        if (path < 2) assertEq(usdc.balanceOf(treasury), uint256(p) / 100);
        if (path == 3) assertEq(usdc.balanceOf(BURN), d);
    }
}
