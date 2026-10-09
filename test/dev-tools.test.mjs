import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { zipDirectory } from '../scripts/lib/zip.mjs';
import { createReplayServer } from '../scripts/lib/replay-server.mjs';

test('ZIP entries preserve nested files, spaces and binary data with portable names', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rater zip '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'nested folder'));
  const bytes = Buffer.from([0, 255, 13, 10, 128]);
  fs.writeFileSync(path.join(root, 'nested folder', 'örnek.bin'), bytes);
  fs.writeFileSync(path.join(root, 'manifest.json'), '{"version":"0.9.9"}');
  fs.writeFileSync(path.join(root, '.DS_Store'), 'excluded');
  const files = unzipSync(zipDirectory(root));
  assert.deepEqual(Object.keys(files).sort(), ['manifest.json', 'nested folder/örnek.bin']);
  assert.deepEqual(Buffer.from(files['nested folder/örnek.bin']), bytes);
  assert.equal(JSON.parse(Buffer.from(files['manifest.json']).toString()).version, '0.9.9');
});

test('replay server serves directory indexes and modules from a path with spaces', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rater replay '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'test page'));
  fs.writeFileSync(path.join(root, 'test page', 'index.html'), '<h1>Replay</h1>');
  fs.writeFileSync(path.join(root, 'test page', 'module.mjs'), 'export const ok = true;');
  const server = createReplayServer(root);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(`${base}/test%20page/`);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), '<h1>Replay</h1>');
  const module = await fetch(`${base}/test%20page/module.mjs`);
  assert.match(module.headers.get('content-type'), /javascript/);
  assert.equal(await module.text(), 'export const ok = true;');
  const head = await fetch(`${base}/test%20page/`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await fetch(`${base}/missing`)).status, 404);
  assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400);
  assert.equal((await fetch(`${base}/..%5Coutside`)).status, 400);
  assert.equal((await fetch(`${base}/%2e%2e%2foutside`)).status, 403);
  assert.equal((await fetch(`${base}/test%20page/`, { method: 'POST' })).status, 405);
});
