// What a resolution (src/resolution.js) must say, written out against the old fields it is built
// from, so a later change to either that makes them disagree fails. Used by test/resolution.test.mjs
// for plan steps and by test/pagekit.test.mjs for every report item its fills return.
import assert from 'node:assert/strict';
import { itemResolution } from '../src/resolution.js';

const KEYS = ['answer', 'explanation', 'method', 'status'];
const blank = (v) => v === null || v === undefined || v === '';

// A field step's: its value, source and note (else warn), and a status that each old flag decides.
export function assertStepResolution(step, where = '') {
  const r = step.resolution;
  const at = `${where} step ${step.id} ${step.name}`;
  assert.ok(r, `${at}: no resolution`);
  assert.deepEqual(Object.keys(r).sort(), KEYS, at);
  assert.deepEqual(r.answer, step.value ?? null, `${at}: answer`);
  assert.equal(r.method, step.source ?? null, `${at}: method`);
  assert.equal(r.method === 'standard', !!step.standard, `${at}: standard`);
  assert.equal(r.explanation, step.note ?? step.warn ?? null, `${at}: explanation`);
  const left = !step.manualOnly && (step.ignore || step.verifyOnly);
  const given = !step.manualOnly && !left && !blank(step.value);
  assert.equal(r.status === 'agent', !!step.manualOnly, `${at}: agent iff manualOnly`);
  assert.equal(r.status === 'kept', !!left, `${at}: kept iff ignore or verifyOnly`);
  assert.equal(r.status === 'open', !step.manualOnly && !left && blank(step.value), `${at}: open iff no answer`);
  assert.equal(r.status === 'review', given && !!step.reviewRequired, `${at}: review iff reviewRequired`);
  assert.equal(r.status === 'confirm', given && !step.reviewRequired && !!step.warn, `${at}: confirm iff warn`);
  assert.equal(r.status === 'answered', given && !step.reviewRequired && !step.warn, `${at}: answered`);
}

const LISTS = { filled: 'answered', kept: 'kept', noData: 'open', leftRequired: 'open', failed: 'failed', unknown: 'unknown' };
export const ITEM_LISTS = [...Object.keys(LISTS), 'checks'];

// A report item's: its source and note (else reason), its list's status unless it is the agent's
// alone, and its plan step's answer where it was given. The page kit's (resolveItems) and
// resolution.js itemResolution must agree.
export function assertItemResolution(item, list, step, where = '') {
  const r = item.resolution;
  const at = `${where} ${list} ${item.label ?? item.name}`;
  assert.ok(r, `${at}: no resolution`);
  assert.deepEqual(Object.keys(r).sort(), KEYS, at);
  assert.equal(r.method, item.source ?? null, `${at}: method`);
  // A plan marks `standard` exactly when its source is; a hand-made test step may have one only.
  if (item.source != null) assert.equal(r.method === 'standard', !!item.standard, `${at}: standard`);
  assert.equal(r.explanation, item.note ?? item.reason ?? null, `${at}: explanation`);
  const status = item.manualOnly ? 'agent' : list === 'checks' ? (item.review ? 'review' : 'confirm') : LISTS[list];
  assert.equal(r.status, status, `${at}: status`);
  const given = !['agent', 'open', 'unknown'].includes(status);
  assert.deepEqual(r.answer, given ? step?.value ?? null : null, `${at}: answer`);
  assert.deepEqual(r, itemResolution(item, list, step?.value ?? null), `${at}: the page kit's and resolution.js disagree`);
}

// Every item of a fill report against the plan the fill had; the statuses it saw. Copied first: a
// report from another script world (a vm context, a browser page) has its own prototypes.
export function assertReportResolutions(report, plan = [], where = '') {
  const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const steps = new Map((plan ?? []).filter((s) => s.kind !== 'action').map((s) => [s.id, s]));
  const statuses = [];
  for (const list of ITEM_LISTS) {
    for (const x of report?.[list] ?? []) {
      const item = copy(x);
      assertItemResolution(item, list, copy(steps.get(item.stepId)), where);
      statuses.push(item.resolution.status);
    }
  }
  return statuses;
}
