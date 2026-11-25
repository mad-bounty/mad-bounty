// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MADBountyCore} from "../src/MADBountyCore.sol";
import {OnchainCheckVerifier} from "../periphery/src/OnchainCheckVerifier.sol";
import {HashRevealVerifier} from "../periphery/src/HashRevealVerifier.sol";
import {TeeMLVerifier} from "../periphery/src/TeeMLVerifier.sol";

/// Redeploy the adapters changed by audit r3 (F-1c, F-2, I-1) against an existing core. Adapters hold no funds
/// and no state shared across bounties, so old bounties keep using the old adapter instances.
contract DeployAdaptersR3 is Script {
    function run() external {
        MADBountyCore core = MADBountyCore(vm.envAddress("MADB_CORE"));
        require(address(core).code.length > 0, "core has no code");
        require(keccak256(bytes(core.NAME())) == keccak256("MADBounty"), "not a MADBounty core");
        vm.startBroadcast();
        address oc = address(new OnchainCheckVerifier(core));
        address hr = address(new HashRevealVerifier(core));
        address tv = address(new TeeMLVerifier(core));
        vm.stopBroadcast();
        console2.log("OnchainCheckVerifier", oc);
        console2.log("HashRevealVerifier  ", hr);
        console2.log("TeeMLVerifier       ", tv);
    }
}
