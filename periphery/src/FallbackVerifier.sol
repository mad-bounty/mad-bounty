// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {MADBountyCore} from "../../src/MADBountyCore.sol";
import {AdapterBase} from "./AdapterBase.sol";

/// @title FallbackVerifier
/// @notice Verifier-outage protection. Per bounty, an ordered list of up to 3 signers [primary, backup1, backup2]
///         (EOA, EIP-7702 or ERC-1271) and a step timeout. Signer i may decide once
///         `block.timestamp >= submittedAt + i * stepTimeout`. Earlier signers stay valid; the first verdict that
///         lands wins (core moves the bounty out of Submitted).
///         submittedAt is derived from core: `deadline - reviewWindow` (or `deadline - 2*reviewWindow` if review
///         was extended, since extendReview adds exactly one reviewWindow). An extension therefore does NOT shift
///         the ladder; it only gives later signers more time before the silence timeout pays the worker.
///         Verdicts are EIP-712 over this adapter's domain:
///         Verdict(uint256 id,address worker,bytes32 evidenceHash,bool accept).
///         Reverse (undo a reject during core's 24h cooling) is allowed for the PRIMARY signer only:
///         Reverse(uint256 id,address worker,bytes32 evidenceHash).
///         REFUND-safe: only if every listed signer is independent of the agent.
///         If every signer stays silent, core's timeout pays the worker (verifier silence = accept).
contract FallbackVerifier is AdapterBase, EIP712 {
    bytes32 public constant VERDICT_TYPEHASH =
        keccak256("Verdict(uint256 id,address worker,bytes32 evidenceHash,bool accept)");
    bytes32 public constant REVERSE_TYPEHASH = keccak256("Reverse(uint256 id,address worker,bytes32 evidenceHash)");
    uint256 public constant MAX_SIGNERS = 3;

    struct Config {
        address[3] signers;
        uint8 count;
        uint32 stepTimeout;
    }

    mapping(uint256 => Config) internal _configs;

    event Configured(uint256 indexed id, address[] signers, uint32 stepTimeout);
    event Resolved(uint256 indexed id, uint256 indexed signerIndex, address signer, bool accept);
    event Reversed(uint256 indexed id, address signer);

    error BadIndex();
    error BadSig();

    constructor(MADBountyCore core_) AdapterBase(core_) EIP712("MADBountyFallbackVerifier", "1") {}

    /// @notice Two-step path (a claim can front-run it). Prefer `post` with
    ///         verifierInit = abi.encode(address[] signers, uint32 stepTimeout).
    ///         `stepTimeout * (n-1)` must be < the bounty's reviewWindow so every backup gets a chance.
    function configure(uint256 id, address[] calldata signers, uint32 stepTimeout) external {
        BountyView memory b = _checkConfigurable(id);
        _set(id, b, signers, stepTimeout);
    }

    function _configure(uint256 id, BountyView memory b, bytes calldata data) internal override {
        (address[] memory signers, uint32 stepTimeout) = abi.decode(data, (address[], uint32));
        _set(id, b, signers, stepTimeout);
    }

    function _set(uint256 id, BountyView memory b, address[] memory signers, uint32 stepTimeout) internal {
        Config storage c = _configs[id];
        if (c.count != 0) revert AlreadyConfigured();
        uint256 n = signers.length;
        if (n == 0 || n > MAX_SIGNERS) revert BadConfig();
        for (uint256 i; i < n; ++i) {
            if (signers[i] == address(0)) revert BadConfig();
            for (uint256 j; j < i; ++j) if (signers[j] == signers[i]) revert BadConfig();
            c.signers[i] = signers[i];
        }
        if (n > 1 && (stepTimeout == 0 || uint256(stepTimeout) * (n - 1) >= b.reviewWindow)) revert BadConfig();
        c.count = uint8(n);
        c.stepTimeout = stepTimeout;
        emit Configured(id, signers, stepTimeout);
    }

    function config(uint256 id) external view returns (address[] memory signers, uint32 stepTimeout) {
        Config storage c = _configs[id];
        signers = new address[](c.count);
        for (uint256 i; i < c.count; ++i) signers[i] = c.signers[i];
        stepTimeout = c.stepTimeout;
    }

    /// @notice Submission time derived from core (valid while Submitted).
    function submittedAt(uint256 id) public view returns (uint256) {
        BountyView memory b = _bounty(id);
        _requireSubmitted(b);
        return _submittedAt(b);
    }

    /// @notice Timestamp from which signer `i` may decide.
    function activeFrom(uint256 id, uint256 i) public view returns (uint256) {
        return submittedAt(id) + i * _configs[id].stepTimeout;
    }

    function verdictDigest(uint256 id, address worker, bytes32 evidenceHash, bool accept) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(VERDICT_TYPEHASH, id, worker, evidenceHash, accept)));
    }

    function reverseDigest(uint256 id, address worker, bytes32 evidenceHash) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(REVERSE_TYPEHASH, id, worker, evidenceHash)));
    }

    /// @notice Permissionless relay of signer `signerIndex`'s verdict.
    function resolve(uint256 id, bool accept, uint256 signerIndex, bytes calldata sig) external {
        Config storage c = _configs[id];
        if (c.count == 0) revert NotConfigured();
        if (signerIndex >= c.count) revert BadIndex();
        BountyView memory b = _bounty(id);
        _requireSubmitted(b);
        if (block.timestamp < _submittedAt(b) + signerIndex * c.stepTimeout) revert TooEarly();
        address signer = c.signers[signerIndex];
        if (!_validSig(signer, verdictDigest(id, b.worker, b.evidenceHash, accept), sig)) revert BadSig();
        emit Resolved(id, signerIndex, signer, accept);
        core.settle(id, accept);
    }

    /// @notice Permissionless relay of the PRIMARY signer's Reverse intent (core enforces Rejected + cooling).
    function reverse(uint256 id, bytes calldata sig) external {
        Config storage c = _configs[id];
        if (c.count == 0) revert NotConfigured();
        BountyView memory b = _bounty(id);
        address signer = c.signers[0];
        if (!_validSig(signer, reverseDigest(id, b.worker, b.evidenceHash), sig)) revert BadSig();
        emit Reversed(id, signer);
        core.reverse(id);
    }
}
