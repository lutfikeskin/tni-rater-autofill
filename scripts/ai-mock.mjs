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
let mode = 'normal';
let releaseRequest, requestStarted;
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
    if (url.hostname === 'api.typesafe.ai') {
      requests++;
      if (mode === 'slow') {
        requestStarted?.();
        await new Promise(resolve => { releaseRequest = resolve; });
      }
      const body = route.request().postDataJSON();
      const distribution = (criteria, choice, probability = 0.999) => {
        const keys = Object.keys(criteria);
        return { type: 'choice', choice,
          probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? probability : (1 - probability) / (keys.length - 1)])),
          confidence: (probability - 1 / keys.length) / (1 - 1 / keys.length) };
      };
      const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]) => {
        if (q.type === 'noul') return [id, { type: 'noul', noul: mode === 'unsupported' ? 0.2 : 0.999 }];
        const mockChoice = q.instructions.field.label.includes('Mock review choice');
        const key = id.endsWith('_source')
          ? Object.keys(q.criteria).find(k => q.criteria[k]?.path === 'operations.hazPlacard')
          : Object.keys(q.criteria).find(k => q.criteria[k]?.label === 'No');
        return [id, distribution(q.criteria, mockChoice && key ? key : '__leave__', mode === 'uncertain' ? 0.75 : 0.999)];
      }));
      return route.fulfill({ json: { model: body.model, answers, usage: { input_tokens: 100, output_tokens: 0 } } });
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
  await panel.setViewportSize({ width: 420, height: 900 });
  for (const page of [mock, panel]) page.on('pageerror', error => errors.push(error.message));
  await panel.goto(`chrome-extension://${id}/sidepanel/sidepanel.html`);
  await panel.evaluate(() => chrome.storage.local.set({ settings: { aiOn: true, aiAuto: false,
    aiKey: 'legacy-openai-key', autoAdvance: false, serverUrl: '', serverToken: '' } }));
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
  const manifest = fs.existsSync(path.join(pool, 'manifest.json')) && JSON.parse(fs.readFileSync(path.join(pool, 'manifest.json')));
  const sample = manifest?.cases?.find(c => c.id.startsWith('03-'));
  const loadPdf = async () => {
    if (await panel.locator('#clear-client').isVisible()) {
      await panel.locator('#clear-client').click();
      await panel.locator('#home').waitFor({ state: 'visible' });
    }
    await panel.setInputFiles('#file', sample ? path.join(pool, sample.pdf) : path.join(root, 'test/fixtures/sample-intake.pdf'));
    await panel.locator('#quote').waitFor({ state: 'visible' });
  };
  await loadPdf();
  await panel.locator('#tab-fill').click();
  await panel.locator('#fill').click();
  await panel.getByText(/Jev needs a TypeSafe API key/).waitFor();
  verify('legacy OpenAI key is never used for Jev', requests, 0);
  await panel.locator('#settings-btn').click();
  await panel.locator('#ai-key').fill('synthetic-test-key');
  await panel.locator('#ai-key').press('Tab');
  await panel.waitForFunction(async () => (await chrome.storage.local.get('settings')).settings.jevKey === 'synthetic-test-key');
  verify('Jev settings are visible', await panel.getByText('Jev assistant', { exact: true }).isVisible(), true);
  await panel.screenshot({ path: path.join(out, 'jev-settings.png'), fullPage: true });
  await panel.locator('#settings-done').click();
  await panel.locator('#fill').click();
  const accept = panel.getByRole('button', { name: 'Use this answer', exact: true });
  await accept.waitFor({ timeout: 30000 });
  verify('suggestions only leave the page untouched', await mock.locator('#mockReviewChoice').inputValue(), '');
  await accept.click();
  await mock.waitForFunction(() => document.querySelector('#mockReviewChoice').value === 'No', null, { timeout: 6000 }).catch(async error => { console.error(await panel.locator('#report').innerText()); throw error; });
  verify('accepted suggestion is applied', await mock.locator('#mockReviewChoice').inputValue(), 'No');
  // The panel records an accepted answer once the page has kept it; edit only after that, as an
  // agent would after seeing the confirmation (editing earlier raced the bookkeeping).
  await panel.getByText(/Put in .*purple on the page/).first().waitFor({ timeout: 15000 });
  await mock.locator('#mockReviewChoice').selectOption('Yes');
  await panel.waitForTimeout(1800); // recorder debounce
  await panel.locator('#fill').click();
  await panel.waitForFunction(() => !document.querySelector('#fill').disabled);
  verify('manual edit survives another fill', await mock.locator('#mockReviewChoice').inputValue(), 'Yes');
  verify('same context reuses its AI response', requests, 2);
  await panel.screenshot({ path: path.join(out, 'suggestion-edited.png'), fullPage: true });

  // New intake clears earlier decisions; verified auto-select still waits for agent approval.
  await panel.evaluate(() => chrome.storage.local.set({ settings: { aiOn: true, aiAuto: true,
    jevKey: 'synthetic-test-key', autoAdvance: true, serverUrl: '', serverToken: '' } }));
  await panel.reload();
  await openMock();
  await loadPdf();
  await panel.locator('#tab-fill').click();
  await panel.locator('#fill').click();
  const approve = panel.getByRole('button', { name: 'Approve and continue', exact: true });
  await approve.waitFor({ timeout: 30000 }).catch(async error => { console.error(await panel.locator('#report').innerText()); throw error; });
  verify('auto-select applies the choice', await mock.locator('#mockReviewChoice').inputValue(), 'No');
  verify('auto-select does not advance without approval', await mock.evaluate(() => window.__amwinsMock.saves), 0);
  await panel.screenshot({ path: path.join(out, 'approval-required.png'), fullPage: true });
  await approve.click();
  await mock.waitForFunction(() => window.__amwinsMock.saves > 0, null, { timeout: 30000 });
  verify('approval permits continue', await mock.evaluate(() => window.__amwinsMock.saves > 0), true);
  verify('no submission', await mock.evaluate(() => window.__amwinsMock.submitted), false);
  for (const scenario of ['uncertain', 'unsupported']) {
    mode = scenario;
    await panel.reload();
    await openMock();
    await loadPdf();
    await panel.locator('#tab-fill').click();
    await panel.locator('#fill').click();
    if (scenario === 'uncertain') await panel.getByRole('button', { name: 'Use this answer', exact: true }).waitFor();
    else await panel.getByText('AI: this one is yours to decide.', { exact: true }).waitFor();
    verify(`${scenario} evidence never auto-selects`, await mock.locator('#mockReviewChoice').inputValue(), '');
    verify(`${scenario} does not advance`, await mock.evaluate(() => window.__amwinsMock.saves), 0);
    await panel.screenshot({ path: path.join(out, `${scenario}.png`), fullPage: true });
  }
  mode = 'normal';
  await panel.reload();
  await openMock();
  await loadPdf();
  await panel.locator('#tab-fill').click();
  await panel.locator('#fill').click();
  await panel.getByRole('button', { name: 'Approve and continue', exact: true }).waitFor();
  await mock.locator('#mockReviewChoice').selectOption('');
  await panel.getByRole('button', { name: 'Approve and continue', exact: true }).click();
  await panel.getByText('AI answer rejected: answer it on the page.', { exact: true }).waitFor();
  verify('approval rechecks that the page still has the AI choice', await mock.locator('#mockReviewChoice').inputValue(), '');
  verify('stale approval never advances', await mock.evaluate(() => window.__amwinsMock.saves), 0);
  mode = 'slow';
  await panel.reload();
  await openMock();
  await loadPdf();
  await panel.locator('#tab-fill').click();
  const waiting = new Promise(resolve => { requestStarted = resolve; });
  await panel.locator('#fill').click();
  await waiting;
  await mock.locator('#mockReviewChoice').selectOption('Yes');
  mode = 'normal';
  releaseRequest();
  await panel.getByText(/the page changed; click Fill this page/).waitFor();
  verify('manual edit during Jev request survives', await mock.locator('#mockReviewChoice').inputValue(), 'Yes');
  verify('stale response cannot advance', await mock.evaluate(() => window.__amwinsMock.saves), 0);

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
