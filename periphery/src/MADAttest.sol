// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MADBountyCore} from "../../src/MADBountyCore.sol";
import {MADReceipts} from "./MADReceipts.sol";

/// @title MADAttest
/// @notice Party-to-party ratings bound to real, settled bounties. Only the agent or the worker of a
///         recorded terminal bounty may attest about the other, once per bounty, within 30 days of the
///         record timestamp. Ratings run -2..+2 with an optional note hash (off-chain content).
///         No bond is taken: the sybil cost of a fake rating pair is the real reward escrowed plus the
///         fee already paid on that bounty, and `contradicted` marks the one case where the chain itself
///         contradicts the rating (the agent rates the worker negative on a bounty the agent's own
///         verifier accepted and paid) so scorers can discount it.
///         No owner, no admin, no upgrade. Holds no funds.
contract MADAttest {
    MADBountyCore public immutable core;
    MADReceipts public immutable receipts;

    uint32 public constant WINDOW = 30 days;

    struct Attestation {
        address attester;     // agent or worker of the bounty
        address subject;      // the other party
        int8 rating;          // -2..+2
        bytes32 noteHash;     // hash of off-chain note (may be 0)
        uint64 at;
        bool contradicted;   // agent rated the worker negative on a Paid bounty
    }

    struct SubjectStats {
        uint64 count;
        int128 sumRating;
        uint64 contradictedCount;
    }

    mapping(uint256 => mapping(address => Attestation)) public attestations; // id -> attester
    mapping(address => SubjectStats) public stats;                          // subject aggregates

    event Attested(uint256 indexed id, address indexed attester, address indexed subject, int8 rating, bool contradicted);

    error BadCore();
    error NotParty();
    error Cancelled();
    error BadRating();
    error AlreadyAttested();
    error NotRecorded();
    error TooLate();

    constructor(MADBountyCore core_, MADReceipts receipts_) {
        if (address(core_) == address(0) || address(receipts_) == address(0)) revert BadCore();
        core = core_;
        receipts = receipts_;
    }

    /// @notice Rate your counterparty on a settled bounty. Records the receipt first if needed.
    function attest(uint256 id, int8 rating, bytes32 noteHash) external {
        if (rating < -2 || rating > 2) revert BadRating();
        if (!receipts.recorded(id)) {
            receipts.record(id); // reverts NotTerminal if the bounty is not settled yet
        }
        if (block.timestamp > receipts.recordedAt(id) + WINDOW) revert TooLate();

        (address agent, , , address worker, , , , , , , , , , MADBountyCore.State s, ) = core.bounties(id);
        if (s == MADBountyCore.State.Cancelled) revert Cancelled(); // no work happened; nothing to rate
        if (attestations[id][msg.sender].at != 0) revert AlreadyAttested();

        bool isAgent = msg.sender == agent;
        bool isWorker = msg.sender == worker;
        if (!isAgent && !isWorker) revert NotParty();
        address subject = isAgent ? worker : agent;

        // the one on-chain contradiction: the agent pans work its own verifier accepted and paid
        bool contradicted = isAgent && rating < 0 && s == MADBountyCore.State.Paid;

        attestations[id][msg.sender] =
            Attestation({attester: msg.sender, subject: subject, rating: rating, noteHash: noteHash, at: uint64(block.timestamp), contradicted: contradicted});

        SubjectStats storage ss = stats[subject];
        ss.count++;
        ss.sumRating += rating;
        if (contradicted) ss.contradictedCount++;

        emit Attested(id, msg.sender, subject, rating, contradicted);
    }
}
