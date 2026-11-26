// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MADBountyCore} from "../src/MADBountyCore.sol";
import {MADReceipts} from "../periphery/src/MADReceipts.sol";
import {MADAttest} from "../periphery/src/MADAttest.sol";

/// Reputation periphery: MADReceipts (outcome tally) + MADAttest (party ratings).
/// Env: MADB_CORE (required, must have code). Immutable, no owner; the deployer holds no powers.
contract DeployReputation is Script {
    function run() external {
        MADBountyCore core = MADBountyCore(vm.envAddress("MADB_CORE"));
        require(address(core).code.length > 0, "MADB_CORE has no code");
        require(core.MAX_FEE_BPS() > 0, "MADB_CORE is not a MADBountyCore");

        vm.startBroadcast();
        MADReceipts receipts = new MADReceipts(core);
        MADAttest attests = new MADAttest(core, receipts);
        vm.stopBroadcast();

        console2.log("MADReceipts", address(receipts));
        console2.log("MADAttest  ", address(attests));
    }
}
