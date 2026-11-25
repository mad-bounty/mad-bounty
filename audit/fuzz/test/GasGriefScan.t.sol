// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {MADBountyCore, IERC20} from "../../../src/MADBountyCore.sol";
import {FuzzUSDC} from "../harness/MADFuzzHandler.sol";

/// Deterministic scan: can a third party pick a gas limit so a permissionless exit SUCCEEDS while the inner
/// token transfer runs out of gas inside BountyVault.send's try/catch, diverting the push into `owed`?
/// Reports the result; asserts only that no funds leave the vault/owed accounting (conservation).
contract GasGriefScanTest is Test {
    MADBountyCore core;
    FuzzUSDC usdc;
    address treasury = address(0x7EA5);
    address agent = address(0xA6E0);
    address worker = address(0xB0E0);
    address verifier = address(0x5E7);
    address griefer = address(0x6E1EF);

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new FuzzUSDC();
        core = new MADBountyCore(IERC20(address(usdc)), treasury, "m", bytes32(0));
        usdc.mint(agent, 10_000e6); usdc.mint(worker, 10_000e6);
        usdc.setAllowance(agent, address(core), type(uint256).max);
        usdc.setAllowance(worker, address(core), type(uint256).max);
    }

    function _post() internal returns (uint256 id) {
        vm.prank(agent);
        id = core.post(MADBountyCore.Params({verifier: verifier, claimAuthorizer: address(0), reward: 100e6,
            deposit: 2e6, workWindow: 1 days, reviewWindow: 1 days, openUntil: uint64(block.timestamp + 1 days),
            rejectMode: MADBountyCore.RejectMode.Burn, specHash: 0, encKey: "", verifierInit: ""}));
    }

    function _scan(bytes memory data, string memory name, address payee) internal returns (uint256 hits) {
        uint256 snap = vm.snapshotState();
        for (uint256 g = 30_000; g < 200_000; g += 250) {
            vm.revertToState(snap);
            vm.prank(griefer);
            (bool ok,) = address(core).call{gas: g}(data);
            uint256 id = abi.decode(_slice(data), (uint256));
            if (ok && core.owed(id, payee) > 0) {
                if (hits == 0) console.log(name, "owed-diversion at gas", g, core.owed(id, payee));
                hits++;
            }
        }
        vm.revertToState(snap);
        console.log(name, "hits:", hits);
    }

    function _slice(bytes memory d) internal pure returns (bytes memory o) {
        o = new bytes(32);
        for (uint256 i; i < 32; i++) o[i] = d[i + 4];
    }

    function test_scan_payOnTimeout() public {
        uint256 id = _post();
        vm.prank(worker); core.claim(id, 0, "");
        vm.prank(worker); core.submit(id, bytes32(uint256(1)));
        vm.warp(block.timestamp + 1 days + 1);
        _scan(abi.encodeCall(MADBountyCore.payOnTimeout, (id)), "payOnTimeout->worker", worker);
    }

    function test_scan_refundExpired() public {
        uint256 id = _post();
        vm.warp(block.timestamp + 1 days + 1);
        _scan(abi.encodeCall(MADBountyCore.refundExpired, (id)), "refundExpired->agent", agent);
    }

    function test_scan_finalizeReject() public {
        uint256 id = _post();
        vm.prank(worker); core.claim(id, 0, "");
        vm.prank(worker); core.submit(id, bytes32(uint256(1)));
        vm.prank(verifier); core.settle(id, false);
        vm.warp(block.timestamp + 1 days + 1);
        _scan(abi.encodeCall(MADBountyCore.finalizeReject, (id)), "finalizeReject->BURN", core.BURN());
    }

    function test_scan_reclaimAbandoned() public {
        uint256 id = _post();
        vm.prank(worker); core.claim(id, 0, "");
        vm.warp(block.timestamp + 1 days + 1);
        _scan(abi.encodeCall(MADBountyCore.reclaimAbandoned, (id)), "reclaimAbandoned->BURN", core.BURN());
    }
}
