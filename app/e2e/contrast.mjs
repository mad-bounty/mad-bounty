// WCAG contrast audit of the built app: every visible text node's colour against its effective
// (alpha-blended) background. Usage: cd app && npm run build && node e2e/contrast.mjs
// Fails (exit 1) on any text under 4.5:1 (3:1 for large text: >= 24px, or >= 18.66px bold).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const SITE = resolve(new URL('../../site', import.meta.url).pathname);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  let f = join(SITE, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  try { if ((await stat(f)).isDirectory()) f = join(f, 'index.html'); } catch { /* */ }
  try { res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream' }).end(await readFile(f)); }
  catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/app/`;
const PAGES = (process.env.MADB_PAGES ?? '8453:#/,84532:#/,84532:#/bounty/3,84532:#/bounty/22,84532:#/post,84532:#/help,84532:#/me').split(',');

const audit = () => {
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return [0, 0, 0, 0]; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const blend = (top, bot) => { const a = top[3]; return [top[0] * a + bot[0] * (1 - a), top[1] * a + bot[1] * (1 - a), top[2] * a + bot[2] * (1 - a), 1]; };
  const bgOf = (el) => {
    const stack = [];
    for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c[3] > 0) stack.push(c); if (c[3] >= 1) break; }
    let col = [10, 12, 16, 1]; // --bg
    for (let i = stack.length - 1; i >= 0; i--) col = blend(stack[i], col);
    return col;
  };
  const opac = (el) => { let o = 1; for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent.trim()) continue;
    const el = n.parentElement; if (!el || seen.has(el)) continue; seen.add(el);
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || cs.visibility === 'hidden' || el.closest('.sr, [aria-hidden="true"] .sr')) continue;
    if (el.closest('button:disabled, [aria-disabled="true"]')) continue; // WCAG exempts disabled controls
    const bg = bgOf(el);
    let fg = parse(cs.color); const o = opac(el); fg = blend([fg[0], fg[1], fg[2], fg[3] * o], bg);
    const a = L(fg), b = L(bg); const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const px = parseFloat(cs.fontSize); const bold = Number(cs.fontWeight) >= 700;
    const large = px >= 24 || (bold && px >= 18.66);
    const need = large ? 3 : 4.5;
    if (ratio < need) out.push({ text: n.textContent.trim().slice(0, 40), cls: el.className?.toString?.().slice(0, 40) ?? '', tag: el.tagName, ratio: Math.round(ratio * 100) / 100, need, color: cs.color, bg: `rgb(${bg.slice(0, 3).map(Math.round).join(',')})` });
  }
  return out;
};

const browser = await chromium.launch();
let bad = 0;
for (const spec of PAGES) {
  const [chain, hash] = spec.split(/:(.*)/s);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await ctx.addInitScript((c) => localStorage.setItem('madb.chain', c), chain);
  const page = await ctx.newPage();
  await page.goto(BASE + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"], .sk'), null, { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; }));
  const fails = await page.evaluate(audit);
  const uniq = [...new Map(fails.map((f) => [`${f.cls}|${f.color}|${f.bg}`, f])).values()];
  console.log(`\n${chain} ${hash}: ${uniq.length ? uniq.length + ' failing style(s)' : 'all text passes'}`);
  for (const f of uniq) console.log(`  ${f.ratio}:1 < ${f.need}  <${f.tag.toLowerCase()} class="${f.cls}"> "${f.text}"  ${f.color} on ${f.bg}`);
  bad += uniq.length;
  await ctx.close();
}
await browser.close(); server.close();
process.exitCode = bad ? 1 : 0;
