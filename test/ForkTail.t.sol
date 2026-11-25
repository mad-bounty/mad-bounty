// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";

interface IUSDC {
    function blacklister() external view returns (address);
    function blacklist(address) external;
    function transfer(address, uint256) external returns (bool);
}

/// Tail event T6/T7: USDC blacklisting on Base mainnet fork.
contract ForkTailTest is Test {
    IUSDC usdc = IUSDC(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    address escrow = makeAddr("escrow");
    address worker = makeAddr("worker");

    function setUp() public {
        vm.createSelectFork("https://mainnet.base.org");
        deal(address(usdc), escrow, 100e6);
    }

    function test_blacklistedRecipient_blocksPushPayout() public {
        vm.prank(usdc.blacklister()); usdc.blacklist(worker);
        vm.prank(escrow);
        (bool ok,) = address(usdc).call(abi.encodeCall(IUSDC.transfer, (worker, 10e6)));
        console.log("push payout to blacklisted worker ok?", ok);
        assertFalse(ok);
    }

    function test_blacklistedEscrow_freezesAllFunds() public {
        vm.prank(usdc.blacklister()); usdc.blacklist(escrow);
        vm.prank(escrow);
        (bool ok,) = address(usdc).call(abi.encodeCall(IUSDC.transfer, (worker, 10e6)));
        console.log("escrow can still send after blacklist?", ok);
        assertFalse(ok);
    }
}
