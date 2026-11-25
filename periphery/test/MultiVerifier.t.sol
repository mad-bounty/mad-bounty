// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MADBountyCore} from "../../src/MADBountyCore.sol";
import {MultiVerifier} from "../src/MultiVerifier.sol";
import {AdapterBase} from "../src/AdapterBase.sol";
import {PeripheryBase} from "./PeripheryBase.sol";

contract MultiVerifierTest is PeripheryBase {
    MultiVerifier mv;
    uint256[] keys;
    address[] addrs; // sorted

    function setUp() public {
        _setUpCore();
        mv = new MultiVerifier(core);
        for (uint256 i = 1; i <= 5; ++i) keys.push(0x1000 + i);
        // sort keys by address
        for (uint256 i; i < keys.length; ++i)
            for (uint256 j = i + 1; j < keys.length; ++j)
                if (vm.addr(keys[j]) < vm.addr(keys[i])) (keys[i], keys[j]) = (keys[j], keys[i]);
        for (uint256 i; i < keys.length; ++i) addrs.push(vm.addr(keys[i]));
    }

    function _setup(uint8 m) internal returns (uint256 id) {
        id = _post(address(mv), MADBountyCore.RejectMode.Refund);
        vm.prank(agent); mv.configure(id, addrs, m);
        _claimSubmit(id, ev);
    }

    function _sigs(uint256 id, bool accept, uint256[] memory idx)
        internal view returns (address[] memory s, bytes[] memory g)
    {
        s = new address[](idx.length); g = new bytes[](idx.length);
        bytes32 d = mv.verdictDigest(id, worker, ev, accept);
        for (uint256 i; i < idx.length; ++i) { s[i] = addrs[idx[i]]; g[i] = _sign(keys[idx[i]], d); }
    }

    function _idx(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory r) {
        r = new uint256[](3); r[0] = a; r[1] = b; r[2] = c;
    }

    function test_3of5_accept() public {
        uint256 id = _setup(3);
        (address[] memory s, bytes[] memory g) = _sigs(id, true, _idx(0, 2, 4));
        vm.prank(stranger); mv.resolve(id, true, s, g);
        assertEq(uint8(_state(id)), uint8(MADBountyCore.State.Paid));
        _paidWorker();
    }

    function test_3of5_reject_thenQuorumReverse() public {
        uint256 id = _setup(3);
        (address[] memory s, bytes[] memory g) = _sigs(id, false, _idx(1, 2, 3));
        mv.resolve(id, false, s, g);
        assertEq(uint8(_state(id)), uint8(MADBountyCore.State.Rejected));
        bytes32 rd = mv.reverseDigest(id, worker, ev);
        bytes[] memory rg = new bytes[](3);
        for (uint256 i; i < 3; ++i) rg[i] = _sign(keys[i + 1], rd);
        mv.reverse(id, s, rg);
        assertEq(uint8(_state(id)), uint8(MADBountyCore.State.Paid));
    }

    function test_belowThreshold() public {
        uint256 id = _setup(3);
        uint256[] memory two = new uint256[](2); two[0] = 0; two[1] = 1;
        (address[] memory s, bytes[] memory g) = _sigs(id, true, two);
        vm.expectRevert(MultiVerifier.BelowThreshold.selector);
        mv.resolve(id, true, s, g);
    }

    function test_duplicateSigner_rejected() public {
        uint256 id = _setup(3);
        (address[] memory s, bytes[] memory g) = _sigs(id, true, _idx(0, 0, 1));
        vm.expectRevert(MultiVerifier.NotSorted.selector);
        mv.resolve(id, true, s, g);
        (s, g) = _sigs(id, true, _idx(2, 1, 0));
        vm.expectRevert(MultiVerifier.NotSorted.selector);
        mv.resolve(id, true, s, g);
    }

    function test_wrongSigner_andMismatchedSig() public {
        uint256 id = _setup(2);
        uint256[] memory two = new uint256[](2); two[0] = 0; two[1] = 1;
        (address[] memory s, bytes[] memory g) = _sigs(id, true, two);
        address outsider = address(type(uint160).max);
        s[1] = outsider;
        vm.expectRevert(MultiVerifier.UnknownSigner.selector);
        mv.resolve(id, true, s, g);
        (s, g) = _sigs(id, true, two);
        g[1] = g[0];
        vm.expectRevert(MultiVerifier.BadSig.selector);
        mv.resolve(id, true, s, g);
        (s, g) = _sigs(id, true, two);
        vm.expectRevert(MultiVerifier.BadSig.selector); // accept sigs used for reject
        mv.resolve(id, false, s, g);
    }

    function test_replayOtherBounty() public {
        uint256 a = _setup(2);
        uint256 b = _post(address(mv), MADBountyCore.RejectMode.Burn);
        vm.prank(agent); mv.configure(b, addrs, 2);
        vm.prank(worker); core.claim(b, 0, "");
        vm.prank(worker); core.submit(b, ev);
        uint256[] memory two = new uint256[](2); two[0] = 0; two[1] = 1;
        (address[] memory s, bytes[] memory g) = _sigs(a, false, two);
        vm.expectRevert(MultiVerifier.BadSig.selector);
        mv.resolve(b, false, s, g);
    }

    function test_configAuth_setOnce_bounds() public {
        uint256 id = _post(address(mv), MADBountyCore.RejectMode.Burn);
        vm.prank(stranger);
        vm.expectRevert(AdapterBase.NotAgent.selector);
        mv.configure(id, addrs, 3);
        vm.prank(agent);
        vm.expectRevert(AdapterBase.BadConfig.selector);
        mv.configure(id, addrs, 6);
        vm.prank(agent);
        vm.expectRevert(AdapterBase.BadConfig.selector);
        mv.configure(id, addrs, 0);
        address[] memory unsorted = new address[](2); unsorted[0] = addrs[1]; unsorted[1] = addrs[0];
        vm.prank(agent);
        vm.expectRevert(MultiVerifier.NotSorted.selector);
        mv.configure(id, unsorted, 1);
        address[] memory eight = new address[](8);
        for (uint256 i; i < 8; ++i) eight[i] = address(uint160(i + 1));
        vm.prank(agent);
        vm.expectRevert(AdapterBase.BadConfig.selector);
        mv.configure(id, eight, 1);
        vm.prank(agent); mv.configure(id, addrs, 3);
        vm.prank(agent);
        vm.expectRevert(AdapterBase.AlreadyConfigured.selector);
        mv.configure(id, addrs, 2);
        assertEq(mv.signersOf(id).length, 5);
    }

    function test_silent_payOnTimeout() public {
        uint256 id = _setup(3);
        vm.warp(block.timestamp + 1 days + 1);
        core.payOnTimeout(id);
        _paidWorker();
    }
}
