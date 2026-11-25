// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MADBounty} from "../src/MADBounty.sol";

contract MADBountyTest is Test {
    MADBounty m;
    address agent = makeAddr("agent");
    address worker = makeAddr("worker");
    uint256 vk = 0xA11CE;           // TEE verifier key (in prod: generated inside the enclave)
    address verifier;
    address constant SINK = 0x000000000000000000000000000000000000dEaD;
    bytes32 policy = keccak256("policy-v1|model|mrtd");
    bytes32 spec = keccak256("0g-storage-root-spec");
    bytes32 evidence = keccak256("0g-storage-root-evidence");

    function setUp() public {
        m = new MADBounty();
        verifier = vm.addr(vk);
        vm.deal(agent, 100 ether);
        vm.deal(worker, 100 ether);
    }

    function _post() internal returns (uint256 id) {
        vm.prank(agent);
        // reward 10, bond 1, worker deposit 25% of reward, 1 day work, 1 day review, expiry 7 days
        id = m.post{value: 11 ether}(verifier, policy, spec, 10 ether, 2500, 1 days, 1 days, uint64(block.timestamp + 7 days));
    }

    function _claimSubmit(uint256 id) internal {
        uint256 dep = m.requiredDeposit(id, worker);
        vm.prank(worker); m.claim{value: dep}(id);
        vm.prank(worker); m.submit(id, evidence);
    }

    function _sig(uint256 key, uint256 id, bool accept) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", m.DOMAIN_SEPARATOR(),
            keccak256(abi.encode(m.VERDICT_TYPEHASH(), id, evidence, policy, accept))));
        (v, r, s) = vm.sign(key, digest);
    }

    function test_accept_paysWorker_returnsBond() public {
        uint256 id = _post(); _claimSubmit(id);
        (uint8 v, bytes32 r, bytes32 s) = _sig(vk, id, true);
        m.settle(id, true, v, r, s);                       // anyone can relay
        assertEq(worker.balance, 110 ether);               // +10 reward, deposit back
        assertEq(agent.balance, 90 ether);                 // paid 10, bond back
    }

    function test_reject_burnsEverything_agentGetsNothingBack() public {
        uint256 id = _post(); _claimSubmit(id);
        (uint8 v, bytes32 r, bytes32 s) = _sig(vk, id, false);
        m.settle(id, false, v, r, s);
        vm.expectRevert(MADBounty.TooEarly.selector); m.finalizeBurn(id);
        vm.warp(block.timestamp + 1 days + 1);
        m.finalizeBurn(id);
        assertEq(agent.balance, 89 ether);                 // agent lost reward + bond
        assertEq(worker.balance, 97.5 ether);              // worker lost 2.5 deposit
        assertEq(SINK.balance, 13.5 ether);
        (,, , uint128 burned) = m.agentStats(agent);
        assertEq(burned, 13.5 ether);
    }

    function test_rejectReversal_inCoolingWindow_pays() public {
        uint256 id = _post(); _claimSubmit(id);
        (uint8 v, bytes32 r, bytes32 s) = _sig(vk, id, false);
        m.settle(id, false, v, r, s);
        (v, r, s) = _sig(vk, id, true);
        m.settle(id, true, v, r, s);
        assertEq(worker.balance, 110 ether);
        (,, uint64 rejected,) = m.agentStats(agent);
        assertEq(rejected, 0);
    }

    function test_verifierSilence_paysWorker() public {
        uint256 id = _post(); _claimSubmit(id);
        vm.expectRevert(MADBounty.TooEarly.selector); m.payOnTimeout(id);
        vm.warp(block.timestamp + 1 days + 1);
        m.payOnTimeout(id);
        assertEq(worker.balance, 110 ether);
    }

    function test_wrongSigner_reverts() public {
        uint256 id = _post(); _claimSubmit(id);
        (uint8 v, bytes32 r, bytes32 s) = _sig(0xBAD, id, true);
        vm.expectRevert(MADBounty.BadSig.selector); m.settle(id, true, v, r, s);
    }

    function test_agentCannotSwapEvidence_sigBoundToEvidence() public {
        uint256 id = _post(); _claimSubmit(id);
        (uint8 v, bytes32 r, bytes32 s) = _sig(vk, id, false);
        // signature for a different id must not verify
        uint256 id2 = _post();
        vm.expectRevert(); m.settle(id2, false, v, r, s);
    }

    function test_abandon_reopens_depositBurned() public {
        uint256 id = _post();
        uint256 dep = m.requiredDeposit(id, worker);
        vm.prank(worker); m.claim{value: dep}(id);
        vm.warp(block.timestamp + 1 days + 1);
        m.reclaimAbandoned(id);
        assertEq(SINK.balance, dep);
        assertEq(agent.balance, 89 ether);                 // agent funds still locked in the reopened bounty
        (, , , , , , , , , , , , , , MADBounty.State st) = m.bounties(id);
        assertEq(uint8(st), uint8(MADBounty.State.Open));
    }

    function test_expiredUnclaimed_refundsAgent() public {
        uint256 id = _post();
        vm.warp(block.timestamp + 7 days + 1);
        m.refundExpired(id);
        assertEq(agent.balance, 100 ether);
    }

    function test_depositShrinksWithReputation() public {
        vm.deal(agent, 1000 ether);
        uint256 before;
        for (uint256 i; i < 10; i++) {
            uint256 id = _post();
            if (i == 0) before = m.requiredDeposit(id, worker);
            _claimSubmit(id);
            (uint8 v, bytes32 r, bytes32 s) = _sig(vk, id, true);
            m.settle(id, true, v, r, s);
        }
        uint256 id2 = _post();
        assertEq(before, 2.5 ether);
        assertEq(m.requiredDeposit(id2, worker), 1.25 ether); // 10 paid jobs -> half deposit
    }
}
