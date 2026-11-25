// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MADBountyCore} from "../../src/MADBountyCore.sol";
import {AdapterBase} from "./AdapterBase.sol";

/// @title HashRevealVerifier
/// @notice Agent commits `keccak256(abi.encode(answer))` (answer: bytes). The bounty's worker calls
///         `reveal(id, answer)` after submitting; a matching answer accepts. ACCEPT-ONLY, so REFUND-safe.
///         WARNING: the answer becomes public on reveal (calldata + event). Use it for answers that are fine to
///         publish, or make the committed answer a hash of private data. Low-entropy answers can be brute-forced
///         from the commitment; salt them (e.g. answer = abi.encode(realAnswer, salt) and tell the worker how
///         the salt is derived from the work).
///         Front-running is harmless: only `bounty.worker` may reveal, and core pays `bounty.worker` regardless of
///         who calls, so a watcher copying the answer from the mempool can neither reveal nor redirect payment.
///         (An answer copied from another bounty's reveal is the agent's choice of a reused commitment.)
contract HashRevealVerifier is AdapterBase {
    mapping(uint256 => bytes32) public commitment;

    event Configured(uint256 indexed id, bytes32 commitment);
    event Revealed(uint256 indexed id, address indexed worker, bytes answer);

    error NotWorker();
    error WrongAnswer();

    constructor(MADBountyCore core_) AdapterBase(core_) {}

    function configure(uint256 id, bytes32 commitment_) external {
        _checkConfigurable(id);
        if (commitment[id] != bytes32(0)) revert AlreadyConfigured();
        if (commitment_ == bytes32(0)) revert BadConfig();
        commitment[id] = commitment_;
        emit Configured(id, commitment_);
    }

    function commit(bytes calldata answer) external pure returns (bytes32) {
        return keccak256(abi.encode(answer));
    }

    function reveal(uint256 id, bytes calldata answer) external {
        bytes32 c = commitment[id];
        if (c == bytes32(0)) revert NotConfigured();
        BountyView memory b = _bounty(id);
        _requireSubmitted(b);
        if (msg.sender != b.worker) revert NotWorker();
        if (keccak256(abi.encode(answer)) != c) revert WrongAnswer();
        emit Revealed(id, msg.sender, answer);
        core.settle(id, true);
    }
}
