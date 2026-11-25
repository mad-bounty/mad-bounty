// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console} from "forge-std/Test.sol";
import {MADBountyCore, BountyVault, IERC20} from "../../src/MADBountyCore.sol";
import {AuditBase, AuditUSDC, HookToken, ITokenHook} from "./AuditBase.sol";

/// ERC-1271 verifier that tries to re-enter the core during isValidSignature, then says "valid".
contract ReentrantVerifier {
    MADBountyCore public core;
    uint256 public target;
    bool public reentered;
    constructor(MADBountyCore c) { core = c; }
    function setTarget(uint256 id) external { target = id; }
    function isValidSignature(bytes32, bytes calldata) external returns (bytes4) {
        // Try a state-changing re-entry. Under staticcall this must fail.
        (bool ok,) = address(core).call(abi.encodeCall(MADBountyCore.payOnTimeout, (target)));
        if (ok) reentered = true; // SSTORE: also reverts under staticcall
        return 0x1626ba7e;
    }
}

/// A contract with no ERC-1271 support (stands in for EIP-7702 delegate code without isValidSignature).
contract NoSigSupport { fallback() external {} }

/// Worker contract that re-enters the core from a token receive hook.
contract HookWorker is ITokenHook {
    MADBountyCore core; uint256 id; bool public tried; bool public succeeded;
    constructor(MADBountyCore c) { core = c; }
    function setId(uint256 i) external { id = i; }
    function doClaim(IERC20 t) external { (bool a,) = address(t).call(abi.encodeWithSignature("approve(address,uint256)", address(core), type(uint256).max)); a; core.claim(id, 0, ""); }
    function doSubmit() external { core.submit(id, keccak256("ev")); }
    function doWithdraw() external { core.withdraw(id); }
    function onTokenReceived(address, uint256) external {
        if (tried) return;
        tried = true;
        // re-enter withdraw (would double-pay if guard missing) and payOnTimeout
        (bool a,) = address(core).call(abi.encodeCall(MADBountyCore.withdraw, (id)));
        (bool b,) = address(core).call(abi.encodeCall(MADBountyCore.payOnTimeout, (id)));
        succeeded = a || b;
    }
}

contract AuditFindingsTest is AuditBase {
    AuditUSDC usdc;
    address treasury = makeAddr("treasury");
    address agent = makeAddr("agent");
    address worker = makeAddr("worker");
    address worker2 = makeAddr("worker2");
    uint256 vk = 0xA11CE;
    address verifier;
    uint256 ak = 0xB0B;   // claim authorizer key
    bytes32 ev = keccak256("evidence");

    function setUp() public {
        usdc = new AuditUSDC();
        core = new MADBountyCore(IERC20(address(usdc)), treasury, "ipfs://manual", bytes32(0));
        verifier = vm.addr(vk);
        address[3] memory who = [agent, worker, worker2];
        for (uint256 i; i < 3; i++) {
            usdc.mint(who[i], 100_000e6);
            vm.prank(who[i]); usdc.approve(address(core), type(uint256).max);
        }
    }

    function _post(address v, uint96 p, uint96 d, MADBountyCore.RejectMode m) internal returns (uint256 id) {
        vm.prank(agent); id = core.post(_params(v, p, d, m));
    }

    function _claimSubmit(uint256 id, address w) internal {
        vm.prank(w); core.claim(id, 0, "");
        vm.prank(w); core.submit(id, ev);
    }

    // =====================================================================================
    // L-01 CONFIRMED: claimAuthorizer signature is reusable (no nonce / one-shot binding).
    // The same signed Claim(id, worker, deadline) re-claims the bounty after reclaimAbandoned,
    // so one authorized worker can lock an authorizer-gated bounty again and again until
    // authDeadline, and the authorizer cannot revoke an ECDSA authorization.
    // =====================================================================================
    function test_L01_claimAuthSig_reusableAfterAbandon() public {
        MADBountyCore.Params memory p = _params(verifier, 100e6, 2e6, MADBountyCore.RejectMode.Burn);
        p.claimAuthorizer = vm.addr(ak);
        p.workWindow = 1 hours;
        vm.prank(agent); uint256 id = core.post(p);
        uint256 dl = block.timestamp + 7 days;              // authorizer intended ONE claim
        bytes memory sig = _claimSig(ak, id, worker, dl);
        uint256 t = block.timestamp;
        for (uint256 i; i < 5; i++) {
            vm.prank(worker); core.claim(id, dl, sig);       // same signature every time
            t += 1 hours + 1; vm.warp(t);
            core.reclaimAbandoned(id);
        }
        vm.prank(worker); core.claim(id, dl, sig);
        assertEq(uint8(_state(id)), uint8(MADBountyCore.State.Claimed));
        // a different (authorized-by-nobody) worker is still locked out
        vm.warp(t + 1 hours + 1); core.reclaimAbandoned(id);
        vm.prank(worker2); vm.expectRevert(MADBountyCore.BadSig.selector); core.claim(id, dl, sig);
    }

    // =====================================================================================
    // L-02 CONFIRMED: burns and the Abandoned/Burned/Refunded events are "fire and forget".
    // vault.send(BURN, ..) return values are ignored (slither unused-return). While USDC is paused
    // (or the vault is frozen), permissionless reclaimAbandoned / finalizeReject flip state and emit
    // "burned" events while the tokens stay in the vault with no owed entry. They are unrecoverable
    // (economically burned), but indexers/SDK reading events see burns that never happened, and the
    // vault ends with an unaccounted surplus.
    // =====================================================================================
    function test_L02_reclaimAbandoned_duringPause_silentlySkipsBurn() public {
        uint256 id = _post(verifier, 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        vm.prank(worker); core.claim(id, 0, "");
        vm.warp(block.timestamp + 1 days + 1);
        usdc.setPaused(true);
        vm.expectEmit(true, true, false, true, address(core));
        emit MADBountyCore.Abandoned(id, worker, 10e6);      // event says 10 USDC burned
        core.reclaimAbandoned(id);
        usdc.setPaused(false);
        assertEq(usdc.balanceOf(BURN), 0);                  // ...nothing burned
        assertEq(usdc.balanceOf(_vault(id)), 110e6);          // deposit stuck in an Open vault
        assertEq(core.owed(id, worker), 0);
        // the bounty proceeds normally; the old deposit is never released to anyone
        _claimSubmit(id, worker2);
        vm.prank(verifier); core.settle(id, true);
        assertEq(usdc.balanceOf(_vault(id)), 10e6);           // stranded forever
    }

    function test_L02_finalizeRejectRefund_duringPause_depositStaysInVault() public {
        uint256 id = _post(verifier, 100e6, 10e6, MADBountyCore.RejectMode.Refund);
        _claimSubmit(id, worker);
        vm.prank(verifier); core.settle(id, false);
        vm.warp(block.timestamp + 1 days + 1);
        usdc.setPaused(true);
        core.finalizeReject(id);                              // emits Refunded(id, 100e6, 10e6)
        usdc.setPaused(false);
        assertEq(core.owed(id, agent), 100e6);
        vm.prank(agent); core.withdraw(id);
        assertEq(usdc.balanceOf(BURN), 0);
        assertEq(usdc.balanceOf(_vault(id)), 10e6);           // "burned" deposit is stuck instead
    }

    function test_L02_finalizeRejectBurn_duringPause_reportsBurn() public {
        uint256 id = _post(verifier, 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        _claimSubmit(id, worker);
        vm.prank(verifier); core.settle(id, false);
        vm.warp(block.timestamp + 1 days + 1);
        usdc.setPaused(true);
        vm.expectEmit(true, false, false, true, address(core));
        emit MADBountyCore.Burned(id, 110e6);
        core.finalizeReject(id);
        usdc.setPaused(false);
        assertEq(usdc.balanceOf(BURN), 0);
        assertEq(usdc.balanceOf(_vault(id)), 110e6);
        assertEq(uint8(_state(id)), uint8(MADBountyCore.State.Burned));
    }

    /// L-02 (gas variant): with a cheap post-call tail (just an event), can a caller starve the
    /// inner transfer so the burn is skipped while the outer tx succeeds? Logs the result either way.
    function test_L02_gasStarvedBurn_probe() public {
        uint256 id = _post(verifier, 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        vm.prank(worker); core.claim(id, 0, "");
        vm.warp(block.timestamp + 1 days + 1);
        uint256 hitAbandon;
        for (uint256 g = 5_000; g < 200_000; g += 100) {
            uint256 snap = vm.snapshotState();
            (bool ok,) = address(core).call{gas: g}(abi.encodeCall(MADBountyCore.reclaimAbandoned, (id)));
            bool skipped = ok && usdc.balanceOf(BURN) == 0;
            vm.revertToState(snap);
            if (skipped) { hitAbandon = g; break; }
        }
        console.log("reclaimAbandoned burn skippable at gas (0 = never):", hitAbandon);
        // finalizeReject Burn
        uint256 id2 = _post(verifier, 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        _claimSubmit(id2, worker2);
        vm.prank(verifier); core.settle(id2, false);
        vm.warp(block.timestamp + 1 days + 1);
        uint256 hitBurn;
        for (uint256 g = 5_000; g < 200_000; g += 100) {
            uint256 snap = vm.snapshotState();
            (bool ok,) = address(core).call{gas: g}(abi.encodeCall(MADBountyCore.finalizeReject, (id2)));
            bool skipped = ok && usdc.balanceOf(BURN) == 0;
            vm.revertToState(snap);
            if (skipped) { hitBurn = g; break; }
        }
        console.log("finalizeReject burn skippable at gas (0 = never):", hitBurn);
    }

    // =====================================================================================
    // L-03 CONFIRMED: a verifier address that gains code (EIP-7702 delegation, or a counterfactual
    // smart wallet deployed later) is checked ONLY via ERC-1271; its ECDSA signatures stop working.
    // If the verifier relied on relayed signatures, silence then pays the worker on timeout.
    // =====================================================================================
    function test_L03_verifierWithCode_ecdsaSigRejected_timeoutPaysWorker() public {
        uint256 id = _post(verifier, 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        _claimSubmit(id, worker);
        bytes memory rej = _verdictSig(vk, id, worker, ev, false);
        vm.etch(verifier, address(new NoSigSupport()).code); // stands in for 7702 delegate code
        vm.expectRevert(MADBountyCore.BadSig.selector);
        core.settleWithSig(id, false, rej);                    // valid ECDSA REJECT refused
        vm.warp(block.timestamp + 1 days + 1);
        core.payOnTimeout(id);                                 // worker paid despite the reject
        assertEq(usdc.balanceOf(worker), 100_000e6 + 99e6);
    }

    // =====================================================================================
    // REFUTED checks (pass = safe)
    // =====================================================================================

    /// Clones copy the impl runtime bytecode, so immutables (core, token) are correct in every clone.
    function test_R_cloneImmutables() public {
        uint256 id = _post(verifier, 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        BountyVault v = BountyVault(_vault(id));
        assertEq(v.core(), address(core));
        assertEq(address(v.token()), address(usdc));
        assertTrue(address(v) != core.vaultImpl());
        vm.expectRevert(bytes("core")); v.send(address(this), 1);
        // impl itself: also core-gated
        BountyVault impl = BountyVault(core.vaultImpl());
        assertEq(impl.core(), address(core));
        vm.expectRevert(bytes("core")); impl.send(address(this), 1);
    }

    /// ERC-1271 isValidSignature runs under STATICCALL: a verifier cannot re-enter the core.
    function test_R_1271ReentrancyBlocked() public {
        ReentrantVerifier rv = new ReentrantVerifier(core);
        uint256 id = _post(address(rv), 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        _claimSubmit(id, worker);
        rv.setTarget(id);
        vm.warp(block.timestamp + 1 days); // == deadline: settle still allowed
        // Under staticcall the re-entrant call fails (TSTORE/SSTORE forbidden, and the guard is held),
        // so the verifier cannot change core state mid-check; only its own verdict lands.
        core.settleWithSig(id, false, hex"00");
        assertFalse(rv.reentered());
        assertEq(uint8(_state(id)), uint8(MADBountyCore.State.Rejected));
        assertEq(core.owed(id, worker), 0);
    }

    /// Hook token (ERC777-like): recipient re-enters withdraw/payOnTimeout from the receive hook.
    function test_R_hookTokenReentrancy() public {
        HookToken ht = new HookToken();
        MADBountyCore c2 = new MADBountyCore(IERC20(address(ht)), treasury, "", bytes32(0));
        HookWorker hw = new HookWorker(c2);
        ht.mint(agent, 1_000e6); ht.mint(address(hw), 1_000e6);
        vm.prank(agent); ht.approve(address(c2), type(uint256).max);
        vm.prank(agent); uint256 id = c2.post(_params(verifier, 100e6, 10e6, MADBountyCore.RejectMode.Burn));
        hw.setId(id); hw.doClaim(IERC20(address(ht))); hw.doSubmit();
        vm.prank(verifier); c2.settle(id, true);
        assertTrue(hw.tried());
        assertFalse(hw.succeeded());
        assertEq(ht.balanceOf(address(hw)), 1_000e6 + 99e6);
        assertEq(c2.owed(id, address(hw)), 0);
        (, , , , BountyVault v, , , , , , , , , ,) = c2.bounties(id);
        assertEq(ht.balanceOf(address(v)), 0);
    }

    /// Every deadline boundary: at t == deadline only the "in-window" action works, at t == deadline+1 only
    /// the "timeout" action works. No overlap, no gap.
    function test_R_deadlineBoundaries() public {
        uint256 id = _post(verifier, 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        (, , , , , , , , , uint64 openUntil, , , , ,) = core.bounties(id);
        vm.warp(openUntil);
        vm.expectRevert(MADBountyCore.TooEarly.selector); core.refundExpired(id);
        uint256 snap = vm.snapshotState();
        vm.warp(openUntil + 1);
        vm.prank(worker); vm.expectRevert(MADBountyCore.TooLate.selector); core.claim(id, 0, "");
        core.refundExpired(id);
        vm.revertToState(snap);

        vm.prank(worker); core.claim(id, 0, "");            // claim at t == openUntil
        uint64 d = _deadline(id);
        vm.warp(d);
        vm.expectRevert(MADBountyCore.TooEarly.selector); core.reclaimAbandoned(id);
        snap = vm.snapshotState();
        vm.warp(d + 1);
        vm.prank(worker); vm.expectRevert(MADBountyCore.TooLate.selector); core.submit(id, ev);
        vm.revertToState(snap);
        vm.prank(worker); core.submit(id, ev);               // submit at t == deadline

        d = _deadline(id);
        vm.warp(d);
        vm.expectRevert(MADBountyCore.TooEarly.selector); core.payOnTimeout(id);
        vm.prank(agent); core.extendReview(id);              // extend allowed at t == deadline
        assertEq(_deadline(id), d + 1 days);
        vm.prank(verifier); vm.expectRevert(MADBountyCore.NotAllowed.selector); core.extendReview(id);
        vm.warp(d + 1);
        vm.expectRevert(MADBountyCore.TooEarly.selector); core.payOnTimeout(id); // extension honoured
        vm.warp(d + 1 days);
        vm.prank(verifier); core.settle(id, false);           // settle at t == extended deadline
        d = _deadline(id);
        assertEq(d, block.timestamp + 24 hours);
        vm.warp(d);
        vm.expectRevert(MADBountyCore.TooEarly.selector); core.finalizeReject(id);
        snap = vm.snapshotState();
        vm.warp(d + 1);
        vm.prank(verifier); vm.expectRevert(MADBountyCore.TooLate.selector); core.reverse(id);
        core.finalizeReject(id);
        vm.revertToState(snap);
        vm.prank(verifier); core.reverse(id);                 // reverse at t == cooling end
        assertEq(uint8(_state(id)), uint8(MADBountyCore.State.Paid));
    }

    /// extendReview after timeout is impossible; payOnTimeout after extension uses the new deadline.
    function test_R_extendAfterDeadlineBlocked() public {
        uint256 id = _post(verifier, 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        _claimSubmit(id, worker);
        vm.warp(_deadline(id) + 1);
        vm.prank(agent); vm.expectRevert(MADBountyCore.NotAllowed.selector); core.extendReview(id);
        core.payOnTimeout(id);
    }

    /// A2 re-verified on every paying entrypoint: starving gas never diverts a payout to `owed`
    /// while the tx succeeds (the owed SSTORE does not fit in the 1/64 remainder).
    function test_R_A2_gasGrief_allEntrypoints() public {
        uint256 found;
        // cancel
        uint256 a = _post(verifier, 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        found += _grief(abi.encodeCall(MADBountyCore.cancel, (a)), agent, a, agent);
        // refundExpired
        uint256 b = _post(verifier, 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        // settle accept (verifier adapter could pass limited gas)
        uint256 c = _post(verifier, 100e6, 10e6, MADBountyCore.RejectMode.Burn); _claimSubmit(c, worker);
        found += _grief(abi.encodeCall(MADBountyCore.settle, (c, true)), verifier, c, worker);
        // settleWithSig accept
        bytes memory s = _verdictSig(vk, c, worker, ev, true);
        found += _grief(abi.encodeCall(MADBountyCore.settleWithSig, (c, true, s)), address(this), c, worker);
        // reverse
        uint256 r = _post(verifier, 100e6, 10e6, MADBountyCore.RejectMode.Refund); _claimSubmit(r, worker2);
        vm.prank(verifier); core.settle(r, false);
        found += _grief(abi.encodeCall(MADBountyCore.reverse, (r)), verifier, r, worker2);
        vm.warp(block.timestamp + 31 days);
        found += _grief(abi.encodeCall(MADBountyCore.refundExpired, (b)), address(this), b, agent);
        found += _grief(abi.encodeCall(MADBountyCore.finalizeReject, (r)), address(this), r, agent);
        assertEq(found, 0);
    }

    function _grief(bytes memory data, address caller, uint256 id, address victim) internal returns (uint256) {
        for (uint256 g = 20_000; g < 400_000; g += 250) {
            uint256 snap = vm.snapshotState();
            vm.prank(caller);
            (bool ok,) = address(core).call{gas: g}(data);
            bool hit = ok && (core.owed(id, victim) > 0 || core.owed(id, treasury) > 0);
            vm.revertToState(snap);
            if (hit) { console.log("griefable at gas", g); return 1; }
        }
        return 0;
    }

    /// Verdict / reverse / claim signatures are domain-bound and type-distinct; high-s rejected.
    function test_R_sigMalleabilityAndCrossType() public {
        uint256 id = _post(verifier, 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        _claimSubmit(id, worker);
        bytes32 sh = keccak256(abi.encode(core.VERDICT_TYPEHASH(), id, worker, ev, true));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(vk, _digest(sh));
        bytes32 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory high = abi.encodePacked(r, bytes32(uint256(n) - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(MADBountyCore.BadSig.selector); core.settleWithSig(id, true, high);
        // a Reverse sig is not an accept verdict
        bytes memory rev = _reverseSig(vk, id, worker, ev);
        vm.expectRevert(MADBountyCore.BadSig.selector); core.settleWithSig(id, true, rev);
        // a sig from another deployment (different verifyingContract) is rejected
        MADBountyCore other = new MADBountyCore(IERC20(address(usdc)), treasury, "", bytes32(0));
        bytes32 od = keccak256(abi.encodePacked("\x19\x01", other.domainSeparator(), sh));
        (v, r, s) = vm.sign(vk, od);
        vm.expectRevert(MADBountyCore.BadSig.selector); core.settleWithSig(id, true, abi.encodePacked(r, s, v));
    }

    /// owed cannot be double-withdrawn, and is isolated per bounty vault.
    function test_R_owedIsolationAndSingleWithdraw() public {
        uint256 a = _post(verifier, 100e6, 10e6, MADBountyCore.RejectMode.Burn); _claimSubmit(a, worker);
        uint256 b = _post(verifier, 100e6, 10e6, MADBountyCore.RejectMode.Burn); _claimSubmit(b, worker2);
        usdc.blacklist(worker);
        vm.prank(verifier); core.settle(a, true);
        usdc.unBlacklist(worker);
        assertEq(core.owed(a, worker), 109e6);
        vm.prank(worker); vm.expectRevert(MADBountyCore.BadParam.selector); core.withdraw(b);
        vm.prank(worker); core.withdraw(a);
        vm.prank(worker); vm.expectRevert(MADBountyCore.BadParam.selector); core.withdraw(a);
        assertEq(usdc.balanceOf(_vault(b)), 110e6);
    }

    /// Frozen vault: withdraw reverts (owed kept), so it is retryable once unfrozen.
    function test_R_withdrawRetryableAfterFreeze() public {
        uint256 a = _post(verifier, 100e6, 10e6, MADBountyCore.RejectMode.Burn); _claimSubmit(a, worker);
        usdc.blacklist(_vault(a));
        vm.prank(verifier); core.settle(a, true);
        assertEq(core.owed(a, worker), 109e6);
        assertEq(core.owed(a, treasury), 1e6);
        vm.prank(worker); vm.expectRevert(MADBountyCore.TransferFailed.selector); core.withdraw(a);
        usdc.unBlacklist(_vault(a));
        vm.prank(worker); core.withdraw(a);
        vm.prank(treasury); core.withdraw(a);
        assertEq(usdc.balanceOf(_vault(a)), 0);
    }
}
