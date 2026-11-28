// REAL end-to-end test on Base Sepolia (84532) through the actual UI, with signing wallets.
// Usage: cd app && npm run build && node e2e/flow.mjs [outDir]
//
// Each browser context gets an EIP-6963-announced EIP-1193 provider whose request() is forwarded to a
// Node-side handler: accounts/chain answered locally, eth_sendTransaction signed with viem
// (privateKeyToAccount + walletClient), everything else proxied to the public RPC.
// Keys are read at runtime from ~/.secrets and are never printed.
//
// Spends: agent 1 USDC (bounty X, paid out) + 1 USDC (bounty Y, refunded) + gas; worker 1 USDC deposit
// (returned with 0.95 USDC net reward) + gas; verifier gas. Two bounties per run.
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { chromium } from 'playwright';
import { createPublicClient, createWalletClient, http, erc20Abi, keccak256, stringToBytes, numberToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { madBountyCoreAbi, DEPLOYMENTS } from '@madbounty/sdk';

const RPC = 'https://base-sepolia-rpc.publicnode.com';
const SITE = resolve(new URL('../../site', import.meta.url).pathname);
const OUT = process.argv[2] ?? join(homedir(), '.hermes/cache/scratch/app-flow');
const CORE = DEPLOYMENTS[84532].core;
const USDC = DEPLOYMENTS[84532].usdc;
const STATES = ['None', 'Open', 'Claimed', 'Submitted', 'Rejected', 'Paid', 'Burned', 'Refunded', 'Cancelled'];
const VP = { width: 390, height: 844 };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain' };

const loadKey = (f) => { const k = readFileSync(join(homedir(), '.secrets', f), 'utf8').trim(); return (k.startsWith('0x') ? k : `0x${k}`); };
const pc = createPublicClient({ chain: baseSepolia, transport: http(RPC, { retryCount: 4, retryDelay: 600 }) });

// ---------------------------------------------------------------- results
const results = [];
const txs = [];
const pass = (flow, msg) => { results.push({ flow, ok: true, msg }); console.log(`PASS [${flow}] ${msg}`); };
const fail = (flow, msg) => { results.push({ flow, ok: false, msg }); console.log(`FAIL [${flow}] ${msg}`); };
const check = (flow, cond, msg) => (cond ? pass(flow, msg) : fail(flow, msg));

// ---------------------------------------------------------------- static server
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(SITE, p);
  try { if ((await stat(f)).isDirectory()) f = join(f, 'index.html'); } catch { try { await stat(f + '.html'); f += '.html'; } catch { /* 404 */ } }
  if (!f.startsWith(SITE)) { res.writeHead(403).end(); return; }
  try { const b = await readFile(f); res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream' }).end(b); }
  catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/app/`;
await mkdir(OUT, { recursive: true });

// ---------------------------------------------------------------- signing wallet (Node side)
function makeWallet(role, keyFile, startChain = 84532) {
  const account = privateKeyToAccount(loadKey(keyFile));
  const wc = createWalletClient({ account, chain: baseSepolia, transport: http(RPC, { retryCount: 4, retryDelay: 600 }) });
  const w = {
    role, address: account.address, chainId: startChain, rejectNext: 0, sent: [],
    async handle({ method, params = [] }) {
      switch (method) {
        case 'eth_requestAccounts': case 'eth_accounts': return [account.address];
        case 'eth_chainId': return numberToHex(w.chainId);
        case 'net_version': return String(w.chainId);
        case 'wallet_switchEthereumChain': {
          const id = Number(params[0].chainId);
          if (id !== 84532 && id !== 8453) throw Object.assign(new Error('Unrecognized chain ID'), { code: 4902 });
          w.chainId = id; return null;
        }
        case 'wallet_addEthereumChain': return null;
        case 'eth_sendTransaction': {
          if (w.rejectNext > 0) { w.rejectNext--; throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); }
          if (w.chainId !== 84532) throw Object.assign(new Error('wallet is not on Base Sepolia'), { code: 4901 });
          const t = params[0];
          if (t.from && t.from.toLowerCase() !== account.address.toLowerCase()) throw Object.assign(new Error('from mismatch'), { code: 4100 });
          const hash = await wc.sendTransaction({
            to: t.to, data: t.data, value: t.value ? BigInt(t.value) : undefined, gas: t.gas ? BigInt(t.gas) : undefined,
          });
          w.sent.push(hash);
          return hash;
        }
        case 'personal_sign': case 'eth_signTypedData_v4': case 'eth_sign':
          throw Object.assign(new Error(`${method} not supported by test wallet`), { code: 4200 });
        default:
          if (w.chainId !== 84532) throw Object.assign(new Error(`test wallet only reads Base Sepolia (${method})`), { code: 4901 });
          return pc.request({ method, params });
      }
    },
  };
  return w;
}

// In-page EIP-1193 provider: forwards to the binding; EIP-6963 announce like screens.mjs.
function injectProvider(walletName) {
  const listeners = {};
  const call = async (payload) => {
    for (let i = 0; i < 200 && typeof window.__madbRpc !== 'function'; i++) await new Promise((r) => setTimeout(r, 25));
    const out = JSON.parse(await window.__madbRpc(JSON.stringify(payload)));
    if (out.error) throw Object.assign(new Error(out.error.message), { code: out.error.code, data: out.error.data });
    if ((payload.method === 'wallet_switchEthereumChain') && out.chainChanged) (listeners.chainChanged || []).forEach((f) => f(out.chainChanged));
    return out.result;
  };
  const provider = {
    isMadbTest: true,
    request: (args) => call({ method: args.method, params: args.params ?? [] }),
    on(ev, fn) { (listeners[ev] ||= []).push(fn); },
    removeListener(ev, fn) { listeners[ev] = (listeners[ev] || []).filter((x) => x !== fn); },
  };
  const info = { uuid: `madb-test-${walletName}`, name: `Test ${walletName}`, icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Crect width=%2232%22 height=%2232%22 rx=%228%22 fill=%22%2322c55e%22/%3E%3C/svg%3E', rdns: `org.madbounty.test.${walletName}` };
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
}

const browser = await chromium.launch();
const consoleErrors = [];
const shots = [];

async function session(w) {
  const ctx = await browser.newContext({ viewport: VP, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await ctx.exposeBinding('__madbRpc', async (_src, json) => {
    const req = JSON.parse(json);
    try {
      const result = await w.handle(req);
      return JSON.stringify({ result, chainChanged: req.method === 'wallet_switchEthereumChain' ? numberToHex(w.chainId) : undefined });
    } catch (e) {
      return JSON.stringify({ error: { code: e.code ?? -32603, message: (e.shortMessage || e.message || 'error').split('\n')[0], data: e.data ?? e.cause?.data } });
    }
  });
  await ctx.addInitScript(injectProvider, w.role);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[${w.role}] ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`[${w.role}] pageerror ${e.message}`));
  return { ctx, page };
}
async function go(page, hash) {
  const url = BASE + hash;
  if (page.url().startsWith(BASE)) await page.evaluate((h) => { location.hash = h; }, hash);
  else await page.goto(url, { waitUntil: 'domcontentloaded' });
  await settle(page);
}
async function settle(page) {
  await page.waitForTimeout(300);
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"], .sk'), null, { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(400);
}
async function shot(page, name, full = false) {
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: full });
  shots.push(file);
  return file;
}
async function connect(page) {
  await page.locator('.wbtn').first().click();
  const opt = page.getByRole('dialog').locator('.wopt').first();
  await opt.waitFor({ timeout: 10_000 });
  await opt.click();
  await page.getByRole('dialog').waitFor({ state: 'detached', timeout: 15_000 });
}
async function selectTestnet(page) {
  await page.getByRole('radio', { name: 'Base Sepolia' }).first().click();
  await page.locator('.testnet-banner').waitFor({ timeout: 5_000 });
}
const reads = {
  async bounty(id) {
    const r = await pc.readContract({ address: CORE, abi: madBountyCoreAbi, functionName: 'bounties', args: [id] });
    return { state: STATES[Number(r[13])], evidenceHash: r[14], worker: r[3], raw: r };
  },
  usdc: (a) => pc.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] }),
};
/** Wait for the on-chain state (public RPC can lag a block behind the wallet receipt). */
async function waitState(id, want, ms = 45_000) {
  const t0 = Date.now(); let b;
  while (Date.now() - t0 < ms) { b = await reads.bounty(id); if (b.state === want) return b; await new Promise((r) => setTimeout(r, 1500)); }
  return b;
}
async function waitBalance(addr, want, ms = 45_000) {
  const t0 = Date.now(); let v;
  while (Date.now() - t0 < ms) { v = await reads.usdc(addr); if (v === want) return v; await new Promise((r) => setTimeout(r, 1500)); }
  return v;
}
/** Toast for `title` reaching a terminal stage; returns {stage, text}. */
async function toastFor(page, titleRe, ms = 200_000) {
  const t = page.locator('.toast').filter({ hasText: titleRe }).last();
  await t.waitFor({ timeout: 20_000 });
  const h = await t.elementHandle();
  await page.waitForFunction((el) => /toast-(confirmed|failed)/.test(el.className), h, { timeout: ms }).catch(() => {});
  const cls = await t.getAttribute('class').catch(() => '');
  return { stage: /toast-confirmed/.test(cls) ? 'confirmed' : /toast-failed/.test(cls) ? 'failed' : 'pending', text: (await t.innerText().catch(() => '')).replace(/\s+/g, ' ') };
}
const hasHex = (s) => /0x[0-9a-fA-F]{8,}/.test(s);
const primaryBtn = (page, name) => page.getByRole('button', { name, exact: false });
const dialog = (page) => page.getByRole('dialog');

const agentW = makeWallet('agent', 'madb-testnet-deployer3.key', 8453); // starts on Base mainnet: exercises the switch path
const workerW = makeWallet('worker', 'madb-testnet-deployer2.key');
const verifierW = makeWallet('verifier', 'madb-testnet-deployer.key');
console.log(`agent ${agentW.address} · worker ${workerW.address} · verifier ${verifierW.address}`);
const bal0 = { agent: await reads.usdc(agentW.address), worker: await reads.usdc(workerW.address) };
console.log(`USDC before: agent ${Number(bal0.agent) / 1e6}, worker ${Number(bal0.worker) / 1e6}`);

const TITLE_X = `E2E flow ${new Date().toISOString().slice(0, 16)}Z — check the FAQ links`;
const TITLE_Y = `E2E cancel ${new Date().toISOString().slice(0, 16)}Z`;
const EVIDENCE = `https://gist.github.com/madb-e2e/flow-${Date.now()} — all 14 FAQ links return 200; report attached.`;

/** Fill and submit the post wizard; returns the new bounty id (bigint) or undefined. */
async function postBounty(page, title, tag, flow) {
  await go(page, '#/post');
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByLabel('Instructions', { exact: true }).fill('Open every link in the MAD Bounty FAQ (madbounty.org/#faq) and report its HTTP status. Flag any link that does not return 200.');
  await page.getByLabel('Criterion 1').fill('Every FAQ link is listed with its HTTP status');
  await page.getByLabel('What should the worker submit?').fill('A link to a public gist with the report');
  await shot(page, `${tag}-01-wizard-step1`, true);
  await page.getByRole('button', { name: /Continue/ }).click();
  await page.getByLabel('Reward', { exact: true }).waitFor();
  await page.getByLabel('Reward', { exact: true }).fill('1');
  await page.getByLabel('Time to do the work').selectOption('1');
  await page.getByLabel('Time to review').selectOption('12');
  await page.getByRole('radio', { name: /Someone else reviews/ }).check();
  await page.getByLabel('Reviewer address').fill(verifierW.address);
  await page.getByRole('radio', { name: /Burn it/ }).check();
  const dep = await page.getByLabel('Worker deposit', { exact: true }).inputValue();
  check(flow, dep === '1.00', `default deposit is the minimum (${dep})`);
  await shot(page, `${tag}-02-wizard-step2`, true);
  await page.getByRole('button', { name: /^Review/ }).click();
  await page.getByRole('heading', { name: /Check and post/ }).waitFor();
  await page.waitForTimeout(800);
  await shot(page, `${tag}-03-wizard-step3`, true);
  const postBtn = page.getByRole('button', { name: /(Approve & post|^Post) ·/ });
  if (process.env.MADB_DRY) {
    agentW.rejectNext = 99;
    await postBtn.click();
    const t = await toastFor(page, /Post “/);
    await shot(page, `${tag}-04-dry-rejected-toast`);
    check(flow, t.stage === 'failed' && t.text.includes('You cancelled in your wallet.'), `DRY: wallet rejection on post → "${t.text}"`);
    agentW.rejectNext = 0;
    return undefined;
  }
  await postBtn.click();
  const tst = await toastFor(page, /Post “/);
  await shot(page, `${tag}-04-post-toast`);
  if (tst.stage !== 'confirmed') { fail(flow, `post toast ended ${tst.stage}: ${tst.text}`); return undefined; }
  const h = page.getByRole('heading', { name: /Bounty #\d+ is live/ });
  await h.waitFor({ timeout: 30_000 });
  const id = BigInt(/#(\d+)/.exec(await h.innerText())[1]);
  await shot(page, `${tag}-05-post-success`);
  pass(flow, `success screen shows bounty #${id}`);
  return id;
}

let X, Y;
const openPages = [];
try {
  // ================================================================ A) agent posts bounty X
  const A = await session(agentW); openPages.push(['agent', A.page]);
  await go(A.page, '#/');
  await selectTestnet(A.page);
  await connect(A.page);
  await shot(A.page, 'A-00-connected');
  const sentBeforeX = agentW.sent.length;
  let titleX = TITLE_X;
  if (process.env.MADB_X) {
    // Resume with a bounty posted through this UI on an earlier run (saves test USDC).
    X = BigInt(process.env.MADB_X); titleX = process.env.MADB_X_TITLE ?? TITLE_X;
    console.log(`reusing bounty #${X} for flows A-checks/B/C`);
    await go(A.page, `#/bounty/${X}`);
  } else {
    X = await postBounty(A.page, TITLE_X, 'A', 'A');
    if (X === undefined) throw new Error('post X failed');
    txs.push(...agentW.sent.slice(sentBeforeX).map((h) => `A post #${X}: ${h}`));
    check('A', agentW.chainId === 84532, 'wallet switched from Base to Base Sepolia during post');
    await A.page.getByRole('link', { name: /Open the bounty/ }).click();
    await settle(A.page);
  }
  check('A', (await waitState(X, 'Open')).state === 'Open', `on-chain #${X} state Open`);
  await A.page.locator('h1.bhead-t').waitFor({ timeout: 60_000 });
  await A.page.getByText('Verified on-chain').first().waitFor({ timeout: 30_000 }).catch(() => {});
  check('A', await A.page.getByText('Verified on-chain').first().isVisible().catch(() => false), 'bounty page shows the verified spec badge');
  check('A', (await A.page.locator('h1.bhead-t').innerText()) === titleX, 'bounty page title equals the typed title');
  await shot(A.page, 'A-06-bounty-page', true);
  // E (agent can't claim own bounty): the claim option for the poster is disabled with a plain sentence
  const ownWhy = await A.page.locator('body').innerText();
  check('E', /You posted this bounty, so you cannot claim it\.|Cancel & get reward back/.test(ownWhy) && !(await A.page.getByRole('button', { name: /^Claim this bounty$/ }).isEnabled().catch(() => false)),
    'agent sees no enabled Claim on own bounty');

  // ================================================================ D (part 1) + E: post Y, worker opens claim sheet, agent cancels
  const W = await session(workerW); openPages.push(['worker', W.page]);
  await go(W.page, '#/');
  await selectTestnet(W.page);
  await connect(W.page);
  if (!process.env.MADB_SKIP_D) {
  const sentBeforeY = agentW.sent.length;
  Y = await postBounty(A.page, TITLE_Y, 'D', 'D');
  if (Y === undefined) throw new Error('post Y failed');
  txs.push(...agentW.sent.slice(sentBeforeY).map((h) => `D post #${Y}: ${h}`));
  const agentAfterY = await reads.usdc(agentW.address);

  await go(W.page, `#/bounty/${Y}`);
  await primaryBtn(W.page, 'Claim this bounty').click();
  await dialog(W.page).waitFor();
  await shot(W.page, 'E-01-claim-sheet-before-cancel');

  // agent cancels Y from the UI
  await go(A.page, `#/bounty/${Y}`);
  await primaryBtn(A.page, 'Cancel & get reward back').click();
  await dialog(A.page).waitFor();
  await shot(A.page, 'D-06-cancel-sheet');
  const sentBeforeCancel = agentW.sent.length;
  await dialog(A.page).getByRole('button', { name: 'Yes, cancel & refund me' }).click();
  const ct = await toastFor(A.page, /Cancel/);
  await shot(A.page, 'D-07-cancel-toast');
  txs.push(...agentW.sent.slice(sentBeforeCancel).map((h) => `D cancel #${Y}: ${h}`));
  check('D', ct.stage === 'confirmed', `cancel toast confirmed (${ct.text})`);
  check('D', (await waitState(Y, 'Cancelled')).state === 'Cancelled', `on-chain #${Y} state Cancelled`);
  const agentAfterCancel = await waitBalance(agentW.address, agentAfterY + 1_000_000n);
  check('D', agentAfterCancel - agentAfterY === 1_000_000n, `agent refunded ${Number(agentAfterCancel - agentAfterY) / 1e6} USDC`);
  await A.page.reload({ waitUntil: 'domcontentloaded' }); await settle(A.page);
  await shot(A.page, 'D-08-cancelled-page', true);

  // worker confirms the stale claim sheet → friendly sentence, no hex, no tx sent
  const wSentBefore = workerW.sent.length;
  await dialog(W.page).getByRole('button', { name: 'Claim & lock deposit' }).click();
  const et = await toastFor(W.page, /Claim/);
  await shot(W.page, 'E-02-claim-after-cancel-toast');
  check('E', et.stage === 'failed' && !hasHex(et.text) && /not in the right state|cancel|no longer|closed/i.test(et.text), `claim after cancel → "${et.text}"`);
  check('E', workerW.sent.length === wSentBefore, 'no transaction was sent for the doomed claim');
  if (workerW.sent.length > wSentBefore) txs.push(...workerW.sent.slice(wSentBefore).map((h) => `E stale claim #${Y}: ${h}`));
  await W.page.locator('.toast .icon-btn').first().click().catch(() => {});

  }
  // ================================================================ B) worker claims + submits X
  await go(W.page, `#/bounty/${X}`);
  await shot(W.page, 'B-01-bounty-open', true);
  // E: user rejects in wallet once
  workerW.rejectNext = 1;
  await primaryBtn(W.page, 'Claim this bounty').click();
  await dialog(W.page).waitFor();
  const safety = await dialog(W.page).locator('.safety').count();
  await shot(W.page, 'B-02-claim-sheet');
  check('B', (await dialog(W.page).innerText()).includes('Only escrow what you can afford to lose'), `claim sheet shown (safety block present: ${safety > 0})`);
  await dialog(W.page).getByRole('button', { name: 'Claim & lock deposit' }).click();
  const rj = await toastFor(W.page, /Claim/);
  await shot(W.page, 'E-03-wallet-rejected-toast');
  check('E', rj.stage === 'failed' && rj.text.includes('You cancelled in your wallet.'), `wallet rejection → "${rj.text}"`);
  await W.page.locator('.toast .icon-btn').first().click().catch(() => {});
  check('E', (await reads.bounty(X)).state === 'Open', 'bounty still Open after the rejected claim');

  const wSentClaim = workerW.sent.length;
  await primaryBtn(W.page, 'Claim this bounty').click();
  await dialog(W.page).waitFor();
  await dialog(W.page).getByRole('button', { name: 'Claim & lock deposit' }).click();
  const cl = await toastFor(W.page, /Claim/);
  await shot(W.page, 'B-03-claim-toast');
  txs.push(...workerW.sent.slice(wSentClaim).map((h) => `B claim #${X}: ${h}`));
  check('B', cl.stage === 'confirmed', `claim toast confirmed (${cl.text})`);
  const bC = await waitState(X, 'Claimed');
  check('B', bC.state === 'Claimed' && bC.worker.toLowerCase() === workerW.address.toLowerCase(), `on-chain #${X} Claimed by worker`);
  const workerAfterClaim = await reads.usdc(workerW.address);

  await settle(W.page);
  await W.page.getByRole('button', { name: 'Submit work' }).first().waitFor({ timeout: 30_000 });
  await W.page.getByRole('button', { name: 'Submit work' }).first().click();
  await dialog(W.page).waitFor();
  await dialog(W.page).getByLabel('Your evidence').fill(EVIDENCE);
  await shot(W.page, 'B-04-submit-sheet');
  const wSentSub = workerW.sent.length;
  await dialog(W.page).getByRole('button', { name: 'Submit work' }).click();
  const sb = await toastFor(W.page, /Submit/);
  await shot(W.page, 'B-05-submit-toast');
  txs.push(...workerW.sent.slice(wSentSub).map((h) => `B submit #${X}: ${h}`));
  check('B', sb.stage === 'confirmed', `submit toast confirmed (${sb.text})`);
  const bS = await waitState(X, 'Submitted');
  check('B', bS.state === 'Submitted', `on-chain #${X} Submitted`);
  check('B', bS.evidenceHash === keccak256(stringToBytes(EVIDENCE)), 'evidenceHash == keccak256(utf8 evidence)');

  // ================================================================ C) verifier accepts
  const V = await session(verifierW); openPages.push(['verifier', V.page]);
  await go(V.page, '#/');
  await selectTestnet(V.page);
  await connect(V.page);
  await go(V.page, `#/bounty/${X}`);
  await shot(V.page, 'C-01-bounty-submitted', true);
  await primaryBtn(V.page, 'Accept work & pay the worker').click();
  await dialog(V.page).waitFor();
  await shot(V.page, 'C-02-accept-sheet');
  const vSent = verifierW.sent.length;
  await dialog(V.page).getByRole('button', { name: 'Accept & pay worker' }).click();
  const ac = await toastFor(V.page, /Accept/);
  await shot(V.page, 'C-03-accept-toast');
  txs.push(...verifierW.sent.slice(vSent).map((h) => `C accept #${X}: ${h}`));
  check('C', ac.stage === 'confirmed', `accept toast reached confirmed (${ac.text})`);
  check('C', (await waitState(X, 'Paid')).state === 'Paid', `on-chain #${X} Paid`);
  const workerFinal = await waitBalance(workerW.address, workerAfterClaim + 1_950_000n);
  check('C', workerFinal - workerAfterClaim === 1_950_000n, `worker USDC +${Number(workerFinal - workerAfterClaim) / 1e6} on accept (net over run ${Number(workerFinal - bal0.worker) / 1e6})`);
  await V.page.reload({ waitUntil: 'domcontentloaded' }); await settle(V.page);
  await V.page.locator('.tl').first().getByText(/worker paid/i).first().waitFor({ timeout: 30_000 }).catch(() => {});
  check('C', await V.page.locator('.tl:visible').getByText(/worker paid/i).first().isVisible().catch(() => false), 'timeline shows "Worker paid" after refresh');
  await shot(V.page, 'C-04-bounty-paid', true);

  await go(W.page, '#/me');
  await W.page.locator(`a[href="#/bounty/${X}"]`).first().waitFor({ timeout: 60_000 }).catch(() => {});
  check('C', (await W.page.locator(`a[href="#/bounty/${X}"]`).count()) > 0, `worker "My bounties" lists #${X}`);
  await shot(W.page, 'C-05-worker-me', true);

  await Promise.all([A.ctx.close(), W.ctx.close(), V.ctx.close()]);
} catch (e) {
  fail('run', `aborted: ${(e && e.message || String(e)).split('\n')[0]}`);
  for (const [n, pg] of openPages) {
    await shot(pg, `FAIL-${n}`, true).catch(() => {});
    console.log(`[${n}] at ${pg.url()}: ${(await pg.locator('main').innerText().catch(() => '')).slice(0, 300).replace(/\s+/g, ' ')}`);
  }
}

await browser.close();
server.close();
const bal1 = { agent: await reads.usdc(agentW.address), worker: await reads.usdc(workerW.address) };
console.log(`\nUSDC after: agent ${Number(bal1.agent) / 1e6} (Δ ${Number(bal1.agent - bal0.agent) / 1e6}), worker ${Number(bal1.worker) / 1e6} (Δ ${Number(bal1.worker - bal0.worker) / 1e6})`);
console.log(`bounties: X=#${X ?? '-'} (post→claim→submit→accept), Y=#${Y ?? '-'} (post→cancel)`);
console.log('\nTRANSACTIONS:\n' + txs.join('\n'));
console.log('\nSCREENSHOTS:\n' + shots.join('\n'));
const relevantErrors = consoleErrors.filter((e) => !/Failed to load resource/.test(e));
if (relevantErrors.length) console.log('\nCONSOLE ERRORS:\n' + relevantErrors.join('\n'));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log('FAILED:\n' + failed.map((f) => `[${f.flow}] ${f.msg}`).join('\n')); process.exitCode = 1; }
