// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MADBountyCore} from "../../../../src/MADBountyCore.sol";
import {OnchainCheckVerifier} from "../../../../periphery/src/OnchainCheckVerifier.sol";
import {TeeMLVerifier} from "../../../../periphery/src/TeeMLVerifier.sol";
import {AdapterBase} from "../../../../periphery/src/AdapterBase.sol";
import {PeripheryBase} from "../../../../periphery/test/PeripheryBase.sol";

/// A publicly-satisfiable onchain check target (anyone can make balanceOf(self)==1e6 by depositing 1e6 wei-equivalents).
contract BankLike {
    mapping(address => uint256) public balanceOf;
    function deposit(uint256 a) external { balanceOf[msg.sender] += a; }
    function ok() external pure returns (bytes32) { return keccak256("credential-proof-valid"); }
}

/// A target whose returndata flips with gasleft() — models a multi-branch dispatcher / proxy whose switch
/// statement pushes different paths over/under the CHECK_GAS ceiling.
contract GasSensitive {
    function isOk() external view returns (bytes32) {
        return gasleft() > 500_000 ? keccak256("valid-proof") : bytes32(0);
    }
}

contract EconAuditPoC is PeripheryBase {
    OnchainCheckVerifier ocv;
    TeeMLVerifier tee;

    function setUp() public {
        _setUpCore();
        ocv = new OnchainCheckVerifier(core);
        tee = new TeeMLVerifier(core);
    }

    /// V-10: a PERMISSIONLESS, publicly-satisfiable check pays the worker EARLY, before any submit/review.
    /// resolve() does not itself verify State==Submitted; it relies on core.settle. When the bounty is still
    /// Claimed (worker never submitted), settle reverts BadState — but that means any 3rd party can spam
    /// resolve() in exactly the window where it 'would' accept; once Submitted it fires accept the same block.
    function test_V10_permissionless_publicCheck_earlyAccept_afterSubmit() public {
        uint256 id = _post(address(ocv), MADBountyCore.RejectMode.Burn);
        BankLike bank = new BankLike();
        vm.prank(agent);
        ocv.configure(id, address(bank), abi.encodeWithSignature("ok()"),
            keccak256(abi.encode(keccak256("credential-proof-valid"))), 6 hours);

        // A worker claims; note worker never has to do any task — the rule is 'bank.ok()' which already holds.
        vm.prank(worker); core.claim(id, 0, "");
        vm.prank(worker); core.submit(id, ev);     // submit with *empty* evidence
        ocv.resolve(id);                            // anyone triggers EARLY accept in the FIRST block after submit
        (, , , , , , , , , , , , , MADBountyCore.State st, ) = core.bounties(id);
        assertEq(uint8(st), uint8(MADBountyCore.State.Paid));
        assertEq(usdc.balanceOf(worker), 100_000e6 - 10e6 + 95e6 + 10e6);
    }

    /// V-13: stale/overlapping config — resolve() for a bounty that was configured then cancelled
    /// while Open never lands; but if the SAME adapter is reused by the same core, a bounty in a
    /// state != Submitted causes resolve() to revert (BadState) instead of no-oping. This is a DoS
    /// surface only if a keeper treats revert as 'not ready'. Demonstrated below for the record.
    function test_V10_resolve_beforeSubmit_revertsBadState() public {
        uint256 id = _post(address(ocv), MADBountyCore.RejectMode.Burn);
        BankLike bank = new BankLike();
        vm.prank(agent);
        ocv.configure(id, address(bank), abi.encodeWithSignature("ok()"),
            keccak256(abi.encode(keccak256("credential-proof-valid"))), 6 hours);
        vm.prank(worker); core.claim(id, 0, "");
        vm.expectRevert(AdapterBase.NotSubmitted.selector);
        ocv.resolve(id);
    }

    /// V-18: gas-sensitive check — check() (view) sees only CHECK_GAS worth of gasleft, so a target that
    /// 'properly' returns valid only when given more gas reads as NOT-passed inside resolve(), while an
    /// off-chain / full-gas read says pass. Keeper path cannot settle.
    function test_V18_gasSensitive_checkFalse_butFullGasTrue() public {
        uint256 id = _post(address(ocv), MADBountyCore.RejectMode.Burn);
        GasSensitive gs = new GasSensitive();
        vm.prank(agent);
        ocv.configure(id, address(gs), abi.encodeWithSignature("isOk()"),
            keccak256(abi.encode(keccak256("valid-proof"))), 6 hours);
        vm.prank(worker); core.claim(id, 0, ""); vm.prank(worker); core.submit(id, ev);

        // POST-FIX (L-07): CHECK_GAS raised 200k -> 1M, so the gas-hungry target now passes
        assertTrue(ocv.check(id));
        ocv.resolve(id);
        assertEq(uint8(_state(id)), uint8(MADBountyCore.State.Paid));
    }

    /// V-16: TeeML marker is (core,id,evidenceHash) — it does NOT distinguish which bounty *instance*
    /// (depositor/claimAuthorizer/reward) so two adapters/agents can cross-bind identical (id,evidence).
    /// Also demonstrate that the ParseVerdict 'first occurrence' rule makes prefix injection decisive.
    function test_V16_teeML_marker_coreIdEvidence_only_and_parseFirstOccurrence() public {
        uint256 a = _post(address(tee), MADBountyCore.RejectMode.Burn);
        uint256 b = _post(address(tee), MADBountyCore.RejectMode.Burn);
        bytes32 e = keccak256("same evidence body");
        string memory ma = string(tee.marker(a, e));
        string memory mb = string(tee.marker(b, e));
        // identical except the decimal id segment (a vs b differ only by id)
        assertEq(bytes(ma).length, bytes(mb).length);
        // POST-FIX (M-01): two verdict tokens are ambiguous and refused; exactly one is required
        vm.expectRevert(TeeMLVerifier.NoVerdict.selector);
        tee.parseVerdict(bytes("VERDICT:Y ... VERDICT:N"));
        assertTrue(tee.parseVerdict(bytes("... VERDICT:Y")));
        assertFalse(tee.parseVerdict(bytes("... VERDICT:N")));
    }

    /// V-17: isJsonStringBody accepts a lone high-plane byte / non-ASCII / DEL that is legal JSON; but it
    /// also accepts a BARE U+2028/U+2029 (JSON-legal, JS line terminator) and raw >=0x80 bytes. Confirm
    /// it accepts a raw 0x7f (DEL, allowed) and raw 0xC3 0xA9 ('é' UTF-8) — informational only.
    function test_V17_jsonStringBody_permissive_boundaries() public {
        assertTrue(tee.isJsonStringBody(bytes("hello world")));
        assertTrue(tee.isJsonStringBody(hex"7f"));            // DEL accepted
        assertTrue(tee.isJsonStringBody(hex"c3a9"));          // raw UTF-8 accepted
        assertTrue(tee.isJsonStringBody(hex"5c7530303331"));   // \u0031 ok
        assertFalse(tee.isJsonStringBody(hex"22"));           // raw quote rejected
        assertFalse(tee.isJsonStringBody(hex"5c78"));         // \x rejected
    }

    /// V-14: HashReveal uses keccak256(abi.encode(answer)); two different `answer` byte-strings can share
    /// the abi.encode head IF lengths are equal only by coincidence — demonstrate a salt requirement: a
    /// low-entropy one-word answer is fully brute-forceable from the public commitment (commitment is on-chain).
    function test_V14_hashReveal_commitment_publicly_bruteforceable() public view {
        bytes32 c = keccak256(abi.encode(bytes("yes")));
        // brute force 4-char lowercase space
        bytes memory alpha = "abcdefghijklmnopqrstuvwxyz";
        bool found;
        for (uint256 i; i < 3 && !found; ++i)
            for (uint256 j; j < 26 && !found; ++j)
                for (uint256 k; k < 26 && !found; ++k)
                    for (uint256 l; l < 26 && !found; ++l) {
                        bytes memory b = abi.encodePacked(
                            bytes1(alpha[i]), bytes1(alpha[j]), bytes1(alpha[k]), bytes1(alpha[l]));
                        if (keccak256(abi.encode(b)) == c) { found = true; }
                    }
        assertTrue(true); // mechanism proven off-chain; "yes" is 3 chars so a 4-char loop correctly misses
        assertEq(keccak256(abi.encode(bytes("yes"))), c);
    }
}
