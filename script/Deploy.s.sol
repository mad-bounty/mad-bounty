// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MADBountyCore, IERC20} from "../src/MADBountyCore.sol";

/// @notice Deploys the immutable core. Every value is permanent: check them twice.
/// Env:
///   MADB_USDC          USDC address (Base mainnet 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
///   MADB_TREASURY      fee recipient (use a multisig; it can never be changed)
///   MADB_MANUAL_URI    e.g. ipfs://<cid>/llms-full.txt
///   MADB_MANUAL_HASH   keccak256 of that file (cast keccak "$(cat docs/llms-full.txt)")
/// Run:
///   forge script script/Deploy.s.sol --rpc-url $RPC --account deployer --broadcast --verify
contract Deploy is Script {
    function run() external returns (MADBountyCore core) {
        address usdc = vm.envAddress("MADB_USDC");
        address treasury = vm.envAddress("MADB_TREASURY");
        string memory uri = vm.envString("MADB_MANUAL_URI");
        bytes32 h = vm.envBytes32("MADB_MANUAL_HASH");
        require(usdc.code.length > 0, "USDC has no code on this chain");
        require(treasury != address(0), "treasury unset");
        require(h != bytes32(0), "manual hash unset");

        vm.startBroadcast();
        core = new MADBountyCore(IERC20(usdc), treasury, uri, h);
        vm.stopBroadcast();

        console.log("MADBountyCore", address(core));
        console.log("vaultImpl", core.vaultImpl());
        console.log("treasury", core.treasury());
        console.log("manualURI", core.manualURI());
    }
}
