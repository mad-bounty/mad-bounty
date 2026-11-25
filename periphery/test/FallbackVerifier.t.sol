// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MADBountyCore} from "../../src/MADBountyCore.sol";
import {FallbackVerifier} from "../src/FallbackVerifier.sol";
import {AdapterBase} from "../src/AdapterBase.sol";
import {PeripheryBase, Mock1271} from "./PeripheryBase.sol";

contract FallbackVerifierTest is PeripheryBase {
    FallbackVerifier fv;
    uint256 k0 = 0xA1; uint256 k1 = 0xB2; uint256 k2 = 0xC3;
    address s0; address s1; address s2;
    uint32 step = 4 hours;

    function setUp() public {
        _setUpCore();
        fv = new FallbackVerifier(core);
        s0 = vm.addr(k0); s1 = vm.addr(k1); s2 = vm.addr(k2);
    }

    function _signers() internal view returns (address[] memory a) {
        a = new address[](3); a[0] = s0; a[1] = s1; a[2] = s2;
    }

    function _setup(MADBountyCore.RejectMode m) internal returns (uint256 id) {
        id = _post(address(fv), m);
        vm.prank(agent); fv.configure(id, _signers(), step);
        _claimSubmit(id, ev);
    }

    function _v(uint256 key, uint256 id, bool a) internal view returns (bytes memory) {
        return _sign(key, fv.verdictDigest(id, worker, ev, a));
    }

    function test_primaryAcceptImmediately() public {
        uint256 id = _setup(MADBountyCore.RejectMode.Burn);
        bytes memory sig = _v(k0, id, true);
        vm.prank(stranger); fv.resolve(id, true, 0, sig);
        assertEq(uint8(_state(id)), uint8(MADBountyCore.State.Paid));
        _paidWorker();
    }

    function test_backupTiming() public {
        uint256 id = _setup(MADBountyCore.RejectMode.Burn);
        bytes memory sig1 = _v(k1, id, false);
        bytes memory sig2 = _v(k2, id, false);
        vm.expectRevert(FallbackVerifier.TooEarly.selector);
        fv.resolve(id, false, 1, sig1);
        vm.warp(block.timestamp + step);
        vm.expectRevert(FallbackVerifier.TooEarly.selector);
        fv.resolve(id, false, 2, sig2);
        fv.resolve(id, false, 1, sig1);
        assertEq(uint8(_state(id)), uint8(MADBountyCore.State.Rejected));
    }

    function test_backup2AfterTwoSteps_andActiveFrom() public {
        uint256 id = _setup(MADBountyCore.RejectMode.Burn);
        uint256 sub = block.timestamp;
        assertEq(fv.submittedAt(id), sub);
        assertEq(fv.activeFrom(id, 2), sub + 2 * step);
        vm.warp(sub + 2 * step);
        fv.resolve(id, true, 2, _v(k2, id, true));
        assertEq(uint8(_state(id)), uint8(MADBountyCore.State.Paid));
    }

    function test_extendedReview_ladderUnchanged() public {
        uint256 id = _setup(MADBountyCore.RejectMode.Burn);
        uint256 sub = block.timestamp;
        vm.prank(agent); core.extendReview(id);
        assertEq(fv.submittedAt(id), sub);
        vm.warp(sub + 1 days + 1); // past original review deadline, inside extension
        fv.resolve(id, true, 2, _v(k2, id, true));
        assertEq(uint8(_state(id)), uint8(MADBountyCore.State.Paid));
    }

    function test_wrongSigner_andWrongIndex() public {
        uint256 id = _setup(MADBountyCore.RejectMode.Burn);
        bytes memory sig = _v(k1, id, true);
        vm.expectRevert(FallbackVerifier.BadSig.selector);
        fv.resolve(id, true, 0, sig);
        bytes memory bad = _v(0xDEAD, id, true);
        vm.expectRevert(FallbackVerifier.BadSig.selector);
        fv.resolve(id, true, 0, bad);
        vm.expectRevert(FallbackVerifier.BadIndex.selector);
        fv.resolve(id, true, 3, sig);
        // flipped verdict
        bytes memory acc = _v(k0, id, true);
        vm.expectRevert(FallbackVerifier.BadSig.selector);
        fv.resolve(id, false, 0, acc);
    }

    function test_replayOtherBounty() public {
        uint256 a = _setup(MADBountyCore.RejectMode.Burn);
        uint256 b = _post(address(fv), MADBountyCore.RejectMode.Burn);
        vm.prank(agent); fv.configure(b, _signers(), step);
        vm.prank(worker); core.claim(b, 0, "");
        vm.prank(worker); core.submit(b, ev);
        bytes memory sigA = _v(k0, a, false);
        vm.expectRevert(FallbackVerifier.BadSig.selector);
        fv.resolve(b, false, 0, sigA);
        // core-domain signature is not valid for adapter domain
        bytes memory coreSig = _verdictSig(k0, b, worker, ev, false);
        vm.expectRevert(FallbackVerifier.BadSig.selector);
        fv.resolve(b, false, 0, coreSig);
    }

    function test_configAuth_setOnce_bounds() public {
        uint256 id = _post(address(fv), MADBountyCore.RejectMode.Burn);
        address[] memory sg = _signers();
        vm.prank(stranger);
        vm.expectRevert(AdapterBase.NotAgent.selector);
        fv.configure(id, sg, step);
        // step too long: 2*step >= reviewWindow (1 day)
        vm.prank(agent);
        vm.expectRevert(AdapterBase.BadConfig.selector);
        fv.configure(id, sg, 12 hours);
        address[] memory dup = new address[](2); dup[0] = s0; dup[1] = s0;
        vm.prank(agent);
        vm.expectRevert(AdapterBase.BadConfig.selector);
        fv.configure(id, dup, step);
        vm.prank(agent); fv.configure(id, sg, step);
        vm.prank(agent);
        vm.expectRevert(AdapterBase.AlreadyConfigured.selector);
        fv.configure(id, sg, step);
        // not the verifier
        vm.prank(agent);
        uint256 other = core.post(_params(s0, 100e6, 10e6, MADBountyCore.RejectMode.Burn));
        vm.prank(agent);
        vm.expectRevert(AdapterBase.NotVerifier.selector);
        fv.configure(other, sg, step);
    }

    function test_configOnlyWhileOpen() public {
        uint256 id = _post(address(fv), MADBountyCore.RejectMode.Burn);
        _claimSubmit(id, ev);
        address[] memory sg = _signers();
        vm.prank(agent);
        vm.expectRevert(AdapterBase.NotOpen.selector);
        fv.configure(id, sg, step);
    }

    function test_reversePrimaryOnly() public {
        uint256 id = _setup(MADBountyCore.RejectMode.Refund);
        fv.resolve(id, false, 0, _v(k0, id, false));
        bytes memory r1 = _sign(k1, fv.reverseDigest(id, worker, ev));
        vm.expectRevert(FallbackVerifier.BadSig.selector);
        fv.reverse(id, r1);
        fv.reverse(id, _sign(k0, fv.reverseDigest(id, worker, ev)));
        assertEq(uint8(_state(id)), uint8(MADBountyCore.State.Paid));
    }

    function test_erc1271Signer() public {
        Mock1271 w = new Mock1271(s1);
        uint256 id = _post(address(fv), MADBountyCore.RejectMode.Burn);
        address[] memory sg = new address[](1); sg[0] = address(w);
        vm.prank(agent); fv.configure(id, sg, 0);
        _claimSubmit(id, ev);
        fv.resolve(id, true, 0, _v(k1, id, true));
        assertEq(uint8(_state(id)), uint8(MADBountyCore.State.Paid));
    }

    function test_silentAdapter_payOnTimeout() public {
        uint256 id = _setup(MADBountyCore.RejectMode.Burn);
        vm.warp(block.timestamp + 1 days + 1);
        bytes memory sig = _v(k0, id, false);
        vm.expectRevert(MADBountyCore.TooLate.selector);
        fv.resolve(id, false, 0, sig);
        core.payOnTimeout(id);
        _paidWorker();
        assertEq(usdc.balanceOf(address(fv)), 0);
    }

    function test_secondResolveFails() public {
        uint256 id = _setup(MADBountyCore.RejectMode.Burn);
        fv.resolve(id, true, 0, _v(k0, id, true));
        bytes memory sig = _v(k0, id, false);
        vm.expectRevert(AdapterBase.NotSubmitted.selector);
        fv.resolve(id, false, 0, sig);
    }
}
