// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MADBountyCore, IERC20} from "../../src/MADBountyCore.sol";
import {MockUSDC, CoreHelpers} from "../../test/MADBountyCore.t.sol";

/// ERC-1271 wallet that approves digests signed by its owner key.
contract Mock1271 {
    address public immutable owner;
    constructor(address o) { owner = o; }
    function isValidSignature(bytes32 h, bytes calldata sig) external view returns (bytes4) {
        (bytes32 r, bytes32 s) = abi.decode(sig[:64], (bytes32, bytes32));
        uint8 v = uint8(sig[64]);
        return ecrecover(h, v, r, s) == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

abstract contract PeripheryBase is CoreHelpers {
    MockUSDC usdc;
    address treasury = makeAddr("treasury");
    address agent = makeAddr("agent");
    address worker = makeAddr("worker");
    address stranger = makeAddr("stranger");
    bytes32 ev = keccak256("evidence");

    function _setUpCore() internal {
        usdc = new MockUSDC();
        core = new MADBountyCore(IERC20(address(usdc)), treasury, "ipfs://manual", bytes32(0));
        usdc.mint(agent, 100_000e6); usdc.mint(worker, 100_000e6);
        vm.prank(agent); usdc.approve(address(core), type(uint256).max);
        vm.prank(worker); usdc.approve(address(core), type(uint256).max);
    }

    function _post(address verifier, MADBountyCore.RejectMode m) internal returns (uint256 id) {
        vm.prank(agent);
        id = core.post(_params(verifier, 100e6, 10e6, m));
    }

    function _claimSubmit(uint256 id, bytes32 e) internal {
        vm.prank(worker); core.claim(id, 0, "");
        vm.prank(worker); core.submit(id, e);
    }

    function _state(uint256 id) internal view returns (MADBountyCore.State s) {
        (, , , , , , , , , , , , , s,) = core.bounties(id);
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _paidWorker() internal view {
        assertEq(usdc.balanceOf(worker), 100_000e6 - 10e6 + 99e6 + 10e6);
    }
}
