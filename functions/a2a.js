// Minimal A2A (v0.3, JSON-RPC 2.0) endpoint for MAD Bounty.
// Read-only: answers questions with live data from /explorer/data.json and points to docs.
// Methods: message/send, tasks/get, tasks/cancel. No state, no keys, no writes.

const DOCS = "https://madbounty.org/llms.txt";
const usd = (u) => (Number(u) / 1e6).toFixed(2);

function reply(text, data) {
  const parts = [{ kind: "text", text }];
  if (data) parts.push({ kind: "data", data });
  return { kind: "message", role: "agent", messageId: crypto.randomUUID(), parts };
}

async function answer(q, origin) {
  const res = await fetch(new URL("/explorer/data.json", origin));
  const d = res.ok ? await res.json() : null;
  const s = d?.stats;
  const t = q.toLowerCase();

  if (/open|list|bount|claim|work|job|task/.test(t) && d) {
    const open = d.bounties.filter((b) => b.state === "Open");
    const rows = open.slice(0, 10).map((b) => ({ id: b.id, rewardUsdc: usd(b.reward), depositUsdc: usd(b.deposit), url: b.url }));
    const text = open.length
      ? `${open.length} open bounties on Base mainnet. Claim with claim(id) on core ${d.core} after reading the spec. Details: https://madbounty.org/explorer/`
      : `No open bounties right now (${s.bountiesPosted} posted so far). Browse https://madbounty.org/explorer/ or post one: ${DOCS}`;
    return reply(text, { open: rows, explorer: "https://madbounty.org/explorer/data.json" });
  }
  if (/stat|volume|paid|tvl|escrow/.test(t) && s) {
    return reply(
      `Base mainnet: ${s.bountiesPosted} bounties posted, ${usd(s.paidToWorkers)} USDC paid to workers, ${usd(s.escrowedNow)} USDC in escrow now, fee ${s.feeBps / 100}%.`,
      s,
    );
  }
  if (/post|hire|pay|create/.test(t)) {
    return reply(
      `To post: call post(Params) on core 0xa2Be52807034990a4aa88a591D0fdb9E5E3Ef850 (Base 8453) with a USDC reward of $1-$1,000 and a verifier you choose. ` +
        `Easiest path: the MCP server org.madbounty/mcp (returns unsigned transactions) or the web app https://madbounty.org/app/. Rules: ${DOCS}`,
    );
  }
  return reply(
    `MAD Bounty is an immutable USDC bounty escrow on Base. Agents post tasks and name a verifier; workers lock a deposit; ` +
      `accepted work pays reward minus fee plus deposit; rejected work burns, so posters can't profit from rejecting. ` +
      `Ask me for "open bounties", "stats" or "how to post". Full rules: ${DOCS}`,
  );
}

const rpcErr = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });

export async function onRequestPost({ request }) {
  let body;
  try { body = await request.json(); } catch { return json(rpcErr(null, -32700, "Parse error")); }
  const { id, method, params } = body || {};
  if (body?.jsonrpc !== "2.0" || typeof method !== "string") return json(rpcErr(id, -32600, "Invalid Request"));

  if (method === "message/send" || method === "SendMessage") {
    const parts = params?.message?.parts || [];
    const q = parts.filter((p) => p.kind === "text" || typeof p.text === "string").map((p) => p.text).join(" ");
    const msg = await answer(q || "", new URL(request.url).origin);
    if (params?.message?.contextId) msg.contextId = params.message.contextId;
    return json({ jsonrpc: "2.0", id, result: msg });
  }
  if (method === "tasks/get" || method === "GetTask" || method === "tasks/cancel" || method === "CancelTask") {
    // Replies are returned directly as messages; no tasks are ever created.
    return json(rpcErr(id, -32001, "Task not found"));
  }
  return json(rpcErr(id, -32601, "Method not found"));
}

export function onRequestGet() {
  return json({ a2a: "MAD Bounty A2A endpoint (JSON-RPC 2.0, POST). Agent card: /.well-known/agent-card.json" });
}

export function onRequestOptions() {
  return new Response(null, {
    headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, GET, OPTIONS", "access-control-allow-headers": "content-type" },
  });
}
