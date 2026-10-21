import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { inferShowWhen, fieldId } from '../scripts/lib/conditions.mjs';
import { buildLayouts } from '../scripts/lib/layouts.mjs';
import { layoutTransitions, summarizeTransitions } from '../scripts/lib/transitions.mjs';

const hazmat = (selected) => ({ q: '2A1', kind: 'radio', label: 'Hauls hazmat?', options: ['Select one', 'Yes', 'No', 'Unsure'], selected });
const placards = { q: '2A2', kind: 'text', label: 'Placards carried' };
const radius = (selected) => ({ q: '2B9D', kind: 'select', label: 'Farthest distance', options: ['50 miles', '500 miles'], selected });
const snap = (...fields) => ({ fields });

test('a follow-up shows when its trigger had the picks it was always seen with', () => {
  const when = inferShowWhen([
    snap(radius('50 miles'), hazmat('Yes'), placards), snap(radius('500 miles'), hazmat('Yes'), placards),
    snap(radius('50 miles'), hazmat('No')), snap(radius('500 miles'), hazmat('No')),
  ]);
  const c = when.get('2A2');
  assert.deepEqual([c.trigger, [...c.is], c.shown, c.hidden], ['2A1', ['Yes'], 2, 2]);
  assert.deepEqual([...c.unseen], ['Unsure'], 'an answer no layout showed');
  assert.equal(when.has('2A1'), false, 'on every layout: no condition');
});

test('no condition is claimed without enough layouts on both sides, or when they disagree', () => {
  assert.equal(inferShowWhen([snap(hazmat('Yes'), placards), snap(hazmat('No'))]).get('2A2'), null, 'one layout per side is not enough');
  const disagree = inferShowWhen([snap(hazmat('Yes'), placards), snap(hazmat('Yes'), placards), snap(hazmat('Yes')), snap(hazmat('No')), snap(hazmat('No'))]);
  assert.equal(disagree.get('2A2'), null, 'Yes seen both with and without it');
  // Shown once without its would-be trigger on the page: not that trigger's follow-up.
  const without = inferShowWhen([snap(hazmat('Yes'), placards), snap(hazmat('Yes'), placards), snap(placards), snap(hazmat('No')), snap(hazmat('No'))]);
  assert.equal(without.get('2A2'), null);
  // Layouts without picks (before 0.9.5) can't say when.
  assert.equal(inferShowWhen([snap(hazmat(), placards), snap(hazmat(), placards), snap(hazmat()), snap(hazmat())]).get('2A2'), null);
});

test('questions repeated on a page or without any name are left out', () => {
  const row = { kind: 'radio', label: 'Exclude Collision Coverage', options: ['Yes', 'No'] };
  const when = inferShowWhen([snap(hazmat('Yes'), row, row), snap(hazmat('Yes'), row, row), snap(hazmat('No')), snap(hazmat('No'))]);
  assert.equal(when.has(fieldId(row)), false);
  assert.equal(fieldId({ kind: 'select', label: '' }), null);
  assert.equal(fieldId({ kind: 'select', label: '', dataId: 'state' }), 'data:state', 'an unlabelled list is told apart by its data-id');
});

const layoutEvent = (session, fields, extra = {}) => ({ type: 'page_layout', carrier: 'progressive', page: 'Operations', session, t: '2026-10-06T10:00:00Z',
  reason: 'changed', context: { state: 'FL', businessClass: 'Expediter', vehicleTypes: ['Van'] }, fields, buttons: ['Continue', 'Log out'], ...extra });

test('built layouts carry the conditions, the buttons seen and sometimes-required questions', () => {
  const events = [
    layoutEvent('a', [hazmat('Yes'), { ...placards, required: true }]), layoutEvent('a', [hazmat('No')]),
    layoutEvent('b', [hazmat('Yes'), placards]), layoutEvent('b', [hazmat('No')]),
    // A fill before the page drew its questions (0.9.5): no evidence.
    layoutEvent('b', [], { reason: 'fill' }),
  ];
  const [{ layout }] = buildLayouts(events);
  const page = layout.pages.Operations;
  const f = page.fields.find((x) => x.q === '2A2');
  assert.deepEqual({ ...f.showWhen, is: [...f.showWhen.is] }, { q: '2A1', caption: 'Hauls hazmat?', is: ['Yes'], seen: { shown: 2, hidden: 2 }, unseen: ['Unsure'] });
  assert.deepEqual([f.cond, f.req, f.reqSometimes], [true, true, true]);
  assert.deepEqual(page.seenButtons, ['Continue', 'Log out']);
  assert.equal(page.buttons, undefined, 'not drawn (or clicked) on the replay page');
});

test('an AmWINS step is a page of its own; its layouts without a step tell nothing about conditions', () => {
  const amwins = (fields, extra) => ({ ...layoutEvent('a', fields, extra), carrier: 'amwins', page: '/application/businessauto' });
  const pages = Object.keys(buildLayouts([amwins([placards], { step: 'Vehicles' }), amwins([hazmat('Yes')], { step: 'Coverages' })])[0].layout.pages);
  assert.deepEqual(pages, ['/application/businessauto › Vehicles', '/application/businessauto › Coverages']);
  const old = buildLayouts([amwins([hazmat('Yes'), placards]), amwins([hazmat('Yes'), placards]), amwins([hazmat('No')]), amwins([hazmat('No')])])[0].layout;
  const f = old.pages['/application/businessauto'].fields.find((x) => x.q === '2A2');
  assert.deepEqual([f.showWhen, f.condition], [undefined, 'unknown']);
});

test('transitions pair two layouts of a page with only that page\'s answers between them', () => {
  let seq = 0;
  const e = (x) => ({ session: 's', seq: ++seq, t: '2026-10-06T10:00:00Z', carrier: 'progressive', ...x });
  const events = [
    e({ type: 'intake_loaded', state: 'FL' }),
    e(layoutEvent('s', [hazmat('No')], { reason: 'arrived' })),
    e({ type: 'field_change', page: 'Operations', label: 'Hauls hazmat?', kind: 'radio', from: 'No', to: 'Yes', by: 'agent' }),
    e(layoutEvent('s', [hazmat('Yes'), placards], { reason: 'appeared+changed' })),
    // Another page, then back: an arrival, not a consequence of the answer.
    e({ type: 'page_view', page: 'Drivers', from: 'Operations' }),
    e(layoutEvent('s', [hazmat('Yes')], { reason: 'arrived' })),
  ];
  const list = layoutTransitions(events);
  assert.deepEqual(list.map((t) => [t.page, t.after.map((c) => `${c.question}: ${c.from} → ${c.to}`), t.appeared, t.removed]),
    [['Operations', ['Hauls hazmat?: No → Yes'], ['Placards carried'], []]]);
  const [summary] = summarizeTransitions([...list, { ...list[0], session: 's2' }]);
  assert.deepEqual([summary.cause, summary.effect, summary.quotes, summary.states], ['Hauls hazmat?: No → Yes (agent)', '+ Placards carried', 2, ['FL']]);
  const filled = summarizeTransitions([list[0], { ...list[0], session: 's3', after: [{ ...list[0].after[0], by: 'fill' }] }]);
  assert.equal(filled.length, 2, 'the agent\'s answer and the extension\'s are counted apart');
});

test('a follow-up seen while its trigger was unanswered rules that trigger out', () => {
  const other = (selected) => ({ q: '2B9D', kind: 'select', label: 'Farthest distance', options: ['50 miles'], selected });
  const when = inferShowWhen([
    snap(other('50 miles'), hazmat('Yes'), placards), snap(other('50 miles'), hazmat('Yes'), placards),
    snap(other('50 miles'), hazmat('No')), snap(other('50 miles'), hazmat('No')),
    // Recorded with picks (0.9.5+), the hazmat question unanswered, and Placards showing.
    snap(other('50 miles'), hazmat(undefined), placards),
  ]);
  assert.equal(when.get('2A2'), null);
});

test('pages about one vehicle or driver are left out of conditions', () => {
  const events = ['a', 'a', 'b', 'b'].map((session, i) => ({ ...layoutEvent(session, i % 2 ? [hazmat('No')] : [hazmat('Yes'), placards]), page: 'AddVehicle' }));
  const f = buildLayouts(events)[0].layout.pages.AddVehicle.fields.find((x) => x.q === '2A2');
  assert.deepEqual([f.showWhen, f.condition], [undefined, 'unknown']);
});

test('a trigger without a question id is named by its element identity for the replay', () => {
  const noEquipment = (selected) => ({ kind: 'checkbox', label: 'Vehicle has no equipment', dataId: 'noEquip', selected });
  const value = { kind: 'text', label: 'Equipment value', dataId: 'equipValue' };
  const events = [layoutEvent('a', [noEquipment('unchecked'), value]), layoutEvent('a', [noEquipment('checked')]),
    layoutEvent('b', [noEquipment('unchecked'), value]), layoutEvent('b', [noEquipment('checked')])];
  const f = buildLayouts(events)[0].layout.pages.Operations.fields.find((x) => x.dataId === 'equipValue');
  assert.deepEqual([f.showWhen.q, f.showWhen.dataId, f.showWhen.caption, [...f.showWhen.is]], [null, 'noEquip', 'Vehicle has no equipment', ['unchecked']]);
});

test('transitions skip repeated rows, use the layout\'s own state, and keep views apart', () => {
  let seq = 0;
  const e = (x) => ({ session: 's', seq: ++seq, t: '2026-10-06T10:00:00Z', carrier: 'progressive', ...x });
  const row = { q: '2C1A', kind: 'select', label: 'Rental per vehicle', options: ['None', '$40'] };
  const corrected = { state: 'GA', businessClass: 'Expediter', vehicleTypes: ['Van'] };
  const events = [
    e({ type: 'intake_loaded', state: 'FL' }),
    e(layoutEvent('s', [hazmat('No'), row, row], { reason: 'arrived', view: 't1' })),
    // Another tab on the same page: its own sequence.
    e(layoutEvent('s', [hazmat('No')], { reason: 'arrived', view: 't2' })),
    e({ type: 'field_change', view: 't1', page: 'Operations', label: 'Hauls hazmat?', kind: 'radio', from: 'No', to: 'Yes', by: 'agent' }),
    // One of the two rows goes away: rows can't be matched, so that is not reported.
    e(layoutEvent('s', [hazmat('Yes'), placards, row], { reason: 'appeared+changed', view: 't1', context: corrected })),
  ];
  const list = layoutTransitions(events);
  assert.deepEqual(list.map((t) => [t.appeared, t.removed, t.options, t.state]), [[['Placards carried'], [], [], 'GA']]);
});

test('picks differing only in case are one answer, so they can\'t split the two sides', () => {
  const contradicted = inferShowWhen([snap(hazmat('Yes'), placards), snap(hazmat('Yes'), placards), snap(hazmat('YES')), snap(hazmat('YES'))]);
  assert.equal(contradicted.get('2A2'), null);
  const agreed = inferShowWhen([snap(hazmat('Yes'), placards), snap(hazmat('YES'), placards), snap(hazmat('No')), snap(hazmat('no'))]);
  assert.deepEqual([...agreed.get('2A2').is], ['Yes']);
  assert.deepEqual([...agreed.get('2A2').unseen], ['Unsure']);
});

test('a trigger known only by its caption keeps its kind', () => {
  const same = (selected) => ({ kind: 'checkbox', label: 'Same as mailing', selected });
  const events = [layoutEvent('a', [same('unchecked'), placards]), layoutEvent('a', [same('checked')]),
    layoutEvent('b', [same('unchecked'), placards]), layoutEvent('b', [same('checked')])];
  const f = buildLayouts(events)[0].layout.pages.Operations.fields.find((x) => x.q === '2A2');
  assert.deepEqual([f.showWhen.q, f.showWhen.kind, f.showWhen.caption], [null, 'checkbox', 'Same as mailing']);
});

test('a question that shows only for some coverages is not pinned on an answer that went with them', () => {
  const cargo = { state: 'FL', businessClass: 'Expediter', vehicleTypes: ['Van'], coverages: ['autoLiability', 'cargo'] };
  const noCargo = { ...cargo, coverages: ['autoLiability'] };
  const cargoLimit = { q: '3C1', kind: 'select', label: 'Cargo limit', options: ['$100k'] };
  const events = [
    layoutEvent('a', [hazmat('Yes'), cargoLimit], { context: cargo }), layoutEvent('b', [hazmat('Yes'), cargoLimit], { context: cargo }),
    layoutEvent('c', [hazmat('No')], { context: noCargo }), layoutEvent('d', [hazmat('No')], { context: noCargo }),
  ];
  const f = buildLayouts(events)[0].layout.pages.Operations.fields.find((x) => x.q === '3C1');
  assert.deepEqual([f.showWhen, f.condition], [undefined, 'unknown']);
  // Within one coverage request the same pattern is a condition, and groups that agree add up.
  const within = buildLayouts([
    layoutEvent('a', [hazmat('Yes'), placards], { context: cargo }), layoutEvent('a', [hazmat('No')], { context: cargo }),
    layoutEvent('b', [hazmat('Yes'), placards], { context: cargo }), layoutEvent('b', [hazmat('No')], { context: cargo }),
    layoutEvent('c', [hazmat('Yes'), placards], { context: noCargo }), layoutEvent('c', [hazmat('No')], { context: noCargo }),
    layoutEvent('d', [hazmat('Yes'), placards], { context: noCargo }), layoutEvent('d', [hazmat('No')], { context: noCargo }),
  ])[0].layout.pages.Operations.fields.find((x) => x.q === '2A2');
  assert.deepEqual([[...within.showWhen.is], within.showWhen.seen], [['Yes'], { shown: 4, hidden: 4 }]);
});

test('transitions ignore option spelling drift and break on a layout that could not be read', () => {
  let seq = 0;
  const e = (x) => ({ session: 's', seq: ++seq, t: '2026-10-06T10:00:00Z', carrier: 'progressive', ...x });
  const change = () => e({ type: 'field_change', page: 'Operations', label: 'Hauls hazmat?', kind: 'radio', from: 'No', to: 'Yes', by: 'agent' });
  const spelled = (options) => ({ ...hazmat('No'), options });
  const drift = layoutTransitions([
    e(layoutEvent('s', [spelled(['Yes', 'No'])], { reason: 'arrived' })), change(),
    e(layoutEvent('s', [spelled(['YES ', 'no'])], { reason: 'changed' })),
  ]);
  assert.deepEqual(drift, [], 'the same options, spelled differently');
  const broken = layoutTransitions([
    e(layoutEvent('s', [hazmat('No')], { reason: 'arrived' })), change(),
    e({ type: 'layout_error', page: 'Operations', reason: 'changed', error: 'page busy' }),
    e(layoutEvent('s', [hazmat('Yes'), placards], { reason: 'changed' })),
  ]);
  assert.deepEqual(broken, [], 'the page between them was never seen');
});

test('a coverage group where the question stays while its trigger changes rules the condition out', () => {
  const cargo = { state: 'FL', businessClass: 'Expediter', vehicleTypes: ['Van'], coverages: ['cargo'] };
  const noCargo = { ...cargo, coverages: [] };
  const events = [
    layoutEvent('a', [hazmat('Yes'), placards], { context: cargo }), layoutEvent('a', [hazmat('No')], { context: cargo }),
    layoutEvent('b', [hazmat('Yes'), placards], { context: cargo }), layoutEvent('b', [hazmat('No')], { context: cargo }),
    // Without cargo the question is always there, whatever the answer.
    layoutEvent('c', [hazmat('Yes'), placards], { context: noCargo }), layoutEvent('c', [hazmat('No'), placards], { context: noCargo }),
  ];
  const f = buildLayouts(events)[0].layout.pages.Operations.fields.find((x) => x.q === '2A2');
  assert.deepEqual([f.showWhen, f.condition], [undefined, 'unknown']);
});

// GEICO names a question Id_<data-model name>_<render number> and renumbers it on every redraw. The
// FL captures of 2026-10-20 were recorded before the kit sent `ref` for them: each layout named a
// question by another number, so no condition could ever be seen across two layouts.
const FIELD_KEY = fs.readFileSync(new URL('../src/content/field-key.js', import.meta.url), 'utf8');
const kitContext = {};
vm.runInNewContext(FIELD_KEY, kitContext, { filename: 'src/content/field-key.js' });
const { dataName } = kitContext.__raterFieldKey;

test('a GEICO question recorded without its name is known by the name its id carries, as the kit names it', () => {
  const samples = [
    { kind: 'text', id: 'Id_GiveInitialZipCode_54827', name: 'Id_GiveInitialZipCode_54827' },
    // A radio option's input: the name has no option digit, the id has it and -shadow.
    { kind: 'radio', id: 'Id_GiveHasFilingsYesNo_148170-shadow', name: 'Id_GiveHasFilingsYesNo_14817' },
    { kind: 'radio', id: 'Id_GiveHasFilingsYesNo_148171-shadow' },
    { kind: 'text', id: 'Id_GiveVinPreQuote_31337', name: 'Id_GiveVinPreQuote_31337maskedField' },
    // The boxes of a checkbox group share one name; the box is in the id.
    { kind: 'checkbox', id: 'checkbox-Id_AddFilings_20517-MCS90', name: 'Id_AddFilings_20517' },
    { kind: 'checkbox', id: 'checkbox-Id_AddFilings_20517-StateFiling', name: 'Id_AddFilings_20517' },
    // A coverage list (a UUID has dashes) and the portal's own controls have no data-model name.
    { kind: 'select', id: 'Id_0f8e2a7c-1b3d-4e5f-9a6b-7c8d9e0f1a2b_412_COMP' },
    { kind: 'select', id: 'Id_a1b2c3d4-1b3d-4e5f-9a6b-7c8d9e0f1a2b_412' },
    { kind: 'checkbox', id: 'darkModeSwitch-button-switch-checkbox', name: 'darkModeSwitch-button-switch-checkbox' },
    { kind: 'text', id: 'Id_GiveInitialZipCode', name: 'Id_GiveInitialZipCode' },
  ];
  for (const f of samples) {
    const name = dataName({ id: f.id, name: f.name });
    assert.equal(fieldId(f), name ? `ref:${name}` : `#${f.id}`, f.id);
  }
  assert.deepEqual(samples.map((f) => fieldId(f)).slice(0, 6),
    ['ref:GiveInitialZipCode', 'ref:GiveHasFilingsYesNo', 'ref:GiveHasFilingsYesNo', 'ref:GiveVinPreQuote', 'ref:AddFilings.MCS90', 'ref:AddFilings.StateFiling']);
  // As a layout the kit records now (its name in `ref`), whatever the number.
  assert.equal(fieldId({ kind: 'radio', id: 'Id_GiveFilingType_521330-shadow', name: 'Id_GiveFilingType_52133' }), fieldId({ kind: 'radio', ref: 'GiveFilingType', id: 'Id_GiveFilingType_10-shadow' }));
  // A Duck Creek question id still comes first.
  assert.equal(fieldId({ q: '2A1', id: 'Id_GiveHasFilingsYesNo_14817' }), '2A1');
});

test('a GEICO follow-up\'s condition is seen across layouts that numbered its questions differently', () => {
  const filings = (n, selected) => ({ kind: 'radio', id: `Id_GiveHasFilingsYesNo_${n}0-shadow`, name: `Id_GiveHasFilingsYesNo_${n}`,
    label: 'Does the business need filings?', options: ['Yes', 'No'], selected });
  const filingType = (n) => ({ kind: 'radio', id: `Id_GiveFilingType_${n}0-shadow`, name: `Id_GiveFilingType_${n}`, label: 'Filing type', options: ['Federal', 'State'] });
  const when = inferShowWhen([snap(filings(101, 'Yes'), filingType(102)), snap(filings(203, 'Yes'), filingType(204)), snap(filings(305, 'No')), snap(filings(407, 'No'))]);
  const c = when.get('ref:GiveFilingType');
  assert.deepEqual([c.trigger, [...c.is], c.shown, c.hidden], ['ref:GiveHasFilingsYesNo', ['Yes'], 2, 2]);
});
