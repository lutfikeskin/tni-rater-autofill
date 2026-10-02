#!/usr/bin/env node
// Replay regression run: every recorded layout (each state / product) is rebuilt on the replay
// page (test/replay/) in a real browser, and the real fill engine and Progressive rules fill it
// with the sample intake, page by page. Compares with the last accepted run so a rule change
// that breaks another state shows up before a release, not during a live quote.
//
//   npm run e2e                 # all layouts; exits 1 on a regression
//   npm run e2e -- --update     # accept the current results as the new baseline
//   npm run e2e -- --headed     # watch it
//
// Layouts: test/bakeoff/course-*.json, captures/progressive/*.json and the per-state layouts
// npm run layouts builds (captures/progressive/generated/, git-ignored). Needs internet (the
// replay page loads ExtJS from cdnjs) and Playwright's Chromium (npx playwright install chromium).
// Reports go to reviews/e2e-<date>.md; the baseline is test/e2e-baseline.json.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const baselineFile = path.join(root, 'test', 'e2e-baseline.json');
const today = new Date().toISOString().slice(0, 10);

const layouts = [
  ...list('test/bakeoff', /^course-.*\.json$/),
  ...list('captures/progressive', /\.json$/),
  ...list('captures/progressive/generated', /\.json$/),
].filter((f) => {
  try { return !!JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')).pages; } catch { return false; }
});
if (!layouts.length) { console.error('No layouts found.'); process.exit(1); }

// The replay page needs the repo served over http (ES modules, fetch).
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.pdf': 'application/pdf', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const file = p.endsWith('/') ? path.join(p, 'index.html') : p;
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ headless: !args.has('--headed') });
const results = {};
// A few layouts at a time: each waits on simulated server round trips, not on the CPU.
const queue = [...layouts];
const worker = async () => {
  for (let layout = queue.shift(); layout; layout = queue.shift()) await runLayout(layout);
};
try {
  await Promise.all(Array.from({ length: Math.min(4, layouts.length) }, worker));
} finally {
  await browser.close();
  server.close();
}

async function runLayout(layout) {
  {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));

    try {
      await page.goto(`${base}/test/replay/`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.Ext && window.replay && window.__raterKit, null, { timeout: 30000 });
      await page.fill('#layout', `/${layout}`);
      await page.click('#load');
      await page.waitForFunction(() => document.getElementById('page').options.length > 0, null, { timeout: 30000 });
      await page.click('#fill-all');
      await page.waitForFunction(() => /^(Done|Error)/.test(document.getElementById('status').textContent), null, { timeout: 10 * 60 * 1000 });
      const status = await page.textContent('#status');
      const rows = await page.evaluate(() => window.replay.lastReport ?? []);
      results[layout] = summarize(rows, status, errors);
      console.log(`${layout} … ${results[layout].filled}/${results[layout].questions} filled, ${results[layout].failed} failed${results[layout].issues.length ? `, ${results[layout].issues.length} issue(s)` : ''}`);
    } catch (e) {
      results[layout] = { error: String(e.message).split('\n')[0], issues: [`run failed: ${String(e.message).split('\n')[0]}`], pages: {} };
      console.log(`${layout} … run failed: ${results[layout].error}`);
    } finally {
      await page.close();
    }
  }
}

// Per layout: totals, per-page numbers, and things that are wrong whatever the baseline says.
function summarize(rows, status, errors) {
  const pages = {};
  const issues = [];
  if (!/^Done/.test(status)) issues.push(`replay stopped: ${status}`);
  for (const e of errors) issues.push(`page error: ${e}`);
  for (const r of rows) {
    const continued = r.clicked.some((c) => /^(continue|ok,? start quote)/i.test(c));
    pages[r.page] = { questions: r.questions, filled: r.filled.length, failed: r.failed, noData: r.noData.length, unmapped: r.unmapped.length, clicked: r.clicked };
    // Continue with something still open on the page is the bug from the first PA quote.
    if (continued && (r.failed.length || r.unmapped.length)) issues.push(`${r.page}: clicked Continue with ${r.failed.length} failed / ${r.unmapped.length} unmapped question(s) open`);
  }
  const sum = (k) => Object.values(pages).reduce((n, p) => n + (Array.isArray(p[k]) ? p[k].length : p[k]), 0);
  return { questions: sum('questions'), filled: sum('filled'), failed: sum('failed'), unmapped: sum('unmapped'), issues, pages };
}

// --- Compare with the baseline ----------------------------------------------------------------
const baseline = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, 'utf8')) : null;
const regressions = [];
for (const [layout, now] of layouts.filter((l) => results[l]).map((l) => [l, results[l]])) {
  for (const issue of now.issues) regressions.push(`${layout}: ${issue}`);
  const before = baseline?.[layout];
  if (!before || now.error) continue;
  for (const [pageName, p] of Object.entries(now.pages)) {
    const b = before.pages?.[pageName];
    if (!b) continue;
    if (p.filled < b.filled) regressions.push(`${layout} ${pageName}: filled ${b.filled} → ${p.filled}`);
    // Diagnostics in parentheses (e.g. which elements appeared) don't make a failure new.
    const core = (f) => f.replace(/\s*\([^)]*\)\s*$/, '');
    const newFails = p.failed.filter((f) => !b.failed.map(core).includes(core(f)));
    for (const f of newFails) regressions.push(`${layout} ${pageName}: new failure: ${f}`);
  }
}

const lines = [`# Replay regression run ${today}`, '', `${layouts.length} layouts · baseline: ${baseline ? 'test/e2e-baseline.json' : 'none yet (run with --update)'}`, ''];
lines.push('| Layout | Filled | Failed | No rule | Issues |', '| --- | --- | --- | --- | --- |');
for (const [layout, r] of layouts.filter((l) => results[l]).map((l) => [l, results[l]])) lines.push(`| ${layout} | ${r.filled ?? '—'}/${r.questions ?? '—'} | ${r.failed ?? '—'} | ${r.unmapped ?? '—'} | ${r.issues.length} |`);
lines.push('', '## Regressions and issues', '', ...(regressions.length ? regressions.map((x) => `- ${x}`) : ['None.']), '');
for (const [layout, r] of layouts.filter((l) => results[l]).map((l) => [l, results[l]])) {
  lines.push(`## ${layout}`, '', '| Page | Questions | Filled | Failed | No rule | Clicked |', '| --- | --- | --- | --- | --- | --- |');
  for (const [p, x] of Object.entries(r.pages)) lines.push(`| ${p} | ${x.questions} | ${x.filled} | ${x.failed.length} | ${x.unmapped} | ${x.clicked.join(', ').replace(/\|/g, '/')} |`);
  const fails = Object.entries(r.pages).flatMap(([p, x]) => x.failed.map((f) => `- ${p}: ${f}`));
  if (fails.length) lines.push('', 'Failed:', ...fails);
  lines.push('');
}
const out = path.join(root, 'reviews', `e2e-${today}.md`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join('\n'));

if (args.has('--update')) {
  fs.writeFileSync(baselineFile, JSON.stringify(results, null, 1) + '\n');
  console.log(`\nBaseline updated: ${path.relative(root, baselineFile)}`);
}
console.log(`\n${path.relative(process.cwd(), out)}`);
if (regressions.length) {
  console.log(`\n${regressions.length} regression(s)/issue(s):`);
  for (const r of regressions) console.log(`  - ${r}`);
  if (!args.has('--update')) process.exit(1);
} else console.log('No regressions.');

function list(dir, re) {
  const full = path.join(root, dir);
  return fs.existsSync(full) ? fs.readdirSync(full).filter((f) => re.test(f)).sort().map((f) => `${dir}/${f}`) : [];
}
