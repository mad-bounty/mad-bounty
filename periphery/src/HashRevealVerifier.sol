// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MADBountyCore} from "../../src/MADBountyCore.sol";
import {AdapterBase} from "./AdapterBase.sol";

/// @title HashRevealVerifier
/// @notice Agent commits `keccak256(abi.encode(answer))` (answer: bytes) and a reveal window. The bounty's worker
///         calls `reveal(id, answer)` after submitting; a matching answer accepts. If no matching answer is
///         revealed within `revealWindow` of submission, ANYONE may call `rejectUnrevealed` (audit C-01: without it
///         a zero-work worker was paid by core's silence timeout).
///         REFUND-safe: the agent cannot block a correct reveal, so in REFUND mode the agent only recovers the
///         reward when no correct answer was revealed in time. Workers must still check the commitment is answerable.
///         WARNING: the answer becomes public on reveal (calldata + event). Low-entropy answers can be brute-forced
///         from the commitment; salt them. Front-running is harmless: only `bounty.worker` may reveal.
contract HashRevealVerifier is AdapterBase {
    mapping(uint256 => bytes32) public commitment;
    mapping(uint256 => uint32) public revealWindow;

    event Configured(uint256 indexed id, bytes32 commitment, uint32 revealWindow);
    event Revealed(uint256 indexed id, address indexed worker, bytes answer);
    event RejectedUnrevealed(uint256 indexed id, address indexed caller);

    error NotWorker();
    error WrongAnswer();

    constructor(MADBountyCore core_) AdapterBase(core_) {}

    /// @notice Two-step path (a claim can front-run it). Prefer `post` with
    ///         verifierInit = abi.encode(bytes32 commitment, uint32 revealWindow).
    function configure(uint256 id, bytes32 commitment_, uint32 revealWindow_) external {
        BountyView memory b = _checkConfigurable(id);
        _set(id, b, commitment_, revealWindow_);
    }

    function _configure(uint256 id, BountyView memory b, bytes calldata data) internal override {
        (bytes32 commitment_, uint32 revealWindow_) = abi.decode(data, (bytes32, uint32));
        _set(id, b, commitment_, revealWindow_);
    }

    function _set(uint256 id, BountyView memory b, bytes32 commitment_, uint32 revealWindow_) internal {
        if (commitment[id] != bytes32(0)) revert AlreadyConfigured();
        if (commitment_ == bytes32(0)) revert BadConfig();
        _checkWindow(b, revealWindow_);
        commitment[id] = commitment_;
        revealWindow[id] = revealWindow_;
        emit Configured(id, commitment_, revealWindow_);
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

    /// @notice Anyone: no correct reveal within revealWindow of submission → reject.
    function rejectUnrevealed(uint256 id) external {
        if (commitment[id] == bytes32(0)) revert NotConfigured();
        BountyView memory b = _bounty(id);
        _requireSubmitted(b);
        if (block.timestamp < _submittedAt(b) + revealWindow[id]) revert TooEarly();
        emit RejectedUnrevealed(id, msg.sender);
        core.settle(id, false);
    }
}
