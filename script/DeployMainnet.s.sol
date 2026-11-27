// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MADBountyCore, IERC20} from "../src/MADBountyCore.sol";
import {FallbackVerifier} from "../periphery/src/FallbackVerifier.sol";
import {OnchainCheckVerifier} from "../periphery/src/OnchainCheckVerifier.sol";
import {HashRevealVerifier} from "../periphery/src/HashRevealVerifier.sol";
import {TeeMLVerifier} from "../periphery/src/TeeMLVerifier.sol";
import {MultiVerifier} from "../periphery/src/MultiVerifier.sol";
import {MADReceipts} from "../periphery/src/MADReceipts.sol";
import {MADAttest} from "../periphery/src/MADAttest.sol";

/// Base mainnet: core + 5 adapters + reputation in one broadcast. All parameters are pinned
/// constants (no env) because the deploy is immutable — a typo would be permanent.
contract DeployMainnet is Script {
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // native USDC on Base
    address constant TREASURY = 0x4a1447FC0466cECFCa2966E1116204E7906B5aF7;
    string constant MANUAL_URI = "https://madbounty.org/manual/v1.txt";
    bytes32 constant MANUAL_HASH = 0xeb789fafc19538986bbb3bfed4c1a5b1395b5aea07687b0fe72b366bf2018651; // sha256

    function run() external {
        require(block.chainid == 8453, "not Base mainnet");
        require(USDC.code.length > 0, "USDC has no code");

        vm.startBroadcast();
        MADBountyCore core = new MADBountyCore(IERC20(USDC), TREASURY, MANUAL_URI, MANUAL_HASH);
        address fb = address(new FallbackVerifier(core));
        address oc = address(new OnchainCheckVerifier(core));
        address hr = address(new HashRevealVerifier(core));
        address tv = address(new TeeMLVerifier(core));
        address mv = address(new MultiVerifier(core));
        MADReceipts receipts = new MADReceipts(core);
        MADAttest attest = new MADAttest(core, receipts);
        vm.stopBroadcast();

        require(core.feeBps() == 500 && core.MAX_FEE_BPS() == 500, "fee");
        require(core.treasury() == TREASURY && address(core.usdc()) == USDC, "wiring");
        require(core.manualHash() == MANUAL_HASH, "manual");

        console2.log("MADBountyCore       ", address(core));
        console2.log("FallbackVerifier    ", fb);
        console2.log("OnchainCheckVerifier", oc);
        console2.log("HashRevealVerifier  ", hr);
        console2.log("TeeMLVerifier       ", tv);
        console2.log("MultiVerifier       ", mv);
        console2.log("MADReceipts         ", address(receipts));
        console2.log("MADAttest           ", address(attest));
    }
}
