// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MADBountyCore, BountyVault, IERC20} from "../../../src/MADBountyCore.sol";
import {AdapterBase} from "../../../periphery/src/AdapterBase.sol";
import {FallbackVerifier} from "../../../periphery/src/FallbackVerifier.sol";
import {MultiVerifier} from "../../../periphery/src/MultiVerifier.sol";
import {HashRevealVerifier} from "../../../periphery/src/HashRevealVerifier.sol";
import {OnchainCheckVerifier} from "../../../periphery/src/OnchainCheckVerifier.sol";
import {TeeMLVerifier} from "../../../periphery/src/TeeMLVerifier.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

// ------------------------------------------------------------------ mocks

/// USDC-like: blacklist (checks from/to/msg.sender) + pause, exactly like Circle FiatToken.
contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blacklisted;
    bool public paused;
    uint256 public totalSupply;

    function mint(address to, uint256 a) external { balanceOf[to] += a; totalSupply += a; }
    function blacklist(address a) external { blacklisted[a] = true; }
    function setPaused(bool p) external { paused = p; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { _move(msg.sender, to, a); return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= a;
        _move(f, to, a);
        return true;
    }
    function _move(address f, address to, uint256 a) internal virtual {
        require(!paused, "Pausable: paused");
        require(!blacklisted[f] && !blacklisted[to] && !blacklisted[msg.sender], "Blacklistable: account is blacklisted");
        balanceOf[f] -= a; balanceOf[to] += a;
    }
}

/// Two-address contract used as a verifier: whoever deploys/attacks can make it return ANY verdict.
/// Models the A3 "permissive verifier" an agent (or an attacker front-running a pending post) may pick.
contract AnyVerifier {
    MADBountyCore immutable core;
    constructor(MADBountyCore c) { core = c; }
    function settleAny(uint256 id, bool accept) external { core.settle(id, accept); }
}

/// ERC-1271 "wallet" whose isValidSignature reverts when asked (models a broken / gas-hungry multisig verifier).
contract Reverting1271 {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        revert("nope");
    }
}

/// ERC-1271 wallet that RE-ENTERS core.settleWithSig for the SAME bounty while being asked to validate.
contract Reentrant1271 {
    MADBountyCore core;
    uint256 public id;
    bytes public innerSig;
    bool armed;

    constructor(MADBountyCore c) { core = c; }
    function arm(uint256 id_, bytes calldata s) external { id = id_; innerSig = s; armed = true; }

    function isValidSignature(bytes32 h, bytes calldata sig) external returns (bytes4) {
        if (armed) {
            armed = false;
            // re-enter with the same verdict (accept) while the outer call has NOT yet mutated state
            core.settleWithSig(id, true, innerSig);
        }
        (bytes32 r, bytes32 s) = abi.decode(sig[:64], (bytes32, bytes32));
        uint8 v = uint8(sig[64]);
        return ecrecover(h, v, r, s) != address(0) ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

/// OnchainCheck target: a simple storage reader + a mode that returns fixed bytes.
contract GasSensitiveTarget {
    bool public good;
    constructor() { good = true; }
    function set(bool g) external { good = g; }
    function probe() external view returns (bytes32) {
        return good ? bytes32(uint256(1)) : bytes32(uint256(2));
    }
}

// ------------------------------------------------------------------ base

abstract contract Base is Test {
    MockUSDC usdc;
    MADBountyCore core;
    address treasury = makeAddr("treasury");
    address agent = makeAddr("agent");
    address worker = makeAddr("worker");
    address attacker = makeAddr("attacker");
    address BURN = 0x000000000000000000000000000000000000dEaD;
    bytes32 ev = keccak256("evidence");

    function setUp() public virtual {
        usdc = new MockUSDC();
        core = new MADBountyCore(IERC20(address(usdc)), treasury, "ipfs://manual", bytes32(0));
        usdc.mint(agent, 1_000_000e6);
        usdc.mint(worker, 1_000_000e6);
        usdc.mint(attacker, 1_000_000e6);
        vm.prank(agent); usdc.approve(address(core), type(uint256).max);
        vm.prank(worker); usdc.approve(address(core), type(uint256).max);
        vm.prank(attacker); usdc.approve(address(core), type(uint256).max);
    }

    function _params(address verifier, uint96 p, uint96 d, MADBountyCore.RejectMode m)
        internal view returns (MADBountyCore.Params memory)
    {
        return MADBountyCore.Params({
            verifier: verifier, claimAuthorizer: address(0), reward: p, deposit: d,
            workWindow: 1 days, reviewWindow: 1 days, openUntil: uint64(block.timestamp + 30 days),
            rejectMode: m, specHash: keccak256("spec"), encKey: "", verifierInit: ""
        });
    }

    function _post(address verifier, uint96 p, uint96 d, MADBountyCore.RejectMode m) internal returns (uint256 id) {
        vm.prank(agent);
        id = core.post(_params(verifier, p, d, m));
    }

    function _claimSubmit(uint256 id, address w) internal {
        vm.prank(w); core.claim(id, 0, "");
        vm.prank(w); core.submit(id, ev);
    }

    function _vault(uint256 id) internal view returns (address v) {
        (, , , , BountyVault vb, , , , , , , , , ,) = core.bounties(id);
        v = address(vb);
    }

    function _state(uint256 id) internal view returns (MADBountyCore.State s) {
        (, , , , , , , , , , , , , s,) = core.bounties(id);
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", core.domainSeparator(), structHash));
    }

    function _vSig(uint256 key, uint256 id, address w, bytes32 e, bool accept) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, _digest(keccak256(abi.encode(core.VERDICT_TYPEHASH(), id, w, e, accept))));
        return abi.encodePacked(r, s, v);
    }

    function _rSig(uint256 key, uint256 id, address w, bytes32 e) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, _digest(keccak256(abi.encode(core.REVERSE_TYPEHASH(), id, w, e))));
        return abi.encodePacked(r, s, v);
    }
}
