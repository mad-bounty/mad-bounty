// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Test fixture for the live Base Sepolia E2E (OnchainCheckVerifier target). Not part of the protocol.
contract E2EFlag {
    mapping(uint256 => bool) public done;
    function set(uint256 id) external { done[id] = true; }
}
