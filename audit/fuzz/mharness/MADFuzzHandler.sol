// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MADBountyCore, BountyVault, IERC20} from "../msrc/MADBountyCore.sol";

/// Cheatcodes supported by Foundry, medusa and echidna alike.
interface IHevm {
    function warp(uint256) external;
    function prank(address) external;
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function addr(uint256) external returns (address);
}

/// USDC-like: pausable, blacklist checks from / to / msg.sender (FiatToken semantics).
contract FuzzUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blacklisted;
    bool public paused;
    uint256 public totalSupply;
    address public immutable admin;

    constructor() { admin = msg.sender; }

    modifier onlyAdmin() { require(msg.sender == admin, "admin"); _; }
    function mint(address to, uint256 a) external onlyAdmin { balanceOf[to] += a; totalSupply += a; }
    function setAllowance(address o, address s, uint256 a) external onlyAdmin { allowance[o][s] = a; }
    function setBlacklist(address a, bool b) external onlyAdmin { blacklisted[a] = b; }
    function setPaused(bool p) external onlyAdmin { paused = p; }

    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { _move(msg.sender, to, a); return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a; _move(f, to, a); return true;
    }
    function _move(address f, address to, uint256 a) internal {
        require(!paused, "paused");
        require(!blacklisted[f] && !blacklisted[to] && !blacklisted[msg.sender], "blacklisted");
        balanceOf[f] -= a; balanceOf[to] += a;
    }
}

/// Stateful handler. Every core call goes through _exec, which snapshots all balances + owed entries, performs
/// the call as the chosen actor, then checks the exact per-function money flow and state transition. Any
/// mismatch latches `violated` + a reason string. Invariant/property functions read the latch plus global
/// accounting. Same contract is the medusa/echidna target (property_* functions) and the Foundry handler.
contract MADFuzzHandler {
    IHevm internal constant vm = IHevm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    address internal constant BURN = 0x000000000000000000000000000000000000dEaD;

    enum K { Cancel, Expire, Claim, Submit, Reclaim, SettleT, SettleF, SigT, SigF, Timeout, Reverse, ReverseSig,
        Final, Extend, Withdraw, RetryBurn }

    MADBountyCore public core;
    FuzzUSDC public usdc;
    address public treasury = address(0x7EA5);
    uint256 internal constant V0K = 0xA11CE;
    uint256 internal constant V1K = 0xB0B0B;
    uint256 internal constant AUTHK = 0xA0A0A;
    address public v0; address public v1; address public authSigner;
    // tracked: 0,1 agents | 2,3 workers | 4 griefer | 5,6 verifiers | 7 treasury | 8 BURN
    address[9] public T;
    uint256[] public ids;
    uint256 public supply;

    // ---- latches / ghosts
    bool public violated;
    string public why;
    uint256 public why_id;
    mapping(uint256 => uint256) public workerGain;   // cumulative worker-role value gained per id (payouts)
    mapping(uint256 => uint256) public treasuryGain; // cumulative treasury value gained per id
    mapping(uint256 => uint256) public terminalEntries;
    mapping(uint256 => mapping(address => uint256)) public credited;  // owed increments
    mapping(uint256 => mapping(address => uint256)) public withdrawnAmt;
    mapping(uint256 => uint256) public timeoutPaidFromRejected;
    // signature bank (every verifier signature ever produced, for replay by the griefer)
    struct Sig { uint256 id; bool isReverse; bool accept; bytes sig; }
    Sig[] internal bank;

    // ---- call stats
    uint256[16] public okCount;
    uint256 public callsTotal;
    bool internal gasMode;
    uint256 public gasGriefOwed;     // owed credited with nobody blocked, under a griefer-chosen gas limit

    struct Snap { uint256[] bal; uint256[] vbal; uint256[][] owed; uint8[] st; }

    constructor() {
        usdc = new FuzzUSDC();
        core = new MADBountyCore(IERC20(address(usdc)), treasury, "ipfs://m", bytes32(0));
        v0 = vm.addr(V0K); v1 = vm.addr(V1K); authSigner = vm.addr(AUTHK);
        T = [address(0xA6E0), address(0xA6E1), address(0xB0E0), address(0xB0E1), address(0x6E1EF), v0, v1, treasury, BURN];
        for (uint256 i; i < 7; i++) {
            usdc.mint(T[i], 100_000e6);
            usdc.setAllowance(T[i], address(core), type(uint256).max);
        }
        supply = usdc.totalSupply();
    }

    // ================================================================ utils
    function _bd(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) { return lo + x % (hi - lo + 1); }
    function _b(uint256 id) internal view returns (MADBountyCore.Bounty memory b) {
        (b.agent, b.verifier, b.claimAuthorizer, b.worker, b.vault, b.reward, b.deposit, b.workWindow, b.reviewWindow,
            b.openUntil, b.deadline, b.extended, b.rejectMode, b.state, b.evidenceHash) = core.bounties(id);
    }
    function _id(uint256 s) internal view returns (uint256) {
        if (ids.length == 0) return 1;
        if (s % 16 == 0) return ids.length + 1 + (s >> 4) % 2; // occasionally a nonexistent id
        return ids[(s >> 4) % ids.length];
    }
    function _idIn(uint256 s, MADBountyCore.State st) internal view returns (uint256) {
        if (s % 5 == 0 || ids.length == 0) return _id(s >> 3);
        uint256 n;
        for (uint256 i; i < ids.length; i++) if (_b(ids[i]).state == st) n++;
        if (n == 0) return _id(s >> 3);
        uint256 k = (s >> 3) % n;
        for (uint256 i; i < ids.length; i++) if (_b(ids[i]).state == st) { if (k == 0) return ids[i]; k--; }
        return _id(s);
    }
    function _fail(string memory r, uint256 id) internal {
        if (!violated) { violated = true; why = r; why_id = id; }
    }
    function _vk(address v) internal view returns (uint256) { return v == v0 ? V0K : v == v1 ? V1K : 0; }
    function _sign(uint256 key, bytes32 sh) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", core.domainSeparator(), sh)));
        return abi.encodePacked(r, s, v);
    }

    function _snap() internal view returns (Snap memory s) {
        s.bal = new uint256[](9); s.vbal = new uint256[](ids.length); s.owed = new uint256[][](ids.length);
        s.st = new uint8[](ids.length);
        for (uint256 i; i < 9; i++) s.bal[i] = usdc.balanceOf(T[i]);
        for (uint256 j; j < ids.length; j++) {
            MADBountyCore.Bounty memory b = _b(ids[j]);
            s.vbal[j] = usdc.balanceOf(address(b.vault));
            s.st[j] = uint8(b.state);
            s.owed[j] = new uint256[](9);
            for (uint256 i; i < 9; i++) s.owed[j][i] = core.owed(ids[j], T[i]);
        }
    }

    function _idx(address a) internal view returns (uint256) {
        for (uint256 i; i < 9; i++) if (T[i] == a) return i;
        return 99;
    }

    // ================================================================ the checked call
    function _exec(K k, uint256 id, address caller, bytes memory data, uint256 gasLim) internal returns (bool ok) {
        callsTotal++;
        Snap memory pre = _snap();
        MADBountyCore.Bounty memory bp = _b(id);
        uint256 ts = block.timestamp;
        vm.prank(caller);
        if (gasLim == 0) (ok,) = address(core).call(data);
        else (ok,) = address(core).call{gas: gasLim}(data);
        gasMode = gasLim != 0;
        if (!ok) { if (gasLim == 0) _liveness(k, id, bp, ts); return ok; }
        okCount[uint256(k)]++;
        _checkCall(k, id, caller, bp, pre, _snap(), ts);
    }

    /// Permissionless exits must never revert once their condition holds (with ample gas).
    function _liveness(K k, uint256 id, MADBountyCore.Bounty memory b, uint256 ts) internal {
        if (k == K.Timeout && b.state == MADBountyCore.State.Submitted && ts > b.deadline) _fail("live: payOnTimeout", id);
        if (k == K.Final && b.state == MADBountyCore.State.Rejected && ts > b.deadline) _fail("live: finalizeReject", id);
        if (k == K.Expire && b.state == MADBountyCore.State.Open && ts > b.openUntil) _fail("live: refundExpired", id);
        if (k == K.Reclaim && b.state == MADBountyCore.State.Claimed && ts > b.deadline) _fail("live: reclaim", id);
    }

    function _checkCall(K k, uint256 id, address caller, MADBountyCore.Bounty memory bp, Snap memory pre,
        Snap memory pst, uint256 ts) internal
    {
        uint256 j = 99;
        for (uint256 x; x < ids.length; x++) if (ids[x] == id) j = x;
        if (j == 99) { _fail("success on unknown id", id); return; }
        MADBountyCore.Bounty memory ba = _b(id);
        MADBountyCore.State S = bp.state;
        MADBountyCore.State A = ba.state;
        uint256 fee = uint256(bp.reward) / 100;

        // ---- (2)/(4)/(7) transition table per entry point
        bool okT;
        if (k == K.Cancel) okT = S == MADBountyCore.State.Open && A == MADBountyCore.State.Cancelled && caller == bp.agent && bp.worker == address(0);
        else if (k == K.Expire) okT = S == MADBountyCore.State.Open && A == MADBountyCore.State.Cancelled && ts > bp.openUntil && bp.worker == address(0);
        else if (k == K.Claim) okT = S == MADBountyCore.State.Open && A == MADBountyCore.State.Claimed && ts <= bp.openUntil && ba.worker == caller;
        else if (k == K.Submit) okT = S == MADBountyCore.State.Claimed && A == MADBountyCore.State.Submitted && caller == bp.worker && ts <= bp.deadline;
        else if (k == K.Reclaim) okT = S == MADBountyCore.State.Claimed && A == MADBountyCore.State.Open && ts > bp.deadline && ba.worker == address(0);
        else if (k == K.SettleT || k == K.SigT) okT = S == MADBountyCore.State.Submitted && A == MADBountyCore.State.Paid && ts <= bp.deadline;
        else if (k == K.SettleF || k == K.SigF) okT = S == MADBountyCore.State.Submitted && A == MADBountyCore.State.Rejected && ts <= bp.deadline && ba.deadline == ts + 24 hours;
        else if (k == K.Timeout) okT = S == MADBountyCore.State.Submitted && A == MADBountyCore.State.Paid && ts > bp.deadline;
        else if (k == K.Reverse || k == K.ReverseSig) okT = S == MADBountyCore.State.Rejected && A == MADBountyCore.State.Paid && ts <= bp.deadline;
        else if (k == K.Final) okT = S == MADBountyCore.State.Rejected && ts > bp.deadline
            && A == (bp.rejectMode == MADBountyCore.RejectMode.Refund ? MADBountyCore.State.Refunded : MADBountyCore.State.Burned);
        else if (k == K.Extend) okT = S == MADBountyCore.State.Submitted && A == S && !bp.extended && ba.extended
            && ba.deadline == bp.deadline + bp.reviewWindow && (caller == bp.agent || caller == bp.verifier) && ts <= bp.deadline;
        else okT = A == S; // withdraw / retryBurn
        if (!okT) _fail(string.concat("transition k=", _u(uint256(k)), " from=", _u(uint256(S)), " to=", _u(uint256(A))), id);
        if (k == K.Timeout && S == MADBountyCore.State.Rejected) { timeoutPaidFromRejected[id]++; _fail("timeout from Rejected", id); }
        if (uint8(S) >= uint8(MADBountyCore.State.Paid) && A != S) _fail("left terminal", id);
        if (uint8(S) < uint8(MADBountyCore.State.Paid) && uint8(A) >= uint8(MADBountyCore.State.Paid)) terminalEntries[id]++;
        if (terminalEntries[id] > 1) _fail("two terminal outcomes", id);

        // ---- other bounties untouched
        for (uint256 x; x < ids.length; x++) {
            if (x == j) continue;
            if (pre.vbal[x] != pst.vbal[x] || pre.st[x] != pst.st[x]) _fail("other bounty touched", ids[x]);
            for (uint256 i; i < 9; i++) if (pre.owed[x][i] != pst.owed[x][i]) _fail("other owed touched", ids[x]);
        }

        // ---- (1)(3)(5) exact value-claim deltas: claim = balance + owed[id]
        int256[9] memory exp;
        if (k == K.Cancel || k == K.Expire) _add(exp, bp.agent, int256(uint256(bp.reward)));
        else if (k == K.Claim) _add(exp, caller, -int256(uint256(bp.deposit)));
        else if (k == K.Reclaim) _add(exp, BURN, int256(uint256(bp.deposit)));
        else if (A == MADBountyCore.State.Paid && S != A) {
            _add(exp, bp.worker, int256(uint256(bp.reward) - fee + bp.deposit));
            _add(exp, treasury, int256(fee));
        } else if (k == K.Final) {
            if (bp.rejectMode == MADBountyCore.RejectMode.Refund) {
                _add(exp, bp.agent, int256(uint256(bp.reward))); _add(exp, BURN, int256(uint256(bp.deposit)));
            } else _add(exp, BURN, int256(uint256(bp.reward) + bp.deposit));
        }
        int256 sumBal;
        for (uint256 i; i < 9; i++) {
            int256 dBal = int256(pst.bal[i]) - int256(pre.bal[i]);
            int256 dOwed = int256(pst.owed[j][i]) - int256(pre.owed[j][i]);
            sumBal += dBal;
            if (dBal + dOwed != exp[i]) _fail(string.concat("value delta k=", _u(uint256(k)), " who=", _u(i)), id);
            if (dOwed > 0) {
                credited[id][T[i]] += uint256(dOwed);
                // owed may only arise when the push could genuinely fail
                bool blocked = usdc.paused() || usdc.blacklisted(T[i]) || usdc.blacklisted(address(bp.vault));
                if (!blocked) { if (gasMode) gasGriefOwed++; else _fail(string.concat("owed w/o block who=", _u(i)), id); }
            }
            if (dOwed < 0) {
                withdrawnAmt[id][T[i]] += uint256(-dOwed);
                if (withdrawnAmt[id][T[i]] > credited[id][T[i]]) _fail("withdrawn > credited", id);
                if (!(k == K.Withdraw && T[i] == caller) && !(k == K.RetryBurn && T[i] == BURN)) _fail("owed drained by wrong fn", id);
                if (pst.owed[j][i] != 0) _fail("partial withdraw", id);
            }
            if (i == 2 || i == 3) {} // workers tracked via role below
        }
        int256 dVault = int256(pst.vbal[j]) - int256(pre.vbal[j]);
        if (sumBal + dVault != 0) _fail("per-call conservation", id);
        if (usdc.totalSupply() != supply) _fail("supply", id);
        if (A == MADBountyCore.State.Paid && S != A) {
            uint256 wi = _idx(bp.worker);
            if (wi < 9) workerGain[id] += uint256(int256(pst.bal[wi]) - int256(pre.bal[wi]) + int256(pst.owed[j][wi]) - int256(pre.owed[j][wi]));
            treasuryGain[id] += uint256(int256(pst.bal[7]) - int256(pre.bal[7]) + int256(pst.owed[j][7]) - int256(pre.owed[j][7]));
            if (workerGain[id] > uint256(bp.reward) - fee + bp.deposit) _fail("worker overpaid", id);
            if (treasuryGain[id] != fee) _fail("fee != 1%", id);
        }
    }

    function _add(int256[9] memory e, address a, int256 v) internal view { uint256 i = _idx(a); if (i < 9) e[i] += v; }
    function _u(uint256 v) internal pure returns (string memory s) {
        if (v == 0) return "0";
        bytes memory b; while (v > 0) { b = abi.encodePacked(bytes1(uint8(48 + v % 10)), b); v /= 10; } s = string(b);
    }

    // ================================================================ actions (agents / workers / verifiers)
    function post(uint256 agentS, uint96 reward, uint96 depS, bool refund, uint8 vS, uint32 openS, uint32 work,
        uint32 review, bool withAuth) public
    {
        if (ids.length >= 40) return;
        uint256 live;
        for (uint256 i; i < ids.length; i++) if (uint8(_b(ids[i]).state) < uint8(MADBountyCore.State.Paid)) live++;
        if (live >= 8) return;
        reward = uint96(_bd(reward, 1e6, 1_000e6));
        if (agentS % 7 == 0) reward = uint96(_bd(reward, 1e6, 5e6)); // small rewards: rounding edges
        uint96 d = uint96(_bd(depS, core.minDeposit(reward), reward));
        address agent = T[agentS % 2];
        address ver = vS % 4 == 3 ? agent : (vS % 2 == 0 ? v0 : v1); // agent-as-verifier allowed (REFUND design)
        MADBountyCore.Params memory p = MADBountyCore.Params({
            verifier: ver, claimAuthorizer: withAuth ? authSigner : address(0), reward: reward, deposit: d,
            workWindow: uint32(_bd(work, 1 hours, 3 days)), reviewWindow: uint32(_bd(review, 12 hours, 3 days)),
            openUntil: uint64(block.timestamp + _bd(openS, 1 hours, 10 days)),
            rejectMode: refund ? MADBountyCore.RejectMode.Refund : MADBountyCore.RejectMode.Burn,
            specHash: bytes32(uint256(reward)), encKey: "", verifierInit: ""
        });
        uint256 b0 = usdc.balanceOf(agent);
        vm.prank(agent);
        try core.post(p) returns (uint256 id) {
            ids.push(id);
            MADBountyCore.Bounty memory b = _b(id);
            if (usdc.balanceOf(address(b.vault)) != reward || b0 - usdc.balanceOf(agent) != reward) _fail("post flow", id);
            if (b.state != MADBountyCore.State.Open || b.worker != address(0)) _fail("post state", id);
        } catch {}
    }

    function claim(uint256 idS, uint256 who, uint256 authDl) public {
        uint256 id = _idIn(idS, MADBountyCore.State.Open);
        address w = who % 5 == 4 ? T[4] : (who % 5 == 3 ? T[who % 2] : T[2 + who % 2]); // workers, griefer, or agent self-claim
        bytes memory sig;
        uint256 dl = block.timestamp + authDl % 2 days;
        if (_b(id).claimAuthorizer != address(0) && authDl % 5 != 0)
            sig = _sign(AUTHK, keccak256(abi.encode(core.CLAIM_TYPEHASH(), id, w, dl)));
        _exec(K.Claim, id, w, abi.encodeCall(MADBountyCore.claim, (id, dl, sig)), 0);
    }

    function submit(uint256 idS, bytes32 ev) public {
        uint256 id = _idIn(idS, MADBountyCore.State.Claimed);
        _exec(K.Submit, id, _b(id).worker, abi.encodeCall(MADBountyCore.submit, (id, ev)), 0);
    }

    function settle(uint256 idS, bool accept, bool useSig, uint256 relayer) public {
        uint256 id = _idIn(idS, MADBountyCore.State.Submitted);
        MADBountyCore.Bounty memory b = _b(id);
        uint256 key = _vk(b.verifier);
        if (!useSig || key == 0) {
            _exec(accept ? K.SettleT : K.SettleF, id, b.verifier, abi.encodeCall(MADBountyCore.settle, (id, accept)), 0);
            return;
        }
        bytes memory sig = _sign(key, keccak256(abi.encode(core.VERDICT_TYPEHASH(), id, b.worker, b.evidenceHash, accept)));
        bank.push(Sig(id, false, accept, sig));
        _exec(accept ? K.SigT : K.SigF, id, T[relayer % 5], abi.encodeCall(MADBountyCore.settleWithSig, (id, accept, sig)), 0);
    }

    /// Verifier signs a verdict but it is NOT relayed now (leaked / pre-signed). Griefer may replay later.
    function presign(uint256 idS, bool accept, bool isReverse) public {
        uint256 id = _id(idS);
        MADBountyCore.Bounty memory b = _b(id);
        uint256 key = _vk(b.verifier);
        if (key == 0) return;
        bytes memory sig = isReverse
            ? _sign(key, keccak256(abi.encode(core.REVERSE_TYPEHASH(), id, b.worker, b.evidenceHash)))
            : _sign(key, keccak256(abi.encode(core.VERDICT_TYPEHASH(), id, b.worker, b.evidenceHash, accept)));
        bank.push(Sig(id, isReverse, accept, sig));
    }

    function reverse(uint256 idS, bool useSig, uint256 relayer) public {
        uint256 id = _idIn(idS, MADBountyCore.State.Rejected);
        MADBountyCore.Bounty memory b = _b(id);
        uint256 key = _vk(b.verifier);
        if (!useSig || key == 0) { _exec(K.Reverse, id, b.verifier, abi.encodeCall(MADBountyCore.reverse, (id)), 0); return; }
        bytes memory sig = _sign(key, keccak256(abi.encode(core.REVERSE_TYPEHASH(), id, b.worker, b.evidenceHash)));
        bank.push(Sig(id, true, true, sig));
        _exec(K.ReverseSig, id, T[relayer % 5], abi.encodeCall(MADBountyCore.reverseWithSig, (id, sig)), 0);
    }

    function extendReview(uint256 idS, bool byAgent) public {
        uint256 id = _idIn(idS, MADBountyCore.State.Submitted);
        MADBountyCore.Bounty memory b = _b(id);
        _exec(K.Extend, id, byAgent ? b.agent : b.verifier, abi.encodeCall(MADBountyCore.extendReview, (id)), 0);
    }

    function cancel(uint256 idS) public {
        if (idS % 8 != 0) return; // keep bounties alive longer
        uint256 id = _idIn(idS, MADBountyCore.State.Open);
        _exec(K.Cancel, id, _b(id).agent, abi.encodeCall(MADBountyCore.cancel, (id)), 0);
    }

    function withdraw(uint256 idS, uint256 who) public {
        uint256 id = _id(idS);
        _exec(K.Withdraw, id, T[who % 8], abi.encodeCall(MADBountyCore.withdraw, (id)), 0);
    }

    // ================================================================ permissionless / griefer
    function poke(uint8 fn, uint256 idS, uint256 who) public {
        address c = T[who % 7];
        fn = fn % 5;
        if (fn == 0) { uint256 id = _idIn(idS, (idS >> 200) % 3 == 0 ? MADBountyCore.State.Rejected : MADBountyCore.State.Submitted); _exec(K.Timeout, id, c, abi.encodeCall(MADBountyCore.payOnTimeout, (id)), 0); }
        else if (fn == 1) { uint256 id = _idIn(idS, MADBountyCore.State.Rejected); _exec(K.Final, id, c, abi.encodeCall(MADBountyCore.finalizeReject, (id)), 0); }
        else if (fn == 2) { uint256 id = _idIn(idS, MADBountyCore.State.Open); _exec(K.Expire, id, c, abi.encodeCall(MADBountyCore.refundExpired, (id)), 0); }
        else if (fn == 3) { uint256 id = _idIn(idS, MADBountyCore.State.Claimed); _exec(K.Reclaim, id, c, abi.encodeCall(MADBountyCore.reclaimAbandoned, (id)), 0); }
        else { uint256 id = _id(idS); _exec(K.RetryBurn, id, c, abi.encodeCall(MADBountyCore.retryBurn, (id)), 0); }
    }

    /// Griefer calls privileged entry points on arbitrary bounties. Any success is checked by the same table,
    /// so e.g. a griefer cancel succeeding would fail "transition" (caller != agent).
    function griefPrivileged(uint8 fn, uint256 idS, bool b, bytes32 x) public {
        address g = T[4];
        uint256 id = _id(idS);
        fn = fn % 6;
        if (fn == 0) _exec(K.Cancel, id, g, abi.encodeCall(MADBountyCore.cancel, (id)), 0);
        else if (fn == 1) _exec(b ? K.SettleT : K.SettleF, id, g, abi.encodeCall(MADBountyCore.settle, (id, b)), 0);
        else if (fn == 2) _exec(K.Reverse, id, g, abi.encodeCall(MADBountyCore.reverse, (id)), 0);
        else if (fn == 3) _exec(K.Extend, id, g, abi.encodeCall(MADBountyCore.extendReview, (id)), 0);
        else if (fn == 4) _exec(K.Submit, id, g, abi.encodeCall(MADBountyCore.submit, (id, x)), 0);
        else _exec(b ? K.SigT : K.SigF, id, g, abi.encodeCall(MADBountyCore.settleWithSig, (id, b, abi.encodePacked(x, x, uint8(27)))), 0);
    }

    /// Replay any previously produced verifier signature on any bounty at any time.
    function replay(uint256 k, uint256 idS, bool keepId) public {
        if (bank.length == 0) return;
        Sig memory s = bank[k % bank.length];
        uint256 id = keepId ? s.id : _id(idS);
        if (s.isReverse) _exec(K.ReverseSig, id, T[4], abi.encodeCall(MADBountyCore.reverseWithSig, (id, s.sig)), 0);
        else _exec(s.accept ? K.SigT : K.SigF, id, T[4], abi.encodeCall(MADBountyCore.settleWithSig, (id, s.accept, s.sig)), 0);
    }

    /// 63/64 gas griefing: permissionless exits with a tight gas limit. If the call succeeds but credits owed
    /// while nobody is blocked, _checkCall flags "owed w/o block".
    function gasGrief(uint8 fn, uint256 idS, uint32 g) public {
        uint256 gl = _bd(g, 25_000, 400_000);
        fn = fn % 4;
        if (fn == 0) { uint256 id = _idIn(idS, (idS >> 200) % 3 == 0 ? MADBountyCore.State.Rejected : MADBountyCore.State.Submitted); _exec(K.Timeout, id, T[4], abi.encodeCall(MADBountyCore.payOnTimeout, (id)), gl); }
        else if (fn == 1) { uint256 id = _idIn(idS, MADBountyCore.State.Rejected); _exec(K.Final, id, T[4], abi.encodeCall(MADBountyCore.finalizeReject, (id)), gl); }
        else if (fn == 2) { uint256 id = _idIn(idS, MADBountyCore.State.Open); _exec(K.Expire, id, T[4], abi.encodeCall(MADBountyCore.refundExpired, (id)), gl); }
        else { uint256 id = _idIn(idS, MADBountyCore.State.Claimed); _exec(K.Reclaim, id, T[4], abi.encodeCall(MADBountyCore.reclaimAbandoned, (id)), gl); }
    }

    /// Griefer calls a vault directly: must always revert.
    function griefVault(uint256 idS, uint96 amt) public {
        uint256 id = _id(idS);
        address v = address(_b(id).vault);
        if (v == address(0)) return;
        vm.prank(T[4]);
        (bool ok,) = v.call(abi.encodeCall(BountyVault.send, (T[4], amt)));
        if (ok) _fail("vault.send by stranger", id);
    }

    // ================================================================ environment
    function togglePause(uint8 x) public { if (usdc.paused() || x % 4 == 0) usdc.setPaused(!usdc.paused()); }
    function toggleBlacklist(uint256 who, bool doIt) public {
        address a;
        uint256 w = who % 11;
        if (w < 9) a = T[w]; else { uint256 id = _id(who >> 4); a = address(_b(id).vault); if (a == address(0)) return; }
        if (!usdc.blacklisted(a) && !doIt) return; // unblacklist always, blacklist half the time
        usdc.setBlacklist(a, !usdc.blacklisted(a));
    }
    function warp(uint32 secs) public { vm.warp(block.timestamp + _bd(secs, 1, 4 days)); }
    function warpToDeadline(uint256 idS, uint8 mode) public {
        if (ids.length == 0) return;
        MADBountyCore.Bounty memory b = _b(ids[idS % ids.length]);
        uint256 d = b.state == MADBountyCore.State.Open ? b.openUntil : b.deadline;
        if (d == 0) return;
        uint256 t = d + (mode % 3) - 1;
        if (t > block.timestamp) vm.warp(t);
    }

    // ================================================================ global checks (views)
    function idsLength() external view returns (uint256) { return ids.length; }

    /// (1) conservation: global supply fully accounted and each vault == what its state + owed says.
    function checkConservation() public view returns (bool) {
        uint256 t;
        for (uint256 i; i < 9; i++) t += usdc.balanceOf(T[i]);
        t += usdc.balanceOf(address(core)) + usdc.balanceOf(core.vaultImpl()) + usdc.balanceOf(address(this));
        for (uint256 j; j < ids.length; j++) t += usdc.balanceOf(address(_b(ids[j]).vault));
        return t == supply && usdc.totalSupply() == supply;
    }

    function checkVaults() public view returns (bool) {
        for (uint256 j; j < ids.length; j++) {
            MADBountyCore.Bounty memory b = _b(ids[j]);
            uint256 bal = usdc.balanceOf(address(b.vault));
            uint256 o;
            for (uint256 i; i < 9; i++) o += core.owed(ids[j], T[i]);
            uint256 escrow;
            if (b.state == MADBountyCore.State.Open) escrow = b.reward;
            else if (b.state == MADBountyCore.State.Claimed || b.state == MADBountyCore.State.Submitted
                || b.state == MADBountyCore.State.Rejected) escrow = uint256(b.reward) + b.deposit;
            if (bal != escrow + o) return false;
            if (b.state == MADBountyCore.State.Open && b.worker != address(0)) return false;
        }
        return true;
    }

    /// (3) treasury gets exactly 1% of reward per Paid bounty, nothing otherwise; worker cap.
    function checkFees() public view returns (bool) {
        uint256 expT; uint256 owedT;
        for (uint256 j; j < ids.length; j++) {
            MADBountyCore.Bounty memory b = _b(ids[j]);
            uint256 fee = uint256(b.reward) / 100;
            if (b.state == MADBountyCore.State.Paid) { expT += fee; if (treasuryGain[ids[j]] != fee) return false; }
            else if (treasuryGain[ids[j]] != 0) return false;
            if (workerGain[ids[j]] > uint256(b.reward) - fee + b.deposit) return false;
            owedT += core.owed(ids[j], treasury);
        }
        return usdc.balanceOf(treasury) + owedT == expT;
    }

    /// (5) no owed entries for addresses that are not a party of the bounty (agent, worker-ever, treasury, BURN).
    function checkOwedParties() public view returns (bool) {
        for (uint256 j; j < ids.length; j++) {
            if (core.owed(ids[j], T[4]) != 0 && credited[ids[j]][T[4]] == 0) return false;
            if (core.owed(ids[j], v0) != 0 || core.owed(ids[j], v1) != 0) {
                MADBountyCore.Bounty memory b = _b(ids[j]);
                if (b.agent != v0 && b.agent != v1) return false;
            }
        }
        return true;
    }

    // medusa / echidna property entry points
    function property_noViolation() public view returns (bool) { return !violated; }
    function property_conservation() public view returns (bool) { return checkConservation(); }
    function property_vaults() public view returns (bool) { return checkVaults(); }
    function property_fees() public view returns (bool) { return checkFees(); }
    function property_owedParties() public view returns (bool) { return checkOwedParties(); }
    function property_noGasGriefOwed() public view returns (bool) { return gasGriefOwed == 0; }
}
