// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @notice Per-bounty USDC vault. Only the core can move funds. A token freeze on one vault touches one bounty.
contract BountyVault {
    address public immutable core;
    IERC20 public immutable token;

    constructor(IERC20 token_) {
        core = msg.sender;
        token = token_;
    }

    /// @return ok false instead of reverting, so a blocked recipient can't stall settlement
    function send(address to, uint256 amount) external returns (bool ok) {
        require(msg.sender == core, "core");
        if (amount == 0) return true;
        try token.transfer(to, amount) returns (bool r) { ok = r; } catch { ok = false; }
    }
}

/// @title MADBounty v1 core
/// @notice Immutable dual-deposit (MAD) escrow for agent-posted bounties. No owner, no proxy, no pause.
///         Terms (accepted by calling post / claim):
///         - The agent escrows reward P. The worker escrows deposit D (>= max(1 USDC, 2% of P)) on claim.
///         - The named verifier decides. ACCEPT: worker gets P - 1% fee + D.
///         - REJECT starts a 24h cooling window. The verifier may undo it only with a separate Reverse intent.
///           After cooling: BURN mode burns P + D. REFUND mode returns P to the agent and burns D.
///           REFUND mode is only fair with a verifier independent of the agent; workers must check the verifier.
///         - Verifier silence past review pays the worker. A missed work window burns D and reopens the bounty.
///         - The agent may cancel while Open. After openUntil, anyone may return an unclaimed bounty to the agent.
contract MADBountyCore is EIP712, ReentrancyGuardTransient {
    enum State { None, Open, Claimed, Submitted, Rejected, Paid, Burned, Refunded, Cancelled }
    enum RejectMode { Burn, Refund }

    struct Params {
        address verifier;          // EOA, ERC-1271 wallet, or adapter contract
        address claimAuthorizer;   // optional: must sign each claim (0 = open to anyone)
        uint96 reward;
        uint96 deposit;
        uint32 workWindow;
        uint32 reviewWindow;
        uint64 openUntil;          // unclaimed bounty returnable to the agent after this
        RejectMode rejectMode;
        bytes32 specHash;
        bytes encKey;              // agent's public encryption key for secrets (optional)
    }

    struct Bounty {
        address agent;
        address verifier;
        address claimAuthorizer;
        address worker;
        BountyVault vault;
        uint96 reward;
        uint96 deposit;
        uint32 workWindow;
        uint32 reviewWindow;
        uint64 openUntil;
        uint64 deadline;           // current phase deadline
        bool extended;
        RejectMode rejectMode;
        State state;
        bytes32 evidenceHash;
    }

    uint256 public constant FEE_BPS = 100;                 // 1% of reward, on accept only
    uint256 public constant MIN_REWARD = 1e6;              // $1
    uint256 public constant MAX_REWARD = 1_000e6;          // v1 cap: $1,000 (USDC 6 decimals)
    uint256 public constant MIN_DEPOSIT = 1e6;             // $1 floor (kills free claim-lock griefing, A1)
    uint256 public constant MIN_DEPOSIT_BPS = 200;         // and at least 2% of reward
    uint32 public constant MIN_WORK = 1 hours;
    uint32 public constant MAX_WORK = 30 days;
    uint32 public constant MIN_REVIEW = 12 hours;          // >= OP Stack forced-inclusion delay (~12h)
    uint32 public constant MAX_REVIEW = 30 days;
    uint32 public constant MAX_OPEN = 180 days;
    uint32 public constant COOLING = 24 hours;
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    bytes32 public constant VERDICT_TYPEHASH =
        keccak256("Verdict(uint256 id,address worker,bytes32 evidenceHash,bool accept)");
    bytes32 public constant REVERSE_TYPEHASH = keccak256("Reverse(uint256 id,address worker,bytes32 evidenceHash)");
    bytes32 public constant CLAIM_TYPEHASH = keccak256("Claim(uint256 id,address worker,uint256 deadline)");

    /// @notice Machine-readable pointer for agents reading the chain: where the manual lives and its content hash.
    string public constant NAME = "MADBounty";
    string public constant VERSION = "1";
    string public constant TERMS =
        "Agent escrows reward; worker escrows deposit on claim. Named verifier decides. Accept: worker gets reward-1%+deposit. "
        "Reject: 24h cooling (verifier may Reverse), then BURN (reward+deposit burned) or REFUND (reward to agent, deposit burned). "
        "Verifier silence pays worker. Missed work window burns deposit. No admin, no upgrades, no appeals.";

    IERC20 public immutable usdc;
    address public immutable treasury;
    address public immutable vaultImpl;
    bytes32 public immutable manualHash;   // keccak256 of the manual file at manualURI
    string public manualURI;               // set once in the constructor (e.g. ipfs://<cid>/llms.txt)

    uint256 public nextId = 1;
    mapping(uint256 => Bounty) public bounties;
    mapping(uint256 => mapping(address => uint256)) public owed; // failed pushes, withdrawable

    event Posted(uint256 indexed id, address indexed agent, address indexed verifier, address vault, uint256 reward,
        uint256 deposit, uint32 workWindow, uint32 reviewWindow, uint64 openUntil, RejectMode rejectMode,
        address claimAuthorizer, bytes32 specHash, bytes encKey);
    event Cancelled(uint256 indexed id);
    event Expired(uint256 indexed id);
    event Claimed(uint256 indexed id, address indexed worker, uint64 deadline);
    event Submitted(uint256 indexed id, bytes32 evidenceHash, uint64 reviewDeadline);
    event ReviewExtended(uint256 indexed id, uint64 reviewDeadline);
    event Rejected(uint256 indexed id, uint64 coolingEnd);
    event Reversed(uint256 indexed id);
    event Paid(uint256 indexed id, address indexed worker, uint256 toWorker, uint256 fee, bool byTimeout);
    event Burned(uint256 indexed id, uint256 amount);
    event Refunded(uint256 indexed id, uint256 toAgent, uint256 depositBurned);
    event Abandoned(uint256 indexed id, address indexed worker, uint256 depositBurned);
    event Owed(uint256 indexed id, address indexed to, uint256 amount);
    event Withdrawn(uint256 indexed id, address indexed to, uint256 amount);

    error BadParam();
    error BadState();
    error NotAllowed();
    error TooEarly();
    error TooLate();
    error BadSig();
    error TransferFailed();

    constructor(IERC20 usdc_, address treasury_, string memory manualURI_, bytes32 manualHash_)
        EIP712("MADBounty", "1")
    {
        if (address(usdc_) == address(0) || treasury_ == address(0)) revert BadParam();
        usdc = usdc_;
        treasury = treasury_;
        vaultImpl = address(new BountyVault(usdc_));
        manualURI = manualURI_;
        manualHash = manualHash_;
    }

    function minDeposit(uint256 reward) public pure returns (uint256) {
        uint256 pct = reward * MIN_DEPOSIT_BPS / 10_000;
        return pct > MIN_DEPOSIT ? pct : MIN_DEPOSIT;
    }

    // ------------------------------------------------------------------ agent

    function post(Params calldata p) external nonReentrant returns (uint256 id) {
        if (p.verifier == address(0) || p.reward < MIN_REWARD || p.reward > MAX_REWARD) revert BadParam();
        if (p.deposit < minDeposit(p.reward) || p.deposit > p.reward) revert BadParam();
        if (p.workWindow < MIN_WORK || p.workWindow > MAX_WORK) revert BadParam();
        if (p.reviewWindow < MIN_REVIEW || p.reviewWindow > MAX_REVIEW) revert BadParam();
        if (p.openUntil <= block.timestamp || p.openUntil > block.timestamp + MAX_OPEN) revert BadParam();
        id = nextId++;
        BountyVault vault = BountyVault(Clones.clone(vaultImpl));
        Bounty storage b = bounties[id];
        b.agent = msg.sender; b.verifier = p.verifier; b.claimAuthorizer = p.claimAuthorizer; b.vault = vault;
        b.reward = p.reward; b.deposit = p.deposit; b.workWindow = p.workWindow; b.reviewWindow = p.reviewWindow;
        b.openUntil = p.openUntil; b.rejectMode = p.rejectMode; b.state = State.Open;
        _pull(msg.sender, address(vault), p.reward);
        emit Posted(id, msg.sender, p.verifier, address(vault), p.reward, p.deposit, p.workWindow, p.reviewWindow,
            p.openUntil, p.rejectMode, p.claimAuthorizer, p.specHash, p.encKey);
    }

    function cancel(uint256 id) external nonReentrant {
        Bounty storage b = bounties[id];
        if (b.state != State.Open) revert BadState();
        if (msg.sender != b.agent) revert NotAllowed();
        b.state = State.Cancelled;
        _pay(id, b, b.agent, b.reward);
        emit Cancelled(id);
    }

    /// @notice Anyone: unclaimed past openUntil → reward back to the agent (dead or absent agents).
    function refundExpired(uint256 id) external nonReentrant {
        Bounty storage b = bounties[id];
        if (b.state != State.Open) revert BadState();
        if (block.timestamp <= b.openUntil) revert TooEarly();
        b.state = State.Cancelled;
        _pay(id, b, b.agent, b.reward);
        emit Expired(id);
    }

    /// @notice One-time review extension (verifier outage, slow evidence). Agent or verifier.
    function extendReview(uint256 id) external {
        Bounty storage b = bounties[id];
        if (b.state != State.Submitted) revert BadState();
        if (msg.sender != b.agent && msg.sender != b.verifier) revert NotAllowed();
        if (b.extended || block.timestamp > b.deadline) revert NotAllowed();
        b.extended = true;
        b.deadline += b.reviewWindow;
        emit ReviewExtended(id, b.deadline);
    }

    // ----------------------------------------------------------------- worker

    function claim(uint256 id, uint256 authDeadline, bytes calldata authSig) external nonReentrant {
        Bounty storage b = bounties[id];
        if (b.state != State.Open) revert BadState();
        if (block.timestamp > b.openUntil) revert TooLate();
        if (b.claimAuthorizer != address(0)) {
            if (block.timestamp > authDeadline) revert TooLate();
            bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, id, msg.sender, authDeadline)));
            if (!SignatureChecker.isValidSignatureNow(b.claimAuthorizer, digest, authSig)) revert BadSig();
        }
        b.worker = msg.sender;
        b.deadline = uint64(block.timestamp) + b.workWindow;
        b.state = State.Claimed;
        _pull(msg.sender, address(b.vault), b.deposit);
        emit Claimed(id, msg.sender, b.deadline);
    }

    function submit(uint256 id, bytes32 evidenceHash) external {
        Bounty storage b = bounties[id];
        if (b.state != State.Claimed) revert BadState();
        if (msg.sender != b.worker) revert NotAllowed();
        if (block.timestamp > b.deadline) revert TooLate();
        b.evidenceHash = evidenceHash;
        b.deadline = uint64(block.timestamp) + b.reviewWindow;
        b.state = State.Submitted;
        emit Submitted(id, evidenceHash, b.deadline);
    }

    /// @notice Anyone: worker missed the work window. Deposit burns, bounty reopens.
    function reclaimAbandoned(uint256 id) external nonReentrant {
        Bounty storage b = bounties[id];
        if (b.state != State.Claimed) revert BadState();
        if (block.timestamp <= b.deadline) revert TooEarly();
        address w = b.worker;
        uint256 d = b.deposit;
        b.worker = address(0); b.deadline = 0; b.state = State.Open;
        b.vault.send(BURN, d);
        emit Abandoned(id, w, d);
    }

    // ---------------------------------------------------------------- verdict

    /// @notice Verifier calls directly (EOA or adapter contract). Only valid while Submitted.
    function settle(uint256 id, bool accept) external nonReentrant {
        if (msg.sender != bounties[id].verifier) revert NotAllowed();
        _settle(id, accept);
    }

    /// @notice Anyone relays a verifier verdict signature (ECDSA or ERC-1271).
    function settleWithSig(uint256 id, bool accept, bytes calldata sig) external nonReentrant {
        Bounty storage b = bounties[id];
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(VERDICT_TYPEHASH, id, b.worker, b.evidenceHash, accept)));
        if (!SignatureChecker.isValidSignatureNow(b.verifier, digest, sig)) revert BadSig();
        _settle(id, accept);
    }

    /// @notice Verifier undoes its own REJECT during cooling. Separate intent from ACCEPT (stops verdict grinding, A4).
    function reverse(uint256 id) external nonReentrant {
        if (msg.sender != bounties[id].verifier) revert NotAllowed();
        _reverse(id);
    }

    function reverseWithSig(uint256 id, bytes calldata sig) external nonReentrant {
        Bounty storage b = bounties[id];
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(REVERSE_TYPEHASH, id, b.worker, b.evidenceHash)));
        if (!SignatureChecker.isValidSignatureNow(b.verifier, digest, sig)) revert BadSig();
        _reverse(id);
    }

    /// @notice Anyone: verifier silent past review → worker is paid.
    function payOnTimeout(uint256 id) external nonReentrant {
        Bounty storage b = bounties[id];
        if (b.state != State.Submitted) revert BadState();
        if (block.timestamp <= b.deadline) revert TooEarly();
        _accept(id, b, true);
    }

    /// @notice Anyone: cooling over → reject is final. BURN: P + D burn. REFUND: P to agent, D burns.
    function finalizeReject(uint256 id) external nonReentrant {
        Bounty storage b = bounties[id];
        if (b.state != State.Rejected) revert BadState();
        if (block.timestamp <= b.deadline) revert TooEarly();
        if (b.rejectMode == RejectMode.Refund) {
            b.state = State.Refunded;
            b.vault.send(BURN, b.deposit);
            _pay(id, b, b.agent, b.reward);
            emit Refunded(id, b.reward, b.deposit);
        } else {
            b.state = State.Burned;
            uint256 amt = uint256(b.reward) + b.deposit;
            b.vault.send(BURN, amt); // a frozen vault leaves funds locked forever: same economic outcome
            emit Burned(id, amt);
        }
    }

    function withdraw(uint256 id) external nonReentrant {
        uint256 amt = owed[id][msg.sender];
        if (amt == 0) revert BadParam();
        owed[id][msg.sender] = 0;
        if (!bounties[id].vault.send(msg.sender, amt)) revert TransferFailed();
        emit Withdrawn(id, msg.sender, amt);
    }

    // --------------------------------------------------------------- internal

    function _settle(uint256 id, bool accept) internal {
        Bounty storage b = bounties[id];
        if (b.state != State.Submitted) revert BadState();
        if (block.timestamp > b.deadline) revert TooLate();
        if (accept) {
            _accept(id, b, false);
        } else {
            b.state = State.Rejected;
            b.deadline = uint64(block.timestamp) + COOLING;
            emit Rejected(id, b.deadline);
        }
    }

    function _reverse(uint256 id) internal {
        Bounty storage b = bounties[id];
        if (b.state != State.Rejected) revert BadState();
        if (block.timestamp > b.deadline) revert TooLate();
        emit Reversed(id);
        _accept(id, b, false);
    }

    function _accept(uint256 id, Bounty storage b, bool byTimeout) internal {
        b.state = State.Paid;
        uint256 fee = uint256(b.reward) * FEE_BPS / 10_000;
        uint256 toWorker = uint256(b.reward) - fee + b.deposit;
        _pay(id, b, b.worker, toWorker);
        _pay(id, b, treasury, fee);
        emit Paid(id, b.worker, toWorker, fee, byTimeout);
    }

    /// @dev Push; on failure credit `owed` so one blocked address never stalls the bounty.
    function _pay(uint256 id, Bounty storage b, address to, uint256 amt) internal {
        if (amt == 0) return;
        if (!b.vault.send(to, amt)) {
            owed[id][to] += amt;
            emit Owed(id, to, amt);
        }
    }

    function _pull(address from, address to, uint256 amt) internal {
        if (amt == 0) return;
        uint256 before = usdc.balanceOf(to);
        if (!usdc.transferFrom(from, to, amt)) revert TransferFailed();
        if (usdc.balanceOf(to) - before != amt) revert TransferFailed();
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
