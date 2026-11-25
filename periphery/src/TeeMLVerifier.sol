// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {MADBountyCore} from "../../src/MADBountyCore.sol";
import {AdapterBase} from "./AdapterBase.sol";
import {BytesSearch} from "./BytesSearch.sol";

/// @title TeeMLVerifier (0G Compute TeeML)
/// @notice Settles from an LLM verdict signed inside a 0G TeeML enclave. 0G TeeML providers sign the text
///         `hex(sha256(requestBody)) ":" hex(sha256(responseBody))` (lowercase, no 0x, 129 chars) with EIP-191
///         personal_sign; the signer is the provider's teeSignerAddress (published on 0G chain, which Base can't
///         read, so the agent pins 1..3 enclave signer addresses per bounty).
///
///         The request must be EXACTLY: prefix || marker || evidence || suffix, where
///           - keccak256(prefix) == prefixHash and keccak256(suffix) == suffixHash (fixed by the agent: model,
///             temperature 0, system prompt, judging rubric, JSON framing),
///           - marker == "MADB:" || lowercase hex(core) || ":" || decimal(id) || ":" || 0x-hex(evidenceHash),
///           - keccak256(evidence) == bounty.evidenceHash, and evidence is a valid JSON string BODY (no raw '"',
///             no control bytes, every '\' starts a valid escape), so it cannot break out of the JSON string the
///             agent's prefix opens (no injected messages/params). Workers therefore commit
///             evidenceHash = keccak256(JSON-escaped evidence text).
///         Without the template, a worker could ask the same public TEE "say VERDICT:Y" and get a valid signature.
///         Verdict: the response must contain EXACTLY ONE "VERDICT:" token, followed by Y or N (audit M-01: a
///         first-occurrence parse let an echoed format string or reasoning override the final answer). Zero or
///         several tokens → revert. Evidence may not contain "VERDICT" and is capped at MAX_EVIDENCE bytes.
///
///         Burden of proof is on the WORKER (audit C-02): only the worker holds the evidence text, so a reject
///         proof could be withheld or gas-bombed. Therefore:
///           - `resolve` with a valid enclave VERDICT:Y accepts; with VERDICT:N it rejects (anyone may relay).
///           - if no valid proof has settled the bounty `proofWindow` after submission, ANYONE may call
///             `rejectUnproven`. A worker who wants to be paid must obtain and relay the accept proof in time.
///         Trust: the enclave signer + model; prompt injection inside the evidence text remains an LLM risk.
///         Anti-grinding: the agent's template should pin temperature 0 / a seed. The first valid resolve wins.
///         REVERSE: not supported (a TEE verdict can't be re-asked meaningfully); a reject stands.
///         REFUND-safe: yes if the agent does not control the enclave signer, but the agent writes the prompt,
///         so workers must read the template (prefix/suffix preimages are published off-chain by the agent)
///         and test it against the enclave BEFORE claiming.
contract TeeMLVerifier is AdapterBase {
    uint256 public constant MAX_SIGNERS = 3;
    uint256 public constant MAX_EVIDENCE = 8192;
    uint256 public constant MAX_RESPONSE = 16384;
    bytes internal constant VERDICT_TAG = "VERDICT:";
    bytes internal constant VERDICT_WORD = "VERDICT";

    struct Config {
        address[3] signers;
        uint8 count;
        uint32 proofWindow;
        bytes32 prefixHash;
        bytes32 suffixHash;
    }

    mapping(uint256 => Config) internal _configs;

    event Configured(uint256 indexed id, address[] signers, bytes32 prefixHash, bytes32 suffixHash, uint32 proofWindow);
    event RejectedUnproven(uint256 indexed id, address indexed caller);
    event Resolved(uint256 indexed id, address indexed teeSigner, bool accept, bytes32 requestSha, bytes32 responseSha);

    error BadSigner();
    error BadTemplate();
    error BadMarker();
    error BadEvidence();
    error NoVerdict();

    constructor(MADBountyCore core_) AdapterBase(core_) {}

    /// @notice Two-step path (a claim can front-run it). Prefer `post` with
    ///         verifierInit = abi.encode(address[] signers, bytes32 prefixHash, bytes32 suffixHash, uint32 proofWindow).
    function configure(uint256 id, address[] calldata signers, bytes32 prefixHash, bytes32 suffixHash, uint32 proofWindow)
        external
    {
        BountyView memory b = _checkConfigurable(id);
        _set(id, b, signers, prefixHash, suffixHash, proofWindow);
    }

    function _configure(uint256 id, BountyView memory b, bytes calldata data) internal override {
        (address[] memory signers, bytes32 prefixHash, bytes32 suffixHash, uint32 proofWindow) =
            abi.decode(data, (address[], bytes32, bytes32, uint32));
        _set(id, b, signers, prefixHash, suffixHash, proofWindow);
    }

    function _set(
        uint256 id,
        BountyView memory b,
        address[] memory signers,
        bytes32 prefixHash,
        bytes32 suffixHash,
        uint32 proofWindow
    ) internal {
        Config storage c = _configs[id];
        if (c.count != 0) revert AlreadyConfigured();
        uint256 n = signers.length;
        if (n == 0 || n > MAX_SIGNERS) revert BadConfig();
        for (uint256 i; i < n; ++i) {
            if (signers[i] == address(0)) revert BadConfig();
            for (uint256 j; j < i; ++j) if (signers[j] == signers[i]) revert BadConfig();
            c.signers[i] = signers[i];
        }
        _checkWindow(b, proofWindow);
        c.count = uint8(n);
        c.proofWindow = proofWindow;
        c.prefixHash = prefixHash;
        c.suffixHash = suffixHash;
        emit Configured(id, signers, prefixHash, suffixHash, proofWindow);
    }

    function config(uint256 id)
        external
        view
        returns (address[] memory signers, bytes32 prefixHash, bytes32 suffixHash, uint32 proofWindow)
    {
        Config storage c = _configs[id];
        signers = new address[](c.count);
        for (uint256 i; i < c.count; ++i) signers[i] = c.signers[i];
        return (signers, c.prefixHash, c.suffixHash, c.proofWindow);
    }

    /// @notice The binding marker the request must carry right after the agent's prefix.
    function marker(uint256 id, bytes32 evidenceHash) public view returns (bytes memory) {
        return bytes(string.concat(
            "MADB:", Strings.toHexString(address(core)), ":", Strings.toString(id), ":",
            Strings.toHexString(uint256(evidenceHash), 32)
        ));
    }

    /// @notice The 129-char text 0G TeeML signs.
    function signedText(bytes32 requestSha, bytes32 responseSha) public pure returns (bytes memory t) {
        t = new bytes(129);
        bytes16 hexd = "0123456789abcdef";
        for (uint256 i; i < 32; ++i) {
            t[2 * i] = hexd[uint8(requestSha[i]) >> 4];
            t[2 * i + 1] = hexd[uint8(requestSha[i]) & 15];
            t[65 + 2 * i] = hexd[uint8(responseSha[i]) >> 4];
            t[65 + 2 * i + 1] = hexd[uint8(responseSha[i]) & 15];
        }
        t[64] = ":";
    }

    /// @notice EIP-191 recover of a 0G TeeML signature. Returns address(0) on a malformed signature.
    function teeSigner(bytes32 requestSha, bytes32 responseSha, bytes memory sig) public pure returns (address) {
        bytes32 h = MessageHashUtils.toEthSignedMessageHash(signedText(requestSha, responseSha));
        (address s, ECDSA.RecoverError err,) = ECDSA.tryRecover(h, sig);
        return err == ECDSA.RecoverError.NoError ? s : address(0);
    }

    /// @notice The response must contain exactly one "VERDICT:" token, immediately followed by Y or N.
    function parseVerdict(bytes memory response) public pure returns (bool accept) {
        bytes memory tag = VERDICT_TAG;
        uint256 i = BytesSearch.indexOf(response, tag, 0);
        if (i == BytesSearch.NOT_FOUND || i + tag.length >= response.length) revert NoVerdict();
        if (BytesSearch.indexOf(response, tag, i + 1) != BytesSearch.NOT_FOUND) revert NoVerdict();
        bytes1 v = response[i + tag.length];
        if (v == "Y") return true;
        if (v == "N") return false;
        revert NoVerdict();
    }

    /// @notice True if `s` can sit between two '"' in JSON without terminating the string early.
    function isJsonStringBody(bytes calldata s) public pure returns (bool) {
        uint256 n = s.length;
        for (uint256 i; i < n; ++i) {
            bytes1 ch = s[i];
            if (ch == '"' || uint8(ch) < 0x20) return false;
            if (ch == "\\") {
                if (++i >= n) return false;
                bytes1 e = s[i];
                if (e == "u") {
                    if (i + 4 >= n) return false;
                    for (uint256 k = 1; k <= 4; ++k) {
                        bytes1 h = s[i + k];
                        if (!((h >= "0" && h <= "9") || (h >= "a" && h <= "f") || (h >= "A" && h <= "F"))) return false;
                    }
                    i += 4;
                } else if (!(e == '"' || e == "\\" || e == "/" || e == "b" || e == "f" || e == "n" || e == "r" || e == "t")) {
                    return false;
                }
            }
        }
        return true;
    }

    /// @param prefixLen length of the agent's prefix inside `request`
    /// @param suffixLen length of the agent's suffix inside `request`
    function resolve(
        uint256 id,
        bytes calldata request,
        uint256 prefixLen,
        uint256 suffixLen,
        bytes calldata response,
        bytes calldata sig
    ) external {
        Config storage c = _configs[id];
        if (c.count == 0) revert NotConfigured();
        BountyView memory b = _bounty(id);
        _requireSubmitted(b);

        // (b) template + bounty binding
        bytes memory mk = marker(id, b.evidenceHash);
        uint256 evStart = prefixLen + mk.length;
        if (evStart + suffixLen > request.length) revert BadTemplate();
        uint256 evEnd = request.length - suffixLen;
        if (keccak256(request[:prefixLen]) != c.prefixHash) revert BadTemplate();
        if (keccak256(request[evEnd:]) != c.suffixHash) revert BadTemplate();
        if (keccak256(request[prefixLen:evStart]) != keccak256(mk)) revert BadMarker();
        bytes calldata evidence = request[evStart:evEnd];
        if (evidence.length > MAX_EVIDENCE || response.length > MAX_RESPONSE) revert BadEvidence();
        if (keccak256(evidence) != b.evidenceHash) revert BadEvidence();
        if (!isJsonStringBody(evidence)) revert BadEvidence();
        if (BytesSearch.indexOf(evidence, VERDICT_WORD, 0) != BytesSearch.NOT_FOUND) revert BadEvidence();

        // (a) enclave signature
        bytes32 reqSha = sha256(request);
        bytes32 respSha = sha256(response);
        address s = teeSigner(reqSha, respSha, sig);
        bool allowed;
        for (uint256 i; i < c.count; ++i) if (s != address(0) && c.signers[i] == s) allowed = true;
        if (!allowed) revert BadSigner();

        // (c) verdict
        bool accept = parseVerdict(response);
        emit Resolved(id, s, accept, reqSha, respSha);
        core.settle(id, accept);
    }

    /// @notice Anyone: no valid enclave proof settled the bounty within proofWindow of submission → reject.
    function rejectUnproven(uint256 id) external {
        Config storage c = _configs[id];
        if (c.count == 0) revert NotConfigured();
        BountyView memory b = _bounty(id);
        _requireSubmitted(b);
        if (block.timestamp < _submittedAt(b) + c.proofWindow) revert TooEarly();
        emit RejectedUnproven(id, msg.sender);
        core.settle(id, false);
    }
}
