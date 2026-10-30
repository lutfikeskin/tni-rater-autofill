// What a resolution (src/resolution.js) must say, written out against the old fields it is built
// from, so a later change to either that makes them disagree fails. Used by test/resolution.test.mjs
// for plan steps and by test/pagekit.test.mjs for every report item its fills return.
import assert from 'node:assert/strict';
import { agentsAlone, isStandard, itemResolution } from '../src/resolution.js';
import { fillEvents } from '../src/usage.js';

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
  // What the panel and the AI read in place of the old flags (resolution.js) says what they said.
  assert.equal(agentsAlone(item), !!item.manualOnly, `${at}: agentsAlone`);
  if (item.source != null) assert.equal(isStandard(item, list), !!item.standard, `${at}: isStandard`);
  // The panel's reason for an item left (fill.js itemsLeft) is its explanation, which is its note
  // there only while these lists never carry a failure's `reason`.
  if (['noData', 'checks', 'leftRequired'].includes(list)) assert.equal(item.reason, undefined, `${at}: a reason on a ${list} item`);
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
  assertEventsAgree(copy(report), where);
  return statuses;
}

// The usage log reads each item's resolution (usage.js fieldWhy); its fill_field events must say
// what the old flags said: source, standard, manualOnly and review, each only when set.
const LOGGED = [['filled', 'filled'], ['failed', 'failed'], ['noData', 'noData'], ['kept', 'kept'], ['leftRequired', 'leftRequired'], ['unknown', 'unfamiliar']];
export function oldWhy(x) {
  return { ...(x.source ? { source: x.source } : {}), ...(x.standard ? { standard: true } : {}), ...(x.manualOnly ? { manualOnly: true } : {}), ...(x.review ? { review: true } : {}) };
}
export function assertEventsAgree(report, where = '') {
  const events = fillEvents([report], { carrier: 'c', page: 'p', view: 'v', overwrite: false, ms: 0, redact: (s) => s }).filter((e) => e.type === 'fill_field');
  const items = LOGGED.flatMap(([list, result]) => (report[list] ?? []).map((x) => [x, result]));
  assert.equal(events.length, items.length, `${where}: one event per logged item`);
  items.forEach(([x, result], i) => {
    const e = events[i];
    assert.equal(e.result, result, `${where}: event order`);
    const why = { ...(e.source ? { source: e.source } : {}), ...(e.standard ? { standard: true } : {}), ...(e.manualOnly ? { manualOnly: true } : {}), ...(e.review ? { review: true } : {}) };
    const want = oldWhy(x);
    // A plan marks `standard` exactly when its source is; a hand-made test step may have one only.
    if (x.resolution && x.source == null) { delete want.standard; delete why.standard; }
    assert.deepEqual(why, want, `${where} ${result} ${x.label ?? x.name}: the usage log's why fields`);
  });
}
