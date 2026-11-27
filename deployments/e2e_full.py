#!/usr/bin/env python3
"""Full live function sweep of MAD Bounty on Base Sepolia.
`python3 e2e_full.py now`   : every path that completes immediately + every revert guard (eth_call, no gas)
`python3 e2e_full.py later` : runs due time-gated actions (abandon 1h, adapter windows 1h, timeout 12-24h, cooling 24h)
Results append to e2e-full.log; pending actions in e2e-full-state.json. Keys are read from ~/.secrets and never printed."""
import json, os, subprocess, sys, time

MAINNET = os.environ.get("MADB_NET") == "mainnet"
R = os.environ.get("MADB_RPC") or ("https://base.drpc.org" if MAINNET else "https://sepolia.base.org")
D = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "base-mainnet.json" if MAINNET else "base-sepolia.json")))
CORE, USDC = D["contracts"]["MADBountyCore"], D["usdc"]
FB, OC, HR, TV, MV = (D["contracts"][k] for k in ("FallbackVerifier", "OnchainCheckVerifier", "HashRevealVerifier", "TeeMLVerifier", "MultiVerifier"))
TREAS, DEAD, ZERO = D["treasury"], "0x000000000000000000000000000000000000dEaD", "0x" + "0" * 40
SEC = os.path.expanduser("~/.secrets/")
HERE = os.path.dirname(os.path.abspath(__file__))
_sfx = "-mainnet" if MAINNET else ""
STATE, LOG = os.environ.get("MADB_E2E_STATE", os.path.join(HERE, f"e2e-full{_sfx}-state.json")), os.path.join(HERE, f"e2e-full{_sfx}.log")
PARAMS = "(address,address,uint96,uint96,uint32,uint32,uint64,uint8,bytes32,bytes,bytes)"
BOUNTY = "bounties(uint256)(address,address,address,address,address,uint96,uint96,uint32,uint32,uint64,uint64,bool,uint8,uint8,bytes32)"
ST = {1: "Open", 2: "Claimed", 3: "Submitted", 4: "Rejected", 5: "Paid", 6: "Burned", 7: "Refunded", 8: "Cancelled"}
ONE = 1_000_000
RESULTS = {"pass": 0, "fail": 0}

TRANSIENT = ("HTTP error 403", "HTTP error 429", "rate limit", "request limit", "timed out", "408", "502", "503", "Archive requests")
def cast(*a, check=True):
    for attempt in range(5):  # public RPCs are load-balanced/rate-limited: retry only pre-broadcast transient errors
        r = subprocess.run(["cast", *a], capture_output=True, text=True)
        err = r.stderr + r.stdout
        if r.returncode == 0 or not any(t in err for t in TRANSIENT) or "nonce too low" in err: break
        time.sleep(2 + 3 * attempt)
    if check and r.returncode: raise RuntimeError(r.stderr.strip()[:500])
    return r
def out(*a): return cast(*a).stdout.strip()
def key(n): return open(SEC + n).read().strip()
def addr(k): return out("wallet", "address", "--private-key", k)
def newkey(): return json.loads(out("wallet", "new", "--json"))[0]["private_key"]
def call(to, sig, *args): return out("call", to, sig, *args, "--rpc-url", R)
def first(s): return s.split("\n")[0].split(" ")[0]
def bal(a): return int(first(call(USDC, "balanceOf(address)(uint256)", a)))
def b(i): return call(CORE, BOUNTY, str(i)).split("\n")
def state(i): return int(first(b(i)[13]))
def vault(i): return first(b(i)[4])
def fee_bps(i):
    # v1.1 core locks a rate per bounty; the pre-ratchet core (no feeBpsOf) was a flat 1%
    r = cast("call", CORE, "feeBpsOf(uint256)(uint256)", str(i), "--rpc-url", R, check=False)
    return int(first(r.stdout.strip())) if r.returncode == 0 else 100
def fee(i, amt=ONE): return amt * fee_bps(i) // 10_000
def kk(*parts): return out("keccak", *parts)
def enc(sig, *args): return out("abi-encode", sig, *args)
def sel(err): return out("sig", err)[:10].lower()

def log(msg):
    line = time.strftime("%Y-%m-%dT%H:%M:%SZ ", time.gmtime()) + msg
    print(line, flush=True); open(LOG, "a").write(line + "\n")
def check(name, ok, detail=""):
    RESULTS["pass" if ok else "fail"] += 1
    log(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""))
    return ok

def send(k, to, sig=None, *args, value=None):
    head = [to, sig, *args] if sig else [to]
    extra = ["--value", value] if value else []
    o = json.loads(out("send", *head, *extra, "--private-key", k, "--rpc-url", R, "--json"))
    if int(o["status"], 16) != 1: raise RuntimeError(f"tx failed {o['transactionHash']}")
    return o["transactionHash"]
def tx(name, k, to, sig=None, *args, value=None):
    try:
        h = send(k, to, sig, *args, value=value); check(name, True, h); return h
    except Exception as e:
        check(name, False, str(e)[:240]); return None
def reverts(name, frm, to, sig, args, err):
    r = cast("call", "--from", frm, to, sig, *args, "--rpc-url", R, check=False)
    blob = (r.stderr + r.stdout).lower()
    ok = r.returncode != 0 and (sel(err) in blob or err.split("(")[0].lower() in blob)
    return check(f"{name} reverts {err.split('(')[0]}", ok, "" if ok else (r.stderr or r.stdout).strip()[:200])

AG, WK, VK = ((key("madb-mainnet-agent.key"), key("madb-mainnet-worker.key"), key("madb-mainnet-verifier.key")) if MAINNET else
              (key("madb-testnet-deployer3.key"), key("madb-testnet-deployer2.key"), key("madb-testnet-deployer.key")))
A, W, V = addr(AG), addr(WK), addr(VK)
STRANGER = "0x00000000000000000000000000000000000BEEF1"

def params(verifier, mode=0, review=43200, work=3600, open_s=86400, init="0x", auth=ZERO, reward=ONE, dep=ONE, enckey="0x"):
    now = int(time.time())
    return f"({verifier},{auth},{reward},{dep},{work},{review},{now + open_s},{mode},0x{'5a' * 32},{enckey},{init})"
def post(name, p):
    i = int(first(call(CORE, "nextId()(uint256)")))
    h = tx(f"{name}: post #{i}", AG, CORE, f"post({PARAMS})", p)
    if h is None: raise SystemExit("post failed, aborting")
    return i
def claim(i, k=None): return tx(f"#{i} claim", k or WK, CORE, "claim(uint256,uint256,bytes)", str(i), "0", "0x")
def submit(i, ev, k=None): return tx(f"#{i} submit", k or WK, CORE, "submit(uint256,bytes32)", str(i), ev)
def digest712(struct_hash):
    dom = first(call(CORE, "domainSeparator()(bytes32)"))
    return kk("0x1901" + dom[2:] + struct_hash[2:])
def signd(k, d): return out("wallet", "sign", "--no-hash", d, "--private-key", k)
def verdict_sig(k, i, worker, ev, accept):
    th = first(call(CORE, "VERDICT_TYPEHASH()(bytes32)"))
    return signd(k, digest712(kk(enc("f(bytes32,uint256,address,bytes32,bool)", th, str(i), worker, ev, "true" if accept else "false"))))
def reverse_sig(k, i, worker, ev):
    th = first(call(CORE, "REVERSE_TYPEHASH()(bytes32)"))
    return signd(k, digest712(kk(enc("f(bytes32,uint256,address,bytes32)", th, str(i), worker, ev))))
def expect_state(i, s, name=""): return check(f"#{i} state {ST.get(s)}{' ' + name if name else ''}", state(i) == s, ST.get(state(i)))
def vault_holds(i, amt): v = bal(vault(i)); return check(f"#{i} vault holds {amt/1e6} USDC", v == amt, f"{v/1e6}")

def later_add(st, due_in, action, **kw):
    st["pending"].append({"due": int(time.time()) + due_in, "action": action, **kw})

# --------------------------------------------------------------------------- now
def now_phase():
    st = {"pending": [], "started": int(time.time()), "core": CORE}
    log(f"==== NOW phase. agent {A} worker {W} verifier {V}")
    # funding
    if MAINNET:  # agent wallet is the only funded one: seed worker (gas + deposits) and verifier (gas)
        if float(out("balance", W, "--ether", "--rpc-url", R)) < 0.0003: tx("fund worker ETH", AG, W, value="0.0005ether")
        if float(out("balance", V, "--ether", "--rpc-url", R)) < 0.0002: tx("fund verifier ETH", AG, V, value="0.0004ether")
        if bal(W) < 7 * ONE: tx("agent -> worker 7 USDC (deposits)", AG, USDC, "transfer(address,uint256)", W, str(7 * ONE - bal(W)))
    elif float(out("balance", V, "--ether", "--rpc-url", R)) < 0.0003: tx("fund verifier ETH", AG, V, value="0.0006ether")
    if not MAINNET and bal(V) >= 15 * ONE: tx("verifier -> agent 15 USDC", VK, USDC, "transfer(address,uint256)", A, str(15 * ONE))
    if not MAINNET and bal(A) < 25 * ONE and bal(W) > 12 * ONE: tx("worker -> agent 8 USDC", WK, USDC, "transfer(address,uint256)", A, str(8 * ONE))
    tx("agent approve", AG, USDC, "approve(address,uint256)", CORE, str(10**12))
    tx("worker approve", WK, USDC, "approve(address,uint256)", CORE, str(10**12))
    tx("verifier approve", VK, USDC, "approve(address,uint256)", CORE, str(10**12))

    # ---- views
    check("NAME()", out("call", CORE, "NAME()(string)", "--rpc-url", R) == '"MADBounty"')
    check("VERSION()", out("call", CORE, "VERSION()(string)", "--rpc-url", R) == '"1"')
    terms = out("call", CORE, "TERMS()(string)", "--rpc-url", R)
    check("TERMS() non-empty + mentions silence rule", "silence" in terms.lower(), terms[:80])
    check("manualURI()", D["manualURI"] in call(CORE, "manualURI()(string)"))
    check("manualHash()", first(call(CORE, "manualHash()(bytes32)")) == D["manualHash"])
    check("treasury()", first(call(CORE, "treasury()(address)")).lower() == TREAS.lower())
    check("usdc()", first(call(CORE, "usdc()(address)")).lower() == USDC.lower())
    check("MAX_FEE_BPS == 500", first(call(CORE, "MAX_FEE_BPS()(uint256)")) == "500")
    check("feeBps == 500 (5%)", first(call(CORE, "feeBps()(uint256)")) == "500")
    reverts("lowerFee by non-treasury", A, CORE, "lowerFee(uint256)", ["100"], "NotAllowed()")
    reverts("lowerFee raise by treasury", TREAS, CORE, "lowerFee(uint256)", ["501"], "BadParam()")
    reverts("lowerFee equal by treasury", TREAS, CORE, "lowerFee(uint256)", ["500"], "BadParam()")
    check("minDeposit($2) = $1 floor", first(call(CORE, "minDeposit(uint256)(uint256)", str(2 * ONE))) == str(ONE))
    check("minDeposit($100) = $2 (2%)", first(call(CORE, "minDeposit(uint256)(uint256)", str(100 * ONE))) == str(2 * ONE))

    # ---- post() parameter guards (eth_call, no gas)
    for nm, p in [("reward < $1", params(V, reward=ONE - 1)), ("reward > $1000", params(V, reward=1000 * ONE + 1, dep=21 * ONE)),
                  ("deposit < floor", params(V, dep=ONE - 1)), ("deposit > reward", params(V, reward=ONE, dep=ONE + 1)),
                  ("workWindow < 1h", params(V, work=3599)), ("reviewWindow < 12h", params(V, review=43199)),
                  ("openUntil in past", params(V, open_s=-10)), ("verifier = 0", params(ZERO))]:
        reverts(f"post {nm}", A, CORE, f"post({PARAMS})", [p], "BadParam()")
    reverts("post HashReveal window+12h > review", A, CORE, f"post({PARAMS})",
            [params(HR, init=enc("f(bytes32,uint32)", "0x" + "ab" * 32, str(12 * 3600 + 1)))], "BadConfig()")
    reverts("post HashReveal window < 1h", A, CORE, f"post({PARAMS})",
            [params(HR, init=enc("f(bytes32,uint32)", "0x" + "ab" * 32, "3599"))], "BadConfig()")
    reverts("adapter onPost by non-core", A, HR, "onPost(uint256,address,bytes)", ["1", A, "0x"], "NotCore()")
    reverts("withdraw with nothing owed", A, CORE, "withdraw(uint256)", ["1"], "BadParam()")
    reverts("retryBurn with nothing owed", A, CORE, "retryBurn(uint256)", ["1"], "BadParam()")

    # ---- C1 cancel
    a0 = bal(A); i = post("cancel", params(V))
    reverts(f"#{i} cancel by stranger", W, CORE, "cancel(uint256)", [str(i)], "NotAllowed()")
    tx(f"#{i} cancel by agent", AG, CORE, "cancel(uint256)", str(i)); expect_state(i, 8)
    check(f"#{i} agent refunded in full", bal(A) == a0, f"{(bal(A)-a0)/1e6}"); vault_holds(i, 0)
    reverts(f"#{i} claim after cancel", W, CORE, "claim(uint256,uint256,bytes)", [str(i), "0", "0x"], "BadState()")

    # ---- C2 refundExpired (openUntil +120s)
    i = post("expiry", params(V, open_s=120))
    reverts(f"#{i} refundExpired before openUntil", W, CORE, "refundExpired(uint256)", [str(i)], "TooEarly()")
    later_add(st, 150, "expired", id=i)

    # ---- C3 claimAuthorizer + direct EOA settle (accept)
    i = post("claimAuthorizer=V, verifier=V", params(V, auth=V))
    reverts(f"#{i} claim with no auth", W, CORE, "claim(uint256,uint256,bytes)", [str(i), "0", "0x"], "TooLate()")
    dl = str(int(time.time()) + 3600)
    th = first(call(CORE, "CLAIM_TYPEHASH()(bytes32)"))
    asig = signd(VK, digest712(kk(enc("f(bytes32,uint256,address,uint256)", th, str(i), W, dl))))
    reverts(f"#{i} W's claim auth used by another address", A, CORE, "claim(uint256,uint256,bytes)", [str(i), dl, asig], "BadSig()")
    bad = signd(AG, digest712(kk(enc("f(bytes32,uint256,address,uint256)", th, str(i), W, dl))))
    reverts(f"#{i} claim auth signed by wrong key", W, CORE, "claim(uint256,uint256,bytes)", [str(i), dl, bad], "BadSig()")
    tx(f"#{i} claim with valid auth", WK, CORE, "claim(uint256,uint256,bytes)", str(i), dl, asig); expect_state(i, 2)
    vault_holds(i, 2 * ONE)
    reverts(f"#{i} second claim", A, CORE, "claim(uint256,uint256,bytes)", [str(i), dl, asig], "BadState()")
    reverts(f"#{i} submit by non-worker", A, CORE, "submit(uint256,bytes32)", [str(i), "0x" + "01" * 32], "NotAllowed()")
    reverts(f"#{i} settle before submit", V, CORE, "settle(uint256,bool)", [str(i), "true"], "BadState()")
    submit(i, "0x" + "c3" * 32)
    reverts(f"#{i} settle by non-verifier", A, CORE, "settle(uint256,bool)", [str(i), "true"], "NotAllowed()")
    reverts(f"#{i} payOnTimeout early", A, CORE, "payOnTimeout(uint256)", [str(i)], "TooEarly()")
    reverts(f"#{i} extendReview by worker", W, CORE, "extendReview(uint256)", [str(i)], "NotAllowed()")
    w0, t0 = bal(W), bal(TREAS)
    tx(f"#{i} verifier settle(accept) directly", VK, CORE, "settle(uint256,bool)", str(i), "true"); expect_state(i, 5)
    check(f"#{i} feeBpsOf locked at 500", fee_bps(i) == 500)
    check(f"#{i} worker +1.95 (reward-5% + deposit)", bal(W) - w0 == ONE - fee(i) + ONE, f"{(bal(W)-w0)/1e6}")
    check(f"#{i} treasury +0.05 fee", bal(TREAS) - t0 == fee(i)); vault_holds(i, 0)
    reverts(f"#{i} settle twice", V, CORE, "settle(uint256,bool)", [str(i), "false"], "BadState()")

    # ---- C4 abandoned claim -> reclaimAbandoned after 1h
    i = post("abandon", params(V)); claim(i)
    reverts(f"#{i} reclaimAbandoned early", A, CORE, "reclaimAbandoned(uint256)", [str(i)], "TooEarly()")
    later_add(st, 3600 + 60, "abandoned", id=i)

    # ---- C5 direct reject -> direct reverse (verifier undoes its own reject)
    i = post("direct reject+reverse", params(V)); claim(i); submit(i, "0x" + "c5" * 32)
    tx(f"#{i} verifier settle(reject)", VK, CORE, "settle(uint256,bool)", str(i), "false"); expect_state(i, 4)
    reverts(f"#{i} finalizeReject during cooling", A, CORE, "finalizeReject(uint256)", [str(i)], "TooEarly()")
    reverts(f"#{i} reverse by non-verifier", A, CORE, "reverse(uint256)", [str(i)], "NotAllowed()")
    w0 = bal(W)
    tx(f"#{i} verifier reverse()", VK, CORE, "reverse(uint256)", str(i)); expect_state(i, 5)
    check(f"#{i} worker paid after reverse", bal(W) - w0 == 2 * ONE - fee(i)); vault_holds(i, 0)

    # ---- C6 settleWithSig reject relayed, replay guards, reverseWithSig
    i = post("sig reject+reverseWithSig", params(V)); claim(i); ev = "0x" + "c6" * 32; submit(i, ev)
    reverts(f"#{i} replay of #3-style accept sig for another id", A, CORE, "settleWithSig(uint256,bool,bytes)",
            [str(i), "true", verdict_sig(VK, i - 1, W, ev, True)], "BadSig()")
    reverts(f"#{i} accept sig with wrong evidence", A, CORE, "settleWithSig(uint256,bool,bytes)",
            [str(i), "true", verdict_sig(VK, i, W, "0x" + "00" * 32, True)], "BadSig()")
    reverts(f"#{i} verdict signed by agent key", A, CORE, "settleWithSig(uint256,bool,bytes)",
            [str(i), "true", verdict_sig(AG, i, W, ev, True)], "BadSig()")
    rej = verdict_sig(VK, i, W, ev, False)
    tx(f"#{i} stranger relays reject sig", AG, CORE, "settleWithSig(uint256,bool,bytes)", str(i), "false", rej); expect_state(i, 4)
    reverts(f"#{i} reject sig reused as reverse", A, CORE, "reverseWithSig(uint256,bytes)", [str(i), rej], "BadSig()")
    reverts(f"#{i} accept sig can't overturn reject", A, CORE, "settleWithSig(uint256,bool,bytes)",
            [str(i), "true", verdict_sig(VK, i, W, ev, True)], "BadState()")
    tx(f"#{i} reverseWithSig relayed", AG, CORE, "reverseWithSig(uint256,bytes)", str(i), reverse_sig(VK, i, W, ev)); expect_state(i, 5)

    # ---- C7 extendReview then silence -> payOnTimeout after 24h
    i = post("extendReview + timeout", params(V)); claim(i); submit(i, "0x" + "c7" * 32)
    d0 = int(first(b(i)[10]))
    tx(f"#{i} agent extendReview", AG, CORE, "extendReview(uint256)", str(i))
    check(f"#{i} deadline +12h", int(first(b(i)[10])) - d0 == 43200)
    reverts(f"#{i} second extendReview", V, CORE, "extendReview(uint256)", [str(i)], "NotAllowed()")
    later_add(st, 86400 + 120, "timeout_after_extend", id=i)

    # ---- C8 REFUND reject via EOA -> finalize after cooling; C9 BURN reject via EOA -> finalize
    i = post("REFUND reject", params(V, mode=1)); claim(i); submit(i, "0x" + "c8" * 32)
    tx(f"#{i} reject (REFUND)", VK, CORE, "settle(uint256,bool)", str(i), "false"); later_add(st, 86400 + 120, "finalize_refund", id=i)
    i = post("BURN reject", params(V, mode=0)); claim(i); submit(i, "0x" + "c9" * 32)
    tx(f"#{i} reject (BURN)", VK, CORE, "settle(uint256,bool)", str(i), "false"); later_add(st, 86400 + 120, "finalize_burn", id=i)

    # ---- A1 FallbackVerifier ladder
    k2 = newkey(); a2 = addr(k2)
    signers = sorted([V, a2], key=lambda x: 0)  # order matters: [primary V, backup a2]
    i = post("Fallback [V, backup] step 120s", params(FB, init=enc("f(address[],uint32)", f"[{V},{a2}]", "120")))
    claim(i); ev = "0x" + "a1" * 32; submit(i, ev)
    fd = first(call(FB, "verdictDigest(uint256,address,bytes32,bool)(bytes32)", str(i), W, ev, "true"))
    reverts(f"#{i} backup verdict before its step", A, FB, "resolve(uint256,bool,uint256,bytes)", [str(i), "true", "1", signd(k2, fd)], "TooEarly()")
    reverts(f"#{i} backup sig claimed as primary", A, FB, "resolve(uint256,bool,uint256,bytes)", [str(i), "true", "0", signd(k2, fd)], "BadSig()")
    reverts(f"#{i} signer index out of range", A, FB, "resolve(uint256,bool,uint256,bytes)", [str(i), "true", "2", signd(k2, fd)], "BadIndex()")
    st["fb_backup"] = {"id": i, "sig": signd(k2, fd)}
    later_add(st, 150, "fallback_backup", id=i)
    i = post("Fallback primary reject + reverse", params(FB, init=enc("f(address[],uint32)", f"[{V},{a2}]", "120")))
    claim(i); ev = "0x" + "a2" * 32; submit(i, ev)
    tx(f"#{i} primary reject via Fallback", AG, FB, "resolve(uint256,bool,uint256,bytes)", str(i), "false", "0",
       signd(VK, first(call(FB, "verdictDigest(uint256,address,bytes32,bool)(bytes32)", str(i), W, ev, "false")))); expect_state(i, 4)
    rd = first(call(FB, "reverseDigest(uint256,address,bytes32)(bytes32)", str(i), W, ev))
    reverts(f"#{i} backup cannot reverse", A, FB, "reverse(uint256,bytes)", [str(i), signd(k2, rd)], "BadSig()")
    reverts(f"#{i} core-domain reverse sig rejected by adapter", A, FB, "reverse(uint256,bytes)", [str(i), reverse_sig(VK, i, W, ev)], "BadSig()")
    tx(f"#{i} primary reverse via Fallback", AG, FB, "reverse(uint256,bytes)", str(i), signd(VK, rd)); expect_state(i, 5)
    reverts("Fallback configure on a settled bounty", A, FB, "configure(uint256,address[],uint32)", [str(i), f"[{V}]", "0"], "NotOpen()")

    json.dump(st, open(STATE, "w"), indent=1)
    part2(st)

def part2(st):
    if not MAINNET and state(15) == 3:  # crash leftover (testnet only): primary (V) accepts the Fallback bounty #15
        ev = first(b(15)[14])
        tx("#15 primary accept via Fallback (step 0)", AG, FB, "resolve(uint256,bool,uint256,bytes)", "15", "true", "0",
           signd(VK, first(call(FB, "verdictDigest(uint256,address,bytes32,bool)(bytes32)", "15", W, ev, "true")))); expect_state(15, 5)
    # ---- A1b Fallback backup ladder (backup key persisted so the later phase can use it)
    k2 = newkey(); a2 = addr(k2)
    i = post("Fallback backup ladder", params(FB, init=enc("f(address[],uint32)", f"[{V},{a2}]", "120")))
    claim(i); ev = "0x" + "a3" * 32; submit(i, ev)
    fd = first(call(FB, "verdictDigest(uint256,address,bytes32,bool)(bytes32)", str(i), W, ev, "true"))
    reverts(f"#{i} backup verdict before its step", A, FB, "resolve(uint256,bool,uint256,bytes)", [str(i), "true", "1", signd(k2, fd)], "TooEarly()")
    st["fb_backup"] = {"id": i, "sig": signd(k2, fd)}; later_add(st, 150, "fallback_backup", id=i)
    json.dump(st, open(STATE, "w"), indent=1)
    # ---- A2 OnchainCheck with a real target
    flag = os.environ.get("E2E_FLAG")
    if flag: check("reuse E2EFlag target", int(out("codesize", flag, "--rpc-url", R)) > 0, flag)
    if flag:
        nid = int(first(call(CORE, "nextId()(uint256)")))
        init = enc("f(address,bytes,bytes32,uint32)", flag, out("calldata", "done(uint256)", str(nid)), kk(enc("f(bool)", "true")), "3600")
        i = post("OnchainCheck accept", params(OC, init=init, review=46800)); claim(i); submit(i, "0x" + "b1" * 32)
        reverts(f"#{i} resolve while check false", A, OC, "resolve(uint256)", [str(i)], "CheckFailed()")
        reverts(f"#{i} rejectUnmet before window", A, OC, "rejectUnmet(uint256)", [str(i)], "TooEarly()")
        tx(f"#{i} worker does the on-chain work", WK, flag, "set(uint256)", str(i))
        tx(f"#{i} stranger resolves", AG, OC, "resolve(uint256)", str(i)); expect_state(i, 5)
        nid = int(first(call(CORE, "nextId()(uint256)")))
        init = enc("f(address,bytes,bytes32,uint32)", flag, out("calldata", "done(uint256)", str(nid)), kk(enc("f(bool)", "true")), "3600")
        i = post("OnchainCheck zero-work", params(OC, init=init, review=46800)); claim(i); submit(i, "0x" + "b2" * 32)
        later_add(st, 3600 + 60, "reject_unmet", id=i)

    # ---- A3 HashReveal guards
    ans = "0x" + b"e2e-full-answer-salt-41aa".hex()
    i = post("HashReveal", params(HR, init=enc("f(bytes32,uint32)", kk(enc("f(bytes)", ans)), "3600"), review=46800))
    reverts(f"#{i} reveal before submit", W, HR, "reveal(uint256,bytes)", [str(i), ans], "NotSubmitted()")
    claim(i); submit(i, "0x" + "b3" * 32)
    reverts(f"#{i} reveal by non-worker", A, HR, "reveal(uint256,bytes)", [str(i), ans], "NotWorker()")
    reverts(f"#{i} wrong answer", W, HR, "reveal(uint256,bytes)", [str(i), "0x" + b"wrong".hex()], "WrongAnswer()")
    tx(f"#{i} correct reveal", WK, HR, "reveal(uint256,bytes)", str(i), ans); expect_state(i, 5)

    # ---- A4 MultiVerifier quorum accept + quorum reverse
    pk = [VK, newkey(), newkey()]; panel = sorted([(addr(k), k) for k in pk], key=lambda x: int(x[0], 16))
    pa = "[" + ",".join(a for a, _ in panel) + "]"
    i = post("Multi 2-of-3 accept", params(MV, init=enc("f(address[],uint8)", pa, "2"))); claim(i); ev = "0x" + "b4" * 32; submit(i, ev)
    dg = first(call(MV, "verdictDigest(uint256,address,bytes32,bool)(bytes32)", str(i), W, ev, "true"))
    s = [signd(k, dg) for _, k in panel]
    reverts(f"#{i} 1 sig < threshold", A, MV, "resolve(uint256,bool,address[],bytes[])", [str(i), "true", f"[{panel[0][0]}]", f"[{s[0]}]"], "BelowThreshold()")
    reverts(f"#{i} duplicate signer", A, MV, "resolve(uint256,bool,address[],bytes[])", [str(i), "true", f"[{panel[0][0]},{panel[0][0]}]", f"[{s[0]},{s[0]}]"], "NotSorted()")
    reverts(f"#{i} unsorted signers", A, MV, "resolve(uint256,bool,address[],bytes[])", [str(i), "true", f"[{panel[1][0]},{panel[0][0]}]", f"[{s[1]},{s[0]}]"], "NotSorted()")
    reverts(f"#{i} outsider in quorum", A, MV, "resolve(uint256,bool,address[],bytes[])",
            [str(i), "true", "[" + ",".join(sorted([panel[0][0], STRANGER], key=lambda x: int(x, 16))) + "]", f"[{s[0]},{s[1]}]"], "UnknownSigner()")
    tx(f"#{i} 2-of-3 accept", AG, MV, "resolve(uint256,bool,address[],bytes[])", str(i), "true", f"[{panel[0][0]},{panel[1][0]}]", f"[{s[0]},{s[1]}]"); expect_state(i, 5)
    i = post("Multi reject + quorum reverse", params(MV, init=enc("f(address[],uint8)", pa, "2"))); claim(i); ev = "0x" + "b5" * 32; submit(i, ev)
    dg = first(call(MV, "verdictDigest(uint256,address,bytes32,bool)(bytes32)", str(i), W, ev, "false"))
    tx(f"#{i} 2-of-3 reject", AG, MV, "resolve(uint256,bool,address[],bytes[])", str(i), "false", f"[{panel[1][0]},{panel[2][0]}]",
       "[" + ",".join(signd(k, dg) for _, k in panel[1:]) + "]"); expect_state(i, 4)
    rd = first(call(MV, "reverseDigest(uint256,address,bytes32)(bytes32)", str(i), W, ev))
    tx(f"#{i} 2-of-3 reverse", AG, MV, "reverse(uint256,address[],bytes[])", str(i), f"[{panel[0][0]},{panel[2][0]}]",
       f"[{signd(panel[0][1], rd)},{signd(panel[2][1], rd)}]"); expect_state(i, 5)

    # ---- A5 TeeML with a stand-in enclave key (real 0G vector is covered in periphery tests)
    ek = newkey(); ea = addr(ek)
    prefix = '{"model":"glm-5.3-flash","temperature":0,"messages":[{"role":"user","content":"Judge the evidence. '
    suffix = ' End with exactly VERDICT:Y or VERDICT:N."}]}'
    # NOTE: suffix holds the format string, so the response must not echo it.
    px, sx = "0x" + prefix.encode().hex(), "0x" + suffix.encode().hex()
    init = enc("f(address[],bytes32,bytes32,uint32)", f"[{ea}]", kk(px), kk(sx), "3600")
    evidence = "photo cid bafy-e2e shows the storefront sign at 10:42"
    evx = "0x" + evidence.encode().hex()
    def tee_case(name, resp_text, ev_text=evidence, expect=None):
        nid = int(first(call(CORE, "nextId()(uint256)")))
        return nid
    i = post("TeeML accept", params(TV, init=init, review=46800)); claim(i); submit(i, kk(evx))
    mk = first(call(TV, "marker(uint256,bytes32)(bytes)", str(i), kk(evx)))
    req = "0x" + prefix.encode().hex() + mk[2:] + evidence.encode().hex() + suffix.encode().hex()
    def tee_sig(resp_hex):
        rs = out("sha256", req) if False else None
        reqsha = "0x" + __import__("hashlib").sha256(bytes.fromhex(req[2:])).hexdigest()
        respsha = "0x" + __import__("hashlib").sha256(bytes.fromhex(resp_hex[2:])).hexdigest()
        text = first(call(TV, "signedText(bytes32,bytes32)(bytes)", reqsha, respsha))
        return out("wallet", "sign", text, "--private-key", ek), reqsha, respsha
    two = "0x" + b"Format VERDICT:Y or VERDICT:N. Sign shown. VERDICT:Y".hex()
    sg, _, _ = tee_sig(two)
    reverts(f"#{i} response with 2 VERDICT tokens", A, TV, "resolve(uint256,bytes,uint256,uint256,bytes,bytes)",
            [str(i), req, str(len(prefix)), str(len(suffix)), two, sg], "NoVerdict()")
    good = "0x" + b"The sign is visible. VERDICT:Y".hex()
    sg, rq, rp = tee_sig(good)
    check(f"#{i} teeSigner recovers stand-in enclave", first(call(TV, "teeSigner(bytes32,bytes32,bytes)(address)", rq, rp, sg)).lower() == ea.lower())
    reverts(f"#{i} sig from a non-enclave key", A, TV, "resolve(uint256,bytes,uint256,uint256,bytes,bytes)",
            [str(i), req, str(len(prefix)), str(len(suffix)), good, out("wallet", "sign", first(call(TV, "signedText(bytes32,bytes32)(bytes)", rq, rp)), "--private-key", AG)], "BadSigner()")
    tx(f"#{i} TeeML VERDICT:Y relayed", AG, TV, "resolve(uint256,bytes,uint256,uint256,bytes,bytes)", str(i), req, str(len(prefix)), str(len(suffix)), good, sg); expect_state(i, 5)
    i = post("TeeML no proof", params(TV, init=init, review=46800)); claim(i); submit(i, kk("0x" + b"withheld".hex()))
    reverts(f"#{i} rejectUnproven early", A, TV, "rejectUnproven(uint256)", [str(i)], "TooEarly()")
    later_add(st, 3600 + 60, "reject_unproven", id=i)

    json.dump(st, open(STATE, "w"), indent=1)
    log(f"==== NOW done: {RESULTS['pass']} pass, {RESULTS['fail']} fail; {len(st['pending'])} pending timed actions")

# ------------------------------------------------------------------------- later
def later_phase():
    global CORE
    st = json.load(open(STATE)); now = int(time.time()); keep = []
    CORE = st.get("core", CORE)
    log(f"==== LATER phase ({len(st['pending'])} pending)")
    for p in st["pending"]:
        if p["due"] > now: keep.append(p); continue
        i, act = p["id"], p["action"]
        try:
            if act == "expired":
                reverts(f"#{i} claim after openUntil", W, CORE, "claim(uint256,uint256,bytes)", [str(i), "0", "0x"], "TooLate()")
                a0 = bal(A); tx(f"#{i} stranger refundExpired", WK, CORE, "refundExpired(uint256)", str(i))
                expect_state(i, 8); check(f"#{i} agent got reward back", bal(A) - a0 == ONE)
            elif act == "abandoned":
                tx(f"#{i} reclaimAbandoned", AG, CORE, "reclaimAbandoned(uint256)", str(i)); expect_state(i, 1, "(reopened)")
                vault_holds(i, ONE); tx(f"#{i} agent cancels reopened bounty", AG, CORE, "cancel(uint256)", str(i)); expect_state(i, 8)
            elif act == "timeout_after_extend":
                reverts(f"#{i} late verdict", V, CORE, "settle(uint256,bool)", [str(i), "false"], "TooLate()")
                tx(f"#{i} payOnTimeout", AG, CORE, "payOnTimeout(uint256)", str(i)); expect_state(i, 5); vault_holds(i, 0)
            elif act == "finalize_refund":
                reverts(f"#{i} reverse after cooling", V, CORE, "reverse(uint256)", [str(i)], "TooLate()")
                a0 = bal(A); tx(f"#{i} finalizeReject REFUND", WK, CORE, "finalizeReject(uint256)", str(i)); expect_state(i, 7)
                check(f"#{i} agent refunded reward", bal(A) - a0 == ONE); vault_holds(i, 0)
            elif act == "finalize_burn":
                d0 = bal(DEAD); tx(f"#{i} finalizeReject BURN", WK, CORE, "finalizeReject(uint256)", str(i)); expect_state(i, 6)
                check(f"#{i} 2 USDC sent to 0x…dEaD", bal(DEAD) - d0 == 2 * ONE); vault_holds(i, 0)
            elif act == "fallback_backup":
                tx(f"#{i} backup verdict after step", AG, FB, "resolve(uint256,bool,uint256,bytes)", str(i), "true", "1", st["fb_backup"]["sig"]); expect_state(i, 5)
            elif act == "reject_unmet":
                tx(f"#{i} rejectUnmet", AG, p.get("adapter", TV), "rejectUnmet(uint256)", str(i)); expect_state(i, 4)
                later_add_keep(keep, 86400 + 120, "finalize_burn", i)
            elif act == "r3_junk_reject_blocked":   # audit r3 F-1c live: REFUND + junk commitment cannot be rejected
                reverts(f"#{i} rejectUnrevealed without opening (REFUND, junk)", A, HR,
                        "rejectUnrevealed(uint256,bytes)", [str(i), "0x"], "WrongAnswer()")
            elif act == "r3_junk_pays_worker":
                w0 = bal(W); tx(f"#{i} payOnTimeout (junk commitment -> worker paid)", AG, CORE, "payOnTimeout(uint256)", str(i))
                expect_state(i, 5); check(f"#{i} worker paid reward-fee+deposit", bal(W) - w0 == 2 * ONE - fee(i))
            elif act == "reject_unproven":
                tx(f"#{i} rejectUnproven", AG, p.get("adapter", TV), "rejectUnproven(uint256)", str(i)); expect_state(i, 4)
                later_add_keep(keep, 86400 + 120, "finalize_burn", i)
        except Exception as e:
            check(f"#{i} {act}", False, str(e)[:200])
    st["pending"] = keep; json.dump(st, open(STATE, "w"), indent=1)
    log(f"==== LATER done: {RESULTS['pass']} pass, {RESULTS['fail']} fail; {len(keep)} still pending" +
        (f", next due {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime(min(p['due'] for p in keep)))}" if keep else ""))

def later_add_keep(keep, due_in, action, i): keep.append({"due": int(time.time()) + due_in, "action": action, "id": i})

if __name__ == "__main__":
    if sys.argv[1] == "part2":
        st = json.load(open(STATE)) if os.path.exists(STATE) else {"pending": []}
        part2(st)
    else:
        {"now": now_phase, "later": later_phase}[sys.argv[1]]()
