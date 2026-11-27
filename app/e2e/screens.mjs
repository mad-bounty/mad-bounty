// Visual review: serves site/ locally and screenshots every app screen at 390x844 and 1280x800.
// Usage: cd app && npm run build && node e2e/screens.mjs [outDir]
// Reads are LIVE (Base mainnet + Base Sepolia public RPCs). A fake EIP-6963 wallet supplies an address only:
// it can't sign, so wallet prompts end in a friendly 'failed' toast. Role addresses are the Base Sepolia e2e keys' addresses.
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { chromium } from 'playwright';

const SITE = resolve(new URL('../../site', import.meta.url).pathname);
const OUT = process.argv[2] ?? join(homedir(), '.hermes/cache/scratch/app-shots');
// Base Sepolia e2e participants (deployments/e2e-full.log) so role views show real bounties.
const AGENT = process.env.MADB_AGENT ?? '0xdb04aa53590e1D93A9Dd747552f7f51aa8f4d720';
const WORKER = process.env.MADB_WORKER ?? '0x2Ae54f56054fd4b758FA2d60500fEFDB3f5834f7';
const VERIFIER = process.env.MADB_VERIFIER ?? '0xE54d497657C862d84C6eCEF5f6dA17D88C0959b1';
const BOUNTY = process.env.MADB_BOUNTY ?? '3';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain' };

const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(SITE, p);
  try { if ((await stat(f)).isDirectory()) f = join(f, 'index.html'); } catch { try { await stat(f + '.html'); f += '.html'; } catch { /* 404 below */ } }
  if (!f.startsWith(SITE)) { res.writeHead(403).end(); return; }
  try { const b = await readFile(f); res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream' }).end(b); }
  catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/app/`;
await mkdir(OUT, { recursive: true });

const fakeWallet = (addr) => {
  let chainId = '0x14a34';
  const provider = {
    isFake: true,
    async request({ method, params }) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [addr];
      if (method === 'eth_chainId') return chainId;
      if (method === 'wallet_switchEthereumChain') { chainId = params[0].chainId; return null; }
      if (method === 'eth_sendTransaction') throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      throw Object.assign(new Error('fake wallet: ' + method), { code: 4200 });
    },
    on() {}, removeListener() {},
  };
  const info = { uuid: 'fake-0001', name: 'Demo Wallet', icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Crect width=%2232%22 height=%2232%22 rx=%228%22 fill=%22%232e9bff%22/%3E%3C/svg%3E', rdns: 'org.madbounty.demo' };
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
};

const errors = [];
const browser = await chromium.launch();
const shots = [];

async function session(vp, { chain = 8453, wallet } = {}) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await ctx.addInitScript((c) => { try { localStorage.setItem('madb.chain', String(c)); } catch {} }, chain);
  if (wallet) await ctx.addInitScript(fakeWallet, wallet);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${vp.width}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${vp.width}] pageerror ${e.message}`));
  return { ctx, page };
}
async function go(page, hash) {
  await page.goto(BASE + hash, { waitUntil: 'domcontentloaded' });
  // wait for live data: skeletons gone
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"], .sk'), null, { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(600);
}
const overflow = [];
async function shot(page, name, vp, full = true) {
  const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (o > 0) overflow.push(`${name}@${vp.width}: ${o}px horizontal overflow`);
  if (full) { await page.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); }); await page.waitForTimeout(150); }
  const file = join(OUT, `${name}-${vp.width}.png`);
  await page.screenshot({ path: file, fullPage: full });
  shots.push(file);
}
async function firstOpenBounty(page) {
  await go(page, '#/');
  // browse may default to 'All' when nothing is open: pick a card whose state pill says Open
  const href = await page.locator('.bcard').filter({ has: page.locator('.spill', { hasText: /^Open$/i }) }).first().getAttribute('href', { timeout: 3_000 }).catch(() => null);
  return href ? href.split('/').pop() : null;
}
async function openFirstAction(page, name, vp, submitToo = false) {
  const btn = page.locator('.ap-primary .btn:visible:not([disabled]), .arow .btn:visible:not([disabled])').first();
  if (!(await btn.count())) return;
  await btn.click(); await page.waitForTimeout(400);
  if (await page.locator('#ev').count()) await page.fill('#ev', 'https://gist.github.com/example/1a2b3c — result.txt');
  await shot(page, name, vp, false);
  if (submitToo) {
    await page.locator('.sheet-foot .btn').last().click();
    await page.waitForSelector('.toast-failed, .toast-confirmed', { timeout: 30_000 }).catch(() => {});
    await shot(page, '11-toast', vp, false);
  } else await page.keyboard.press('Escape');
}
async function connectWallet(page) {
  await page.locator('.wbtn').first().click().catch(() => {});
  const opt = page.locator('.wopt').first();
  if (await opt.count()) { await opt.click(); await page.waitForTimeout(700); }
}

for (const vp of [{ width: 360, height: 780 }, { width: 390, height: 844 }, { width: 1280, height: 800 }].filter((v) => !process.env.MADB_WIDTHS || process.env.MADB_WIDTHS.split(',').includes(String(v.width)))) {
  // 1. browse, mainnet, no wallet (empty state)
  let { ctx, page } = await session(vp, { chain: 8453 });
  await go(page, '#/'); await shot(page, '01-browse-mainnet-empty', vp);
  await go(page, '#/help'); await shot(page, '08-help', vp);
  await page.locator('.wbtn').first().click(); await page.waitForTimeout(400);
  await shot(page, '09-wallet-picker-none', vp, false);
  await ctx.close();

  // 2. testnet, with wallet
  // verifier: bounty #3 is waiting for their verdict
  ({ ctx, page } = await session(vp, { chain: 84532, wallet: VERIFIER }));
  await go(page, '#/'); await connectWallet(page);
  await go(page, `#/bounty/${BOUNTY}`); await shot(page, `03-bounty-${BOUNTY}`, vp);
  await openFirstAction(page, '05b-confirm-action', vp, true);
  for (const id of (process.env.MADB_EXTRA ?? '22').split(',').filter(Boolean)) { await go(page, `#/bounty/${id}`); await shot(page, `03-bounty-${id}`, vp); }
  await ctx.close();

  // worker: claim sheet with safety check, submit sheet, my bounties
  ({ ctx, page } = await session(vp, { chain: 84532, wallet: WORKER }));
  await go(page, '#/'); await connectWallet(page);
  await go(page, '#/me'); await shot(page, '07-me', vp);
  const open = await firstOpenBounty(page);
  if (open) { await go(page, `#/bounty/${open}`); await shot(page, '04-bounty-open', vp); await openFirstAction(page, '05-confirm-claim', vp); }
  await ctx.close();

  // poster: browse + post wizard
  ({ ctx, page } = await session(vp, { chain: 84532, wallet: AGENT }));
  await go(page, '#/'); await shot(page, '02-browse-testnet', vp);
  await page.locator('.wbtn').first().click(); await page.waitForTimeout(300);
  await shot(page, '10-wallet-picker', vp, false);
  await page.locator('.wopt').first().click(); await page.waitForTimeout(700);

  await go(page, '#/post');
  await page.fill('#title', 'Translate the MAD Bounty FAQ into Spanish');
  await page.fill('#instructions', 'Translate every question and answer on madbounty.org/#faq into neutral Latin-American Spanish. Keep links and code untouched.');
  await page.fill('input[aria-label="Criterion 1"]', 'Every question and answer is translated');
  await page.locator('.addc').first().click();
  await page.fill('input[aria-label="Criterion 2"]', 'A native speaker finds no grammar errors');
  await page.fill('#evidence', 'A link to a public Google Doc');
  await shot(page, '06a-post-step1', vp);
  await page.getByRole('button', { name: /Continue/ }).click(); await page.waitForTimeout(400);
  await page.fill('#reward', '120');
  await shot(page, '06b-post-step2', vp);
  await page.locator('input[name="rm"]').nth(1).check(); await page.waitForTimeout(200);
  await shot(page, '06c-post-step2-refund', vp);
  await page.locator('input[name="rm"]').nth(0).check();
  await page.getByRole('button', { name: /^Review/ }).click(); await page.waitForTimeout(500);
  await shot(page, '06d-post-step3', vp);

  await ctx.close();
}

await browser.close();
server.close();
console.log(shots.join('\n'));
if (overflow.length) { console.log('\nLAYOUT OVERFLOW:\n' + overflow.join('\n')); process.exitCode = 1; }
else console.log('no horizontal overflow');
if (errors.length) { console.log('\nCONSOLE ERRORS:\n' + errors.join('\n')); process.exitCode = 1; }
else console.log('\nno console errors');
