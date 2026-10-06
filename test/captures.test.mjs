import test from 'node:test';
import assert from 'node:assert/strict';
import { captureStory } from '../scripts/captures.mjs';

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
  assert.match(md, /Not compared with capture 2 \(Operations, t1\): another page, step, tab or vehicle/);
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
  assert.match(md, /Not compared with capture 1 \(Operations, t1\)/, 'another vehicle on the same page');
});
