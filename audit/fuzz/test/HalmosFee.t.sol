// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MADBountyCore, IERC20} from "../../../src/MADBountyCore.sol";
import {FuzzUSDC} from "../harness/MADFuzzHandler.sol";

/// Halmos symbolic checks (check_*). Also runnable by forge as fuzz tests via the testFuzz_ wrappers.
contract HalmosFeeTest is Test {
    MADBountyCore core;
    FuzzUSDC usdc;
    address treasury = address(0x7EA5);
    address agent = address(0xA6E0);
    address worker = address(0xB0E0);
    address verifier = address(0x5E7);
    address constant BURN = 0x000000000000000000000000000000000000dEaD;

    function setUp() public {
        usdc = new FuzzUSDC();
        core = new MADBountyCore(IERC20(address(usdc)), treasury, "m", bytes32(0));
        usdc.mint(agent, 2_000e6); usdc.mint(worker, 2_000e6);
        usdc.setAllowance(agent, address(core), type(uint256).max);
        usdc.setAllowance(worker, address(core), type(uint256).max);
    }

    // -------- split arithmetic checks (smaller SMT queries), over the reachable range reward <= MAX_REWARD
    function check_feeSum(uint96 reward, uint96 deposit) public pure {
        vm.assume(reward <= 1_000e6 && deposit <= reward);
        uint256 fee = uint256(reward) * 500 / 10_000;
        uint256 toWorker = uint256(reward) - fee + deposit;
        assert(toWorker + fee == uint256(reward) + deposit);
    }
    function check_feeFloor(uint96 reward) public pure {
        vm.assume(reward <= 1_000e6);
        uint256 fee = uint256(reward) * 500 / 10_000;
        assert(fee * 20 <= reward);
        assert(reward < fee * 20 + 20);
    }
    function check_feeVsCore(uint96 reward) public view {
        vm.assume(reward <= 1_000e6);
        assert(core.MAX_FEE_BPS() == 500 && core.feeBps() == 500);
        assert(uint256(reward) * core.feeBps() / 10_000 == uint256(reward) / 20);
    }
    function check_minDepositSplit(uint32 reward) public view {
        vm.assume(reward <= 1_000e6);
        uint256 m = core.minDeposit(reward);
        assert(m >= 1e6);
        if (reward >= 50e6) assert(m == uint256(reward) / 50); else assert(m == 1e6);
    }

    // -------- pure arithmetic over the full uint96 reward range the struct allows
    function check_feeSplitExact(uint96 reward, uint96 deposit) public pure {
        uint256 fee = uint256(reward) * 500 / 10_000;
        uint256 toWorker = uint256(reward) - fee + deposit;
        assert(toWorker + fee == uint256(reward) + deposit);   // no dust created or lost
        assert(fee <= uint256(reward) / 20);                   // rounds down, never above 5%
        assert(fee * 20 <= reward && reward - fee * 20 < 20);  // floor exactness
        assert(toWorker <= uint256(reward) - fee + deposit);
    }

    function check_minDeposit(uint256 reward) public view {
        vm.assume(reward <= 1_000e6);
        uint256 m = core.minDeposit(reward);
        assert(m >= 1e6);
        assert(m * 50 + 49 >= reward);                          // >= 2% up to floor rounding (< 1 unit)
        assert(m == 1e6 || m == reward * 200 / 10_000);
        if (reward >= 50e6) assert(m == reward / 50);
        else assert(m == 1e6);
    }

    // -------- post() accepts iff deposit within [max($1, 2%), reward] and reward in [$1, $1000]
    function check_postDepositFloor(uint96 reward, uint96 deposit) public {
        MADBountyCore.Params memory p = _p(reward, deposit);
        vm.prank(agent);
        (bool ok,) = address(core).call(abi.encodeCall(MADBountyCore.post, (p)));
        uint256 floor = reward * uint256(200) / 10_000; if (floor < 1e6) floor = 1e6;
        bool valid = reward >= 1e6 && reward <= 1_000e6 && deposit >= floor && deposit <= reward;
        assert(ok == valid);
    }

    // -------- end-to-end accept: exact money flow for any valid reward/deposit
    function check_acceptFlow(uint96 reward, uint96 deposit) public {
        vm.assume(reward >= 1e6 && reward <= 1_000e6);
        vm.assume(deposit >= core.minDeposit(reward) && deposit <= reward);
        uint256 id = _toSubmitted(reward, deposit);
        vm.prank(verifier); core.settle(id, true);
        uint256 fee = uint256(reward) * 500 / 10_000;
        assert(usdc.balanceOf(treasury) == fee);
        assert(usdc.balanceOf(worker) == 2_000e6 - deposit + (uint256(reward) - fee + deposit));
        assert(usdc.balanceOf(worker) + usdc.balanceOf(treasury) - (2_000e6 - deposit) == uint256(reward) + deposit);
        assert(usdc.balanceOf(agent) == 2_000e6 - reward);
    }

    // -------- end-to-end reject paths: treasury gets nothing, burns exact
    function check_rejectFlow(uint96 reward, uint96 deposit, bool refund) public {
        vm.assume(reward >= 1e6 && reward <= 1_000e6);
        vm.assume(deposit >= core.minDeposit(reward) && deposit <= reward);
        uint256 id = _toSubmittedMode(reward, deposit, refund);
        vm.prank(verifier); core.settle(id, false);
        vm.warp(block.timestamp + 24 hours + 1);
        core.finalizeReject(id);
        assert(usdc.balanceOf(treasury) == 0);
        if (refund) {
            assert(usdc.balanceOf(BURN) == deposit);
            assert(usdc.balanceOf(agent) == 2_000e6);
        } else {
            assert(usdc.balanceOf(BURN) == uint256(reward) + deposit);
        }
    }

    function _p(uint96 reward, uint96 deposit) internal view returns (MADBountyCore.Params memory) {
        return MADBountyCore.Params({verifier: verifier, claimAuthorizer: address(0), reward: reward, deposit: deposit,
            workWindow: 1 days, reviewWindow: 1 days, openUntil: uint64(block.timestamp + 1 days),
            rejectMode: MADBountyCore.RejectMode.Burn, specHash: bytes32(0), encKey: "", verifierInit: ""});
    }
    function _toSubmitted(uint96 r, uint96 d) internal returns (uint256) { return _toSubmittedMode(r, d, false); }
    function _toSubmittedMode(uint96 r, uint96 d, bool refund) internal returns (uint256 id) {
        MADBountyCore.Params memory p = _p(r, d);
        if (refund) p.rejectMode = MADBountyCore.RejectMode.Refund;
        vm.prank(agent); id = core.post(p);
        vm.prank(worker); core.claim(id, 0, "");
        vm.prank(worker); core.submit(id, bytes32(uint256(1)));
    }

    // forge fuzz mirrors
    function testFuzz_feeSplitExact(uint96 r, uint96 d) public pure { check_feeSplitExact(r, d); }
    function testFuzz_minDeposit(uint256 r) public view { r = bound(r, 0, 1_000e6); check_minDeposit(r); }
    function testFuzz_postDepositFloor(uint96 r, uint96 d) public { check_postDepositFloor(r, d); }
    function testFuzz_acceptFlow(uint96 r, uint96 d) public {
        r = uint96(bound(r, 1e6, 1_000e6)); d = uint96(bound(d, core.minDeposit(r), r)); check_acceptFlow(r, d);
    }
    function testFuzz_rejectFlow(uint96 r, uint96 d, bool m) public {
        r = uint96(bound(r, 1e6, 1_000e6)); d = uint96(bound(d, core.minDeposit(r), r)); check_rejectFlow(r, d, m);
    }
}
