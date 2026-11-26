// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MADBountyCore} from "../../src/MADBountyCore.sol";

/// @title MADReceipts
/// @notice Permissionless on-chain record of terminal bounty outcomes, read straight from the core's storage.
///         Anyone may call `record(id)` once a bounty is terminal (Paid / Burned / Refunded / Cancelled);
///         after that the id is sealed. The tally is pure fact — it mirrors core state and holds no opinion.
///         Scores are computed off-chain by whoever reads this; nothing here weights or ranks anyone.
///         Sybil cost: a faked "completed job" entry required the real reward to be escrowed and the real
///         fee to be paid on accept, so volume costs money to fake; `selfDeals` flags agent==worker pairs.
///         No owner, no admin, no upgrade. Holds no funds.
contract MADReceipts {
    MADBountyCore public immutable core;

    struct AgentStats {
        uint64 posted;        // terminal bounties this address listed
        uint64 paid;          // ... that ended Paid
        uint64 burned;        // ... that ended Burned (reject stood)
        uint64 refunded;      // ... that ended Refunded
        uint64 cancelled;      // ... cancelled or expired unclaimed
        uint64 distinctWorkers;
        uint64 selfDeals;      // bounties where agent == worker (excluded from distinctWorkers)
        uint128 volumePaid;   // reward sum over Paid bounties
        uint64 firstAt;
        uint64 lastAt;
    }

    struct WorkerStats {
        uint64 paid;           // bounties completed and paid
        uint64 burned;         // rejected under BURN mode (reward + deposit burned)
        uint64 refunded;       // rejected under REFUND mode (deposit burned)
        uint64 distinctAgents;
        uint64 selfDeals;
        uint128 earned;        // reward - locked fee actually received over Paid bounties
        uint64 firstAt;
        uint64 lastAt;
    }

    struct VerifierStats {
        uint64 accepted;      // bounties settled Paid by a verdict (accept or reverse)
        uint64 rejected;      // bounties settled Burned or Refunded by a reject
    }

    mapping(address => AgentStats) public agentStats;
    mapping(address => WorkerStats) public workerStats;
    mapping(address => VerifierStats) public verifierStats;
    mapping(uint256 => bool) public recorded;
    mapping(uint256 => uint64) public recordedAt;
    mapping(address => mapping(address => bool)) private _paired; // agent -> worker -> ever paired on a Paid bounty

    event Recorded(uint256 indexed id, uint8 outcome, address indexed agent, address indexed worker, address verifier);

    error BadCore();
    error NotTerminal();
    error AlreadyRecorded();

    constructor(MADBountyCore core_) {
        if (address(core_) == address(0)) revert BadCore();
        core = core_;
    }

    /// @notice Record one terminal bounty. Reverts on double record or non-terminal.
    function record(uint256 id) external {
        _record(id);
    }

    /// @notice Bulk record; ids that are non-terminal or already recorded are skipped, not reverted.
    function recordMany(uint256[] calldata ids) external {
        for (uint256 i; i < ids.length; ++i) {
            MADBountyCore.State s = _stateOf(ids[i]);
            if (_terminal(s) && !recorded[ids[i]]) _record(ids[i]);
        }
    }

    function _record(uint256 id) internal {
        if (recorded[id]) revert AlreadyRecorded();
        MADBountyCore.State s = _stateOf(id);
        if (!_terminal(s)) revert NotTerminal();

        (address agent, address verifier, , address worker, , uint96 reward, , , , , , , , , ) = core.bounties(id);
        recorded[id] = true;
        recordedAt[id] = uint64(block.timestamp);

        AgentStats storage a = agentStats[agent];
        a.posted++;
        a.firstAt = a.firstAt == 0 ? uint64(block.timestamp) : a.firstAt;
        a.lastAt = uint64(block.timestamp);

        if (s == MADBountyCore.State.Paid) {
            a.paid++;
            a.volumePaid += uint128(reward);
            WorkerStats storage w = workerStats[worker];
            w.paid++;
            w.earned += uint128(reward) - uint128(uint256(reward) * core.feeBpsOf(id) / 10_000);
            w.firstAt = w.firstAt == 0 ? uint64(block.timestamp) : w.firstAt;
            w.lastAt = uint64(block.timestamp);
            if (agent == worker) {
                a.selfDeals++;
                w.selfDeals++;
            } else if (!_paired[agent][worker]) {
                _paired[agent][worker] = true;
                a.distinctWorkers++;
                w.distinctAgents++;
            }
            verifierStats[verifier].accepted++;
        } else if (s == MADBountyCore.State.Burned) {
            a.burned++;
            workerStats[worker].burned++;
            verifierStats[verifier].rejected++;
        } else if (s == MADBountyCore.State.Refunded) {
            a.refunded++;
            workerStats[worker].refunded++;
            verifierStats[verifier].rejected++;
        } else {
            // Cancelled (includes expired unclaimed): counts for the agent only; worker is zeroed by then.
            a.cancelled++;
        }
        emit Recorded(id, uint8(s), agent, worker, verifier);
    }

    function _terminal(MADBountyCore.State s) internal pure returns (bool) {
        return s == MADBountyCore.State.Paid || s == MADBountyCore.State.Burned
            || s == MADBountyCore.State.Refunded || s == MADBountyCore.State.Cancelled;
    }

    function _stateOf(uint256 id) internal view returns (MADBountyCore.State s) {
        (, , , , , , , , , , , , , s, ) = core.bounties(id);
    }
}
