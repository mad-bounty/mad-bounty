// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console} from "forge-std/Test.sol";
import {MADBountyCore, IERC20} from "../src/MADBountyCore.sol";
import {MockUSDC, CoreHelpers} from "./MADBountyCore.t.sol";

/// Verifier wallet (ERC-1271) that says "valid" to everything: approves both ACCEPT and REJECT.
contract YesManVerifier {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) { return 0x1626ba7e; }
}

/// Attack proofs against v1 core.
/// A1, A2, A4: tests PASS when the attack is BLOCKED (fixed). A3, A5: tests PASS when the attack still works
/// (accepted by design: A3 is the agent's choice of verifier, A5 costs the attacker the full reward).
contract AttacksTest is CoreHelpers {
    MockUSDC usdc;
    address agent = makeAddr("agent");
    address worker = makeAddr("worker");
    address griefer = makeAddr("griefer");
    address verifier = makeAddr("verifier");
    address BURN = 0x000000000000000000000000000000000000dEaD;

    function setUp() public {
        usdc = new MockUSDC();
        core = new MADBountyCore(IERC20(address(usdc)), makeAddr("treasury"), "ipfs://manual", bytes32(0));
        for (uint256 i; i < 3; i++) {
            address a = [agent, worker, griefer][i];
            usdc.mint(a, 10_000e6);
            vm.prank(a); usdc.approve(address(core), type(uint256).max);
        }
    }

    function _post(address v, uint96 p, uint96 d) internal returns (uint256 id) {
        vm.prank(agent);
        id = core.post(_params(v, p, d, MADBountyCore.RejectMode.Burn));
    }

    /// A1 FIXED: zero deposit rejected; each claim-lock cycle now costs the griefer the deposit floor.
    function test_A1_claimLock_nowCostsGriefer() public {
        vm.prank(agent);
        vm.expectRevert(MADBountyCore.BadParam.selector);
        core.post(_params(verifier, 100e6, 0, MADBountyCore.RejectMode.Burn));
        uint256 id = _post(verifier, 100e6, 2e6);
        uint256 t = block.timestamp;
        for (uint256 i; i < 5; i++) {
            vm.prank(griefer); core.claim(id, 0, "");
            t += 1 days + 1; vm.warp(t);
            core.reclaimAbandoned(id);
        }
        assertEq(usdc.balanceOf(griefer), 10_000e6 - 10e6); // 5 days of lock cost the griefer $10
    }

    /// A2 NOT EXPLOITABLE: starve the inner USDC transfer so payout diverts to `owed`. Passes if not griefable.
    function test_A2_gasGriefPayOnTimeout() public {
        uint256 id = _post(verifier, 100e6, 10e6);
        vm.prank(worker); core.claim(id, 0, "");
        vm.prank(worker); core.submit(id, keccak256("e"));
        vm.warp(block.timestamp + 1 days + 1);
        bool found;
        for (uint256 g = 30_000; g < 2_000_000; g += 1_000) {
            uint256 snap = vm.snapshotState();
            (bool ok,) = address(core).call{gas: g}(abi.encodeCall(MADBountyCore.payOnTimeout, (id)));
            if (ok && core.owed(id, worker) > 0) { console.log("griefable at gas", g); found = true; break; }
            vm.revertToState(snap);
        }
        assertFalse(found);
    }

    /// A3 BY DESIGN: a verifier contract that validates ANY signature lets the worker self-accept a fake.
    function test_A3_permissiveVerifier_raceToSettle() public {
        YesManVerifier y = new YesManVerifier();
        uint256 id = _post(address(y), 100e6, 10e6);
        vm.prank(worker); core.claim(id, 0, "");
        vm.prank(worker); core.submit(id, keccak256("fake"));
        vm.prank(worker); core.settleWithSig(id, true, hex"00");
        assertEq(usdc.balanceOf(worker), 10_000e6 + 99e6);
    }

    /// A4 FIXED: a second (ground) ACCEPT signature can't flip a REJECT. Only a Reverse intent can.
    function test_A4_acceptSigCannotFlipReject() public {
        uint256 vk = 0xA11CE;
        uint256 id = _post(vm.addr(vk), 100e6, 10e6);
        vm.prank(worker); core.claim(id, 0, "");
        bytes32 ev = keccak256("borderline");
        vm.prank(worker); core.submit(id, ev);
        core.settleWithSig(id, false, _verdictSig(vk, id, worker, ev, false));
        bytes memory acc = _verdictSig(vk, id, worker, ev, true);
        vm.expectRevert(MADBountyCore.BadState.selector);
        core.settleWithSig(id, true, acc);
    }

    /// A5 BY DESIGN: agent spite costs the agent P (same as paying); the worker loses D + effort.
    function test_A5_spiteCostsAgentP() public {
        uint256 id = _post(agent, 100e6, 25e6);
        vm.prank(worker); core.claim(id, 0, "");
        vm.prank(worker); core.submit(id, keccak256("honest"));
        vm.prank(agent); core.settle(id, false);
        vm.warp(block.timestamp + 25 hours); core.finalizeReject(id);
        assertEq(usdc.balanceOf(agent), 10_000e6 - 100e6);
        assertEq(usdc.balanceOf(worker), 10_000e6 - 25e6);
        assertEq(usdc.balanceOf(BURN), 125e6);
    }

    /// A6 BY DESIGN (refund mode): an agent that is its own verifier can steal work. Workers must not take
    /// REFUND bounties whose verifier is the agent or unknown; the interface must flag this.
    function test_A6_refundModeSelfVerifier_agentKeepsReward() public {
        vm.prank(agent);
        uint256 id = core.post(_params(agent, 100e6, 25e6, MADBountyCore.RejectMode.Refund));
        vm.prank(worker); core.claim(id, 0, "");
        vm.prank(worker); core.submit(id, keccak256("honest"));
        vm.prank(agent); core.settle(id, false);
        vm.warp(block.timestamp + 25 hours); core.finalizeReject(id);
        assertEq(usdc.balanceOf(agent), 10_000e6);           // agent kept P and got the work
        assertEq(usdc.balanceOf(worker), 10_000e6 - 25e6);
    }
}
