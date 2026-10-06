import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureStory, readCaptures } from '../scripts/captures.mjs';

const capture = (n, controls, extra = {}) => ({ kind: 'page-capture', version: 2, carrier: 'progressive', scenario: 'FL van', n,
  capturedAt: `2026-10-06T10:0${n}:00Z`, page: 'Operations', step: null, view: 't1', note: null,
  frames: [{ isTopFrame: true, controls, messages: [], openLists: [] }], ...extra });
const hazmat = (selected) => ({ q: '2A1', kind: 'radio', label: 'Hauls hazmat?', options: ['Yes', 'No'], selected });

test('captures read as a story per scenario: each one in order, and what changed since the last', () => {
  const md = captureStory([
    capture(2, [hazmat('Yes'), { q: '2A2', kind: 'text', label: 'Placards carried', required: true }], { note: 'set hazmat to Yes' }),
    capture(1, [hazmat('No')]),
    capture(3, [hazmat('Yes')], { page: 'Drivers' }),
  ]).join('\n');
  assert.match(md, /## progressive · FL van/);
  assert.ok(md.indexOf('### 1. Operations (t1)') < md.indexOf('### 2. Operations (t1) — set hazmat to Yes'), 'in capture order');
  assert.match(md, /Since capture 1:\n- Answer: Hauls hazmat\?: No → Yes\n- Appeared: Placards carried/);
  assert.match(md, /### 3\. Drivers \(t1\)\n\n1 question, [^\n]*\n\nFirst capture of this page, step, view and intake in the scenario/);
});

test('the story compares like with like: same view, unanswered picks, no repeated rows, every frame, in the order taken', () => {
  const row = (selected) => ({ q: '2C1A', kind: 'select', label: 'Rental per vehicle', options: ['None', '$40'], selected });
  const md = captureStory([
    capture(1, [hazmat(''), row('None'), row('None')], { capturedAt: '2026-10-06T09:00:00Z' }),
    // Taken later, numbered 1 again after the name was reused: still after the first.
    capture(1, [hazmat('Yes'), row('$40'), row('None')], { capturedAt: '2026-10-06T09:05:00Z',
      frames: [{ isTopFrame: true, controls: [hazmat('Yes'), row('$40'), row('None')], messages: [], openLists: [] },
        { isTopFrame: false, frame: 'https://synthetic.example/frame', controls: [], messages: ['Enter a valid ZIP'], openLists: [{ label: null, options: [] }] }] }),
    capture(3, [hazmat('No')], { capturedAt: '2026-10-06T09:10:00Z', view: 't1:v1' }),
  ]).join('\n');
  assert.match(md, /- Answer: Hauls hazmat\?: ∅ → Yes/);
  assert.doesNotMatch(md, /Rental per vehicle: None/, 'repeated rows are not matched');
  assert.match(md, /- Message \(frame https:\/\/synthetic\.example\/frame\): Enter a valid ZIP/);
  assert.match(md, /- Open list \(frame [^)]*\): \(choices not kept\)/);
  assert.match(md, /### 3\. Operations \(t1:v1\)[\s\S]*First capture of this page, step, view and intake/, 'another vehicle on the same page');
});

test('the story pairs a capture with the last one of the same page, view and intake, and ignores spelling', () => {
  const fl = { state: 'FL', coverages: ['cargo'] };
  const md = captureStory([
    capture(1, [hazmat('No')], { capturedAt: '2026-10-06T09:00:00Z', context: fl }),
    capture(2, [hazmat('No')], { capturedAt: '2026-10-06T09:01:00Z', context: fl, view: 't1:v1' }),
    capture(3, [hazmat('YES'), { q: '2A2', kind: 'text', label: 'Placards carried' }], { capturedAt: '2026-10-06T09:02:00Z', context: fl }),
    capture(4, [hazmat('yes ')], { capturedAt: '2026-10-06T09:03:00Z', context: { state: 'GA', coverages: [] } }),
    capture(5, [hazmat('Yes'), { q: '2A2', kind: 'text', label: 'Placards carried' }], { capturedAt: '2026-10-06T09:04:00Z', context: fl }),
  ]).join('\n');
  assert.match(md, /### 3\.[\s\S]*?Since capture 1:\n- Answer: Hauls hazmat\?: No → YES\n- Appeared: Placards carried/, 'back on the first van after the second');
  assert.match(md, /### 4\.[^\n]*\n\n[^\n]*\n\nFirst capture of this page, step, view and intake/, 'another intake is not compared');
  assert.match(md, /### 5\.[\s\S]*?Same questions as capture 3\./, 'YES and Yes are one answer');
});

test('capture files that cannot be read are named, and quotes keep same-named scenarios apart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'captures-'));
  fs.writeFileSync(path.join(dir, 'capture-progressive-a-001-Operations.json'), JSON.stringify(capture(1, [hazmat('No')], { quote: 'aaaa1111' })));
  fs.writeFileSync(path.join(dir, 'capture-progressive-a-002-Operations.json'), '{"kind":"page-capture","vers');
  fs.writeFileSync(path.join(dir, 'capture-progressive-old.json'), JSON.stringify({ tool: 'tni-rater-autofill', version: 1, frames: [] }));
  const { captures, unreadable } = readCaptures([dir]);
  assert.equal(captures.length, 1);
  assert.deepEqual(unreadable.map((u) => path.basename(u.file)), ['capture-progressive-a-002-Operations.json']);
  const md = captureStory([capture(1, [hazmat('No')], { quote: 'aaaa1111' }), capture(1, [hazmat('Yes')], { quote: 'bbbb2222', capturedAt: '2026-10-06T10:09:00Z' })]).join('\n');
  assert.match(md, /## progressive · FL van \(quote aaaa\)[\s\S]*## progressive · FL van \(quote bbbb\)/);
  assert.doesNotMatch(md, /Answer:/, 'two clients are not one before/after');
});
