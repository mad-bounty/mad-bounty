// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MADBountyCore} from "../../src/MADBountyCore.sol";
import {OnchainCheckVerifier} from "../src/OnchainCheckVerifier.sol";
import {AdapterBase} from "../src/AdapterBase.sol";
import {PeripheryBase} from "./PeripheryBase.sol";

contract Target {
    uint256 internal value;
    function get() external view returns (uint256) { return value; }
    function set(uint256 v) external { value = v; }
    function boom() external pure returns (uint256) { revert("boom"); }
    function burn() external view returns (uint256 x) { while (gasleft() > 1000) { x += value; } }
}

contract OnchainCheckVerifierTest is PeripheryBase {
    OnchainCheckVerifier oc;
    Target tgt;

    function setUp() public {
        _setUpCore();
        oc = new OnchainCheckVerifier(core);
        tgt = new Target();
    }

    function _setup(bytes memory data, bytes32 exp) internal returns (uint256 id) {
        id = _post(address(oc), MADBountyCore.RejectMode.Refund);
        vm.prank(agent); oc.configure(id, address(tgt), data, exp, 6 hours);
        _claimSubmit(id, ev);
    }

    function test_happyPath() public {
        uint256 id = _setup(abi.encodeCall(Target.get, ()), keccak256(abi.encode(uint256(42))));
        vm.expectRevert(OnchainCheckVerifier.CheckFailed.selector);
        oc.resolve(id);
        tgt.set(42);
        assertTrue(oc.check(id));
        vm.prank(stranger); oc.resolve(id);
        assertEq(uint8(_state(id)), uint8(MADBountyCore.State.Paid));
        _paidWorker();
        assertEq(usdc.balanceOf(address(oc)), 0);
    }

    function test_revertingTarget_notPassed() public {
        uint256 id = _setup(abi.encodeCall(Target.boom, ()), keccak256(abi.encode(uint256(0))));
        assertFalse(oc.check(id));
        vm.expectRevert(OnchainCheckVerifier.CheckFailed.selector);
        oc.resolve(id);
    }

    function test_gasCap_notPassed() public {
        tgt.set(1);
        uint256 id = _setup(abi.encodeCall(Target.burn, ()), keccak256(abi.encode(uint256(0))));
        uint256 g = gasleft();
        assertFalse(oc.check(id));
        assertLt(g - gasleft(), 1_060_000); // CHECK_GAS raised to 1M (audit L-07)
    }

    function test_configAuth_setOnce() public {
        uint256 id = _post(address(oc), MADBountyCore.RejectMode.Burn);
        bytes memory d = abi.encodeCall(Target.get, ());
        vm.prank(stranger);
        vm.expectRevert(AdapterBase.NotAgent.selector);
        oc.configure(id, address(tgt), d, bytes32(0), 6 hours);
        vm.prank(agent);
        vm.expectRevert(AdapterBase.BadConfig.selector);
        oc.configure(id, stranger, d, bytes32(0), 6 hours); // EOA target
        vm.prank(agent); oc.configure(id, address(tgt), d, bytes32(0), 6 hours);
        vm.prank(agent);
        vm.expectRevert(AdapterBase.AlreadyConfigured.selector);
        oc.configure(id, address(tgt), d, keccak256("x"), 6 hours);
        (address t_, , bytes32 e_,) = oc.config(id);
        assertEq(t_, address(tgt)); assertEq(e_, bytes32(0));
    }

    function test_unconfigured_andWrongState() public {
        uint256 id = _post(address(oc), MADBountyCore.RejectMode.Burn);
        vm.expectRevert(AdapterBase.NotConfigured.selector);
        oc.resolve(id);
        vm.prank(agent); oc.configure(id, address(tgt), abi.encodeCall(Target.get, ()), keccak256(abi.encode(uint256(0))), 6 hours);
        vm.expectRevert(AdapterBase.NotSubmitted.selector); // adapter now gates on Submitted (audit M-01)
        oc.resolve(id);
    }

    function test_silent_payOnTimeout() public {
        uint256 id = _setup(abi.encodeCall(Target.get, ()), keccak256(abi.encode(uint256(42))));
        vm.warp(block.timestamp + 1 days + 1);
        core.payOnTimeout(id);
        _paidWorker();
    }
}
