// Headless runner for the mem test harness.
//
//   node test/run.mjs            run everything, exit non-zero on failure
//   node test/run.mjs --headed   watch it happen in a real window
//
// The harness itself is a browser page — it needs real IndexedDB, real
// structured clone of typed arrays, and real ES modules, none of which a Node
// shim reproduces faithfully. This drives that page and reports the result to
// a terminal.
//
// Playwright is borrowed from a sibling project rather than added as a
// dependency here: `extension/` is the folder Chrome loads unpacked, and it
// should stay free of node_modules.

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const CANDIDATES = [
  path.resolve(ROOT, '../../mem-video/'),
  path.resolve(ROOT, '../'),
  ROOT,
];

function loadPlaywright() {
  for (const base of CANDIDATES) {
    if (!existsSync(path.join(base, 'node_modules', 'playwright'))) continue;
    try {
      return createRequire(path.join(base, 'package.json'))('playwright');
    } catch { /* try the next one */ }
  }
  throw new Error(
    'playwright not found. Install it in a sibling project, or run:\n' +
    '  npm i playwright'
  );
}

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.ttf': 'font/ttf', '.woff2': 'font/woff2',
};

function serve(root) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(root, rel);
      if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
      try {
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(readFileSync(file));
      } catch {
        res.writeHead(404).end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const { chromium } = loadPlaywright();
const headed = process.argv.includes('--headed');
const { server, port } = await serve(ROOT);

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

page.on('pageerror', (e) => console.error('  [page error]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/favicon/i.test(m.text())) console.error('  [console]', m.text());
});

await page.goto(`http://127.0.0.1:${port}/test/harness.html`, { waitUntil: 'load' });

try {
  await page.waitForFunction(() => window.__DONE__ === true, null, { timeout: 180000 });
} catch {
  console.error('\n✕ harness did not finish within 180s');
  const partial = await page.evaluate(() => document.getElementById('totals')?.textContent || '');
  if (partial) console.error('  partial:', partial);
  await browser.close(); server.close();
  process.exit(1);
}

const { summary, report } = await page.evaluate(() => window.__RESULTS__);

let suite = '';
for (const r of report) {
  if (r.suite !== suite) { suite = r.suite; console.log(`\n${suite}`); }
  const mark = r.status === 'pass' ? '\x1b[32m✓\x1b[0m' : r.status === 'fail' ? '\x1b[31m✕\x1b[0m' : '\x1b[33m–\x1b[0m';
  console.log(`  ${mark} ${r.name}${r.ms > 400 ? `  \x1b[2m${r.ms}ms\x1b[0m` : ''}`);
  if (r.detail) console.log(`      \x1b[2m${r.detail}\x1b[0m`);
  if (r.message) console.log(`      \x1b[31m${r.message.replace(/\n/g, '\n      ')}\x1b[0m`);
}

console.log(
  `\n${summary.fail === 0 ? '\x1b[32m' : '\x1b[31m'}${summary.pass} passed, ` +
  `${summary.fail} failed${summary.skip ? `, ${summary.skip} skipped` : ''}\x1b[0m\n`
);

await browser.close();
server.close();
process.exit(summary.fail === 0 ? 0 : 1);
