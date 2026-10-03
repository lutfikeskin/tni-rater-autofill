#!/usr/bin/env node
// Real packaged extension and AmWINS UI, with deterministic AI responses. No API charges.
// Run npm run package first. Optional output directory is the first argument.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), `ai-mock-${Date.now()}`));
fs.mkdirSync(out, { recursive: true });
const server = http.createServer((req, res) => {
  const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const ext = path.join(root, 'dist/tni-rater-autofill');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rater-ai-'));
let context;
const checks = [], errors = [];
let requests = 0;
const verify = (name, actual, expected) => {
  checks.push({ name, actual, expected, ok: actual === expected });
  assert.equal(actual, expected, name);
};
try {
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
  // Also blocks the usage server. Only local assets and fixture CDN dependencies can load.
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'api.openai.com') {
      requests++;
      const input = JSON.parse(route.request().postDataJSON().input[0].content);
      const answers = Object.fromEntries(input.questions.map(q => [q.id, {
        choice: q.question.includes('Mock review choice') ? 'No' : '__leave__',
        basis: q.question.includes('Mock review choice') ? 'intake' : 'none',
        intakePath: q.question.includes('Mock review choice') ? 'operations.hazPlacard' : null,
        confidence: 'high', tip: 'Synthetic test response: the intake says no hazardous placards.',
      }]));
      return route.fulfill({ json: { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ answers }) }] }] } });
    }
    if (['127.0.0.1', 'localhost', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'code.jquery.com'].includes(url.hostname)
      || url.protocol === 'chrome-extension:') return route.continue();
    return route.abort();
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const mock = await context.newPage();
  const panel = await context.newPage();
  for (const page of [mock, panel]) page.on('pageerror', error => errors.push(error.message));
  await panel.goto(`chrome-extension://${id}/sidepanel/sidepanel.html`);
  await panel.evaluate(() => chrome.storage.local.set({ settings: { aiOn: true, aiAuto: false,
    aiKey: 'synthetic-test-key', autoAdvance: false, serverUrl: '', serverToken: '' } }));
  await panel.reload();
  const openMock = async () => {
    await mock.goto(`${base}/test/fixtures/amwins/application.html`);
    await mock.evaluate(() => {
      const field = document.createElement('div');
      field.className = 'form-group';
      field.innerHTML = '<label for="mockReviewChoice">Mock review choice</label><select id="mockReviewChoice" class="form-control" required><option value="">Choose</option><option>Yes</option><option>No</option></select>';
      document.querySelector('.form-tab').append(field);
    });
    await mock.bringToFront();
    await panel.waitForFunction(() => document.querySelector('#site')?.textContent.includes('AmWINS'));
  };
  await openMock();
  // Prefer one of the actual requested synthetic PDFs; fixture keeps the test portable.
  const pool = path.join(root, 'dist/synthetic-intakes');
  const manifest = fs.existsSync(path.join(pool, 'manifest.json')) ? JSON.parse(fs.readFileSync(path.join(pool, 'manifest.json'))) : null;
  const sample = manifest?.cases.find(c => c.id.startsWith('03-'));
  await panel.setInputFiles('#file', sample ? path.join(pool, sample.pdf) : path.join(root, 'test/fixtures/sample-intake.pdf'));
  await panel.locator('#tab-fill').click();
  await panel.locator('#fill').click();
  const accept = panel.getByRole('button', { name: 'Use this answer', exact: true });
  await accept.waitFor({ timeout: 30000 });
  verify('suggestions only leave the page untouched', await mock.locator('#mockReviewChoice').inputValue(), '');
  await accept.click();
  await mock.waitForFunction(() => document.querySelector('#mockReviewChoice').value === 'No');
  verify('accepted suggestion is applied', await mock.locator('#mockReviewChoice').inputValue(), 'No');
  await mock.locator('#mockReviewChoice').selectOption('Yes');
  await panel.waitForTimeout(1800); // recorder debounce
  await panel.locator('#fill').click();
  await panel.waitForFunction(() => !document.querySelector('#fill').disabled);
  verify('manual edit survives another fill', await mock.locator('#mockReviewChoice').inputValue(), 'Yes');
  verify('same context reuses its AI response', requests, 1);
  await panel.screenshot({ path: path.join(out, 'suggestion-edited.png'), fullPage: true });

  // Start a fresh intake; auto-select still waits for agent approval.
  await panel.evaluate(() => chrome.storage.local.set({ settings: { aiOn: true, aiAuto: true,
    aiKey: 'synthetic-test-key', autoAdvance: true, serverUrl: '', serverToken: '' } }));
  await panel.evaluate(() => chrome.storage.session.remove(['intake', 'session']));
  await panel.reload();
  await openMock();
  await panel.setInputFiles('#file', sample ? path.join(pool, sample.pdf) : path.join(root, 'test/fixtures/sample-intake.pdf'));
  await panel.locator('#tab-fill').click();
  await panel.locator('#fill').click();
  const approve = panel.getByRole('button', { name: 'Approve and continue', exact: true });
  await approve.waitFor({ timeout: 30000 });
  verify('auto-select applies the choice', await mock.locator('#mockReviewChoice').inputValue(), 'No');
  verify('auto-select does not advance without approval', await mock.evaluate(() => window.__amwinsMock.saves), 0);
  await panel.screenshot({ path: path.join(out, 'approval-required.png'), fullPage: true });
  await approve.click();
  await mock.waitForFunction(() => window.__amwinsMock.saves > 0, null, { timeout: 30000 });
  verify('approval permits continue', await mock.evaluate(() => window.__amwinsMock.saves > 0), true);
  verify('no submission', await mock.evaluate(() => window.__amwinsMock.submitted), false);
  verify('no browser runtime errors', errors.length, 0);
} catch (error) {
  checks.push({ name: 'runner', ok: false, error: error.stack });
  console.error(error);
  if (context) for (const [i, page] of context.pages().entries()) await page.screenshot({ path: path.join(out, `failure-${i}.png`), fullPage: true }).catch(() => {});
} finally {
  await context?.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
const result = { scope: 'Mock AI responses; real packaged extension controls. No live model-quality measurement.', requests, checks, errors };
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2));
console.log(`${checks.filter(c => c.ok).length}/${checks.length} AI workflow checks passed. ${out}`);
process.exitCode = checks.every(c => c.ok) ? 0 : 1;
