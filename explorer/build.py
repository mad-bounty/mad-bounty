#!/usr/bin/env python3
"""MAD Bounty explorer: static HTML generator over MADBountyCore events. Stdlib only.

    python3 explorer/build.py [--net mainnet|sepolia] [--out site/explorer] [--cache PATH]

Reads deployments/base-<net>.json, scans core events incrementally (cache-<net>.json keeps the
last scanned block, raw logs and block timestamps), reads live state with eth_call, and writes
plain HTML (no JS, no cookies) + data.json + sitemap.xml. Prints one line:
    N bounties, M events, changed=yes|no
changed ignores the 'Last updated' line (HTML) and generatedAt/block (JSON).
"""
import argparse
import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from keccak import keccak256, to_checksum  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
SITE = "https://madbounty.org"
BURN = "0x000000000000000000000000000000000000dead"
REORG_MARGIN = 30          # re-scan this many blocks each run; logs are deduped by (tx, logIndex)
FEED_LEN = 50
LATEST_LEN = 25

NETS = {
    "mainnet": {
        "json": "deployments/base-mainnet.json", "label": "Base", "chainId": 8453,
        "rpcs": ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
        "scan": "https://basescan.org",
    },
    "sepolia": {
        "json": "deployments/base-sepolia.json", "label": "Base Sepolia (testnet)", "chainId": 84532,
        "rpcs": ["https://base-sepolia-rpc.publicnode.com", "https://sepolia.base.org"],
        "scan": "https://sepolia.basescan.org",
    },
}

STATES = ["None", "Open", "Claimed", "Submitted", "Rejected", "Paid", "Burned", "Refunded", "Cancelled"]
TERMINAL = {"Paid", "Burned", "Refunded", "Cancelled"}
STATE_PILL = {"Open": "blue", "Claimed": "gold", "Submitted": "gold", "Rejected": "red",
              "Paid": "blue", "Burned": "red", "Refunded": "", "Cancelled": ""}

# Exact signatures from src/MADBountyCore.sol (indexed flags only matter for decoding below).
EVENTS = {
    "Posted": "Posted(uint256,address,address,address,uint256,uint256,uint32,uint32,uint64,uint8,address,bytes32,bytes)",
    "Cancelled": "Cancelled(uint256)",
    "Expired": "Expired(uint256)",
    "Claimed": "Claimed(uint256,address,uint64)",
    "Submitted": "Submitted(uint256,bytes32,uint64)",
    "ReviewExtended": "ReviewExtended(uint256,uint64)",
    "Rejected": "Rejected(uint256,uint64)",
    "Reversed": "Reversed(uint256)",
    "Paid": "Paid(uint256,address,uint256,uint256,bool)",
    "Burned": "Burned(uint256,uint256)",
    "Refunded": "Refunded(uint256,uint256,uint256)",
    "Abandoned": "Abandoned(uint256,address,uint256)",
    "Owed": "Owed(uint256,address,uint256)",
    "Withdrawn": "Withdrawn(uint256,address,uint256)",
    "FeeLowered": "FeeLowered(uint256,uint256)",
}
TOPIC = {"0x" + keccak256(sig.encode()).hex(): name for name, sig in EVENTS.items()}


def selector(sig):
    return "0x" + keccak256(sig.encode()).hex()[:8]


SEL_BOUNTIES = selector("bounties(uint256)")
SEL_FEEOF = selector("feeBpsOf(uint256)")
SEL_NEXTID = selector("nextId()")
SEL_FEE = selector("feeBps()")
SEL_BAL = selector("balanceOf(address)")


# ------------------------------------------------------------------------------------------- RPC

class RpcError(Exception):
    pass


class Rpc:
    def __init__(self, urls):
        self.urls = list(urls)
        self.i = 0
        self.calls = 0

    @property
    def url(self):
        return self.urls[self.i]

    def _post(self, payload, url):
        req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                     headers={"content-type": "application/json", "user-agent": "madb-explorer/1"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")[:300]
            raise RpcError(f"HTTP {e.code}: {body}")
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise RpcError(f"network: {e}")

    def _send(self, payload, failover=True):
        last = None
        for attempt in range(6):
            try:
                self.calls += 1
                return self._post(payload, self.url)
            except RpcError as e:
                last = e
                msg = str(e)
                if "range" in msg.lower() or "413" in msg:
                    raise  # range errors are handled by the caller (adaptive chunking)
                time.sleep(min(2 ** attempt, 10))
                if failover and attempt >= 2 and len(self.urls) > 1:
                    self.i = (self.i + 1) % len(self.urls)
        raise last

    def call(self, method, params):
        res = self._send({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
        if "error" in res:
            raise RpcError(json.dumps(res["error"]))
        return res["result"]

    def batch(self, reqs, size=40):
        """reqs: list of (method, params). Returns results in order. Falls back to single calls."""
        out = []
        for k in range(0, len(reqs), size):
            part = reqs[k:k + size]
            payload = [{"jsonrpc": "2.0", "id": j, "method": m, "params": p} for j, (m, p) in enumerate(part)]
            try:
                res = self._send(payload)
                if not isinstance(res, list):
                    raise RpcError(f"batch unsupported: {str(res)[:200]}")
                byid = {r.get("id"): r for r in res}
                got = []
                for j in range(len(part)):
                    r = byid.get(j)
                    if r is None or "error" in r:
                        got.append(self.call(*part[j]))
                    else:
                        got.append(r["result"])
                out.extend(got)
            except RpcError:
                out.extend(self.call(m, p) for m, p in part)
        return out


def get_logs(rpc, address, start, end, log):
    """Scan [start, end] with adaptive chunking (Base Sepolia public RPC caps at 200 blocks,
    publicnode at 50000). Range errors shrink the chunk; other errors fail over to the next RPC."""
    logs, chunk, frm = [], 50000, start
    while frm <= end:
        to = min(end, frm + chunk - 1)
        try:
            res = rpc.call("eth_getLogs", [{"address": address, "fromBlock": hex(frm), "toBlock": hex(to)}])
        except RpcError as e:
            msg = str(e)
            lim = re.search(r"(?:range|limited to)[^0-9]{0,40}(\d{2,7})", msg) or re.search(r"(\d{2,7})", msg)
            rangeish = any(s in msg.lower() for s in ("range", "413", "too many", "limit", "exceed"))
            if "archive" in msg.lower() and len(rpc.urls) > 1:
                rpc.i = (rpc.i + 1) % len(rpc.urls)
                log(f"  rpc {rpc.url} (archive limit on previous)")
                continue
            if rangeish and chunk > 1:
                n = int(lim.group(1)) if lim else 0
                chunk = n if 0 < n < chunk else max(1, chunk // 2)
                continue
            raise
        logs.extend(res)
        frm = to + 1
    return logs


# ------------------------------------------------------------------------------------- decoding

def words(data):
    d = data[2:] if data.startswith("0x") else data
    return [d[i:i + 64] for i in range(0, len(d), 64)]


def w_int(w):
    return int(w, 16)


def w_addr(w):
    return "0x" + w[-40:].lower()


def decode(lg):
    name = TOPIC.get(lg["topics"][0].lower())
    if not name:
        return None
    t, w = lg["topics"], words(lg["data"])
    e = {"event": name, "block": int(lg["blockNumber"], 16), "tx": lg["transactionHash"].lower(),
         "logIndex": int(lg["logIndex"], 16)}
    if name != "FeeLowered":
        e["id"] = int(t[1], 16)
    if name == "Posted":
        e.update(agent=w_addr(t[2]), verifier=w_addr(t[3]), vault=w_addr(w[0]), reward=w_int(w[1]),
                 deposit=w_int(w[2]), workWindow=w_int(w[3]), reviewWindow=w_int(w[4]), openUntil=w_int(w[5]),
                 rejectMode=w_int(w[6]), claimAuthorizer=w_addr(w[7]), specHash="0x" + w[8])
        off = w_int(w[9]) // 32
        ln = w_int(w[off]) if off < len(w) else 0
        raw = "".join(w[off + 1:])[:ln * 2] if ln else ""
        e["encKey"] = "0x" + raw
    elif name == "Claimed":
        e.update(worker=w_addr(t[2]), deadline=w_int(w[0]))
    elif name == "Submitted":
        e.update(evidenceHash="0x" + w[0], reviewDeadline=w_int(w[1]))
    elif name == "ReviewExtended":
        e.update(reviewDeadline=w_int(w[0]))
    elif name == "Rejected":
        e.update(coolingEnd=w_int(w[0]))
    elif name == "Paid":
        e.update(worker=w_addr(t[2]), toWorker=w_int(w[0]), fee=w_int(w[1]), byTimeout=bool(w_int(w[2])))
    elif name == "Burned":
        e.update(amount=w_int(w[0]))
    elif name == "Refunded":
        e.update(toAgent=w_int(w[0]), depositBurned=w_int(w[1]))
    elif name == "Abandoned":
        e.update(worker=w_addr(t[2]), depositBurned=w_int(w[0]))
    elif name in ("Owed", "Withdrawn"):
        e.update(to=w_addr(t[2]), amount=w_int(w[0]))
    elif name == "FeeLowered":
        e.update(oldBps=w_int(w[0]), newBps=w_int(w[1]))
    return e


def decode_bounty(hexdata):
    w = words(hexdata)
    if len(w) < 15:
        raise RpcError(f"bounties() returned {len(w)} words")
    return {
        "agent": w_addr(w[0]), "verifier": w_addr(w[1]), "claimAuthorizer": w_addr(w[2]), "worker": w_addr(w[3]),
        "vault": w_addr(w[4]), "reward": w_int(w[5]), "deposit": w_int(w[6]), "workWindow": w_int(w[7]),
        "reviewWindow": w_int(w[8]), "openUntil": w_int(w[9]), "deadline": w_int(w[10]),
        "extended": bool(w_int(w[11])), "rejectMode": w_int(w[12]), "state": w_int(w[13]),
        "evidenceHash": "0x" + w[14],
    }


# ------------------------------------------------------------------------------------ formatting

ZERO = "0x" + "0" * 40
ZERO32 = "0x" + "0" * 64


def usdc(n, unit=True):
    s = f"{n / 1e6:,.6f}".rstrip("0")
    if len(s.split(".")[1]) < 2:
        s = f"{n / 1e6:,.2f}"
    return s + (" USDC" if unit else "")


def ts(t, sec=False):
    if not t:
        return "—"
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC" if sec else "%Y-%m-%d %H:%M UTC")


def dur(s):
    if s % 86400 == 0:
        return f"{s // 86400}d"
    if s % 3600 == 0:
        return f"{s // 3600}h"
    return f"{s // 60}m"


def esc(s):
    return html.escape(str(s), quote=True)


def short(a):
    c = to_checksum(a)
    return c[:6] + "…" + c[-4:]


class Ctx:
    def __init__(self, net, dep):
        self.net, self.dep, self.cfg = net, dep, NETS[net]
        self.scan = self.cfg["scan"]
        self.labels = {}
        names = {"MADBountyCore": "MAD Bounty core", "FallbackVerifier": "Fallback adapter",
                 "OnchainCheckVerifier": "OnchainCheck adapter", "HashRevealVerifier": "HashReveal adapter",
                 "TeeMLVerifier": "TeeML adapter", "MultiVerifier": "Multi (m-of-n) adapter"}
        old = dep.get("supersededV1", {})
        for k, v in old.get("contracts", {}).items():
            self.labels[v.lower()] = names.get(k, k) + " (superseded v1)"
        for k, v in old.get("olderAdapters", {}).items():
            if isinstance(v, str) and v.startswith("0x"):
                self.labels[v.lower()] = names.get(k, k) + " (pre-r3, superseded)"
        for k, v in dep["contracts"].items():
            self.labels[v.lower()] = names.get(k, k)
        for k, v in (dep.get("reputation") or {}).items():
            if isinstance(v, str) and v.startswith("0x") and len(v) == 42:
                self.labels[v.lower()] = k
        self.labels[dep["treasury"].lower()] = "Treasury"
        self.labels[dep["usdc"].lower()] = "USDC"
        self.labels[BURN] = "Burn address"
        self.adapters = {v.lower() for k, v in dep["contracts"].items() if k != "MADBountyCore"}
        self.known = set()

    def tx(self, h, text=None):
        return f'<a class="mono" href="{self.scan}/tx/{esc(h)}">{esc(text or h[:10] + "…")}</a>'

    def addr(self, a, internal=True, label=True):
        """Link an address: to its explorer page if it took part in a bounty, else to basescan."""
        if not a or a == ZERO:
            return '<span class="addr">—</span>'
        a = a.lower()
        lbl = self.labels.get(a) if label else None
        text = esc(short(a)) + (f' <span class="pill">{esc(lbl)}</span>' if lbl else "")
        href = f"/explorer/address/{a}/" if internal and a in self.known else f"{self.scan}/address/{to_checksum(a)}"
        return f'<a class="mono" href="{href}" title="{to_checksum(a)}">{text}</a>'

    def scanaddr(self, a):
        c = to_checksum(a)
        return f'<a class="mono" href="{self.scan}/address/{c}">{c}</a>'


def pill(state):
    return f'<span class="pill {STATE_PILL.get(state, "")}">{esc(state)}</span>'


# ------------------------------------------------------------------------------------------ HTML

LOGO = ('<svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">'
        '<rect x="1" y="1" width="24" height="24" rx="7" stroke="#2e9bff" stroke-width="2"/>'
        '<path d="M7 16.5v-4a2.5 2.5 0 0 1 5 0v4" stroke="#eef2f7" stroke-width="2" stroke-linecap="round"/>'
        '<path d="M14 16.5v-4a2.5 2.5 0 0 1 5 0v4" stroke="#eef2f7" stroke-width="2" stroke-linecap="round"/></svg>')

EXTRA_CSS = """<style>
.xt { width:100%; border-collapse:collapse; font-size:.88rem; }
.xt th, .xt td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--line-soft); vertical-align:top; }
.xt th { color:var(--ink-3); font-weight:500; font-size:.76rem; text-transform:uppercase; letter-spacing:.06em; white-space:nowrap; }
.xt th.n { text-align:right; }
.xt td.n { text-align:right; white-space:nowrap; font-family:var(--mono); font-size:.84rem; }
.scroll { overflow-x:auto; border:1px solid var(--line); border-radius:var(--r); background:var(--bg-raise); }
.feed { list-style:none; }
.feed li { display:grid; grid-template-columns:190px 1fr; gap:12px; align-items:baseline; padding:10px 0; border-bottom:1px solid var(--line-soft); color:var(--ink-2); font-size:.92rem; }
.feed li .when { color:var(--ink-3); font-family:var(--mono); font-size:.78rem; white-space:nowrap; }
@media (max-width:640px) { .feed li { grid-template-columns:1fr; gap:2px; } }
.xt td.t { color:var(--ink-3); }
.stats { margin-top:28px; }
.updated { color:var(--ink-3); font-size:.82rem; font-family:var(--mono); }
.hash { font-family:var(--mono); font-size:.8rem; word-break:break-all; color:var(--ink-2); }
.stats .v { font-size:1.5rem; }
.xt a.mono, .feed a.mono { white-space:nowrap; }
.xt .lbl { display:block; color:var(--ink-3); font-size:.76rem; white-space:nowrap; }
.xt th[scope=row] { width:1%; }
</style>"""


def page(ctx, title, desc, canon, body, updated):
    netnote = "" if ctx.net == "mainnet" else '<span class="pill gold">testnet</span> '
    core = ctx.dep["contracts"]["MADBountyCore"]
    rep = ctx.dep.get("reputation") or {}
    contracts = [f'<span class="addr">Core {esc(core)}</span>']
    for k, lbl in (("MADReceipts", "Receipts"), ("MADAttest", "Attest")):
        if rep.get(k):
            contracts.append(f'<span class="addr">{lbl} {esc(rep[k])}</span>')
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)} — MAD Bounty Explorer</title>
<meta name="description" content="{esc(desc)}">
<link rel="canonical" href="{SITE}{esc(canon)}">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<meta property="og:image" content="{SITE}/assets/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="alternate" type="application/json" href="/explorer/data.json">
<link rel="stylesheet" href="/assets/style.css">
{EXTRA_CSS}
</head>
<body>

<header>
  <div class="wrap nav">
    <a class="brand" href="/">
      {LOGO}
      MAD&nbsp;Bounty
    </a>
    <nav class="links">
      <a href="/#how">How it works</a>
      <a href="/docs">Docs</a>
      <a href="/agents">For agents</a>
      <a href="/app/">App</a>
      <a class="active" href="/explorer/">Explorer</a>
      <a href="https://github.com/mad-bounty/mad-bounty">GitHub</a>
      <a class="btn btn-primary btn-sm" href="/llms-full.txt">llms-full.txt</a>
    </nav>
  </div>
</header>

<main>
<section style="padding-top:40px">
  <div class="wrap stack">
    <div class="callout warn"><strong>Not externally audited.</strong> The contracts are immutable and bugs are permanent, so only escrow what you can afford to lose. Rewards are capped at $1,000 per bounty.</div>
    <p class="updated">{netnote}Last updated {esc(updated)}</p>
{body}
  </div>
</section>
</main>

<footer>
  <div class="wrap foot">
    <div class="col">
      <div class="h">Protocol</div>
      <a href="/docs">Documentation</a>
      <a href="/agents">Agent integration</a>
      <a href="/explorer/">Explorer</a>
      <a href="/explorer/data.json">data.json</a>
      <a href="/llms.txt">llms.txt</a>
    </div>
    <div class="col">
      <div class="h">Code</div>
      <a href="https://github.com/mad-bounty/mad-bounty">GitHub</a>
      <a href="https://github.com/mad-bounty/mad-bounty/tree/main/sdk">SDK</a>
      <a href="https://github.com/mad-bounty/mad-bounty/tree/main/mcp">MCP server</a>
    </div>
    <div class="col">
      <div class="h">Contracts · {esc(ctx.cfg["label"])}</div>
      {chr(10).join("      " + c for c in contracts).strip()}
    </div>
    <div class="fine">
      Generated from on-chain events of the MAD Bounty core contract; no JavaScript, no cookies. Read-only view: to post or work a bounty, see the <a href="/docs">docs</a>. Nothing here is financial advice.
    </div>
  </div>
</footer>

</body>
</html>
"""


def norm_html(s):
    return "\n".join(l for l in s.split("\n") if 'class="updated"' not in l)


# ------------------------------------------------------------------------------------------ model

def sentence(ctx, e, with_id=True):
    b = f'<a href="/explorer/bounty/{e["id"]}/">Bounty #{e["id"]}</a>' if with_id and "id" in e else "Bounty"
    n = e["event"]
    if n == "Posted":
        return (f'{b} posted by {ctx.addr(e["agent"])}: reward {usdc(e["reward"])}, worker deposit '
                f'{usdc(e["deposit"])}, verifier {ctx.addr(e["verifier"])}')
    if n == "Claimed":
        return f'{b} claimed by {ctx.addr(e["worker"])}; work due {ts(e["deadline"])}'
    if n == "Submitted":
        return f'{b}: evidence submitted; review deadline {ts(e["reviewDeadline"])}'
    if n == "ReviewExtended":
        return f'{b}: review extended to {ts(e["reviewDeadline"])}'
    if n == "Rejected":
        return f'{b} rejected by the verifier; cooling period ends {ts(e["coolingEnd"])}'
    if n == "Reversed":
        return f'{b}: verifier reversed its rejection'
    if n == "Paid":
        how = " (verifier silent: paid on timeout)" if e["byTimeout"] else ""
        return f'{b} paid {usdc(e["toWorker"])} to {ctx.addr(e["worker"])} (fee {usdc(e["fee"])}){how}'
    if n == "Burned":
        return f'{b}: {usdc(e["amount"])} burned'
    if n == "Refunded":
        return f'{b}: reward {usdc(e["toAgent"])} refunded to the agent, deposit {usdc(e["depositBurned"])} burned'
    if n == "Abandoned":
        return (f'{b}: {ctx.addr(e["worker"])} missed the work window; deposit {usdc(e["depositBurned"])} burned, '
                f'bounty reopened')
    if n == "Cancelled":
        return f'{b} cancelled by the agent; reward returned'
    if n == "Expired":
        return f'{b} expired unclaimed; reward returned to the agent'
    if n == "Owed":
        return f'{b}: transfer of {usdc(e["amount"])} to {ctx.addr(e["to"])} failed; credited as withdrawable'
    if n == "Withdrawn":
        return f'{b}: {ctx.addr(e["to"])} withdrew {usdc(e["amount"])}'
    if n == "FeeLowered":
        return f'Protocol fee for new bounties lowered from {e["oldBps"] / 100:g}% to {e["newBps"] / 100:g}%'
    return esc(n)


def next_step(b, now):
    s, mode = b["state"], ("BURN" if b["rejectMode"] == 0 else "REFUND")
    if s == "Open":
        if now <= b["openUntil"]:
            return (f'Open for claims until {ts(b["openUntil"])}. After that, anyone can call refundExpired '
                    f'to return the reward to the agent.')
        return (f'The claim window closed {ts(b["openUntil"])}. Anyone can call refundExpired to return the '
                f'reward to the agent.')
    if s == "Claimed":
        if now <= b["deadline"]:
            return (f'The worker has until {ts(b["deadline"])} to submit evidence. If they miss it, anyone can call '
                    f'reclaimAbandoned: the deposit burns and the bounty reopens.')
        return (f'The work window ended {ts(b["deadline"])} without a submission. Anyone can call reclaimAbandoned: '
                f'the deposit burns and the bounty reopens.')
    if s == "Submitted":
        ext = "" if b["extended"] else " The agent or verifier may extend the review once."
        if now <= b["deadline"]:
            return (f'The verifier has until {ts(b["deadline"])} to decide; if silent, the worker can be paid via '
                    f'payOnTimeout.{ext}')
        return (f'The review deadline passed {ts(b["deadline"])} with no verdict. Anyone can call payOnTimeout to '
                f'pay the worker.')
    if s == "Rejected":
        out = ("reward and deposit are burned" if mode == "BURN"
               else "the reward returns to the agent and the deposit is burned")
        if now <= b["deadline"]:
            return (f'Cooling period: the verifier may reverse the rejection until {ts(b["deadline"])}. After that, '
                    f'anyone can call finalizeReject ({mode} mode: {out}).')
        return f'Cooling ended {ts(b["deadline"])}. Anyone can call finalizeReject ({mode} mode: {out}).'
    return "Final. This bounty is settled; nothing further can happen except withdrawals of any failed transfers."


def load_cache(path, core):
    if os.path.exists(path):
        try:
            c = json.load(open(path))
            if c.get("core", "").lower() == core.lower():
                return c
        except (ValueError, OSError):
            pass
    return {"core": core, "lastBlock": None, "logs": [], "blockTimes": {}, "outputs": []}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--net", choices=list(NETS), default="mainnet")
    ap.add_argument("--out", default=os.path.join(REPO, "site", "explorer"))
    ap.add_argument("--cache", default=None)
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args()

    def log(m):
        if a.verbose:
            print(m, file=sys.stderr)

    cfg = NETS[a.net]
    dep = json.load(open(os.path.join(REPO, cfg["json"])))
    if int(dep["chainId"]) != cfg["chainId"]:
        sys.exit(f"chainId mismatch in {cfg['json']}")
    core = dep["contracts"]["MADBountyCore"]
    rpc = Rpc([os.environ["MADB_RPC"]] if os.environ.get("MADB_RPC") else cfg["rpcs"])
    if int(rpc.call("eth_chainId", []), 16) != cfg["chainId"]:
        sys.exit(f"RPC {rpc.url} is not chain {cfg['chainId']}")
    cache_path = a.cache or os.path.join(HERE, f"cache-{a.net}.json")
    cache = load_cache(cache_path, core)

    # ---- incremental log scan
    head = int(rpc.call("eth_blockNumber", []), 16)
    deploy = int(dep["deployBlock"])
    start = deploy if cache["lastBlock"] is None else max(deploy, cache["lastBlock"] + 1 - REORG_MARGIN)
    log(f"scan {start}..{head} via {rpc.url}")
    new = get_logs(rpc, core, start, head, log) if start <= head else []
    keep = [l for l in cache["logs"] if int(l["blockNumber"], 16) < start]
    seen, logs = set(), []
    for l in keep + new:
        if l.get("removed"):
            continue
        k = (l["transactionHash"].lower(), int(l["logIndex"], 16))
        if k not in seen:
            seen.add(k)
            logs.append({x: l[x] for x in ("blockNumber", "transactionHash", "logIndex", "topics", "data")})
    logs.sort(key=lambda l: (int(l["blockNumber"], 16), int(l["logIndex"], 16)))
    cache["logs"], cache["lastBlock"] = logs, head

    events = [e for e in (decode(l) for l in logs) if e]

    # ---- block timestamps (cached forever; blocks below head-margin are final)
    bt = cache["blockTimes"]
    need = sorted({e["block"] for e in events if str(e["block"]) not in bt} | {head})
    if need:
        res = rpc.batch([("eth_getBlockByNumber", [hex(n), False]) for n in need])
        for n, r in zip(need, res):
            bt[str(n)] = int(r["timestamp"], 16)
    for e in events:
        e["time"] = bt[str(e["block"])]
    now = bt[str(head)]
    for k in list(bt):
        if int(k) > head - REORG_MARGIN and int(k) != head and not any(e["block"] == int(k) for e in events):
            bt.pop(k, None)

    # ---- live state at head
    tag = hex(head)
    next_id = int(rpc.call("eth_call", [{"to": core, "data": SEL_NEXTID}, tag]), 16)
    fee_now = int(rpc.call("eth_call", [{"to": core, "data": SEL_FEE}, tag]), 16)
    ids = list(range(1, next_id))
    reqs = []
    for i in ids:
        arg = f"{i:064x}"
        reqs.append(("eth_call", [{"to": core, "data": SEL_BOUNTIES + arg}, tag]))
        reqs.append(("eth_call", [{"to": core, "data": SEL_FEEOF + arg}, tag]))
    res = rpc.batch(reqs) if reqs else []
    bounties = {}
    for k, i in enumerate(ids):
        b = decode_bounty(res[2 * k])
        b["feeBps"] = int(res[2 * k + 1], 16)
        b["id"] = i
        b["state"] = STATES[b["state"]] if b["state"] < len(STATES) else str(b["state"])
        bounties[i] = b
    usdc_addr = dep["usdc"]
    vb = rpc.batch([("eth_call", [{"to": usdc_addr, "data": SEL_BAL + "0" * 24 + b["vault"][2:]}, tag])
                    for b in bounties.values()]) if bounties else []
    for b, r in zip(bounties.values(), vb):
        b["vaultBalance"] = int(r, 16)

    # ---- join events onto bounties
    by_id = {}
    for e in events:
        if "id" in e:
            by_id.setdefault(e["id"], []).append(e)
    for i, b in bounties.items():
        evs = by_id.get(i, [])
        b["events"] = evs
        p = next((e for e in evs if e["event"] == "Posted"), None)
        b["postedAt"], b["postedTx"] = (p["time"], p["tx"]) if p else (None, None)
        b["specHash"] = p["specHash"] if p else None
        b["encKey"] = p["encKey"] if p else None
        b["workers"] = []
        for e in evs:
            if e["event"] == "Claimed" and e["worker"] not in b["workers"]:
                b["workers"].append(e["worker"])
        b["paid"] = sum(e["toWorker"] for e in evs if e["event"] == "Paid")
        b["fee"] = sum(e["fee"] for e in evs if e["event"] == "Paid")

    # ---- stats
    def tot(name, field):
        return sum(e[field] for e in events if e["event"] == name)

    owed_burn = sum(e["amount"] for e in events if e["event"] == "Owed" and e["to"] == BURN)
    returned = sum(bounties[e["id"]]["reward"] for e in events
                   if e["event"] in ("Cancelled", "Expired") and e["id"] in bounties) + tot("Refunded", "toAgent")
    counts = {s: 0 for s in STATES[1:]}
    for b in bounties.values():
        counts[b["state"]] = counts.get(b["state"], 0) + 1
    agents = {b["agent"] for b in bounties.values()}
    workers = {w for b in bounties.values() for w in b["workers"]}
    verifiers = {b["verifier"] for b in bounties.values()}
    stats = {
        "bountiesPosted": len(bounties),
        "byState": counts,
        "openNow": counts.get("Open", 0),
        "activeNow": sum(1 for b in bounties.values() if b["state"] not in TERMINAL),
        "inProgressNow": sum(1 for b in bounties.values() if b["state"] in ("Claimed", "Submitted", "Rejected")),
        "escrowedNow": sum(b["vaultBalance"] for b in bounties.values()),
        "escrowedActive": sum(b["vaultBalance"] for b in bounties.values() if b["state"] not in TERMINAL),
        "paidToWorkers": tot("Paid", "toWorker"),
        "burned": tot("Burned", "amount") + tot("Refunded", "depositBurned") + tot("Abandoned", "depositBurned")
        - owed_burn,
        "returnedToAgents": returned,
        "feesCollected": tot("Paid", "fee"),
        "feeBps": fee_now,
        "distinctAgents": len(agents),
        "distinctWorkers": len(workers),
        "distinctVerifiers": len(verifiers),
        "events": len(events),
    }

    ctx = Ctx(a.net, dep)
    ctx.known = agents | workers | verifiers
    updated = f"{ts(now)}, block {head:,}"
    outputs = {}

    # ---- index
    def bounty_rows(lst):
        rows = []
        for b in lst:
            vlabel = ctx.labels.get(b["verifier"])
            vl = '<span class="lbl">' + esc(vlabel) + "</span>" if vlabel else ""
            rows.append(
                f'<tr><td><a href="/explorer/bounty/{b["id"]}/">#{b["id"]}</a></td><td>{pill(b["state"])}</td>'
                f'<td class="n">{usdc(b["reward"], False)}</td><td>{ctx.addr(b["agent"])}</td>'
                f'<td>{ctx.addr(b["worker"]) if b["worker"] != ZERO else "—"}</td>'
                f'<td>{ctx.addr(b["verifier"], label=False)}{vl}</td>'
                f'<td class="n t">{esc(ts(b["postedAt"]))}</td></tr>')
        return ("<div class=\"scroll\"><table class=\"xt\">\n<tr><th>ID</th><th>State</th><th class=\"n\">Reward (USDC)</th>"
                "<th>Agent</th><th>Worker</th><th>Verifier</th><th class=\"n\">Posted</th></tr>\n" + "\n".join(rows)
                + "\n</table></div>")

    def stat(v, k):
        return f'<div class="stat"><div class="v">{v}</div><div class="k">{esc(k)}</div></div>'

    st = stats
    statgrid = "\n".join([
        '<div class="stats">',
        stat(st["bountiesPosted"], "Bounties posted"),
        stat(st["openNow"], "Open for claims"),
        stat(st["inProgressNow"], "In progress (claimed, submitted, rejected)"),
        stat(f'{usdc(st["escrowedNow"], False)} <span class="unit">USDC</span>', "In escrow now (vault balances)"),
        stat(f'{usdc(st["paidToWorkers"], False)} <span class="unit">USDC</span>', "Paid to workers (incl. deposits)"),
        stat(f'{usdc(st["burned"], False)} <span class="unit">USDC</span>', "Burned"),
        stat(f'{usdc(st["returnedToAgents"], False)} <span class="unit">USDC</span>', "Returned to agents"),
        stat(f'{usdc(st["feesCollected"], False)} <span class="unit">USDC</span>', "Protocol fees collected"),
        stat(f'{st["feeBps"] / 100:g}%', f'Fee for new bounties ({st["feeBps"]} bps)'),
        stat(st["distinctAgents"], "Distinct agents"),
        stat(st["distinctWorkers"], "Distinct workers"),
        stat(st["distinctVerifiers"], "Distinct verifiers"),
        "</div>"])

    latest = sorted(bounties.values(), key=lambda b: -b["id"])
    if latest:
        more = (f'<p><a href="/explorer/bounties/">All {len(latest)} bounties →</a></p>'
                if len(latest) > LATEST_LEN else "")
        table = bounty_rows(latest[:LATEST_LEN]) + more
        feed_items = sorted(events, key=lambda e: (-e["block"], -e["logIndex"]))[:FEED_LEN]
        feed = "<ul class=\"feed\">\n" + "\n".join(
            f'<li><span class="when">{esc(ts(e["time"], True))}</span><span>{sentence(ctx, e)} · {ctx.tx(e["tx"], "tx")}</span></li>'
            for e in feed_items) + "\n</ul>"
    else:
        table = ('<div class="card"><h3>No bounties yet</h3><p>The contract is live but nobody has posted a bounty '
                 'yet. An agent posts one by calling <code>post()</code> on the core with a reward in USDC, a worker '
                 'deposit, a verifier and its windows. Start with the <a href="/docs#posting">docs</a>, or hand your '
                 'agent <a href="/llms.txt">/llms.txt</a> (full manual: <a href="/llms-full.txt">llms-full.txt</a>; '
                 'tools: the <a href="https://github.com/mad-bounty/mad-bounty/tree/main/mcp">MCP server</a>).</p>'
                 '</div>')
        feed = '<p>No contract events yet.</p>'
    clist = []
    for k, v in list(dep["contracts"].items()) + [(k, v) for k, v in (dep.get("reputation") or {}).items()
                                                   if isinstance(v, str) and v.startswith("0x") and len(v) == 42]:
        clist.append(f'<tr><td>{esc(ctx.labels.get(v.lower(), k))}</td><td>{ctx.scanaddr(v)}</td>'
                     f'<td><a href="https://repo.sourcify.dev/{cfg["chainId"]}/{esc(v)}">Sourcify</a></td></tr>')
    clist.append(f'<tr><td>Treasury</td><td>{ctx.scanaddr(dep["treasury"])}</td><td></td></tr>')
    clist.append(f'<tr><td>USDC</td><td>{ctx.scanaddr(dep["usdc"])}</td><td></td></tr>')
    body = f"""    <div class="eyebrow"><span class="dot"></span> Explorer · {esc(cfg["label"])}</div>
    <h1>Every bounty, on-chain.</h1>
    <p class="lead">Live view of the MAD Bounty contract: what was posted, who claimed it, how it settled. Machine-readable: <a href="/explorer/data.json">data.json</a>.</p>
{statgrid}
    <h2 style="margin-top:40px">Latest bounties</h2>
{table}
    <h2 style="margin-top:40px">Recent activity</h2>
{feed}
    <h2 style="margin-top:40px">Contracts</h2>
    <div class="scroll"><table class="xt">
<tr><th>Contract</th><th>Address</th><th>Source</th></tr>
{chr(10).join(clist)}
</table></div>
    <p style="font-size:.88rem">Core deployed at block {int(dep["deployBlock"]):,}. Figures are computed from contract events and live <code>eth_call</code> reads at the block above. "Paid to workers" includes returned worker deposits; "Burned" counts reward and deposit burns to 0x…dEaD.</p>"""
    outputs["index.html"] = page(ctx, "Explorer", "Live MAD Bounty statistics, bounties and activity on "
                                 + cfg["label"] + ".", "/explorer/", body, updated)
    if len(latest) > LATEST_LEN:
        outputs["bounties/index.html"] = page(
            ctx, "All bounties", "Every MAD Bounty bounty.", "/explorer/bounties/",
            f'    <h1>All bounties</h1>\n{bounty_rows(latest)}', updated)

    # ---- bounty pages
    for b in bounties.values():
        mode = "BURN" if b["rejectMode"] == 0 else "REFUND"
        vlabel = ctx.labels.get(b["verifier"])
        warn = ""
        if mode == "REFUND" and b["verifier"] not in ctx.adapters:
            warn = ('<div class="callout warn"><strong>REFUND mode with a non-adapter verifier.</strong> If the agent '
                    'controls the verifier it can reject good work and recover the reward. Workers: check who the '
                    'verifier is before claiming.</div>')
        prev = [w for w in b["workers"] if w != b["worker"]]
        rows = [
            ("State", pill(b["state"])),
            ("Reward", usdc(b["reward"])),
            ("Worker deposit", usdc(b["deposit"])),
            ("Fee rate (locked at post)", f'{b["feeBps"] / 100:g}% ({b["feeBps"]} bps)'),
            ("Agent", ctx.addr(b["agent"])),
            ("Worker", ctx.addr(b["worker"]) if b["worker"] != ZERO else "— (unclaimed)"),
        ]
        if prev:
            rows.append(("Previous workers", ", ".join(ctx.addr(w) for w in prev)))
        rows += [
            ("Verifier", ctx.addr(b["verifier"], label=False) + (f' · {esc(vlabel)}' if vlabel else
                                                                  ' · not a known adapter (EOA or custom)')),
            ("Claim authorizer", ctx.addr(b["claimAuthorizer"]) if b["claimAuthorizer"] != ZERO
             else "None (anyone may claim)"),
            ("Reject mode", f'{mode} — ' + ("reward + deposit burn on a final reject" if mode == "BURN"
                                            else "reward returns to the agent, deposit burns")),
            ("Work window", dur(b["workWindow"])),
            ("Review window", dur(b["reviewWindow"]) + (" (extended once)" if b["extended"] else "")),
            ("Open until", ts(b["openUntil"])),
            ("Current deadline", ts(b["deadline"]) if b["deadline"] else "—"),
            ("Posted", (ts(b["postedAt"]) + " · " + ctx.tx(b["postedTx"])) if b["postedTx"] else "—"),
            ("Spec hash", f'<span class="hash">{esc(b["specHash"] or "—")}</span>'),
            ("Evidence hash", f'<span class="hash">{esc(b["evidenceHash"])}</span>' if b["evidenceHash"] != ZERO32
             else "—"),
            ("Vault", ctx.scanaddr(b["vault"]) + f' · balance {usdc(b["vaultBalance"])}'),
        ]
        if b["encKey"] and b["encKey"] != "0x":
            rows.append(("Agent encryption key", f'<span class="hash">{esc(b["encKey"])}</span>'))
        spec = "\n".join(f'<tr><th scope="row">{esc(k)}</th><td>{v}</td></tr>' for k, v in rows)
        tl = "\n".join(f'<li><span class="when">{esc(ts(e["time"], True))}</span><span><strong>{esc(e["event"])}</strong> — '
                       f'{sentence(ctx, e, with_id=False)} · {ctx.tx(e["tx"])}</span></li>' for e in b["events"])
        bbody = f"""    <div class="eyebrow"><span class="dot"></span> Bounty #{b["id"]} · {esc(cfg["label"])}</div>
    <h1>Bounty #{b["id"]} {pill(b["state"])}</h1>
    <p class="lead">{usdc(b["reward"])} reward · {usdc(b["deposit"])} deposit</p>
    <div class="callout"><strong>What happens next:</strong> {esc(next_step(b, now))}</div>
{warn}
    <div class="scroll"><table class="xt">
{spec}
</table></div>
    <h2 style="margin-top:36px">Timeline</h2>
    <ul class="feed">
{tl or "<li>No events found.</li>"}
    </ul>
    <p><a href="/explorer/">← All bounties</a></p>"""
        outputs[f"bounty/{b['id']}/index.html"] = page(
            ctx, f"Bounty #{b['id']}", f"MAD Bounty #{b['id']}: {b['state']}, reward {usdc(b['reward'])}.",
            f"/explorer/bounty/{b['id']}/", bbody, updated)

    # ---- address pages
    addr_data = {}
    for ad in sorted(ctx.known):
        as_agent = [b for b in bounties.values() if b["agent"] == ad]
        as_worker = [b for b in bounties.values() if ad in b["workers"]]
        as_ver = [b for b in bounties.values() if b["verifier"] == ad]
        earned = sum(e["toWorker"] for b in as_worker for e in b["events"] if e["event"] == "Paid"
                     and e["worker"] == ad)
        dep_burned = sum(e["depositBurned"] for b in as_worker for e in b["events"]
                         if e["event"] == "Abandoned" and e["worker"] == ad)
        dep_burned += sum(b["deposit"] for b in as_worker if b["worker"] == ad and b["state"] in ("Burned", "Refunded"))
        abandoned = sum(1 for b in as_worker for e in b["events"] if e["event"] == "Abandoned" and e["worker"] == ad)

        def outcomes(lst):
            c = {}
            for b in lst:
                c[b["state"]] = c.get(b["state"], 0) + 1
            return ", ".join(f"{v} {k.lower()}" for k, v in sorted(c.items())) or "—"

        summ = {
            "asAgent": {"bounties": len(as_agent), "rewardPosted": sum(b["reward"] for b in as_agent),
                        "paidOut": sum(b["paid"] for b in as_agent), "outcomes": outcomes(as_agent)},
            "asWorker": {"bounties": len(as_worker), "earned": earned, "abandoned": abandoned,
                         "depositsBurned": dep_burned,
                         "outcomes": outcomes([b for b in as_worker if b["worker"] == ad])},
            "asVerifier": {"bounties": len(as_ver), "outcomes": outcomes(as_ver)},
        }
        addr_data[to_checksum(ad)] = summ

        def tbl(lst, worker_view=False):
            if not lst:
                return "<p>None.</p>"
            r = []
            for b in sorted(lst, key=lambda x: -x["id"]):
                st_ = b["state"]
                if worker_view and b["worker"] != ad:
                    st_ = "Abandoned"
                r.append(f'<tr><td><a href="/explorer/bounty/{b["id"]}/">#{b["id"]}</a></td><td>{pill(st_)}</td>'
                         f'<td class="n">{usdc(b["reward"], False)}</td><td>{ctx.addr(b["agent"])}</td>'
                         f'<td>{ctx.addr(b["worker"]) if b["worker"] != ZERO else "—"}</td>'
                         f'<td class="n t">{esc(ts(b["postedAt"]))}</td></tr>')
            return ('<div class="scroll"><table class="xt">\n<tr><th>ID</th><th>Outcome</th><th class="n">Reward (USDC)</th>'
                    '<th>Agent</th><th>Worker</th><th class="n">Posted</th></tr>\n' + "\n".join(r) + "\n</table></div>")

        lbl = ctx.labels.get(ad)
        sa, sw, sv = summ["asAgent"], summ["asWorker"], summ["asVerifier"]
        abody = f"""    <div class="eyebrow"><span class="dot"></span> Address · {esc(cfg["label"])}</div>
    <h1 style="font-size:clamp(1.3rem,3vw,2rem);word-break:break-all">{esc(to_checksum(ad))}</h1>
    <p>{('<span class="pill blue">' + esc(lbl) + '</span> ') if lbl else ''}<a href="{ctx.scan}/address/{to_checksum(ad)}">View on Basescan</a></p>
    <div class="stats">
{stat(sa["bounties"], "Bounties posted (agent)")}
{stat(f'{usdc(sa["paidOut"], False)} <span class="unit">USDC</span>', "Paid out to workers")}
{stat(sw["bounties"], "Bounties claimed (worker)")}
{stat(f'{usdc(sw["earned"], False)} <span class="unit">USDC</span>', "Earned (incl. deposits back)")}
{stat(sw["abandoned"], "Claims abandoned")}
{stat(f'{usdc(sw["depositsBurned"], False)} <span class="unit">USDC</span>', "Own deposits burned")}
{stat(sv["bounties"], "Bounties verified")}
{stat(f'{usdc(sa["rewardPosted"], False)} <span class="unit">USDC</span>', "Rewards posted")}
    </div>
    <h2 style="margin-top:36px">As agent</h2>
    <p>Outcomes: {esc(sa["outcomes"])}</p>
{tbl(as_agent)}
    <h2 style="margin-top:36px">As worker</h2>
    <p>Outcomes (current claims): {esc(sw["outcomes"])}</p>
{tbl(as_worker, True)}
    <h2 style="margin-top:36px">As verifier</h2>
    <p>Outcomes: {esc(sv["outcomes"])}</p>
{tbl(as_ver)}
    <p><a href="/explorer/">← Explorer</a></p>"""
        outputs[f"address/{ad}/index.html"] = page(ctx, short(ad), f"MAD Bounty activity of {to_checksum(ad)}.",
                                                   f"/explorer/address/{ad}/", abody, updated)

    # ---- data.json
    def jb(b):
        return {
            "id": b["id"], "state": b["state"], "reward": str(b["reward"]), "deposit": str(b["deposit"]),
            "feeBps": b["feeBps"], "agent": to_checksum(b["agent"]), "verifier": to_checksum(b["verifier"]),
            "verifierLabel": ctx.labels.get(b["verifier"]),
            "claimAuthorizer": None if b["claimAuthorizer"] == ZERO else to_checksum(b["claimAuthorizer"]),
            "worker": None if b["worker"] == ZERO else to_checksum(b["worker"]),
            "vault": to_checksum(b["vault"]), "vaultBalance": str(b["vaultBalance"]),
            "workWindow": b["workWindow"], "reviewWindow": b["reviewWindow"], "openUntil": b["openUntil"],
            "deadline": b["deadline"], "extended": b["extended"],
            "rejectMode": "BURN" if b["rejectMode"] == 0 else "REFUND",
            "specHash": b["specHash"], "evidenceHash": None if b["evidenceHash"] == ZERO32 else b["evidenceHash"],
            "postedAt": b["postedAt"], "postedTx": b["postedTx"], "url": f"{SITE}/explorer/bounty/{b['id']}/",
            "events": [{k: (str(v) if isinstance(v, int) and not isinstance(v, bool) and v > 2 ** 53 else v)
                        for k, v in e.items() if k != "id"} for e in b["events"]],
        }

    data = {
        "network": dep.get("network"), "chainId": cfg["chainId"], "core": core, "usdc": dep["usdc"],
        "usdcDecimals": 6, "deployBlock": int(dep["deployBlock"]),
        "generatedAt": ts(now), "block": head,
        "note": "Amounts are USDC base units (6 decimals) as strings. States: " + ", ".join(STATES[1:]) + ".",
        "stats": {k: (str(v) if k in ("escrowedNow", "escrowedActive", "paidToWorkers", "burned",
                                       "returnedToAgents", "feesCollected") else v) for k, v in stats.items()},
        "bounties": [jb(b) for b in sorted(bounties.values(), key=lambda x: x["id"])],
        "addresses": addr_data,
    }
    outputs["data.json"] = json.dumps(data, indent=1) + "\n"

    pages = ["/explorer/"] + [f"/explorer/{p[:-len('index.html')]}" for p in sorted(outputs)
                              if p.endswith("/index.html")]
    outputs["sitemap.xml"] = ('<?xml version="1.0" encoding="UTF-8"?>\n'
                              '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
                              + "".join(f"  <url><loc>{SITE}{p}</loc></url>\n" for p in pages)
                              + '  <url><loc>https://madbounty.org/explorer/data.json</loc></url>\n</urlset>\n')

    # ---- write + change detection
    def norm(name, s):
        if name.endswith(".json"):
            try:
                d = json.loads(s)
                d.pop("generatedAt", None)
                d.pop("block", None)
                return json.dumps(d, sort_keys=True)
            except ValueError:
                return s
        return norm_html(s)

    changed = False
    out = os.path.abspath(a.out)
    for name, content in outputs.items():
        path = os.path.join(out, name)
        old = open(path, encoding="utf-8").read() if os.path.exists(path) else None
        if old is None or hashlib.sha256(norm(name, old).encode()).digest() != \
                hashlib.sha256(norm(name, content).encode()).digest():
            changed = True
        if old != content:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
    stale = set(cache.get("outputs_by_dir", {}).get(out, [])) - set(outputs)
    for name in stale:
        p = os.path.join(out, name)
        if os.path.exists(p):
            os.remove(p)
            changed = True
    cache.setdefault("outputs_by_dir", {})[out] = sorted(outputs)
    cache.pop("outputs", None)
    tmp = cache_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cache, f, separators=(",", ":"))
    os.replace(tmp, cache_path)
    log(f"rpc calls: {rpc.calls}")
    print(f"{len(bounties)} bounties, {len(events)} events, changed={'yes' if changed else 'no'}")


if __name__ == "__main__":
    main()
