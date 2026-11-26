// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MADBountyCore, IERC20} from "../../src/MADBountyCore.sol";
import {MockUSDC, CoreHelpers} from "../../test/MADBountyCore.t.sol";
import {MADReceipts} from "../src/MADReceipts.sol";
import {MADAttest} from "../src/MADAttest.sol";

contract MADAttestTest is CoreHelpers {
    MockUSDC usdc;
    address treasury = makeAddr("treasury");
    address agent = makeAddr("agent");
    address worker = makeAddr("worker");
    address worker2 = makeAddr("worker2");
    address stranger = makeAddr("stranger");
    address verifier = makeAddr("verifier");
    MADReceipts receipts;
    MADAttest attests;

    function setUp() public {
        usdc = new MockUSDC();
        core = new MADBountyCore(IERC20(address(usdc)), treasury, "ipfs://m", bytes32(0));
        receipts = new MADReceipts(core);
        attests = new MADAttest(core, receipts);
        usdc.mint(agent, 100_000e6); usdc.mint(worker, 100_000e6); usdc.mint(worker2, 100_000e6);
        vm.prank(agent); usdc.approve(address(core), type(uint256).max);
        vm.prank(worker); usdc.approve(address(core), type(uint256).max);
        vm.prank(worker2); usdc.approve(address(core), type(uint256).max);
    }

    function _post(MADBountyCore.RejectMode m) internal returns (uint256) {
        vm.prank(agent);
        return core.post(MADBountyCore.Params({
            verifier: verifier, claimAuthorizer: address(0), reward: 100e6, deposit: 10e6,
            workWindow: 1 days, reviewWindow: 1 days, openUntil: uint64(block.timestamp + 30 days),
            rejectMode: m, specHash: keccak256("s"), encKey: "", verifierInit: ""
        }));
    }

    function _run(uint256 id, bool accept) internal {
        vm.prank(worker); core.claim(id, 0, "");
        vm.prank(worker); core.submit(id, keccak256("ev"));
        vm.prank(verifier); core.settle(id, accept);
        if (!accept) { vm.warp(block.timestamp + 25 hours); core.finalizeReject(id); }
    }

    function test_agentAttests_workerAggregates() public {
        uint256 id = _post(MADBountyCore.RejectMode.Burn);
        _run(id, true);
        vm.prank(agent); attests.attest(id, 2, keccak256("great"));
        (uint64 c, int128 sum, uint64 cc) = attests.stats(worker);
        assertEq(c, 1); assertEq(int256(sum), 2); assertEq(cc, 0);
    }

    function test_workerAttests_agentAggregates() public {
        uint256 id = _post(MADBountyCore.RejectMode.Burn);
        _run(id, true);
        vm.prank(worker); attests.attest(id, -1, bytes32(0));
        (uint64 c, int128 sum, ) = attests.stats(agent);
        assertEq(c, 1); assertEq(int256(sum), -1);
    }

    function test_bothPartiesCanAttest_sameBounty() public {
        uint256 id = _post(MADBountyCore.RejectMode.Burn);
        _run(id, true);
        vm.prank(agent); attests.attest(id, 1, bytes32(0));
        vm.prank(worker); attests.attest(id, -1, bytes32(0));
        (uint64 c, int128 sum, ) = attests.stats(worker);
        assertEq(c, 1); assertEq(int256(sum), 1);
        (uint64 c2, int128 sum2, ) = attests.stats(agent);
        assertEq(c2, 1); assertEq(int256(sum2), -1);
    }

    function test_strangerAndVerifierRejected() public {
        uint256 id = _post(MADBountyCore.RejectMode.Burn);
        _run(id, true);
        vm.prank(stranger); vm.expectRevert(MADAttest.NotParty.selector); attests.attest(id, 1, bytes32(0));
        vm.prank(verifier); vm.expectRevert(MADAttest.NotParty.selector); attests.attest(id, 1, bytes32(0));
    }

    function test_ratingBounds() public {
        uint256 id = _post(MADBountyCore.RejectMode.Burn);
        _run(id, true);
        vm.prank(agent); vm.expectRevert(MADAttest.BadRating.selector); attests.attest(id, 3, bytes32(0));
        vm.prank(agent); vm.expectRevert(MADAttest.BadRating.selector); attests.attest(id, -3, bytes32(0));
        vm.prank(agent); attests.attest(id, -2, bytes32(0)); // boundary ok
    }

    function test_oncePerParty() public {
        uint256 id = _post(MADBountyCore.RejectMode.Burn);
        _run(id, true);
        vm.prank(agent); attests.attest(id, 1, bytes32(0));
        vm.prank(agent); vm.expectRevert(MADAttest.AlreadyAttested.selector); attests.attest(id, 2, bytes32(0));
    }

    function test_cancelledNotAttestable() public {
        uint256 id = _post(MADBountyCore.RejectMode.Burn);
        vm.prank(agent); core.cancel(id);
        receipts.record(id);
        vm.prank(agent); vm.expectRevert(MADAttest.Cancelled.selector); attests.attest(id, 1, bytes32(0));
    }

    function test_openBounty_notAttestable() public {
        uint256 id = _post(MADBountyCore.RejectMode.Burn); // still Open
        vm.prank(agent); vm.expectRevert(MADReceipts.NotTerminal.selector); attests.attest(id, 1, bytes32(0));
    }

    function test_attestRecordsReceiptIfNeeded() public {
        uint256 id = _post(MADBountyCore.RejectMode.Burn);
        _run(id, true);
        assertFalse(receipts.recorded(id));
        vm.prank(agent); attests.attest(id, 1, bytes32(0));
        assertTrue(receipts.recorded(id));
    }

    function test_windowExpiry() public {
        uint256 id = _post(MADBountyCore.RejectMode.Burn);
        _run(id, true);
        receipts.record(id);
        vm.warp(block.timestamp + 30 days + 1);
        vm.prank(agent); vm.expectRevert(MADAttest.TooLate.selector); attests.attest(id, 1, bytes32(0));
    }

    function test_contradictionFlag_agentNegativeOnPaid() public {
        uint256 id = _post(MADBountyCore.RejectMode.Burn);
        _run(id, true); // Paid: the agent's verifier accepted
        vm.prank(agent); attests.attest(id, -2, bytes32(0));
        (uint64 c, int128 sum, uint64 cc) = attests.stats(worker);
        assertEq(c, 1); assertEq(int256(sum), -2); assertEq(cc, 1);

        // worker negative on a Paid bounty is NOT contradicted (the worker may be unhappy about the fee or terms)
        uint256 id2 = _post(MADBountyCore.RejectMode.Burn);
        _run(id2, true);
        vm.prank(worker); attests.attest(id2, -1, bytes32(0));
        (, , uint64 cc2) = attests.stats(agent);
        assertEq(cc2, 0);
    }

    function test_contradictionNotFlaggedOnBurned() public {
        uint256 id = _post(MADBountyCore.RejectMode.Burn);
        _run(id, false); // Burned: the reject was upheld
        vm.prank(agent); attests.attest(id, -2, bytes32(0));
        (, , uint64 cc) = attests.stats(worker);
        assertEq(cc, 0);
    }
}
