// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {MADBountyCore, BountyVault, IERC20} from "../../src/MADBountyCore.sol";
import {AuditUSDC} from "./AuditBase.sol";

/// Drives random sequences across many actors and bounties. Every action is attempted with a low-level
/// call; reverts are counted, never propagated, so the fuzzer explores freely.
contract CoreHandler is Test {
    MADBountyCore public core;
    AuditUSDC public usdc;
    address public treasury;
    address[] public actors;           // agents and workers (any actor can play any role)
    uint256[] public vkeys;            // verifier keys
    address[] public verifiers;
    uint256[] public ids;
    mapping(uint256 => uint8) public terminalSeen; // 0 = not yet terminal, else State+1 recorded
    mapping(bytes32 => uint256) public calls;
    mapping(bytes32 => uint256) public oks;
    bool public terminalChanged;

    constructor(MADBountyCore c, AuditUSDC u, address t) {
        core = c; usdc = u; treasury = t;
        for (uint256 i; i < 5; i++) {
            address a = makeAddr(string.concat("actor", vm.toString(i)));
            actors.push(a);
            u.mint(a, 1_000_000e6);
            vm.prank(a); u.approve(address(c), type(uint256).max);
        }
        for (uint256 i; i < 2; i++) { vkeys.push(0xA11CE + i); verifiers.push(vm.addr(0xA11CE + i)); }
    }

    // ---------------------------------------------------------------- views for the test
    function idsLength() external view returns (uint256) { return ids.length; }
    function actorsLength() external view returns (uint256) { return actors.length; }
    function allIds() external view returns (uint256[] memory) { return ids; }
    function allActors() external view returns (address[] memory) { return actors; }

    function _b(uint256 id) internal view returns (MADBountyCore.Bounty memory b) {
        (b.agent, b.verifier, b.claimAuthorizer, b.worker, b.vault, b.reward, b.deposit, b.workWindow, b.reviewWindow,
            b.openUntil, b.deadline, b.extended, b.rejectMode, b.state, b.evidenceHash) = core.bounties(id);
    }

    function _id(uint256 seed) internal view returns (uint256) { return ids.length == 0 ? 1 : ids[seed % ids.length]; }

    /// 3 in 4: pick a bounty currently in state `s` (steers the fuzzer onto live paths); else any id.
    function _idIn(uint256 seed, MADBountyCore.State s) internal view returns (uint256) {
        if (seed % 4 == 0 || ids.length == 0) return _id(seed >> 2);
        uint256 n;
        for (uint256 i; i < ids.length; i++) if (_b(ids[i]).state == s) n++;
        if (n == 0) return _id(seed >> 2);
        uint256 k = (seed >> 2) % n;
        for (uint256 i; i < ids.length; i++) if (_b(ids[i]).state == s) { if (k == 0) return ids[i]; k--; }
        return _id(seed);
    }

    /// Warp to just before / at / just after a live deadline of some bounty (boundary hunting).
    function warpToDeadline(uint256 idSeed, uint8 mode) external {
        calls["warpDl"]++;
        uint256 id = _id(idSeed);
        MADBountyCore.Bounty memory b = _b(id);
        uint256 d = b.state == MADBountyCore.State.Open ? b.openUntil : b.deadline;
        if (d == 0) return;
        uint256 target = d + (mode % 3) - 1; // d-1, d, d+1
        if (target > block.timestamp) { vm.warp(target); oks["warpDl"]++; }
    }
    function _actor(uint256 seed) internal view returns (address) { return actors[seed % actors.length]; }

    function _do(bytes32 tag, address who, bytes memory data) internal {
        calls[tag]++;
        vm.prank(who);
        (bool ok,) = address(core).call(data);
        if (ok) oks[tag]++;
        _recordTerminals();
    }

    function _recordTerminals() internal {
        for (uint256 i; i < ids.length; i++) {
            uint8 s = uint8(_b(ids[i]).state);
            bool terminal = s >= uint8(MADBountyCore.State.Paid);
            uint8 seen = terminalSeen[ids[i]];
            if (seen != 0 && seen != s + 1) terminalChanged = true;
            if (seen == 0 && terminal) terminalSeen[ids[i]] = s + 1;
        }
    }

    // ---------------------------------------------------------------- actions
    function post(uint256 agentSeed, uint96 reward, uint96 depSeed, bool refund, uint8 vSeed, uint32 openSecs,
        uint32 work, uint32 review) external
    {
        if (ids.length >= 20) return;
        reward = uint96(bound(reward, core.MIN_REWARD(), core.MAX_REWARD()));
        uint96 d = uint96(bound(depSeed, core.minDeposit(reward), reward));
        MADBountyCore.Params memory p = MADBountyCore.Params({
            verifier: verifiers[vSeed % verifiers.length], claimAuthorizer: address(0), reward: reward, deposit: d,
            workWindow: uint32(bound(work, 1 hours, 3 days)), reviewWindow: uint32(bound(review, 12 hours, 3 days)),
            openUntil: uint64(block.timestamp + bound(openSecs, 1 days, 20 days)),
            rejectMode: refund ? MADBountyCore.RejectMode.Refund : MADBountyCore.RejectMode.Burn,
            specHash: bytes32(uint256(reward)), encKey: ""
        });
        address a = _actor(agentSeed);
        calls["post"]++;
        vm.prank(a);
        try core.post(p) returns (uint256 id) { ids.push(id); oks["post"]++; } catch {}
        _recordTerminals();
    }

    function claim(uint256 idSeed, uint256 actorSeed) external {
        _do("claim", _actor(actorSeed), abi.encodeCall(MADBountyCore.claim, (_idIn(idSeed, MADBountyCore.State.Open), 0, "")));
    }

    function submit(uint256 idSeed, bytes32 ev) external {
        uint256 id = _idIn(idSeed, MADBountyCore.State.Claimed);
        _do("submit", _b(id).worker, abi.encodeCall(MADBountyCore.submit, (id, ev)));
    }

    function settle(uint256 idSeed, bool accept, bool useSig, uint256 callerSeed) external {
        uint256 id = _idIn(idSeed, MADBountyCore.State.Submitted);
        MADBountyCore.Bounty memory b = _b(id);
        if (!useSig) { _do("settle", b.verifier, abi.encodeCall(MADBountyCore.settle, (id, accept))); return; }
        uint256 key = b.verifier == verifiers[0] ? vkeys[0] : vkeys[1];
        bytes32 sh = keccak256(abi.encode(core.VERDICT_TYPEHASH(), id, b.worker, b.evidenceHash, accept));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", core.domainSeparator(), sh)));
        _do("settleSig", _actor(callerSeed), abi.encodeCall(MADBountyCore.settleWithSig, (id, accept, abi.encodePacked(r, s, v))));
    }

    function reverse(uint256 idSeed, bool useSig, uint256 callerSeed) external {
        uint256 id = _idIn(idSeed, MADBountyCore.State.Rejected);
        MADBountyCore.Bounty memory b = _b(id);
        if (!useSig) { _do("reverse", b.verifier, abi.encodeCall(MADBountyCore.reverse, (id))); return; }
        uint256 key = b.verifier == verifiers[0] ? vkeys[0] : vkeys[1];
        bytes32 sh = keccak256(abi.encode(core.REVERSE_TYPEHASH(), id, b.worker, b.evidenceHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", core.domainSeparator(), sh)));
        _do("reverseSig", _actor(callerSeed), abi.encodeCall(MADBountyCore.reverseWithSig, (id, abi.encodePacked(r, s, v))));
    }

    function payOnTimeout(uint256 idSeed, uint256 c) external {
        _do("payOnTimeout", _actor(c), abi.encodeCall(MADBountyCore.payOnTimeout, (_idIn(idSeed, MADBountyCore.State.Submitted))));
    }

    function finalizeReject(uint256 idSeed, uint256 c) external {
        _do("finalizeReject", _actor(c), abi.encodeCall(MADBountyCore.finalizeReject, (_idIn(idSeed, MADBountyCore.State.Rejected))));
    }

    function reclaimAbandoned(uint256 idSeed, uint256 c) external {
        _do("reclaimAbandoned", _actor(c), abi.encodeCall(MADBountyCore.reclaimAbandoned, (_idIn(idSeed, MADBountyCore.State.Claimed))));
    }

    function cancel(uint256 idSeed, bool byAgent, uint256 c) external {
        uint256 id = _idIn(idSeed, MADBountyCore.State.Open);
        _do("cancel", byAgent ? _b(id).agent : _actor(c), abi.encodeCall(MADBountyCore.cancel, (id)));
    }

    function refundExpired(uint256 idSeed, uint256 c) external {
        _do("refundExpired", _actor(c), abi.encodeCall(MADBountyCore.refundExpired, (_idIn(idSeed, MADBountyCore.State.Open))));
    }

    function extendReview(uint256 idSeed, bool byAgent) external {
        uint256 id = _idIn(idSeed, MADBountyCore.State.Submitted);
        MADBountyCore.Bounty memory b = _b(id);
        _do("extendReview", byAgent ? b.agent : b.verifier, abi.encodeCall(MADBountyCore.extendReview, (id)));
    }

    function withdraw(uint256 idSeed, uint256 who) external {
        address w = who % 6 == 5 ? treasury : _actor(who);
        _do("withdraw", w, abi.encodeCall(MADBountyCore.withdraw, (_idIn(idSeed, MADBountyCore.State.Paid))));
    }

    /// Recipient-side blacklist (worker / agent / treasury), exercises the owed path. Vaults are never
    /// blacklisted here so the strict per-vault invariant holds (vault freezes are covered by L-02 PoCs).
    function toggleBlacklist(uint256 who) external {
        address w = who % 6 == 5 ? treasury : _actor(who);
        calls["blacklist"]++; oks["blacklist"]++;
        if (usdc.blacklisted(w)) usdc.unBlacklist(w); else usdc.blacklist(w);
    }

    function warp(uint32 secs) external {
        calls["warp"]++; oks["warp"]++;
        vm.warp(block.timestamp + bound(secs, 1, 4 days));
    }
}

contract AuditInvariantTest is StdInvariant, Test {
    MADBountyCore core;
    AuditUSDC usdc;
    CoreHandler h;
    address treasury = makeAddr("treasury");
    address constant BURN = 0x000000000000000000000000000000000000dEaD;
    uint256 supply;

    function setUp() public {
        usdc = new AuditUSDC();
        core = new MADBountyCore(IERC20(address(usdc)), treasury, "ipfs://manual", bytes32(0));
        h = new CoreHandler(core, usdc, treasury);
        supply = usdc.totalSupply();
        targetContract(address(h));
    }

    function _b(uint256 id) internal view returns (MADBountyCore.Bounty memory b) {
        (b.agent, b.verifier, b.claimAuthorizer, b.worker, b.vault, b.reward, b.deposit, b.workWindow, b.reviewWindow,
            b.openUntil, b.deadline, b.extended, b.rejectMode, b.state, b.evidenceHash) = core.bounties(id);
    }

    function _sumOwed(uint256 id, address[] memory as_) internal view returns (uint256 s) {
        for (uint256 j; j < as_.length; j++) s += core.owed(id, as_[j]);
        s += core.owed(id, treasury);
    }

    /// (1) per-bounty vault balance equals what its state says it must hold.
    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 200
    /// forge-config: default.invariant.fail-on-revert = false
    function invariant_vaultMatchesState() public view {
        uint256[] memory ids = h.allIds();
        address[] memory as_ = h.allActors();
        for (uint256 i; i < ids.length; i++) {
            MADBountyCore.Bounty memory b = _b(ids[i]);
            uint256 bal = usdc.balanceOf(address(b.vault));
            uint256 owedSum = _sumOwed(ids[i], as_);
            MADBountyCore.State s = b.state;
            if (s == MADBountyCore.State.Open) {
                assertEq(bal, b.reward, "open");
                assertEq(owedSum, 0, "open owed");
                assertEq(b.worker, address(0), "open worker");
            } else if (s == MADBountyCore.State.Claimed || s == MADBountyCore.State.Submitted
                || s == MADBountyCore.State.Rejected) {
                assertEq(bal, uint256(b.reward) + b.deposit, "inflight");
                assertEq(owedSum, 0, "inflight owed");
            } else {
                assertEq(bal, owedSum, "terminal: vault == owed");
            }
        }
    }

    /// (2) global conservation: supply constant and fully accounted for.
    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 200
    /// forge-config: default.invariant.fail-on-revert = false
    function invariant_conservation() public view {
        uint256[] memory ids = h.allIds();
        address[] memory as_ = h.allActors();
        uint256 t = usdc.balanceOf(treasury) + usdc.balanceOf(BURN) + usdc.balanceOf(address(core))
            + usdc.balanceOf(core.vaultImpl());
        for (uint256 i; i < as_.length; i++) t += usdc.balanceOf(as_[i]);
        for (uint256 i; i < ids.length; i++) t += usdc.balanceOf(address(_b(ids[i]).vault));
        assertEq(usdc.totalSupply(), supply, "supply");
        assertEq(t, supply, "distribution");
    }

    /// (3) treasury gets exactly 1% of the reward of every Paid bounty (paid + still owed).
    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 200
    /// forge-config: default.invariant.fail-on-revert = false
    function invariant_treasuryFee() public view {
        uint256[] memory ids = h.allIds();
        uint256 expected; uint256 owedT;
        for (uint256 i; i < ids.length; i++) {
            MADBountyCore.Bounty memory b = _b(ids[i]);
            if (b.state == MADBountyCore.State.Paid) expected += uint256(b.reward) * 100 / 10_000;
            owedT += core.owed(ids[i], treasury);
        }
        assertEq(usdc.balanceOf(treasury) + owedT, expected, "fee");
    }

    /// (4) terminal states never change.
    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 200
    /// forge-config: default.invariant.fail-on-revert = false
    function invariant_terminalIsFinal() public view {
        assertFalse(h.terminalChanged(), "terminal changed");
    }

    /// (5) burn address receives exactly: abandoned deposits + Burned (P+D) + Refunded D. Checked as
    /// burn == supply - everything else, i.e. no value leaves to an unexpected sink (covered by (2)),
    /// plus: no owed entry for anyone outside {agent, worker, treasury} of that bounty.
    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 200
    /// forge-config: default.invariant.fail-on-revert = false
    function invariant_owedOnlyParties() public view {
        uint256[] memory ids = h.allIds();
        address[] memory as_ = h.allActors();
        for (uint256 i; i < ids.length; i++) {
            MADBountyCore.Bounty memory b = _b(ids[i]);
            for (uint256 j; j < as_.length; j++) {
                if (as_[j] != b.agent && as_[j] != b.worker) assertEq(core.owed(ids[i], as_[j]), 0, "stranger owed");
            }
        }
    }

    /// Cumulative success counts across ALL runs (env vars persist in the forge process), printed each run;
    /// the last printed line is the total.
    function afterInvariant() external {
        string[17] memory tags = ["warpDl", "post", "claim", "submit", "settle", "settleSig", "reverse", "reverseSig",
            "payOnTimeout", "finalizeReject", "reclaimAbandoned", "cancel", "refundExpired", "extendReview",
            "withdraw", "blacklist", "warp"];
        string memory line = "COV";
        for (uint256 i; i < tags.length; i++) {
            bytes32 t = bytes32(bytes(tags[i]));
            string memory k = string.concat("MADCOV_", tags[i]);
            uint256 tot = vm.envOr(k, uint256(0)) + h.oks(t);
            vm.setEnv(k, vm.toString(tot));
            line = string.concat(line, " ", tags[i], "=", vm.toString(tot));
        }
        uint256 terms = vm.envOr("MADCOV_terminal", uint256(0));
        uint256[] memory ids = h.allIds();
        for (uint256 i; i < ids.length; i++) if (uint8(_b(ids[i]).state) >= uint8(MADBountyCore.State.Paid)) terms++;
        vm.setEnv("MADCOV_terminal", vm.toString(terms));
        console.log(string.concat(line, " terminalBounties=", vm.toString(terms)));
    }
}
