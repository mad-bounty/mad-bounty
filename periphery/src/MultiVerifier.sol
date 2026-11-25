// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {MADBountyCore} from "../../src/MADBountyCore.sol";
import {AdapterBase} from "./AdapterBase.sol";

/// @title MultiVerifier (m-of-n)
/// @notice Per bounty: up to 7 signers (EOA or ERC-1271) and a threshold m. A verdict needs m distinct valid
///         EIP-712 signatures over this adapter's domain:
///         Verdict(uint256 id,address worker,bytes32 evidenceHash,bool accept). Reverse needs m signatures over
///         Reverse(uint256 id,address worker,bytes32 evidenceHash).
///         Signatures are passed with their signer addresses in strictly ascending order (rules out duplicates).
///         If 2m <= n, an accept quorum and a reject quorum can both exist; the first to land wins. Use m > n/2
///         for a strict majority. REFUND-safe only if fewer than m signers are controlled by the agent.
contract MultiVerifier is AdapterBase, EIP712 {
    bytes32 public constant VERDICT_TYPEHASH =
        keccak256("Verdict(uint256 id,address worker,bytes32 evidenceHash,bool accept)");
    bytes32 public constant REVERSE_TYPEHASH = keccak256("Reverse(uint256 id,address worker,bytes32 evidenceHash)");
    uint256 public constant MAX_SIGNERS = 7;

    mapping(uint256 => address[]) internal _signers;
    mapping(uint256 => uint8) public threshold;
    mapping(uint256 => mapping(address => bool)) public isSigner;

    event Configured(uint256 indexed id, address[] signers, uint8 threshold);
    event Resolved(uint256 indexed id, bool accept, address[] signers);
    event Reversed(uint256 indexed id, address[] signers);

    error NotSorted();
    error UnknownSigner();
    error BadSig();
    error BelowThreshold();

    constructor(MADBountyCore core_) AdapterBase(core_) EIP712("MADBountyMultiVerifier", "1") {}

    /// @notice Agent only, while Open, once. `signers` strictly ascending, non-zero; 1 <= m <= n <= 7.
    function configure(uint256 id, address[] calldata signers, uint8 m) external {
        _checkConfigurable(id);
        if (threshold[id] != 0) revert AlreadyConfigured();
        uint256 n = signers.length;
        if (n == 0 || n > MAX_SIGNERS || m == 0 || m > n) revert BadConfig();
        address prev;
        for (uint256 i; i < n; ++i) {
            if (signers[i] <= prev) revert NotSorted(); // also rejects address(0)
            prev = signers[i];
            isSigner[id][signers[i]] = true;
        }
        _signers[id] = signers;
        threshold[id] = m;
        emit Configured(id, signers, m);
    }

    function signersOf(uint256 id) external view returns (address[] memory) {
        return _signers[id];
    }

    function verdictDigest(uint256 id, address worker, bytes32 evidenceHash, bool accept) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(VERDICT_TYPEHASH, id, worker, evidenceHash, accept)));
    }

    function reverseDigest(uint256 id, address worker, bytes32 evidenceHash) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(REVERSE_TYPEHASH, id, worker, evidenceHash)));
    }

    function resolve(uint256 id, bool accept, address[] calldata signers, bytes[] calldata sigs) external {
        BountyView memory b = _bounty(id);
        _requireSubmitted(b);
        _checkQuorum(id, verdictDigest(id, b.worker, b.evidenceHash, accept), signers, sigs);
        emit Resolved(id, accept, signers);
        core.settle(id, accept);
    }

    function reverse(uint256 id, address[] calldata signers, bytes[] calldata sigs) external {
        BountyView memory b = _bounty(id);
        _checkQuorum(id, reverseDigest(id, b.worker, b.evidenceHash), signers, sigs);
        emit Reversed(id, signers);
        core.reverse(id);
    }

    function _checkQuorum(uint256 id, bytes32 digest, address[] calldata signers, bytes[] calldata sigs) internal view {
        uint8 m = threshold[id];
        if (m == 0) revert NotConfigured();
        uint256 n = signers.length;
        if (n != sigs.length) revert BadConfig();
        if (n < m) revert BelowThreshold();
        address prev;
        for (uint256 i; i < n; ++i) {
            address s = signers[i];
            if (s <= prev) revert NotSorted();
            prev = s;
            if (!isSigner[id][s]) revert UnknownSigner();
            if (!SignatureChecker.isValidSignatureNow(s, digest, sigs[i])) revert BadSig();
        }
    }
}
