// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MADBountyCore} from "../../src/MADBountyCore.sol";
import {HashRevealVerifier} from "../src/HashRevealVerifier.sol";
import {AdapterBase} from "../src/AdapterBase.sol";
import {PeripheryBase} from "./PeripheryBase.sol";

contract HashRevealVerifierTest is PeripheryBase {
    HashRevealVerifier hr;
    bytes answer = bytes("the answer is 42 / salt 9f3c");

    function setUp() public {
        _setUpCore();
        hr = new HashRevealVerifier(core);
    }

    function _setup() internal returns (uint256 id) {
        id = _post(address(hr), MADBountyCore.RejectMode.Refund);
        vm.prank(agent); hr.configure(id, keccak256(abi.encode(answer)), 6 hours);
        _claimSubmit(id, ev);
    }

    function test_happyPath() public {
        uint256 id = _setup();
        assertEq(hr.commit(answer), hr.commitment(id));
        vm.prank(worker); hr.reveal(id, answer);
        assertEq(uint8(_state(id)), uint8(MADBountyCore.State.Paid));
        _paidWorker();
    }

    function test_wrongAnswer_andNotWorker() public {
        uint256 id = _setup();
        vm.prank(worker);
        vm.expectRevert(HashRevealVerifier.WrongAnswer.selector);
        hr.reveal(id, bytes("nope"));
        vm.prank(stranger); // front-runner copying calldata
        vm.expectRevert(HashRevealVerifier.NotWorker.selector);
        hr.reveal(id, answer);
    }

    function test_revealBeforeSubmit() public {
        uint256 id = _post(address(hr), MADBountyCore.RejectMode.Burn);
        vm.prank(agent); hr.configure(id, keccak256(abi.encode(answer)), 6 hours);
        vm.prank(worker); core.claim(id, 0, "");
        vm.prank(worker);
        vm.expectRevert(AdapterBase.NotSubmitted.selector);
        hr.reveal(id, answer);
    }

    function test_replayOtherBounty_needsItsOwnCommitment() public {
        _setup();
        uint256 b = _post(address(hr), MADBountyCore.RejectMode.Burn);
        vm.prank(agent); hr.configure(b, keccak256(abi.encode(bytes("other"))), 6 hours);
        _claimSubmit(b, ev);
        vm.prank(worker);
        vm.expectRevert(HashRevealVerifier.WrongAnswer.selector);
        hr.reveal(b, answer);
    }

    function test_configAuth_setOnce() public {
        uint256 id = _post(address(hr), MADBountyCore.RejectMode.Burn);
        vm.prank(stranger);
        vm.expectRevert(AdapterBase.NotAgent.selector);
        hr.configure(id, keccak256("c"), 6 hours);
        vm.prank(agent);
        vm.expectRevert(AdapterBase.BadConfig.selector);
        hr.configure(id, bytes32(0), 6 hours);
        vm.prank(agent); hr.configure(id, keccak256("c"), 6 hours);
        vm.prank(agent);
        vm.expectRevert(AdapterBase.AlreadyConfigured.selector);
        hr.configure(id, keccak256("d"), 6 hours);
    }

    function test_lateReveal_payOnTimeoutStillWorks() public {
        uint256 id = _setup();
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(worker);
        vm.expectRevert(MADBountyCore.TooLate.selector);
        hr.reveal(id, answer);
        core.payOnTimeout(id);
        _paidWorker();
    }
}
