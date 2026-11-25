// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {MADFuzzHandler} from "../harness/MADFuzzHandler.sol";

/// Foundry driver over the shared stateful handler (same handler medusa/echidna use).
contract FuzzInvariantTest is StdInvariant, Test {
    MADFuzzHandler h;

    function setUp() public {
        vm.warp(1_700_000_000);
        h = new MADFuzzHandler();
        targetContract(address(h));
        bytes4[] memory ex = new bytes4[](0);
        ex;
    }

    function invariant_noTransitionOrFlowViolation() public view {
        if (h.violated()) console.log("WHY", h.why(), h.why_id());
        assertFalse(h.violated(), h.why());
    }
    function invariant_conservation() public view { assertTrue(h.checkConservation(), "conservation"); }
    function invariant_vaults() public view { assertTrue(h.checkVaults(), "vault != escrow+owed"); }
    function invariant_fees() public view { assertTrue(h.checkFees(), "fees/worker cap"); }
    function invariant_owedParties() public view { assertTrue(h.checkOwedParties(), "stranger owed"); }

    /// all checks in one (used for the long run so the call budget isn't split across 5 campaigns)
    function invariant_all() public view {
        if (h.violated()) console.log("WHY", h.why(), h.why_id());
        assertFalse(h.violated(), h.why());
        assertTrue(h.checkConservation(), "conservation");
        assertTrue(h.checkVaults(), "vault != escrow+owed");
        assertTrue(h.checkFees(), "fees/worker cap");
        assertTrue(h.checkOwedParties(), "stranger owed");
    }

    function afterInvariant() external {
        string memory line = "COV";
        for (uint256 i; i < 16; i++) {
            string memory k = string.concat("MADFZ_", vm.toString(i));
            uint256 tot = vm.envOr(k, uint256(0)) + h.okCount(i);
            vm.setEnv(k, vm.toString(tot));
            line = string.concat(line, " ", vm.toString(i), "=", vm.toString(tot));
        }
        uint256 gg = vm.envOr("MADFZ_gg", uint256(0)) + h.gasGriefOwed();
        vm.setEnv("MADFZ_gg", vm.toString(gg));
        console.log(string.concat(line, " gasGriefOwed=", vm.toString(gg)));
    }
}
