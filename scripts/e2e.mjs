#!/usr/bin/env node
// Replay regression run: every recorded layout (each state / product) is rebuilt on the replay
// page (test/replay/) in a real browser, and the real fill engine and Progressive rules fill it
// with the sample intake, page by page. Compares with the last accepted run so a rule change
// that breaks another state shows up before a release, not during a live quote.
//
//   npm run e2e                 # all layouts; exits 1 on a regression
//   npm run e2e -- --update     # accept the current results as the new baseline
//   npm run e2e -- --headed     # watch it
//   npm run e2e -- --fixtures   # only committed layouts (no local captures or generated layouts)
//   npm run e2e -- --renumber   # every question renumbered, as Progressive did on 2026-10-07: the
//                               # results must equal the baseline (questions are found by name/text)
//
// A local check: CI runs only the unit tests and packaging (docs/testing.md, since 2026-10-05).
// Layouts: test/bakeoff/course-*.json, captures/progressive/*.json and the per-state layouts
// npm run layouts builds (captures/progressive/generated/, git-ignored). Needs internet (the
// replay page loads ExtJS from cdnjs) and Playwright's Chromium (npx playwright install chromium).
// Reports go to reviews/e2e-<date>.md; the baseline is test/e2e-baseline.json. In every mode, each
// page's outcomes (what each question got, by its text and filling rule: a hash) must equal the baseline's, so a
// rule change that alters an answer with the counts unchanged fails the run until --update.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const baselineFile = path.join(root, 'test', 'e2e-baseline.json');
const today = new Date().toISOString().slice(0, 10);

// Committed per-state layouts (test/fixtures/progressive, refreshed by npm run fixtures:progressive)
// run everywhere; the freshest generated copy of the same state replaces it locally.
const generated = args.has('--fixtures') ? [] : list('captures/progressive/generated', /\.json$/);
const fixtures = list('test/fixtures/progressive', /\.json$/).filter((f) => !generated.some((g) => path.basename(g) === path.basename(f)));
const layouts = [
  ...list('test/bakeoff', /^course-.*\.json$/),
  ...list('captures/progressive', /\.json$/),
  ...generated,
  ...fixtures,
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
      await page.goto(`${base}/test/replay/${args.has('--renumber') ? '?shift=55' : ''}`, { waitUntil: 'load' });
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

// What each question of a page got, by its text and the rule that filled it, never its number (--renumber shifts numbers; an
// unlabeled field is named after its element id, which holds the number, so that part is masked):
// a short hash, so the baseline stays small.
function unnumbered(s) { return String(s ?? '').replace(/\bf [a-z] [0-9a-f]{32}[0-9a-f]+ \d+ \d+\b/gi, 'field'); }
function outcomes(r) {
  return crypto.createHash('sha1').update(JSON.stringify([
    // With the rule that filled it, so two controls reading the same that swap answers differ.
    ...r.filled.map((x) => `filled ${x.rule ?? ''} :: ${unnumbered(x.label)} = ${x.shown ?? ''}`),
    ...r.noData.map((x) => `agent ${unnumbered(x)}`),
    ...r.unmapped.map((x) => `no rule ${unnumbered(x)}`),
  ].sort())).digest('hex').slice(0, 12);
}

// Per layout: totals, per-page numbers, and things that are wrong whatever the baseline says.
function summarize(rows, status, errors) {
  const pages = {};
  const issues = [];
  if (!/^Done/.test(status)) issues.push(`replay stopped: ${status}`);
  for (const e of errors) issues.push(`page error: ${e}`);
  for (const r of rows) {
    const continued = r.clicked.some((c) => /^(continue|ok,? start quote)/i.test(c));
    pages[r.page] = { questions: r.questions, filled: r.filled.length, failed: r.failed, noData: r.noData.length, unmapped: r.unmapped.length, blockers: r.blockers?.length ?? 0, clicked: r.clicked, outcomes: outcomes(r) };
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
    // Diagnostics in parentheses (e.g. which elements appeared) don't make a failure new.
    const core = (f) => f.replace(/\s*\([^)]*\)\s*$/, '');
    const continued = (x) => x.clicked.some((c) => /^(continue|ok,? start quote)/i.test(c));
    if (args.has('--renumber')) {
      // Renumbered questions are the same questions: each gets the same outcome as in the recorded
      // run (not just as many), and the helpers are clicked in the same order.
      const shape = (x) => JSON.stringify([x.filled, x.failed.map(core).sort(), x.noData, x.unmapped, x.blockers ?? null, x.clicked, b.outcomes ? x.outcomes : null]);
      if (shape(p) !== shape(b)) regressions.push(`${layout} ${pageName}: renumbered run differs: ${shape(b)} → ${shape(p)}`);
      continue;
    }
    if (p.filled < b.filled) regressions.push(`${layout} ${pageName}: filled ${b.filled} → ${p.filled}`);
    const newFails = p.failed.filter((f) => !b.failed.map(core).includes(core(f)));
    for (const f of newFails) regressions.push(`${layout} ${pageName}: new failure: ${f}`);
    if (p.unmapped > b.unmapped) regressions.push(`${layout} ${pageName}: unmapped ${b.unmapped} → ${p.unmapped}`);
    if (p.noData > b.noData) regressions.push(`${layout} ${pageName}: left for the agent ${b.noData} → ${p.noData}`);
    if (b.blockers != null && p.blockers > b.blockers) regressions.push(`${layout} ${pageName}: blockers ${b.blockers} → ${p.blockers}`);
    if (continued(b) && !continued(p)) regressions.push(`${layout} ${pageName}: Continue no longer clicked`);
    // The same counts can hide another answer (a rule's value changed): what each question got must
    // match too, in every mode, not only under --renumber (audit 2026-10-08, finding 15).
    if (b.outcomes && p.outcomes !== b.outcomes) regressions.push(`${layout} ${pageName}: outcomes changed (${b.outcomes} → ${p.outcomes}): a question got another answer, or is now filled, left to the agent or without a rule; review the report and --update if intended`);
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

if (args.has('--update') && args.has('--renumber')) {
  console.error('--renumber checks the baseline; it never updates it.');
  process.exit(1);
}
if (args.has('--update')) {
  // Merged: layouts not run this time (generated ones CI doesn't have) keep their entries.
  fs.writeFileSync(baselineFile, JSON.stringify({ ...(baseline ?? {}), ...results }, null, 1) + '\n');
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
