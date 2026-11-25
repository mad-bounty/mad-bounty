// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MADBountyCore} from "../../src/MADBountyCore.sol";

/// @title AdapterBase
/// @notice Shared plumbing for MADBounty verifier adapters. An adapter is a singleton contract named as a
///         bounty's `verifier`; it calls `core.settle` when its rule is satisfied.
///         Invariants shared by every adapter:
///         - Holds no funds (core pays the worker / agent from the per-bounty vault). No owner, no admin, no upgrade.
///         - Per-bounty config is written once, only by the bounty's agent, only while the bounty is still Open
///           (so a worker can read the rule before staking a deposit), and only if this adapter is the verifier.
///         - An unconfigured bounty can never be settled by the adapter: core's verifier-silence timeout pays
///           the worker. Workers MUST check the config exists before claiming.
abstract contract AdapterBase {
    MADBountyCore public immutable core;

    struct BountyView {
        address agent;
        address verifier;
        address worker;
        uint32 reviewWindow;
        uint64 deadline;
        bool extended;
        MADBountyCore.State state;
        bytes32 evidenceHash;
    }

    error BadConfig();
    error NotAgent();
    error NotVerifier();
    error NotOpen();
    error NotSubmitted();
    error AlreadyConfigured();
    error NotConfigured();

    constructor(MADBountyCore core_) {
        if (address(core_) == address(0)) revert BadConfig();
        core = core_;
    }

    function _bounty(uint256 id) internal view returns (BountyView memory v) {
        (
            address agent,
            address verifier,
            ,
            address worker,
            ,
            ,
            ,
            ,
            uint32 reviewWindow,
            ,
            uint64 deadline,
            bool extended,
            ,
            MADBountyCore.State state,
            bytes32 evidenceHash
        ) = core.bounties(id);
        v = BountyView(agent, verifier, worker, reviewWindow, deadline, extended, state, evidenceHash);
    }

    /// @dev Caller is the agent, bounty is Open, and this adapter is the bounty's verifier.
    function _checkConfigurable(uint256 id) internal view returns (BountyView memory b) {
        b = _bounty(id);
        if (b.state != MADBountyCore.State.Open) revert NotOpen();
        if (msg.sender != b.agent) revert NotAgent();
        if (b.verifier != address(this)) revert NotVerifier();
    }

    function _requireSubmitted(BountyView memory b) internal pure {
        if (b.state != MADBountyCore.State.Submitted) revert NotSubmitted();
    }
}
