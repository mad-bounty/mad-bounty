#!/usr/bin/env python3
"""Live Base Sepolia E2E for MAD Bounty. Agent = deployer3, worker = deployer2, verifier/panel = deployer1 + 2 ephemeral keys.
Phase 'now': runs every path that can finish immediately, and leaves timeout/reject-finalize bounties pending.
Phase 'later': finishes them after the 12h review / 24h cooling windows. State in e2e-state.json."""
import json, os, subprocess, sys, time

R = "https://sepolia.base.org"
CORE = "0x0Bb5cd6132a0361Da9747bC90F0B06a212FB7786"
USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
HR = "0xCc06084256d8d31d49A52Fdc1860a1f91d3855a9"
MV = "0x174e9d5B2ff058DF8823855D5C270578E7eB57B2"
TREAS = "0x4a1447FC0466cECFCa2966E1116204E7906B5aF7"
SEC = os.path.expanduser("~/.secrets/")
HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HERE, "e2e-state.json")
PARAMS = "(address,address,uint96,uint96,uint32,uint32,uint64,uint8,bytes32,bytes,bytes)"
REWARD, DEP = 2_000_000, 1_000_000

def sh(*a):
    r = subprocess.run(["cast", *a], capture_output=True, text=True)
    if r.returncode: raise RuntimeError(f"cast {a[0]} {a[1] if len(a)>1 else ''}: {r.stderr.strip()[:400]}")
    return r.stdout.strip()

def key(n): return open(SEC + n).read().strip()
def addr(k): return sh("wallet", "address", "--private-key", k)
def call(to, sig, *args): return sh("call", to, sig, *args, "--rpc-url", R).split(" ")[0]
def send(k, to, sig, *args, value=None):
    extra = ["--value", value] if value else []
    head = [to, sig, *args] if sig else [to]
    out = json.loads(sh("send", *head, *extra, "--private-key", k, "--rpc-url", R, "--json"))
    assert int(out["status"], 16) == 1, out
    return out["transactionHash"]
def usdc(a): return int(call(USDC, "balanceOf(address)(uint256)", a))
def state(i): return int(sh("call", CORE, "bounties(uint256)(address,address,address,address,address,uint96,uint96,uint32,uint32,uint64,uint64,bool,uint8,uint8,bytes32)", str(i), "--rpc-url", R).split("\n")[13].split(" ")[0])
def sign(k, digest): return sh("wallet", "sign", "--no-hash", digest, "--private-key", k)

AG, WK, VK = key("madb-testnet-deployer3.key"), key("madb-testnet-deployer2.key"), key("madb-testnet-deployer.key")
A, W, V = addr(AG), addr(WK), addr(VK)
log = []
def note(name, tx, extra=""):
    line = f"{name}: tx {tx} {extra}"; print(line, flush=True); log.append(line)

def post(verifier, mode, review, init="0x", spec="0x" + "11" * 32):
    now = int(time.time())
    p = f"({verifier},0x0000000000000000000000000000000000000000,{REWARD},{DEP},3600,{review},{now + 86400},{mode},{spec},0x,{init})"
    i = int(call(CORE, "nextId()(uint256)"))
    tx = send(AG, CORE, f"post({PARAMS})", p)
    assert int(call(CORE, "nextId()(uint256)")) == i + 1
    return i, tx

def claim_submit(i, ev):
    t1 = send(WK, CORE, "claim(uint256,uint256,bytes)", str(i), "0", "0x")
    t2 = send(WK, CORE, "submit(uint256,bytes32)", str(i), ev)
    return t1, t2

def now_phase():
    st = {}
    if os.environ.get("RESUME_AFTER_1"):
        assert state(1) == 5; st["accept_sig"] = 1; note("#1 PAID (verified on resume)", "-")
    else:
        _step1(st)
    _rest(st)

def _step1(st):
    # funding: worker gets gas + USDC for deposits; approvals
    if float(sh("balance", W, "--ether", "--rpc-url", R)) < 0.0005:
        note("fund worker ETH", send(AG, W, "", value="0.0008ether"))
    if usdc(W) < 4 * DEP:
        note("fund worker USDC", send(AG, USDC, "transfer(address,uint256)", W, str(5 * DEP)))
    note("agent approve", send(AG, USDC, "approve(address,uint256)", CORE, str(100 * REWARD)))
    note("worker approve", send(WK, USDC, "approve(address,uint256)", CORE, str(100 * DEP)))

    # 1) ACCEPT via EOA verifier signature relayed by a stranger (the agent here)
    t0 = (usdc(W), usdc(TREAS))
    i, tx = post(V, 0, 43200); note(f"#{i} post (EOA verifier, BURN)", tx)
    ev = "0x" + "a1" * 32
    for t in claim_submit(i, ev): note(f"#{i} claim/submit", t)
    dom = call(CORE, "domainSeparator()(bytes32)")
    vt = call(CORE, "VERDICT_TYPEHASH()(bytes32)")
    sh_ = sh("keccak", sh("abi-encode", "f(bytes32,uint256,address,bytes32,bool)", vt, str(i), W, ev, "true"))
    digest = sh("keccak", "0x1901" + dom[2:] + sh_[2:])
    note(f"#{i} settleWithSig(accept)", send(AG, CORE, "settleWithSig(uint256,bool,bytes)", str(i), "true", sign(VK, digest)))
    assert state(i) == 5, state(i)
    dw, dt = usdc(W) - t0[0], usdc(TREAS) - t0[1]
    note(f"#{i} PAID", "-", f"worker net +{dw/1e6} USDC (expected +1.98 = reward-1% after deposit returned), treasury +{dt/1e6} (expected 0.02)")
    assert dw == REWARD - REWARD // 100 and dt == REWARD // 100
    st["accept_sig"] = i

def _rest(st):
    # 2) ACCEPT via HashRevealVerifier, configured atomically in post (H-01 fix live)
    answer = "0x" + b"mad-bounty-e2e-salt-7c1f".hex()
    commit = sh("keccak", sh("abi-encode", "f(bytes)", answer))
    init = sh("abi-encode", "f(bytes32,uint32)", commit, "3600")
    i, tx = post(HR, 1, 46800, init); note(f"#{i} post (HashReveal, REFUND, atomic config)", tx)
    assert call(HR, "commitment(uint256)(bytes32)", str(i)) == commit
    for t in claim_submit(i, "0x" + "b2" * 32): note(f"#{i} claim/submit", t)
    note(f"#{i} reveal(correct)", send(WK, HR, "reveal(uint256,bytes)", str(i), answer))
    assert state(i) == 5; st["accept_hashreveal"] = i

    # 3) REJECT via 2-of-3 MultiVerifier panel (BURN) -> Rejected; finalizeReject after 24h cooling
    panel_keys = [VK] + [json.loads(sh("wallet", "new", "--json"))[0]["private_key"] for _ in range(2)]
    panel = sorted([(addr(k), k) for k in panel_keys], key=lambda x: int(x[0], 16))
    init = sh("abi-encode", "f(address[],uint8)", "[" + ",".join(a for a, _ in panel) + "]", "2")
    i, tx = post(MV, 0, 43200, init); note(f"#{i} post (Multi 2-of-3, BURN, atomic config)", tx)
    ev = "0x" + "c3" * 32
    for t in claim_submit(i, ev): note(f"#{i} claim/submit", t)
    d = call(MV, "verdictDigest(uint256,address,bytes32,bool)(bytes32)", str(i), W, ev, "false")
    s2 = panel[:2]
    note(f"#{i} panel reject", send(AG, MV, "resolve(uint256,bool,address[],bytes[])", str(i), "false",
         "[" + ",".join(a for a, _ in s2) + "]", "[" + ",".join(sign(k, d) for _, k in s2) + "]"))
    assert state(i) == 4; st["reject_multi"] = i

    # 4) TIMEOUT: EOA verifier stays silent -> payOnTimeout after 12h review
    i, tx = post(V, 0, 43200); note(f"#{i} post (silent verifier)", tx)
    for t in claim_submit(i, "0x" + "d4" * 32): note(f"#{i} claim/submit", t)
    st["timeout"] = i

    # 5) HashReveal zero-work -> rejectUnrevealed after 1h (C-01 fix live), REFUND -> finalize after cooling
    commit2 = sh("keccak", sh("abi-encode", "f(bytes)", "0x" + b"unknown-answer-9e2d".hex()))
    i, tx = post(HR, 1, 46800, sh("abi-encode", "f(bytes32,uint32)", commit2, "3600")); note(f"#{i} post (HashReveal zero-work, REFUND)", tx)
    for t in claim_submit(i, "0x" + "e5" * 32): note(f"#{i} claim/submit (no answer)", t)
    st["zero_work"] = i
    st["created"] = int(time.time())
    json.dump(st, open(STATE, "w"), indent=1)
    open(os.path.join(HERE, "e2e-now.log"), "w").write("\n".join(log) + "\n")

def later_phase():
    st = json.load(open(STATE)); out = []
    def tryit(name, fn):
        try: note(name, fn())
        except Exception as e: print(name, "NOT YET:", str(e)[:200])
    if state(st["zero_work"]) == 3:
        tryit(f"#{st['zero_work']} rejectUnrevealed", lambda: send(AG, HR, "rejectUnrevealed(uint256)", str(st["zero_work"])))
    for k in ("reject_multi", "zero_work"):
        if state(st[k]) == 4:
            tryit(f"#{st[k]} finalizeReject", lambda k=k: send(AG, CORE, "finalizeReject(uint256)", str(st[k])))
    if state(st["timeout"]) == 3:
        tryit(f"#{st['timeout']} payOnTimeout", lambda: send(AG, CORE, "payOnTimeout(uint256)", str(st["timeout"])))
    names = {1: "Open", 2: "Claimed", 3: "Submitted", 4: "Rejected", 5: "Paid", 6: "Burned", 7: "Refunded"}
    for k in ("accept_sig", "accept_hashreveal", "reject_multi", "timeout", "zero_work"):
        print(k, st[k], names.get(state(st[k])))
    open(os.path.join(HERE, "e2e-later.log"), "a").write("\n".join(log) + "\n")

if __name__ == "__main__":
    (later_phase if sys.argv[1:] == ["later"] else now_phase)()
