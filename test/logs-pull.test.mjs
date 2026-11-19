import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseExport, writeDays } from '../scripts/lib/logs-pull.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'scripts', 'logs-pull.mjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rater-logs-pull-'));
/** @param {string} id @param {string} day */
const evLine = (id, day) => JSON.stringify({ id, t: `${day}T12:00:00Z`, receivedAt: `${day}T12:00:00Z`, type: 'page_view', carrier: 'progressive', page: 'Quote' });

/**
 * @param {string} body
 * @param {(base: string) => Promise<void>} fn
 */
async function withExportServer(body, fn) {
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer secret') { res.writeHead(401).end('unauthorized'); return; }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}

/**
 * @param {string} base
 * @param {string[]} args
 * @returns {Promise<{status: number | null, stdout: string, stderr: string}>}
 */
function runPull(base, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repo,
      env: { ...process.env, RATER_SERVER: base, RATER_ADMIN_TOKEN: 'secret' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('logs-pull fails on a non-JSON line naming its line number and leaves local files untouched', async () => {
  const out = tmp();
  const eventsDir = path.join(out, 'events');
  fs.mkdirSync(eventsDir, { recursive: true });
  const day1File = path.join(eventsDir, '2026-10-01.jsonl');
  const original = `${evLine('orig-1', '2026-10-01')}\n`;
  fs.writeFileSync(day1File, original);

  const body = `${evLine('new-1', '2026-10-01')}\n${evLine('new-2', '2026-10-01')}\n{"id":"cut","receivedAt":"2026-10-02`;
  await withExportServer(body, async (base) => {
    const r = await runPull(base, ['--out', out]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status} (stderr: ${r.stderr})`);
    assert.match(r.stderr, /\b3\b/, 'stderr names the failing line number');
  });

  assert.equal(fs.readFileSync(day1File, 'utf8'), original, 'existing day file is untouched');
  assert.ok(!fs.existsSync(path.join(eventsDir, '2026-10-02.jsonl')), 'no new day file written');
  assert.deepEqual(fs.readdirSync(eventsDir).filter((f) => f.endsWith('.tmp')), []);
});

test('logs-pull refuses to shrink an existing day file unless --allow-shrink is passed', async () => {
  const out = tmp();
  const eventsDir = path.join(out, 'events');
  fs.mkdirSync(eventsDir, { recursive: true });
  const day1File = path.join(eventsDir, '2026-10-01.jsonl');
  const day2File = path.join(eventsDir, '2026-10-02.jsonl');
  const origDay1 = `${evLine('d1-1', '2026-10-01')}\n`;
  const origDay2 = `${[evLine('d2-1', '2026-10-02'), evLine('d2-2', '2026-10-02'), evLine('d2-3', '2026-10-02')].join('\n')}\n`;
  fs.writeFileSync(day1File, origDay1);
  fs.writeFileSync(day2File, origDay2);

  // Day 1 grew (1 -> 2), day 2 shrank (3 -> 1). Neither may be written without --allow-shrink.
  const body = `${[evLine('d1-1', '2026-10-01'), evLine('d1-2', '2026-10-01'), evLine('d2-1', '2026-10-02')].join('\n')}\n`;
  await withExportServer(body, async (base) => {
    const refused = await runPull(base, ['--out', out]);
    assert.equal(refused.status, 1, `expected exit 1, got ${refused.status} (stderr: ${refused.stderr})`);
    assert.match(refused.stderr, /2026-10-02/, 'stderr names the day');
    assert.match(refused.stderr, /\b3\b/, 'stderr names the existing event count');
    assert.match(refused.stderr, /\b1\b/, 'stderr names the downloaded event count');
    assert.equal(fs.readFileSync(day1File, 'utf8'), origDay1, 'earlier day is not updated when a later day shrinks');
    assert.equal(fs.readFileSync(day2File, 'utf8'), origDay2, 'shrinking day is untouched');

    const allowed = await runPull(base, ['--out', out, '--allow-shrink']);
    assert.equal(allowed.status, 0, `expected exit 0 with --allow-shrink (stderr: ${allowed.stderr})`);
    assert.equal(fs.readFileSync(day1File, 'utf8').trim().split('\n').length, 2);
    assert.equal(fs.readFileSync(day2File, 'utf8').trim().split('\n').length, 1);
    assert.deepEqual(fs.readdirSync(eventsDir).filter((f) => f.endsWith('.tmp')), []);
  });
});

test('writeDays prepares every day as a temporary file in the same folder before the first rename', (t) => {
  const dir = path.join(tmp(), 'events');
  const { byDay } = parseExport(`${evLine('a', '2026-10-01')}\n${evLine('b', '2026-10-02')}\n`);

  /** @type {string[][]} */
  const snapshots = [];
  const realRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (/** @type {fs.PathLike} */ from, /** @type {fs.PathLike} */ to) => {
    assert.equal(path.dirname(String(from)), dir, 'temp file is in the same folder');
    snapshots.push(fs.readdirSync(dir).sort());
    return realRename(from, to);
  });

  writeDays(dir, byDay);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].filter((f) => f.endsWith('.tmp')).length, 2, 'both temp files exist before the first rename');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-10-01.jsonl', '2026-10-02.jsonl']);
});

test('writeDays cleans up temporary files and touches no final file if staging a later day fails', (t) => {
  const dir = path.join(tmp(), 'events');
  fs.mkdirSync(dir, { recursive: true });
  const day1 = path.join(dir, '2026-10-01.jsonl');
  const orig = `${evLine('orig', '2026-10-01')}\n`;
  fs.writeFileSync(day1, orig);

  const { byDay } = parseExport(`${evLine('a', '2026-10-01')}\n${evLine('b', '2026-10-02')}\n`);
  const realWrite = fs.writeFileSync;
  let calls = 0;
  t.mock.method(fs, 'writeFileSync', (/** @type {fs.PathOrFileDescriptor} */ file, /** @type {string | NodeJS.ArrayBufferView} */ data) => {
    calls++;
    if (calls === 2) throw new Error('ENOSPC');
    return realWrite(file, data);
  });

  assert.throws(() => writeDays(dir, byDay), /ENOSPC/);
  assert.equal(fs.readFileSync(day1, 'utf8'), orig);
  assert.deepEqual(fs.readdirSync(dir), ['2026-10-01.jsonl']);
});

test('parseExport handles empty exports and rejects non-object JSON with the 1-based line number', () => {
  assert.deepEqual(parseExport(''), { byDay: new Map(), events: 0 });
  assert.throws(() => parseExport(`${evLine('a', '2026-10-01')}\n\nnull\n`), /line 3/i);
});
