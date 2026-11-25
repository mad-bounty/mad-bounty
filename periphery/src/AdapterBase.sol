// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {MADBountyCore, IVerifierHook} from "../../src/MADBountyCore.sol";

/// @title AdapterBase
/// @notice Shared plumbing for MADBounty verifier adapters. An adapter is a singleton contract named as a
///         bounty's `verifier`; it calls `core.settle` when its rule is satisfied.
///         Invariants shared by every adapter:
///         - Holds no funds (core pays the worker / agent from the per-bounty vault). No owner, no admin, no upgrade.
///         - Per-bounty config is written once, only for a bounty whose verifier is this adapter, and only while the
///           bounty is still Open. Preferred path: `post(Params{verifierInit: abi.encode(...)})` → core calls
///           `onPost` in the same transaction, so no worker can ever claim an unconfigured bounty (audit H-01).
///           The two-step `configure(...)` path stays available but is front-runnable by a claim.
///         - Core pays the worker when the verifier is silent past review. Adapters whose rule can only produce an
///           ACCEPT therefore expose a permissionless "reject if unmet by cutoff" path (audit C-01/C-02). Every
///           cutoff leaves at least INCLUSION_MARGIN before the review deadline so the reject can land even under
///           Base's ~12h forced-inclusion delay.
abstract contract AdapterBase is IVerifierHook {
    uint256 public constant INCLUSION_MARGIN = 12 hours;
    uint256 public constant MIN_WINDOW = 1 hours;

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
    error NotCore();
    error TooEarly();

    constructor(MADBountyCore core_) {
        if (address(core_) == address(0)) revert BadConfig();
        core = core_;
    }

    /// @notice Called by core inside `post` when the agent passes `verifierInit`. Same rules as `configure`.
    function onPost(uint256 id, address, bytes calldata data) external {
        if (msg.sender != address(core)) revert NotCore();
        BountyView memory b = _bounty(id);
        if (b.state != MADBountyCore.State.Open) revert NotOpen();
        if (b.verifier != address(this)) revert NotVerifier();
        _configure(id, b, data);
    }

    /// @dev Decode `data` and store the per-bounty config (must revert AlreadyConfigured on a second call).
    function _configure(uint256 id, BountyView memory b, bytes calldata data) internal virtual;

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

    /// @dev Submission time, derived from core while Submitted (extendReview adds exactly one reviewWindow).
    function _submittedAt(BountyView memory b) internal pure returns (uint256) {
        return uint256(b.deadline) - uint256(b.reviewWindow) * (b.extended ? 2 : 1);
    }

    /// @dev A rule window must leave INCLUSION_MARGIN before the (unextended) review deadline.
    function _checkWindow(BountyView memory b, uint256 window) internal pure {
        if (window < MIN_WINDOW || window + INCLUSION_MARGIN > b.reviewWindow) revert BadConfig();
    }

    /// @dev ECDSA by the address's own key first, then ERC-1271 if it has code (EIP-7702 safe; mirrors core).
    function _validSig(address signer, bytes32 digest, bytes calldata sig) internal view returns (bool) {
        (address rec, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
        if (err == ECDSA.RecoverError.NoError && rec == signer) return true;
        return signer.code.length != 0 && SignatureChecker.isValidERC1271SignatureNow(signer, digest, sig);
    }
}
