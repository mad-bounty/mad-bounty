// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MADBountyCore, IERC20} from "../src/MADBountyCore.sol";
import {FallbackVerifier} from "../periphery/src/FallbackVerifier.sol";
import {OnchainCheckVerifier} from "../periphery/src/OnchainCheckVerifier.sol";
import {HashRevealVerifier} from "../periphery/src/HashRevealVerifier.sol";
import {TeeMLVerifier} from "../periphery/src/TeeMLVerifier.sol";
import {MultiVerifier} from "../periphery/src/MultiVerifier.sol";

/// Core + all five adapters in one broadcast. Same MADB_* env vars as Deploy.s.sol, each checked.
contract DeployAll is Script {
    function run() external {
        address usdc = vm.envAddress("MADB_USDC");
        address treasury = vm.envAddress("MADB_TREASURY");
        string memory uri = vm.envString("MADB_MANUAL_URI");
        bytes32 h = vm.envBytes32("MADB_MANUAL_HASH");
        require(usdc.code.length > 0, "USDC has no code on this chain");
        require(treasury != address(0), "treasury unset");
        require(h != bytes32(0), "manual hash unset");

        vm.startBroadcast();
        MADBountyCore core = new MADBountyCore(IERC20(usdc), treasury, uri, h);
        address fb = address(new FallbackVerifier(core));
        address oc = address(new OnchainCheckVerifier(core));
        address hr = address(new HashRevealVerifier(core));
        address tv = address(new TeeMLVerifier(core));
        address mv = address(new MultiVerifier(core));
        vm.stopBroadcast();

        console2.log("MADBountyCore       ", address(core));
        console2.log("FallbackVerifier    ", fb);
        console2.log("OnchainCheckVerifier", oc);
        console2.log("HashRevealVerifier  ", hr);
        console2.log("TeeMLVerifier       ", tv);
        console2.log("MultiVerifier       ", mv);
    }
}
