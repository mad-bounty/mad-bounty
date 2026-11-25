// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MADBountyCore, IERC20} from "../src/MADBountyCore.sol";
import {CoreHelpers} from "./MADBountyCore.t.sol";

interface IUSDCAdmin { function blacklister() external view returns (address); function blacklist(address) external; }

/// v1 core against REAL Base USDC (fork).
contract ForkCoreTest is CoreHelpers {
    IERC20 usdc = IERC20(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    address treasury = makeAddr("treasury");
    address agent = makeAddr("agent");
    address worker = makeAddr("worker");
    address verifier = makeAddr("verifier");
    address BURN = 0x000000000000000000000000000000000000dEaD;

    function setUp() public {
        vm.createSelectFork("https://mainnet.base.org");
        core = new MADBountyCore(usdc, treasury, "ipfs://manual", bytes32(0));
        deal(address(usdc), agent, 1_000e6); deal(address(usdc), worker, 1_000e6);
        vm.prank(agent); (bool a,) = address(usdc).call(abi.encodeWithSignature("approve(address,uint256)", address(core), type(uint256).max)); a;
        vm.prank(worker); (bool b,) = address(usdc).call(abi.encodeWithSignature("approve(address,uint256)", address(core), type(uint256).max)); b;
    }

    function _job(MADBountyCore.RejectMode m) internal returns (uint256 id) {
        vm.prank(agent); id = core.post(_params(verifier, 100e6, 25e6, m));
        vm.prank(worker); core.claim(id, 0, "");
        vm.prank(worker); core.submit(id, keccak256("ev"));
    }

    function test_realUSDC_accept() public {
        uint256 id = _job(MADBountyCore.RejectMode.Burn);
        vm.prank(verifier); core.settle(id, true);
        assertEq(usdc.balanceOf(worker), 1_099e6);
        assertEq(usdc.balanceOf(treasury), 1e6);
    }

    function test_realUSDC_rejectBurn() public {
        uint256 id = _job(MADBountyCore.RejectMode.Burn);
        vm.prank(verifier); core.settle(id, false);
        vm.warp(block.timestamp + 25 hours);
        uint256 before = usdc.balanceOf(BURN);
        core.finalizeReject(id);
        assertEq(usdc.balanceOf(BURN) - before, 125e6);
    }

    function test_realUSDC_rejectRefund() public {
        uint256 id = _job(MADBountyCore.RejectMode.Refund);
        vm.prank(verifier); core.settle(id, false);
        vm.warp(block.timestamp + 25 hours);
        uint256 before = usdc.balanceOf(BURN);
        core.finalizeReject(id);
        assertEq(usdc.balanceOf(agent), 1_000e6);
        assertEq(usdc.balanceOf(BURN) - before, 25e6);
    }

    function test_realUSDC_blacklistedWorker_settlementStillCompletes() public {
        uint256 id = _job(MADBountyCore.RejectMode.Burn);
        vm.prank(IUSDCAdmin(address(usdc)).blacklister()); IUSDCAdmin(address(usdc)).blacklist(worker);
        vm.prank(verifier); core.settle(id, true);
        assertEq(core.owed(id, worker), 124e6);
        assertEq(usdc.balanceOf(treasury), 1e6);
    }

    /// A2 on real USDC: try to starve the inner transfer so the payout is diverted. Passes if NOT griefable.
    function test_A2_realUSDC_gasGrief() public {
        uint256 id = _job(MADBountyCore.RejectMode.Burn);
        vm.warp(block.timestamp + 1 days + 1);
        bool found;
        for (uint256 g = 30_000; g < 400_000; g += 500) {
            uint256 snap = vm.snapshotState();
            (bool ok,) = address(core).call{gas: g}(abi.encodeCall(MADBountyCore.payOnTimeout, (id)));
            if (ok && core.owed(id, worker) > 0) { found = true; break; }
            vm.revertToState(snap);
        }
        assertFalse(found);
    }
}
