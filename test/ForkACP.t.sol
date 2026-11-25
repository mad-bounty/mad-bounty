// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";

interface IERC20 {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IIdentity { function register(string calldata agentURI) external returns (uint256); }
interface IRep {
    function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string calldata tag1, string calldata tag2,
        string calldata endpoint, string calldata feedbackURI, bytes32 feedbackHash) external;
}

interface IACP {
    function createJob(address provider, address evaluator, uint256 expiredAt, string calldata description, address hook) external returns (uint256);
    function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external;
    function fund(uint256 jobId, uint256 expectedBudget, bytes calldata optParams) external;
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external;
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
    function claimRefund(uint256 jobId) external;
}

/// Probes the LIVE Virtuals ACP core (ERC-8183) on a Base mainnet fork:
/// can a third-party contract be client + evaluator, and where do reject/complete funds go?
contract ForkACPTest is Test {
    IACP acp = IACP(0x238E541BfefD82238730D00a2208E5497F1832E0);
    IERC20 usdc = IERC20(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    address wrapper = makeAddr("madWrapper");   // stands in for the MAD contract (client + evaluator)
    address worker = makeAddr("worker");

    function setUp() public {
        vm.createSelectFork("https://mainnet.base.org");
        deal(address(usdc), wrapper, 100e6);
    }

    function _job() internal returns (uint256 id) {
        vm.startPrank(wrapper);
        id = acp.createJob(worker, wrapper, block.timestamp + 1 days, "mad-probe", address(0));
        vm.stopPrank();
        vm.prank(worker);                       // live ACP: only the provider may set the budget
        acp.setBudget(id, 10e6, "");
        vm.startPrank(wrapper);
        usdc.approve(address(acp), 10e6);
        acp.fund(id, 10e6, "");
        vm.stopPrank();
        vm.prank(worker);
        acp.submit(id, keccak256("evidence"), "");
    }

    function test_rejectRefundsClientWrapper() public {
        uint256 id = _job();
        uint256 before = usdc.balanceOf(wrapper);
        vm.prank(wrapper);
        acp.reject(id, keccak256("reject"), "");
        console.log("refund to wrapper", usdc.balanceOf(wrapper) - before);
        assertEq(usdc.balanceOf(wrapper) - before, 10e6);
    }

    function test_completePaysWorker_feeMeasured() public {
        uint256 id = _job();
        vm.prank(wrapper);
        acp.complete(id, keccak256("ok"), "");
        console.log("worker received", usdc.balanceOf(worker));
    }

    function test_usdcBurnToDead() public {
        vm.prank(wrapper);
        (bool ok,) = address(usdc).call(abi.encodeWithSignature("transfer(address,uint256)", 0x000000000000000000000000000000000000dEaD, 1e6));
        assertTrue(ok);
        vm.prank(wrapper);
        (bool ok0,) = address(usdc).call(abi.encodeWithSignature("transfer(address,uint256)", address(0), 1e6));
        console.log("transfer to address(0) ok?", ok0);
    }

    function test_completeSplit() public {
        uint256 id = _job();
        uint256 w0 = usdc.balanceOf(wrapper);
        vm.prank(wrapper);
        acp.complete(id, keccak256("ok"), "");
        console.log("worker", usdc.balanceOf(worker), "wrapper(evaluator) got", usdc.balanceOf(wrapper) - w0);
    }

    function test_8004_contractCanRegisterWorkerAndRateIt() public {
        IIdentity idr = IIdentity(0x8004A169FB4a3325136EB29fA0ceB6D2e539a432);
        IRep rep = IRep(0x8004BAa17C55a88189AE136b182e5fdA19dE9b63);
        vm.prank(worker);
        uint256 agentId = idr.register("ipfs://worker-profile");
        vm.prank(wrapper);   // the MAD contract writes feedback about the worker
        rep.giveFeedback(agentId, 100, 0, "mad-bounty", "paid", "", "", bytes32(0));
        vm.prank(worker);    // self-feedback must fail
        vm.expectRevert();
        rep.giveFeedback(agentId, 100, 0, "mad-bounty", "paid", "", "", bytes32(0));
    }

    function test_expiryRefundAfterGrace() public {
        uint256 id = _job();
        vm.warp(block.timestamp + 1 days + 1);
        try acp.claimRefund(id) { console.log("refund at expiry+1s: OK"); }
        catch { console.log("refund at expiry+1s: REVERTED (grace period)"); }
    }
}
