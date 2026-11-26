// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MADBountyCore, IERC20} from "../../src/MADBountyCore.sol";
import {MockUSDC, CoreHelpers} from "../../test/MADBountyCore.t.sol";
import {MADReceipts} from "../src/MADReceipts.sol";

contract MADReceiptsTest is CoreHelpers {
    MockUSDC usdc;
    address treasury = makeAddr("treasury");
    address agent = makeAddr("agent");
    address agent2 = makeAddr("agent2");
    address worker = makeAddr("worker");
    address worker2 = makeAddr("worker2");
    address stranger = makeAddr("stranger");
    address verifier = makeAddr("verifier");
    MADReceipts receipts;

    function setUp() public {
        usdc = new MockUSDC();
        core = new MADBountyCore(IERC20(address(usdc)), treasury, "ipfs://m", bytes32(0));
        receipts = new MADReceipts(core);
        usdc.mint(agent, 100_000e6); usdc.mint(agent2, 100_000e6);
        usdc.mint(worker, 100_000e6); usdc.mint(worker2, 100_000e6);
        vm.prank(agent); usdc.approve(address(core), type(uint256).max);
        vm.prank(agent2); usdc.approve(address(core), type(uint256).max);
        vm.prank(worker); usdc.approve(address(core), type(uint256).max);
        vm.prank(worker2); usdc.approve(address(core), type(uint256).max);
    }

    function _post(address a, address w, uint96 p, uint96 d, MADBountyCore.RejectMode m) internal returns (uint256) {
        vm.prank(a);
        return core.post(MADBountyCore.Params({
            verifier: verifier, claimAuthorizer: address(0), reward: p, deposit: d,
            workWindow: 1 days, reviewWindow: 1 days, openUntil: uint64(block.timestamp + 30 days),
            rejectMode: m, specHash: keccak256("s"), encKey: "", verifierInit: ""
        }));
    }

    function _run(uint256 id, bool accept, MADBountyCore.RejectMode m) internal {
        vm.prank(worker); core.claim(id, 0, "");
        vm.prank(worker); core.submit(id, keccak256("ev"));
        vm.prank(verifier); core.settle(id, accept);
        if (!accept) {
            vm.warp(block.timestamp + 25 hours);
            core.finalizeReject(id);
            if (m == MADBountyCore.RejectMode.Burn) {} // burned
        }
    }

    // ---- guards

    function test_record_revertsOnOpenBounty() public {
        uint256 id = _post(agent, worker, 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        vm.expectRevert(MADReceipts.NotTerminal.selector);
        receipts.record(id);
    }

    function test_record_revertsOnDoubleRecord() public {
        uint256 id = _post(agent, worker, 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        _run(id, true, MADBountyCore.RejectMode.Burn);
        receipts.record(id);
        vm.expectRevert(MADReceipts.AlreadyRecorded.selector);
        receipts.record(id);
    }

    function test_recordMany_skipsInvalid() public {
        uint256 open = _post(agent, worker, 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        uint256 paid = _post(agent, worker, 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        _run(paid, true, MADBountyCore.RejectMode.Burn);
        uint256[] memory ids = new uint256[](3);
        ids[0] = open; ids[1] = paid; ids[2] = 999;
        receipts.recordMany(ids);            // no revert
        assertTrue(receipts.recorded(paid));
        assertFalse(receipts.recorded(open));
        assertFalse(receipts.recorded(999));
        receipts.recordMany(ids);            // idempotent
    }

    // ---- outcome paths

    function test_paidPath_tallies() public {
        uint256 id = _post(agent, worker, 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        _run(id, true, MADBountyCore.RejectMode.Burn);
        vm.prank(stranger); receipts.record(id);   // anyone

        (uint64 posted, uint64 paid, uint64 burned, uint64 refunded, uint64 cancelled, uint64 dW, uint64 sd, , uint64 f, uint64 l) =
            receipts.agentStats(agent);
        assertEq(posted, 1); assertEq(paid, 1); assertEq(burned, 0); assertEq(refunded, 0); assertEq(cancelled, 0);
        assertEq(dW, 1); assertEq(sd, 0); assertEq(f, block.timestamp); assertEq(l, block.timestamp);

        (uint64 wPaid, uint64 wBurned, uint64 wRef, uint64 dA, uint64 wSd, uint128 earned, , ) = receipts.workerStats(worker);
        assertEq(wPaid, 1); assertEq(wBurned, 0); assertEq(wRef, 0); assertEq(dA, 1); assertEq(wSd, 0);
        assertEq(earned, 95e6); // 100 reward - 5% fee

        (uint64 acc, uint64 rej) = receipts.verifierStats(verifier);
        assertEq(acc, 1); assertEq(rej, 0);
    }

    function test_burnPath_tallies() public {
        uint256 id = _post(agent, worker, 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        _run(id, false, MADBountyCore.RejectMode.Burn);
        receipts.record(id);
        (, uint64 paid, uint64 burned, , , , , , , ) = receipts.agentStats(agent);
        (uint64 wPaid, uint64 wBurned, , , , , , ) = receipts.workerStats(worker);
        (uint64 acc, uint64 rej) = receipts.verifierStats(verifier);
        assertEq(paid, 0); assertEq(burned, 1); assertEq(wPaid, 0); assertEq(wBurned, 1);
        assertEq(acc, 0); assertEq(rej, 1);
    }

    function test_refundPath_tallies() public {
        uint256 id = _post(agent, worker, 100e6, 10e6, MADBountyCore.RejectMode.Refund);
        _run(id, false, MADBountyCore.RejectMode.Refund);
        receipts.record(id);
        (, , , uint64 refunded, , , , , , ) = receipts.agentStats(agent);
        (, , uint64 wRef, , , , , ) = receipts.workerStats(worker);
        assertEq(refunded, 1); assertEq(wRef, 1);
    }

    function test_cancelPath_countsAgentOnly() public {
        uint256 id = _post(agent, worker, 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        vm.prank(agent); core.cancel(id);
        receipts.record(id);
        (, , , , uint64 cancelled, , , , , ) = receipts.agentStats(agent);
        (uint64 wPaid, uint64 wBurned, uint64 wRef, , , , , ) = receipts.workerStats(worker);
        assertEq(cancelled, 1);
        assertEq(wPaid + wBurned + wRef, 0);
    }

    // ---- distinct counting and self-deals

    function test_distinctCounterpartyCountedOnce() public {
        uint256 a = _post(agent, worker, 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        uint256 b = _post(agent, worker, 50e6, 5e6, MADBountyCore.RejectMode.Burn);
        uint256 c = _post(agent, worker2, 50e6, 5e6, MADBountyCore.RejectMode.Burn);
        _run(a, true, MADBountyCore.RejectMode.Burn); _run(b, true, MADBountyCore.RejectMode.Burn);
        vm.prank(worker2); core.claim(c, 0, "");
        vm.prank(worker2); core.submit(c, keccak256("ev"));
        vm.prank(verifier); core.settle(c, true);
        { uint256[] memory r = _arr3(a, b, c); receipts.recordMany(r); }
        (, , , , , uint64 dW, , , , ) = receipts.agentStats(agent);
        assertEq(dW, 2); // worker and worker2 once each
        (, , , uint64 dA, , , , ) = receipts.workerStats(worker);
        assertEq(dA, 1);
    }

    function test_selfDealFlagged_notDistinct() public {
        usdc.mint(agent, 10e6);
        uint256 id = _post(agent, agent, 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        vm.prank(agent); core.claim(id, 0, "");
        vm.prank(agent); core.submit(id, keccak256("ev"));
        vm.prank(verifier); core.settle(id, true);
        receipts.record(id);
        (, , , , , uint64 dW, uint64 sd, , , ) = receipts.agentStats(agent);
        (, , , uint64 dA, uint64 wSd, , , ) = receipts.workerStats(agent);
        assertEq(dW, 0); assertEq(sd, 1); assertEq(dA, 0); assertEq(wSd, 1);
    }

    // ---- fuzz: tallies equal recomputed truth

    function testFuzz_talliesMatchTruth(uint8 seed, uint8 nB) public {
        nB = uint8(bound(nB, 1, 20));
        uint256 expPosted; uint256 expPaid; uint256 expBurned; uint256 expRefunded; uint128 expEarned;
        for (uint256 i; i < nB; ++i) {
            address a = (seed >> uint8(i % 8)) & 1 == 1 ? agent : agent2;
            bool acc = (uint256(keccak256(abi.encode(seed, i, "v"))) & 1) == 1;
            uint256 path = uint256(keccak256(abi.encode(seed, i, "p"))) % 4; // 0 paid 1 burn 2 refund 3 cancel
            uint96 p = uint96(bound(uint96(uint256(keccak256(abi.encode(seed, i)))), 1e6, 100e6));
            uint256 id = _post(a, worker, p, uint96(core.minDeposit(p)), path == 2 ? MADBountyCore.RejectMode.Refund : MADBountyCore.RejectMode.Burn);
            if (path == 3) { vm.prank(a); core.cancel(id); expPosted++; }
            else {
                vm.prank(worker); core.claim(id, 0, "");
                vm.prank(worker); core.submit(id, keccak256(abi.encode(i)));
                if (path == 0) { vm.prank(verifier); core.settle(id, true); expPaid++; expEarned += p - p * 500 / 10_000; }
                else if (path == 1) { vm.prank(verifier); core.settle(id, false); vm.warp(block.timestamp + 25 hours); core.finalizeReject(id); expBurned++; }
                else { vm.prank(verifier); core.settle(id, false); vm.warp(block.timestamp + 25 hours); core.finalizeReject(id); expRefunded++; }
                expPosted++;
            }
            receipts.record(id);
        }
        (uint64 posted2, uint64 paid2, uint64 burned2, uint64 refunded2, , , , , , ) = receipts.agentStats(agent);
        (, , , , , uint128 earned2, , ) = receipts.workerStats(worker);
        uint256 tP; uint256 tPaid; uint256 tB; uint256 tR;
        // recompute for `agent` only when it was the poster: agents differ per iteration, so recount directly
        for (uint256 id = 1; id <= nB; ++id) {
            (address ag, , , , , , , , , , , , , MADBountyCore.State s, ) = core.bounties(id);
            if (ag != agent) continue;
            tP++;
            if (s == MADBountyCore.State.Paid) tPaid++;
            else if (s == MADBountyCore.State.Burned) tB++;
            else if (s == MADBountyCore.State.Refunded) tR++;
        }
        assertEq(posted2, tP); assertEq(paid2, tPaid); assertEq(burned2, tB); assertEq(refunded2, tR);
        assertEq(earned2, expEarned);
        assertEq(posted2 + paid2 + burned2 + refunded2, tP + tPaid + tB + tR); // no double counting
    }

    function _arr3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory r) {
        r = new uint256[](3); r[0] = a; r[1] = b; r[2] = c;
    }
}
