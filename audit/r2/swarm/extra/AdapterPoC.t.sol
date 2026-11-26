// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MADBountyCore, IERC20} from "../../../../src/MADBountyCore.sol";
import {MockUSDC, CoreHelpers} from "../../../../test/MADBountyCore.t.sol";
import {AdapterBase} from "../../../../periphery/src/AdapterBase.sol";
import {FallbackVerifier} from "../../../../periphery/src/FallbackVerifier.sol";
import {MultiVerifier} from "../../../../periphery/src/MultiVerifier.sol";
import {OnchainCheckVerifier} from "../../../../periphery/src/OnchainCheckVerifier.sol";
import {TeeMLVerifier} from "../../../../periphery/src/TeeMLVerifier.sol";

/// A no-op target the agent points the on-chain check at.
contract Noop {
    function ping() external pure returns (bool) {
        return true;
    }
}

/// A target whose "answer" is a storage slot that starts at 0.
contract Answer {
    bytes32 public answer;
    function set(bytes32 a) external { answer = a; }
    function get() external view returns (bytes32) { return answer; }
}

contract AdapterPoCTest is CoreHelpers {
    MockUSDC usdc;
    address treasury = makeAddr("treasury");
    address agent = makeAddr("agent");
    address worker = makeAddr("worker");
    address stranger = makeAddr("stranger");
    bytes32 ev = keccak256("evidence");

    uint256 k0 = 0xA1;
    uint256 k1 = 0xB2;
    uint256 k2 = 0xC3;
    address s0;
    address s1;
    address s2;

    function setUp() public {
        usdc = new MockUSDC();
        core = new MADBountyCore(IERC20(address(usdc)), treasury, "ipfs://manual", bytes32(0));
        usdc.mint(agent, 100_000e6);
        usdc.mint(worker, 100_000e6);
        usdc.mint(stranger, 100_000e6);
        vm.prank(agent); usdc.approve(address(core), type(uint256).max);
        vm.prank(worker); usdc.approve(address(core), type(uint256).max);
        vm.prank(stranger); usdc.approve(address(core), type(uint256).max);
        s0 = vm.addr(k0);
        s1 = vm.addr(k1);
        s2 = vm.addr(k2);
    }

    function _post(address verifier, MADBountyCore.RejectMode m) internal returns (uint256 id) {
        vm.prank(agent);
        id = core.post(_params(verifier, 100e6, 10e6, m));
    }

    function _claimSubmit(uint256 id) internal {
        vm.prank(worker); core.claim(id, 0, "");
        vm.prank(worker); core.submit(id, ev);
    }

    function _state(uint256 id) internal view returns (MADBountyCore.State s) {
        (,,,,,,,,,,,,, s,) = core.bounties(id);
    }

    function _paidWorker() internal view {
        assertEq(usdc.balanceOf(worker), 100_000e6 - 10e6 + 95e6 + 10e6);
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _vSig(uint256 key, uint256 id, address w, bytes32 e, bool accept) internal view returns (bytes memory) {
        return _sign(key, _digest(keccak256(abi.encode(core.VERDICT_TYPEHASH(), id, w, e, accept))));
    }

    // ================================================================== M-0 (verified)
    /// M-0 (LOW, REAL): none of the adapters implements IERC-1271, so when an adapter is named as the verifier,
    /// core.settle() / settleWithSig () / reverse () / reverseWithSig () and every adapter entrypoint that calls
    /// core.settle() / core.reverse() bubble a `BadSig()` (or revert) for the *core*-domain digest path. The only
    /// settlement route is the adapter's own entrypoints. This is fine for live adapters, but it means the "relay
    /// any core verdict signature" workflow (llms-full.txt §9.5) silently breaks for adapter bounties, and a worker
    /// who is worried about a hostile verifier cannot use an independent on-chain path.
    function test_M0_adapterVerifier_noERC1271() public {
        TeeMLVerifier tv = new TeeMLVerifier(core);
        uint256 id = _post(address(tv), MADBountyCore.RejectMode.Burn);
        _claimSubmit(id);
        vm.prank(stranger);
        vm.expectRevert(); // no isValidSignature on the adapter -> BadSig()
        core.settleWithSig(id, false, _sign(0xBAD, keccak256("x")));
    }

    // ================================================================== M-1
    /// M-1 (LOW): OnchainCheckVerifier.configure only rejects `target.code.length == 0`.  A target with code
    /// (e.g. a live EOA's deployer, a factory) that self-destructs after configure leaves expectedResultHash =
    /// keccak256(""), and staticcall-to-an-empty-account "succeeds" with empty returndata => resolve() accepts.
    /// Demonstrates the code.length guard is the only defence.
    function test_M1_OnchainCheck_EOAtarget_rejected() public {
        OnchainCheckVerifier ocv = new OnchainCheckVerifier(core);
        uint256 id = _post(address(ocv), MADBountyCore.RejectMode.Burn);
        vm.prank(agent);
        vm.expectRevert(AdapterBase.BadConfig.selector);
        ocv.configure(id, address(0xEA01), "", keccak256(""), 6 hours);
    }

    // ================================================================== M-2
    /// M-2 (INFO, documented "accept-only"): a check that already passes in the target's default state lets the
    /// WORKER self-settle with zero deliverables right after a cheapest-possible claim.
    function test_M2_OnchainCheck_defaultStateAlreadyPasses() public {
        OnchainCheckVerifier ocv = new OnchainCheckVerifier(core);
        Answer t = new Answer(); // answer == 0 initially
        uint256 id = _post(address(ocv), MADBountyCore.RejectMode.Burn);
        vm.prank(agent);
        ocv.configure(id, address(t), abi.encodeCall(Answer.get, ()), keccak256(abi.encode(bytes32(0))), 6 hours);
        _claimSubmit(id);
        assertTrue(ocv.check(id)); // passes with no work done
        vm.prank(stranger); ocv.resolve(id);
        _paidWorker();
    }

    // ================================================================== L-1
    /// L-1 (LOW): isJsonStringBody accepts raw 0x7F (DEL), which RFC 8259 forbids unescaped (only 0x00-0x1F
    /// must be escaped; 0x7F is legal JSON actually) — informational.  Real finding: it accepts a bare '\'
    /// only when followed by an escape; OK.  Kept to document the check.
    function test_L1_isJsonStringBody_DEL() public {
        TeeMLVerifier tv = new TeeMLVerifier(core);
        bytes memory b = new bytes(1);
        b[0] = bytes1(0x7f);
        assertTrue(tv.isJsonStringBody(b));
    }
}
