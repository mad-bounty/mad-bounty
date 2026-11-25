// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MADBountyCore, BountyVault, IERC20} from "../../src/MADBountyCore.sol";

/// USDC-like token: blacklist (checks from, to, msg.sender like FiatToken), unblacklist, pause.
contract AuditUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blacklisted;
    bool public paused;
    uint256 public totalSupply;

    function mint(address to, uint256 a) external { balanceOf[to] += a; totalSupply += a; }
    function blacklist(address a) external { blacklisted[a] = true; }
    function unBlacklist(address a) external { blacklisted[a] = false; }
    function setPaused(bool p) external { paused = p; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { _move(msg.sender, to, a); return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a; _move(f, to, a); return true;
    }
    function _move(address f, address to, uint256 a) internal virtual {
        require(!paused, "Pausable: paused");
        require(!blacklisted[f] && !blacklisted[to] && !blacklisted[msg.sender], "Blacklistable: account is blacklisted");
        balanceOf[f] -= a; balanceOf[to] += a;
    }
}

interface ITokenHook { function onTokenReceived(address from, uint256 amount) external; }

/// ERC777-style token: calls the recipient's hook after every transfer. A reverting hook reverts the transfer.
contract HookToken is AuditUSDC {
    function _move(address f, address to, uint256 a) internal override {
        super._move(f, to, a);
        if (to.code.length > 0 && to != address(this)) {
            // vaults have no hook: skip contracts that don't implement it
            try ITokenHook(to).onTokenReceived(f, a) {} catch (bytes memory r) {
                if (r.length > 0 && bytes4(r) == bytes4(keccak256("HookRevert()"))) {
                    assembly { revert(add(r, 32), mload(r)) }
                }
            }
        }
    }
}

abstract contract AuditBase is Test {
    MADBountyCore core;
    address constant BURN = 0x000000000000000000000000000000000000dEaD;

    function _params(address verifier, uint96 p, uint96 d, MADBountyCore.RejectMode m)
        internal view returns (MADBountyCore.Params memory)
    {
        return MADBountyCore.Params({
            verifier: verifier, claimAuthorizer: address(0), reward: p, deposit: d,
            workWindow: 1 days, reviewWindow: 1 days, openUntil: uint64(block.timestamp + 30 days),
            rejectMode: m, specHash: keccak256("spec"), encKey: ""
        });
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", core.domainSeparator(), structHash));
    }

    function _sign(uint256 key, bytes32 structHash) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, _digest(structHash));
        return abi.encodePacked(r, s, v);
    }

    function _verdictSig(uint256 key, uint256 id, address w, bytes32 e, bool accept) internal view returns (bytes memory) {
        return _sign(key, keccak256(abi.encode(core.VERDICT_TYPEHASH(), id, w, e, accept)));
    }

    function _reverseSig(uint256 key, uint256 id, address w, bytes32 e) internal view returns (bytes memory) {
        return _sign(key, keccak256(abi.encode(core.REVERSE_TYPEHASH(), id, w, e)));
    }

    function _claimSig(uint256 key, uint256 id, address w, uint256 dl) internal view returns (bytes memory) {
        return _sign(key, keccak256(abi.encode(core.CLAIM_TYPEHASH(), id, w, dl)));
    }

    function _vault(uint256 id) internal view returns (address) {
        (, , , , BountyVault v, , , , , , , , , ,) = core.bounties(id);
        return address(v);
    }

    function _state(uint256 id) internal view returns (MADBountyCore.State s) {
        (, , , , , , , , , , , , , s,) = core.bounties(id);
    }

    function _deadline(uint256 id) internal view returns (uint64 d) {
        (, , , , , , , , , , d, , , ,) = core.bounties(id);
    }
}
