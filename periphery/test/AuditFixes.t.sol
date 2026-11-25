// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MADBountyCore} from "../../src/MADBountyCore.sol";
import {AdapterBase} from "../src/AdapterBase.sol";
import {OnchainCheckVerifier} from "../src/OnchainCheckVerifier.sol";
import {HashRevealVerifier} from "../src/HashRevealVerifier.sol";
import {MultiVerifier} from "../src/MultiVerifier.sol";
import {FallbackVerifier} from "../src/FallbackVerifier.sol";
import {TeeMLVerifier} from "../src/TeeMLVerifier.sol";
import {PeripheryBase} from "./PeripheryBase.sol";

contract Flag {
    bool public done;
    function set() external { done = true; }
}

contract NoSig {} // code at an EOA's address (EIP-7702 delegate without isValidSignature)

/// Regression tests for the round-2 periphery audit fixes (audit/periphery/REPORT.md).
contract AuditFixesTest is PeripheryBase {
    OnchainCheckVerifier oc;
    HashRevealVerifier hr;
    MultiVerifier mv;
    FallbackVerifier fv;
    TeeMLVerifier tv;
    Flag flag;

    function setUp() public {
        _setUpCore();
        oc = new OnchainCheckVerifier(core);
        hr = new HashRevealVerifier(core);
        mv = new MultiVerifier(core);
        fv = new FallbackVerifier(core);
        tv = new TeeMLVerifier(core);
        flag = new Flag();
    }

    function _postInit(address verifier, MADBountyCore.RejectMode m, bytes memory init) internal returns (uint256 id) {
        MADBountyCore.Params memory p = _params(verifier, 100e6, 10e6, m);
        p.verifierInit = init;
        vm.prank(agent);
        id = core.post(p);
    }

    function _ocInit() internal view returns (bytes memory) {
        return abi.encode(address(flag), abi.encodeWithSignature("done()"), keccak256(abi.encode(true)), uint32(6 hours));
    }

    // ---------------- H-01: atomic configuration inside post ----------------

    function test_H01_fixed_postConfiguresAtomically() public {
        uint256 id = _postInit(address(oc), MADBountyCore.RejectMode.Refund, _ocInit());
        (address t,,, uint32 w) = oc.config(id);
        assertEq(t, address(flag));
        assertEq(w, 6 hours);
        vm.prank(agent);
        vm.expectRevert(AdapterBase.AlreadyConfigured.selector);
        oc.configure(id, address(flag), "", bytes32(0), 6 hours);
    }

    function test_H01_fixed_onPostOnlyCallableByCore() public {
        uint256 id = _post(address(oc), MADBountyCore.RejectMode.Burn);
        vm.prank(agent);
        vm.expectRevert(AdapterBase.NotCore.selector);
        oc.onPost(id, agent, _ocInit());
    }

    function test_H01_fixed_badInitRevertsWholePost() public {
        bytes memory bad = abi.encode(address(flag), bytes(""), bytes32(0), uint32(23 hours)); // window + 12h > review
        MADBountyCore.Params memory p = _params(address(oc), 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        p.verifierInit = bad;
        uint256 before = usdc.balanceOf(agent);
        vm.prank(agent);
        vm.expectRevert(AdapterBase.BadConfig.selector);
        core.post(p);
        assertEq(usdc.balanceOf(agent), before);
    }

    function test_H01_fixed_multiPanelCanRejectWithAtomicConfig() public {
        (address[] memory s, uint256[] memory k) = _sorted3();
        uint256 id = _postInit(address(mv), MADBountyCore.RejectMode.Refund, abi.encode(s, uint8(2)));
        _claimSubmit(id, bytes32(0));
        bytes32 d = mv.verdictDigest(id, worker, bytes32(0), false);
        address[] memory s2 = new address[](2);
        bytes[] memory g = new bytes[](2);
        for (uint256 i; i < 2; ++i) { s2[i] = s[i]; g[i] = _sign(k[i], d); }
        mv.resolve(id, false, s2, g);
        assertEq(uint8(_state(id)), uint8(MADBountyCore.State.Rejected));
    }

    // ---------------- C-01: accept-only adapters can now reject unmet work ----------------

    function test_C01_fixed_onchainCheck_zeroWorkRejected() public {
        uint256 id = _postInit(address(oc), MADBountyCore.RejectMode.Refund, _ocInit());
        _claimSubmit(id, bytes32(0));
        vm.expectRevert(AdapterBase.TooEarly.selector);
        oc.rejectUnmet(id);
        vm.warp(block.timestamp + 6 hours);
        vm.prank(stranger); oc.rejectUnmet(id);
        vm.warp(block.timestamp + 24 hours + 1);
        core.finalizeReject(id);
        assertEq(usdc.balanceOf(agent), 100_000e6);            // REFUND: agent made whole
        assertEq(usdc.balanceOf(worker), 100_000e6 - 10e6);    // zero-work worker loses deposit
    }

    function test_C01_fixed_onchainCheck_cannotRejectDoneWork() public {
        uint256 id = _postInit(address(oc), MADBountyCore.RejectMode.Refund, _ocInit());
        _claimSubmit(id, bytes32(0));
        flag.set();
        vm.warp(block.timestamp + 6 hours);
        vm.expectRevert(OnchainCheckVerifier.CheckPasses.selector);
        oc.rejectUnmet(id);
        oc.resolve(id);
        _paidWorker();
    }

    function test_C01_fixed_hashReveal_zeroWorkRejected_correctRevealWins() public {
        bytes memory answer = bytes("42-salt");
        uint256 a = _postInit(address(hr), MADBountyCore.RejectMode.Refund, abi.encode(keccak256(abi.encode(answer)), uint32(6 hours)));
        _claimSubmit(a, bytes32(0));
        vm.warp(block.timestamp + 6 hours);
        vm.expectRevert(HashRevealVerifier.WrongAnswer.selector);
        hr.rejectUnrevealed(a, bytes("not the answer"));   // r3 F-1c: REFUND reject needs the real opening
        hr.rejectUnrevealed(a, answer);
        assertEq(uint8(_state(a)), uint8(MADBountyCore.State.Rejected));
        // a correct reveal before the window settles accept, after which rejectUnrevealed fails
        uint256 b = _postInit(address(hr), MADBountyCore.RejectMode.Refund, abi.encode(keccak256(abi.encode(answer)), uint32(6 hours)));
        vm.prank(worker); core.claim(b, 0, ""); vm.prank(worker); core.submit(b, bytes32(0));
        vm.prank(worker); hr.reveal(b, answer);
        vm.warp(block.timestamp + 6 hours);
        vm.expectRevert(AdapterBase.NotSubmitted.selector);
        hr.rejectUnrevealed(b, answer);
    }

    function test_C01_fixed_windowMustLeaveInclusionMargin() public {
        // reviewWindow is 1 day in _params: window + 12h must be <= 1 day
        bytes memory tooLong = abi.encode(keccak256("c"), uint32(12 hours + 1));
        MADBountyCore.Params memory p = _params(address(hr), 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        p.verifierInit = tooLong;
        vm.prank(agent);
        vm.expectRevert(AdapterBase.BadConfig.selector);
        core.post(p);
    }

    // ---------------- C-02: TeeML burden of proof on the worker ----------------

    function test_C02_fixed_withheldEvidence_rejectedAfterWindow() public {
        address[] memory s = new address[](1);
        s[0] = makeAddr("tee");
        uint256 id = _postInit(address(tv), MADBountyCore.RejectMode.Burn,
            abi.encode(s, keccak256("p"), keccak256("s"), uint32(6 hours)));
        _claimSubmit(id, keccak256("evidence the worker never publishes"));
        vm.warp(block.timestamp + 6 hours);
        tv.rejectUnproven(id);
        assertEq(uint8(_state(id)), uint8(MADBountyCore.State.Rejected));
    }

    // ---------------- adapters accept EIP-7702 / smart-account ECDSA (port of core L-03) ----------------

    function test_L03_fixed_fallbackSignerWithCode_ecdsaStillWorks() public {
        uint256 key = 0xB0B;
        address signer = vm.addr(key);
        vm.etch(signer, address(new NoSig()).code);
        address[] memory s = new address[](1);
        s[0] = signer;
        uint256 id = _postInit(address(fv), MADBountyCore.RejectMode.Burn, abi.encode(s, uint32(0)));
        _claimSubmit(id, ev);
        fv.resolve(id, false, 0, _sign(key, fv.verdictDigest(id, worker, ev, false)));
        assertEq(uint8(_state(id)), uint8(MADBountyCore.State.Rejected));
    }

    function _sorted3() internal pure returns (address[] memory s, uint256[] memory k) {
        s = new address[](3);
        k = new uint256[](3);
        k[0] = 0xA1; k[1] = 0xA2; k[2] = 0xA3;
        for (uint256 i; i < 3; ++i) s[i] = vm.addr(k[i]);
        for (uint256 i; i < 3; ++i) {
            for (uint256 j = i + 1; j < 3; ++j) {
                if (s[j] < s[i]) {
                    (s[i], s[j]) = (s[j], s[i]);
                    (k[i], k[j]) = (k[j], k[i]);
                }
            }
        }
    }

    // audit r3 I-1: \u escapes that decode to printable ASCII are refused; non-ASCII/control escapes stay allowed.
    function test_r3_I1_asciiUnicodeEscape() public view {
        assertTrue(tv.hasAsciiUnicodeEscape(bytes("x \\u0056ERDICT:Y")));
        assertTrue(tv.hasAsciiUnicodeEscape(bytes("\\u0041")));
        assertFalse(tv.hasAsciiUnicodeEscape(bytes("caf\\u00e9 \\u000a \\u4e2d")));
        assertFalse(tv.hasAsciiUnicodeEscape(bytes("a\\\\u0056"))); // escaped backslash, then literal "u0056"
    }
}
