// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MADBountyCore} from "../../../src/MADBountyCore.sol";
import {AdapterBase} from "../../../periphery/src/AdapterBase.sol";

/// @title OnchainCheckVerifierFixed (audit r3 copy with the F-2 gas guard; NOT the shipped contract)
/// @notice Accept when `keccak256(returndata of target.staticcall(data)) == expectedResultHash`, evaluated while the
///         bounty is Submitted. If the check still fails `checkWindow` after submission, ANYONE may call
///         `rejectUnmet` (audit C-01: without it a zero-work worker was paid by core's silence timeout).
///         Choose a check that ONLY the requested work can make true. A check that is already true, or that anyone
///         can make true (a balance someone can donate to, a spot price), pays the first worker who submits.
///         REFUND-safe only if the agent cannot keep the check false against honest work (workers: read the target).
///         The staticcall is capped at CHECK_GAS; a revert or out-of-gas counts as "not passed".
contract OnchainCheckVerifierFixed is AdapterBase {
    uint256 public constant CHECK_GAS = 1_000_000;
    uint256 public constant MAX_DATA = 4096;

    struct Config {
        address target;
        uint32 checkWindow;
        bytes32 expectedResultHash;
        bytes data;
    }

    mapping(uint256 => Config) internal _configs;

    event Configured(uint256 indexed id, address indexed target, bytes data, bytes32 expectedResultHash, uint32 checkWindow);
    event Resolved(uint256 indexed id, address indexed caller);
    event RejectedUnmet(uint256 indexed id, address indexed caller);

    error CheckFailed();
    error CheckPasses();
    error LowGas();

    constructor(MADBountyCore core_) AdapterBase(core_) {}

    /// @notice Two-step path (a claim can front-run it). Prefer `post` with
    ///         verifierInit = abi.encode(address target, bytes data, bytes32 expectedResultHash, uint32 checkWindow).
    function configure(uint256 id, address target, bytes calldata data, bytes32 expectedResultHash, uint32 checkWindow)
        external
    {
        BountyView memory b = _checkConfigurable(id);
        _set(id, b, target, data, expectedResultHash, checkWindow);
    }

    function _configure(uint256 id, BountyView memory b, bytes calldata init) internal override {
        (address target, bytes memory data, bytes32 expectedResultHash, uint32 checkWindow) =
            abi.decode(init, (address, bytes, bytes32, uint32));
        _set(id, b, target, data, expectedResultHash, checkWindow);
    }

    function _set(uint256 id, BountyView memory b, address target, bytes memory data, bytes32 h, uint32 checkWindow)
        internal
    {
        if (_configs[id].target != address(0)) revert AlreadyConfigured();
        if (target.code.length == 0 || data.length > MAX_DATA) revert BadConfig();
        _checkWindow(b, checkWindow);
        _configs[id] = Config(target, checkWindow, h, data);
        emit Configured(id, target, data, h, checkWindow);
    }

    function config(uint256 id)
        external
        view
        returns (address target, bytes memory data, bytes32 expectedResultHash, uint32 checkWindow)
    {
        Config storage c = _configs[id];
        return (c.target, c.data, c.expectedResultHash, c.checkWindow);
    }

    /// @notice True when the configured check currently passes.
    function check(uint256 id) public view returns (bool) {
        Config storage c = _configs[id];
        if (c.target == address(0)) return false;
        (bool ok, bytes memory ret) = c.target.staticcall{gas: CHECK_GAS}(c.data);
        return ok && keccak256(ret) == c.expectedResultHash;
    }

    /// @notice Anyone, while Submitted: if the check passes, accept.
    function resolve(uint256 id) external {
        if (_configs[id].target == address(0)) revert NotConfigured();
        _requireSubmitted(_bounty(id));
        if (!check(id)) revert CheckFailed();
        emit Resolved(id, msg.sender);
        core.settle(id, true);
    }

    /// @notice Anyone: check still failing `checkWindow` after submission → reject.
    function rejectUnmet(uint256 id) external {
        Config storage c = _configs[id];
        if (c.target == address(0)) revert NotConfigured();
        BountyView memory b = _bounty(id);
        _requireSubmitted(b);
        if (block.timestamp < _submittedAt(b) + c.checkWindow) revert TooEarly();
        // r3 F-2 fix: the staticcall must receive the FULL CHECK_GAS, or a starved call reads as "unmet".
        if (gasleft() < CHECK_GAS * 64 / 63 + 20_000) revert LowGas();
        if (check(id)) revert CheckPasses();
        emit RejectedUnmet(id, msg.sender);
        core.settle(id, false);
    }
}
