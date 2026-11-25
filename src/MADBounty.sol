// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MADBounty — agent-posted bounties for humans, settled by dual-deposit (MAD) escrow.
/// @notice Rules (also the platform T&C): the agent locks the reward + a bond; the worker locks a deposit.
///         The agent's attested verifier signs ACCEPT or REJECT. ACCEPT pays the worker. REJECT burns the
///         reward, the bond and the worker deposit to `SINK` after a cooling window. Rejected money NEVER
///         returns to the agent, so rejecting honest work can't profit the agent. Verifier silence pays the worker.
///         Spec and evidence are 0G Storage root hashes; the verifier is a TEE signing key bound to `policyHash`.
contract MADBounty {
    enum State { None, Open, Claimed, Submitted, Rejected, Paid, Burned, Refunded }

    struct Bounty {
        address agent;          // poster; funds come from here
        address verifier;       // TEE signer that judges submissions
        bytes32 policyHash;     // hash of acceptance policy + model + code measurement (attested)
        bytes32 specRoot;       // 0G Storage root of the task spec
        bytes32 evidenceRoot;   // 0G Storage root of the worker's evidence
        uint128 reward;
        uint128 agentBond;
        uint128 workerDeposit;  // locked when claimed
        uint16 depositBps;      // base worker deposit, in bps of reward
        uint32 workWindow;      // seconds the worker has after claiming
        uint32 reviewWindow;    // seconds the verifier has after submission
        uint64 expiry;          // unclaimed bounty can be refunded after this
        address worker;
        uint64 deadline;        // current phase deadline
        State state;
    }

    struct AgentStats { uint64 posted; uint64 paid; uint64 rejected; uint128 burned; }
    struct WorkerStats { uint64 paid; uint64 rejected; uint64 abandoned; }

    address public constant SINK = 0x000000000000000000000000000000000000dEaD;
    uint32 public constant COOLING = 1 days;   // verifier may reverse a REJECT (bug fix) inside this window
    bytes32 public constant VERDICT_TYPEHASH =
        keccak256("Verdict(uint256 id,bytes32 evidenceRoot,bytes32 policyHash,bool accept)");
    bytes32 public immutable DOMAIN_SEPARATOR;

    uint256 public nextId = 1;
    mapping(uint256 => Bounty) public bounties;
    mapping(address => AgentStats) public agentStats;
    mapping(address => WorkerStats) public workerStats;

    event Posted(uint256 indexed id, address indexed agent, uint256 reward, bytes32 specRoot, bytes32 policyHash);
    event Claimed(uint256 indexed id, address indexed worker, uint256 deposit, uint64 deadline);
    event Submitted(uint256 indexed id, bytes32 evidenceRoot, uint64 reviewDeadline);
    event Verdict(uint256 indexed id, bool accept);
    event Paid(uint256 indexed id, address indexed worker, uint256 amount);
    event Burned(uint256 indexed id, uint256 amount);
    event Refunded(uint256 indexed id, uint256 amount);

    error BadState();
    error BadValue();
    error TooEarly();
    error TooLate();
    error NotWorker();
    error BadSig();

    constructor() {
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("MADBounty"), keccak256("1"), block.chainid, address(this)));
    }

    // ---------------- agent ----------------

    /// @param reward bounty paid to the worker; msg.value must equal reward + agentBond
    function post(
        address verifier, bytes32 policyHash, bytes32 specRoot, uint128 reward,
        uint16 depositBps, uint32 workWindow, uint32 reviewWindow, uint64 expiry
    ) external payable returns (uint256 id) {
        if (reward == 0 || msg.value < reward || depositBps > 10_000 || verifier == address(0)) revert BadValue();
        if (expiry <= block.timestamp || workWindow == 0 || reviewWindow == 0) revert BadValue();
        id = nextId++;
        Bounty storage b = bounties[id];
        b.agent = msg.sender; b.verifier = verifier; b.policyHash = policyHash; b.specRoot = specRoot;
        b.reward = reward; b.agentBond = uint128(msg.value - reward); b.depositBps = depositBps;
        b.workWindow = workWindow; b.reviewWindow = reviewWindow; b.expiry = expiry; b.state = State.Open;
        agentStats[msg.sender].posted++;
        emit Posted(id, msg.sender, reward, specRoot, policyHash);
    }

    /// @notice Unclaimed bounty past expiry: full refund to the agent.
    function refundExpired(uint256 id) external {
        Bounty storage b = bounties[id];
        if (b.state != State.Open) revert BadState();
        if (block.timestamp <= b.expiry) revert TooEarly();
        b.state = State.Refunded;
        uint256 amt = uint256(b.reward) + b.agentBond;
        _send(b.agent, amt);
        emit Refunded(id, amt);
    }

    // ---------------- worker ----------------

    /// @notice Deposit shrinks with track record: base * 10 / (10 + paid), floor 1 wei-bps.
    function requiredDeposit(uint256 id, address worker) public view returns (uint256) {
        Bounty storage b = bounties[id];
        uint256 base = uint256(b.reward) * b.depositBps / 10_000;
        return base * 10 / (10 + workerStats[worker].paid);
    }

    function claim(uint256 id) external payable {
        Bounty storage b = bounties[id];
        if (b.state != State.Open) revert BadState();
        if (block.timestamp > b.expiry) revert TooLate();
        if (msg.value != requiredDeposit(id, msg.sender)) revert BadValue();
        b.worker = msg.sender; b.workerDeposit = uint128(msg.value);
        b.deadline = uint64(block.timestamp) + b.workWindow; b.state = State.Claimed;
        emit Claimed(id, msg.sender, msg.value, b.deadline);
    }

    function submit(uint256 id, bytes32 evidenceRoot) external {
        Bounty storage b = bounties[id];
        if (b.state != State.Claimed) revert BadState();
        if (msg.sender != b.worker) revert NotWorker();
        if (block.timestamp > b.deadline) revert TooLate();
        b.evidenceRoot = evidenceRoot;
        b.deadline = uint64(block.timestamp) + b.reviewWindow; b.state = State.Submitted;
        emit Submitted(id, evidenceRoot, b.deadline);
    }

    /// @notice Worker missed the work window: bounty reopens, worker deposit goes to SINK (not the agent).
    function reclaimAbandoned(uint256 id) external {
        Bounty storage b = bounties[id];
        if (b.state != State.Claimed) revert BadState();
        if (block.timestamp <= b.deadline) revert TooEarly();
        uint256 dep = b.workerDeposit;
        workerStats[b.worker].abandoned++;
        b.worker = address(0); b.workerDeposit = 0; b.deadline = 0; b.state = State.Open;
        _send(SINK, dep);
        emit Burned(id, dep);
    }

    // ---------------- verdict (anyone relays the TEE-signed verdict) ----------------

    function settle(uint256 id, bool accept, uint8 v, bytes32 r, bytes32 s) external {
        Bounty storage b = bounties[id];
        bool reversal = b.state == State.Rejected && accept;
        if (b.state != State.Submitted && !reversal) revert BadState();
        if (b.state == State.Submitted && block.timestamp > b.deadline) revert TooLate();
        if (reversal && block.timestamp > b.deadline) revert TooLate();
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR,
            keccak256(abi.encode(VERDICT_TYPEHASH, id, b.evidenceRoot, b.policyHash, accept))));
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0) || signer != b.verifier) revert BadSig();
        emit Verdict(id, accept);
        if (accept) {
            if (reversal) agentStats[b.agent].rejected--;
            _pay(id, b);
        } else {
            b.state = State.Rejected; b.deadline = uint64(block.timestamp) + COOLING;
            agentStats[b.agent].rejected++;
        }
    }

    /// @notice Verifier stayed silent past the review window: worker is paid (silence can't be a weapon).
    function payOnTimeout(uint256 id) external {
        Bounty storage b = bounties[id];
        if (b.state != State.Submitted) revert BadState();
        if (block.timestamp <= b.deadline) revert TooEarly();
        _pay(id, b);
    }

    /// @notice After the cooling window a REJECT becomes final: everything goes to SINK.
    function finalizeBurn(uint256 id) external {
        Bounty storage b = bounties[id];
        if (b.state != State.Rejected) revert BadState();
        if (block.timestamp <= b.deadline) revert TooEarly();
        b.state = State.Burned;
        uint256 amt = uint256(b.reward) + b.agentBond + b.workerDeposit;
        agentStats[b.agent].burned += uint128(amt);
        workerStats[b.worker].rejected++;
        _send(SINK, amt);
        emit Burned(id, amt);
    }

    // ---------------- internal ----------------

    function _pay(uint256 id, Bounty storage b) internal {
        b.state = State.Paid;
        agentStats[b.agent].paid++;
        workerStats[b.worker].paid++;
        uint256 toWorker = uint256(b.reward) + b.workerDeposit;
        _send(b.worker, toWorker);
        if (b.agentBond > 0) _send(b.agent, b.agentBond);
        emit Paid(id, b.worker, toWorker);
    }

    function _send(address to, uint256 amt) internal {
        (bool ok,) = to.call{value: amt}("");
        require(ok, "send");
    }
}
