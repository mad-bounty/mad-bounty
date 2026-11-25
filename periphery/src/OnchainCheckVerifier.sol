// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MADBountyCore} from "../../src/MADBountyCore.sol";
import {AdapterBase} from "./AdapterBase.sol";

/// @title OnchainCheckVerifier
/// @notice Accept when `keccak256(returndata of target.staticcall(data)) == expectedResultHash`.
///         ACCEPT-ONLY: this adapter can never reject. If the check never passes, core's verifier-silence timeout
///         pays the worker anyway, so the adapter only lets a worker be paid EARLY. Because it never rejects,
///         it is REFUND-safe (the agent cannot use it to take the work and recover the reward).
///         Trust: the check is evaluated at resolve time. If the target's state is manipulable by anyone (e.g. a
///         token balance someone can donate to, a spot price), anyone can make it pass transiently. That only
///         pays the worker early, which the agent accepted by choosing the check.
///         The staticcall is capped at CHECK_GAS; a revert or out-of-gas counts as "not passed" (resolve reverts,
///         no state change).
contract OnchainCheckVerifier is AdapterBase {
    uint256 public constant CHECK_GAS = 200_000;
    uint256 public constant MAX_DATA = 4096;

    struct Config {
        address target;
        bytes32 expectedResultHash;
        bytes data;
    }

    mapping(uint256 => Config) internal _configs;

    event Configured(uint256 indexed id, address indexed target, bytes data, bytes32 expectedResultHash);
    event Resolved(uint256 indexed id, address indexed caller);

    error CheckFailed();

    constructor(MADBountyCore core_) AdapterBase(core_) {}

    /// @notice Agent only, while Open, once. `target` must have code (an EOA staticcall "succeeds" with empty data).
    function configure(uint256 id, address target, bytes calldata data, bytes32 expectedResultHash) external {
        _checkConfigurable(id);
        if (_configs[id].target != address(0)) revert AlreadyConfigured();
        if (target.code.length == 0 || data.length > MAX_DATA) revert BadConfig();
        _configs[id] = Config(target, expectedResultHash, data);
        emit Configured(id, target, data, expectedResultHash);
    }

    function config(uint256 id) external view returns (address target, bytes memory data, bytes32 expectedResultHash) {
        Config storage c = _configs[id];
        return (c.target, c.data, c.expectedResultHash);
    }

    /// @notice True when the configured check currently passes.
    function check(uint256 id) public view returns (bool) {
        Config storage c = _configs[id];
        if (c.target == address(0)) return false;
        (bool ok, bytes memory ret) = c.target.staticcall{gas: CHECK_GAS}(c.data);
        return ok && keccak256(ret) == c.expectedResultHash;
    }

    /// @notice Permissionless keeper: if the check passes, accept. Never rejects.
    function resolve(uint256 id) external {
        if (_configs[id].target == address(0)) revert NotConfigured();
        if (!check(id)) revert CheckFailed();
        emit Resolved(id, msg.sender);
        core.settle(id, true);
    }
}
