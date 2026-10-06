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
  assert.match(md, /Another page than capture 2 \(Operations\)/);
});
