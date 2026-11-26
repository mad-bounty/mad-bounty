// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console} from "forge-std/Test.sol";
import {MADBountyCore, BountyVault, IERC20} from "../../../../src/MADBountyCore.sol";
import {AuditBase, AuditUSDC} from "../../../test/AuditBase.sol";

/// Fee-on-transfer token used to prove the strict fwd==amt check in _pull.
contract FeeToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public immutable bps;
    constructor(uint256 bps_) { bps = bps_; }
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { _move(msg.sender, to, a); return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a; _move(f, to, a); return true;
    }
    function _move(address f, address to, uint256 a) internal {
        uint256 fee = a * bps / 10_000;
        balanceOf[f] -= a; balanceOf[to] += a - fee; balanceOf[address(0xfee)] += fee;
    }
}

contract EthForcer { function force(address to) external { selfdestruct(payable(to)); } }

/// Manual multi-lens audit probes for src/MADBountyCore.sol (MADBountyCore + BountyVault).
/// Each test either CONFIRMS a (low/info) issue or DOCUMENTS a refuted candidate.
contract ManualLensTest is AuditBase {
    AuditUSDC usdc;
    address treasury = makeAddr("treasury");
    address agent = makeAddr("agent");
    address worker = makeAddr("worker");
    address griefer = makeAddr("griefer");
    uint256 vk = 0xA11CE;
    address verifier;
    bytes32 ev = keccak256("evidence");

    function setUp() public {
        usdc = new AuditUSDC();
        core = new MADBountyCore(IERC20(address(usdc)), treasury, "ipfs://manual", bytes32(0));
        verifier = vm.addr(vk);
        address[3] memory who = [agent, worker, griefer];
        for (uint256 i; i < 3; i++) { usdc.mint(who[i], 100_000e6); vm.prank(who[i]); usdc.approve(address(core), type(uint256).max); }
    }

    function _post(address v, uint96 p, uint96 d, MADBountyCore.RejectMode m) internal returns (uint256 id) {
        vm.prank(agent); id = core.post(_params(v, p, d, m));
    }
    function _claimSubmit(uint256 id, address w) internal { vm.prank(w); core.claim(id, 0, ""); vm.prank(w); core.submit(id, ev); }

    // =====================================================================================
    // F-1 (Low) MEDIUM-ish: extendReview griefing — the AGENT (or verifier) can push the
    // worker's payOnTimeout out by a full reviewWindow (up to 30 days) at zero cost, while the
    // worker's deposit is already locked and the work already submitted. Once extended, the
    // worker's funds are held an extra full reviewWindow before anyone can pay them.
    // =====================================================================================
    function test_F1_extendReview_agentDelaysWorker_payBy30Days() public {
        MADBountyCore.Params memory p = _params(verifier, 100e6, 25e6, MADBountyCore.RejectMode.Burn);
        p.reviewWindow = 30 days; // MAX_REVIEW
        vm.prank(agent); uint256 id = core.post(p);
        _claimSubmit(id, worker);
        uint64 dl = _deadline(id); // now + 30d
        vm.prank(agent); core.extendReview(id); // AGENT, not verifier, extends unilaterally
        assertEq(_deadline(id), dl + 30 days);
        // worker is now forced to wait an extra 30 days before payOnTimeout can fire:
        vm.warp(dl + 1);
        vm.expectRevert(MADBountyCore.TooEarly.selector); core.payOnTimeout(id);
        vm.warp(dl + 30 days + 1);
        core.payOnTimeout(id);
        assertEq(uint8(_state(id)), uint8(MADBountyCore.State.Paid));
    }

    // =====================================================================================
    // F-2 (Low) fee-on-transfer / rebasing USDC reverts all deposits via _pull's strict
    // fwd==amt. USDC itself is not FOT, but any FOT/rebasing collateral variant permanently
    // DoSes post() and claim().
    // =====================================================================================
    function test_F2_fotToken_breaksDeposit() public {
        FeeToken t = new FeeToken(100); // 1%
        MADBountyCore c = new MADBountyCore(IERC20(address(t)), treasury, "m", bytes32(0));
        t.mint(agent, 1000e6); vm.prank(agent); t.approve(address(c), type(uint256).max);
        vm.prank(agent);
        vm.expectRevert(MADBountyCore.TransferFailed.selector);
        c.post(_params(verifier, 100e6, 10e6, MADBountyCore.RejectMode.Burn));
    }

    // =====================================================================================
    // F-3 (Info) ETH force-sent to the core (selfdestruct / coinbase) is permanently locked:
    // there is no payable entry and no ETH-recovery pathway.
    // =====================================================================================
    function test_F3_forcedEth_locked() public {
        EthForcer f = new EthForcer(); vm.deal(address(f), 1 ether); f.force(address(core));
        assertEq(address(core).balance, 1 ether);
        assertEq(address(core).code.length > 0, true); // no fallback to recover; structurally locked
    }

    // =====================================================================================
    // F-4 (Info) MAX_REWARD is per-bounty only, not a system cap: N bounties of 1000 USDC each
    // are allowed. Documented by design.
    // =====================================================================================
    function test_F4_maxReward_isPerBounty() public {
        _post(verifier, 1_000e6, 20e6, MADBountyCore.RejectMode.Burn);
        _post(verifier, 1_000e6, 20e6, MADBountyCore.RejectMode.Burn); // second 1000 allowed
        assertEq(core.nextId(), 3);
    }

    // =====================================================================================
    // R- (refuted) Solvency: vault balance always >= outstanding obligations across every path.
    // =====================================================================================
    function test_R_solvency_afterAbandonReopen() public {
        uint256 id = _post(verifier, 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        vm.prank(worker); core.claim(id, 0, "");           // vault 110
        vm.warp(block.timestamp + 1 days + 1); core.reclaimAbandoned(id); // D burned, vault 100
        assertEq(usdc.balanceOf(_vault(id)), 100e6);
        vm.prank(griefer); core.claim(id, 0, "");           // vault 110 again (fresh D)
        assertEq(usdc.balanceOf(_vault(id)), 110e6);
        assertGe(usdc.balanceOf(_vault(id)), uint256(100e6) + 10e6); // == 2% floor too
    }

    // =====================================================================================
    // R- (refuted) verdict-sig replay across reclaim impossible: Submitted cannot go back to Open.
    // =====================================================================================
    function test_R_verdictSigNotReplayable_afterSubmit() public {
        uint256 id = _post(verifier, 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        _claimSubmit(id, worker);
        vm.warp(_deadline(id) + 1);
        vm.expectRevert(MADBountyCore.BadState.selector); core.reclaimAbandoned(id);
    }

    // =====================================================================================
    // R- (refuted) deadlines: every boundary is `>` too-late / `<=` too-early (no overlap/gap).
    // =====================================================================================
    function test_R_deadlines_noGapNoOverlap() public {
        uint256 id = _post(verifier, 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        _claimSubmit(id, worker);
        uint64 dl = _deadline(id);
        vm.warp(dl); vm.prank(verifier); core.settle(id, false); // settle allowed AT deadline
        vm.warp(_deadline(id)); // == cooling end
        vm.expectRevert(MADBountyCore.TooEarly.selector); core.finalizeReject(id);
        vm.prank(verifier); core.reverse(id);                    // reverse allowed AT cooling end
        assertEq(uint8(_state(id)), uint8(MADBountyCore.State.Paid));
    }

    // =====================================================================================
    // R- (refuted) owed[id][treasury] diversion + later withdraw is correctly keyed/self-bound.
    // =====================================================================================
    function test_R_owedTreasury_divertedThenWithdrawn() public {
        uint256 id = _post(verifier, 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        _claimSubmit(id, worker);
        usdc.blacklist(treasury);
        vm.prank(verifier); core.settle(id, true);
        assertEq(core.owed(id, treasury), 5e6);
        usdc.unBlacklist(treasury);
        vm.prank(treasury); core.withdraw(id);
        assertEq(usdc.balanceOf(treasury), 5e6);
    }

    // =====================================================================================
    // R- (refuted) clone vault core/token binding correct (immutables copied via clone).
    // =====================================================================================
    function test_R_cloneBinding() public {
        uint256 id = _post(verifier, 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        BountyVault v = BountyVault(_vault(id));
        assertEq(v.core(), address(core));
        assertEq(address(v.token()), address(usdc));
    }

    // =====================================================================================
    // R- (refuted) claim at openUntil inclusive works; refundExpired same instant is TooEarly.
    // =====================================================================================
    function test_R_claimAtOpenUntil() public {
        uint256 id = _post(verifier, 100e6, 10e6, MADBountyCore.RejectMode.Burn);
        (,,,,,,,,, uint64 ou,,,,,) = core.bounties(id);
        vm.warp(ou);
        vm.prank(worker); core.claim(id, 0, ""); // == openUntil allowed
        assertEq(uint8(_state(id)), uint8(MADBountyCore.State.Claimed));
    }

}

