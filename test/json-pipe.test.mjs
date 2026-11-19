import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Spawn a CLI script with stdout piped and collect its full stdout before exit.
 * @param {string} scriptRel
 * @param {string[]} args
 * @returns {Promise<{status: number | null, stdout: string, stderr: string}>}
 */
function runPiped(scriptRel, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repo, scriptRel), ...args], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = /** @type {Buffer[]} */ ([]);
    let stderr = '';
    child.stdout.on('data', (chunk) => { chunks.push(Buffer.from(chunk)); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout: Buffer.concat(chunks).toString('utf8'), stderr }));
  });
}

test('weekly-signals --json emits complete, valid JSON over a pipe when output exceeds 64 KB', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rater-json-pipe-signals-'));
  try {
    const log = path.join(dir, 'events.jsonl');
    const testsFile = path.join(dir, 'tests.txt');
    fs.writeFileSync(testsFile, '# empty test list\n');

    // Synthetic events producing > 128 KB of --json output (above macOS's 64 KB pipe buffer).
    const lines = [];
    const baseMs = Date.parse('2026-10-06T12:00:00Z');
    for (let i = 0; i < 250; i++) {
      const t = new Date(baseMs + i * 1000).toISOString();
      const session = `s-${i}`;
      lines.push(JSON.stringify({ id: `in-${i}`, t, receivedAt: t, session, v: '0.9.9', agent: 'AB', type: 'intake_loaded', state: 'TX' }));
      lines.push(JSON.stringify({
        id: `pr-${i}`, t, receivedAt: t, session, v: '0.9.9', agent: 'AB', carrier: 'progressive',
        type: 'problem_report', page: `Page${i}`, text: `Synthetic report ${i}: ${'detail '.repeat(60)}`,
      }));
    }
    fs.writeFileSync(log, `${lines.join('\n')}\n`);

    const r = await runPiped('scripts/weekly-signals.mjs', [log, '--all', '--tests', testsFile, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.ok(Buffer.byteLength(r.stdout) > 64 * 1024, `expected > 64 KB JSON output, got ${Buffer.byteLength(r.stdout)} bytes`);
    assert.equal(parsed.problems.length, 250);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger --json emits complete, valid JSON over a pipe when output exceeds 64 KB', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rater-json-pipe-ledger-'));
  try {
    const log = path.join(dir, 'events.jsonl');
    const testsFile = path.join(dir, 'tests.txt');
    const ledgerFile = path.join(dir, 'ledger.md');
    fs.writeFileSync(testsFile, '# empty test list\n');
    const t = '2026-10-06T12:00:00Z';
    fs.writeFileSync(log, `${JSON.stringify({ id: 'in-1', t, receivedAt: t, session: 's-1', v: '0.9.9', agent: 'AB', type: 'intake_loaded', state: 'TX' })}\n`);

    // Ticked items skip gh lookups while still serializing into the JSON output (> 64 KB).
    const body = ['# Weekly review · 2026-10-01 to 2026-10-05', ''];
    for (let i = 1; i <= 250; i++) {
      const id = `W42-${String(i).padStart(3, '0')}`;
      body.push(`- [x] ${id} · S2 · Fix · Synthetic ledger item ${i} ${'description '.repeat(25)} · signature: synthetic ${i}`);
    }
    fs.writeFileSync(ledgerFile, `${body.join('\n')}\n`);

    const r = await runPiped('scripts/ledger.mjs', [log, '--ledger', ledgerFile, '--since', '2026-10-06', '--tests', testsFile, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.ok(Buffer.byteLength(r.stdout) > 64 * 1024, `expected > 64 KB JSON output, got ${Buffer.byteLength(r.stdout)} bytes`);
    assert.equal(parsed.items.length, 250);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('learn-rules and rule-proposals --json emit complete, valid JSON over a pipe when output exceeds 64 KB', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rater-json-pipe-learn-'));
  try {
    const log = path.join(dir, 'events.jsonl');
    const testsFile = path.join(dir, 'tests.txt');
    fs.writeFileSync(testsFile, '# empty test list\n');

    // Synthetic split answers across 2 intakes for 180 distinct unfamiliar questions -> large
    // undecided/candidates list (> 64 KB) in both learn-rules --json and rule-proposals --json.
    const lines = [];
    const baseMs = Date.parse('2026-10-06T12:00:00Z');
    let seq = 0;
    for (let s = 0; s < 2; s++) {
      const session = `sess-${s}`;
      const intakeId = `${String(s + 1).repeat(16)}`;
      const t0 = new Date(baseMs + seq++ * 1000).toISOString();
      lines.push(JSON.stringify({ id: `in-${s}`, t: t0, receivedAt: t0, session, v: '0.9.9', agent: 'AB', type: 'intake_loaded', intakeId, state: 'VA' }));
      for (let q = 0; q < 180; q++) {
        const label = `Synthetic undecided question ${q} with descriptive label text ${'extra '.repeat(10)}`;
        const t1 = new Date(baseMs + seq++ * 1000).toISOString();
        lines.push(JSON.stringify({
          id: `ff-${s}-${q}`, t: t1, receivedAt: t1, session, v: '0.9.9', agent: 'AB', carrier: 'progressive',
          type: 'fill_field', page: 'MoreAboutBusiness', q: `SQ${q}`, label, controlKind: 'radio', result: 'unfamiliar',
        }));
        const t2 = new Date(baseMs + seq++ * 1000).toISOString();
        lines.push(JSON.stringify({
          id: `fc-${s}-${q}`, t: t2, receivedAt: t2, session, v: '0.9.9', agent: 'AB', carrier: 'progressive',
          type: 'field_change', page: 'MoreAboutBusiness', q: `SQ${q}`, label, kind: 'radio', by: 'agent',
          to: s === 0 ? 'Yes' : 'No',
        }));
      }
    }
    fs.writeFileSync(log, `${lines.join('\n')}\n`);

    const learnRes = await runPiped('scripts/learn-rules.mjs', [log, '--min', '2', '--tests', testsFile, '--json']);
    assert.equal(learnRes.status, 0, learnRes.stderr);
    const learned = JSON.parse(learnRes.stdout);
    assert.ok(Buffer.byteLength(learnRes.stdout) > 64 * 1024, `expected > 64 KB learn-rules JSON output, got ${Buffer.byteLength(learnRes.stdout)} bytes`);
    assert.equal(learned.undecided.length, 180);

    const propRes = await runPiped('scripts/rule-proposals.mjs', [log, '--min', '2', '--tests', testsFile, '--json']);
    assert.equal(propRes.status, 0, propRes.stderr);
    const proposed = JSON.parse(propRes.stdout);
    assert.ok(Buffer.byteLength(propRes.stdout) > 64 * 1024, `expected > 64 KB rule-proposals JSON output, got ${Buffer.byteLength(propRes.stdout)} bytes`);
    assert.equal(proposed.candidates.length, 180);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
