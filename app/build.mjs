import { build } from 'esbuild';
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
const out = '../site/app';
mkdirSync(out, { recursive: true });
await build({
  entryPoints: ['src/main.tsx'], bundle: true, minify: true, format: 'esm', target: 'es2020',
  outfile: `${out}/app.js`, jsx: 'automatic', jsxImportSource: 'preact', legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning',
});
copyFileSync('index.html', `${out}/index.html`);
if (existsSync('src/ui/app.css')) copyFileSync('src/ui/app.css', `${out}/app.css`);
const gz = gzipSync(readFileSync(`${out}/app.js`)).length;
console.log(`app.js ${(readFileSync(`${out}/app.js`).length / 1024).toFixed(0)} KB, gzip ${(gz / 1024).toFixed(0)} KB`);
if (gz > 250 * 1024) { console.error('BUDGET EXCEEDED (250 KB gzip)'); process.exit(1); }
