import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEvents, quoteSessions } from '../scripts/lib/events.mjs';
import { learn, finalAnswers, questionOf } from '../scripts/lib/learn.mjs';
import { fieldStatus } from '../scripts/lib/coverage.mjs';
import { buildPlan } from '../src/plan.js';
import { buildLayouts, layoutKey } from '../scripts/lib/layouts.mjs';
import { CARRIERS } from '../src/carriers.js';

// A synthetic week: `n` quotes, each an intake plus what autofill and the agent did.
function week(n, { state = (i) => (i % 2 ? 'MD' : 'VA') } = {}) {
  const events = [];
  let t = Date.parse('2026-10-05T12:00:00Z');
  const e = (session, x) => events.push({ id: crypto.randomUUID(), t: new Date(t += 1000).toISOString(), session, carrier: 'progressive', ...x });
  for (let i = 0; i < n; i++) {
    const s = `s${i}`;
    const st = state(i);
    e(s, { type: 'intake_loaded', carrier: undefined, state: st, businessClass: 'Expediter', vehicleTypes: ['Van'] });
    // Unmapped question, always "No".
    e(s, { type: 'field_change', page: 'CoveragesRates', q: '9A01', label: 'Trailer interchange?', kind: 'radio', by: 'agent', to: 'No' });
    // Unmapped question whose answer depends on the state.
    e(s, { type: 'field_change', page: 'MoreAboutBusiness', q: '9A02', label: 'Garaging territory', kind: 'select', by: 'agent', to: st === 'MD' ? 'Zone 1' : 'Zone 7' });
    // Unmapped text box: agents type the garaging county.
    e(s, { type: 'field_change', page: 'AddVehicle', q: '9A03', label: 'Garaging county', kind: 'text', by: 'agent', change: 'entered', matchesIntake: ['garaging.city'] });
    // Mapped rule that agents correct in 3 of every 5 quotes.
    e(s, { type: 'fill_field', page: 'AddVehicle', q: '2B9D', label: 'Farthest distance', controlKind: 'select', result: 'filled', path: 'progressive.q2B9D', shown: 'More than 500 miles' });
    if (i % 5 < 3) e(s, { type: 'field_change', page: 'AddVehicle', q: '2B9D', label: 'Farthest distance', kind: 'select', by: 'agent', autofilled: 'progressive.q2B9D', vsAutofill: 'different', from: 'More than 500 miles', to: '500 miles' });
    // Mapped rule agents accept.
    e(s, { type: 'fill_field', page: 'AddVehicle', q: '2C05', label: 'Use', controlKind: 'radio', result: 'filled', path: 'progressive.q2C05', shown: 'Business Only' });
    // Layout recorded after the fill; the follow-up question shows in only some quotes.
    e(s, { type: 'page_layout', page: 'AddVehicle', context: { state: st, businessClass: 'Expediter', vehicleTypes: ['Van'], trailers: false },
      fields: [{ q: '2B9D', kind: 'select', label: 'Farthest distance', options: ['50 miles', 'More than 500 miles'], mapped: 'progressive.q2B9D' },
        ...(i % 2 ? [{ q: '2C1A', kind: 'radio', label: 'For hire?', options: ['Yes', 'No'] }] : [])] });
  }
  return events;
}

// A quote's answer to the question with this id (keys are names and texts, not ids).
const byQ = (perSession, q) => [...perSession.values()].find((a) => a.q === q);

test('final answers track who answered each question', () => {
  const answers = finalAnswers(week(1));
  const s0 = answers.get('s0');
  assert.equal(byQ(s0, '9A01').value, 'No');
  assert.equal(byQ(s0, '9A01').source, 'agent');
  const dist = byQ(s0, '2B9D');
  assert.equal(dist.corrected, true);
  assert.equal(dist.correction, '"More than 500 miles" → "500 miles"');
  assert.equal(byQ(s0, '2C05').source, 'autofill');
});

test('learning suggests standard answers, per-state answers, mappings and reviews', () => {
  const { quotes, suggestions } = learn(week(10), { carriers: CARRIERS, minIntakes: 5 });
  assert.equal(quotes, 10);
  const std = suggestions.standard.find((s) => s.q === '9A01');
  assert.equal(std.answer, 'No');
  assert.equal(std.share, 1);
  assert.match(std.rule, /^\{ page: 'CoveragesRates', ask: 'Trailer interchange\?'.*kind: 'bool', value: \(\) => false/);
  assert.doesNotMatch(std.rule, /q: /, 'never by the question id');
  const byState = suggestions.byState.find((s) => s.q === '9A02');
  assert.deepEqual(byState.perState.map((p) => `${p.state}:${p.value}`).sort(), ['MD:Zone 1', 'VA:Zone 7']);
  const map = suggestions.mapping.find((s) => s.q === '9A03');
  assert.equal(map.path, 'garaging.city');
  assert.equal(map.rule, "{ page: 'AddVehicle', ask: 'Garaging county', path: 'garaging.city' },");
  const review = suggestions.review.find((s) => s.q === '2B9D');
  assert.equal(review.corrected, 6);
  assert.equal(review.filled, 10);
  assert.ok(!suggestions.review.some((s) => s.q === '2C05'), 'accepted rules are not flagged');
  assert.ok(!suggestions.standard.some((s) => s.q === '2B9D'), 'mapped questions are not re-suggested');
});

test('too few quotes: no suggestions', () => {
  const { suggestions } = learn(week(3), { carriers: CARRIERS, minIntakes: 5 });
  assert.equal(Object.values(suggestions).flat().length, 0);
});

test('layouts are merged per state and product, with follow-up questions marked', () => {
  const layouts = buildLayouts(week(4));
  assert.deepEqual(layouts.map((l) => l.key).sort(), ['progressive_MD_expediter_van', 'progressive_VA_expediter_van']);
  const md = layouts.find((l) => l.key === 'progressive_MD_expediter_van').layout;
  const fields = md.pages.AddVehicle.fields;
  assert.equal(fields.find((f) => f.q === '2B9D').kind, 'combo');
  assert.equal(md.generated.quotes, 2);
  assert.equal(layoutKey('progressive', { state: 'TX', businessClass: 'Hot Shot', vehicleTypes: ['Pickup Truck'], trailers: true }), 'progressive_TX_hot-shot_pickup-truck_trailers');
  // In the mixed set below 2C1A appears in some snapshots only.
  const mixed = buildLayouts(week(4, { state: () => 'MD' }))[0].layout.pages.AddVehicle.fields;
  assert.equal(mixed.find((f) => f.q === '2C1A').cond, true);
  assert.equal(mixed.find((f) => f.q === '2B9D').cond, undefined);
});

test('events load from server folders and exports, without duplicates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rater-events-'));
  const events = week(2);
  fs.mkdirSync(path.join(dir, 'events'));
  fs.writeFileSync(path.join(dir, 'events', '2026-10-05.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'));
  const exportFile = path.join(dir, 'export.json');
  fs.writeFileSync(exportFile, JSON.stringify({ kind: 'usage-log', agent: 'AYAZ', events: events.slice(0, 3).map((e) => ({ ...e, agent: null, page: e.page ? `${e.page}-Reload` : e.page })) }));
  // The local test page's events, stored before the server refused them: left out.
  fs.writeFileSync(path.join(dir, 'events', '2026-10-02.jsonl'), JSON.stringify({ id: 'local-test', t: '2026-10-02T15:00:00Z', session: 'x', carrier: 'test', type: 'fill_run' }));
  const loaded = loadEvents([dir, exportFile]);
  assert.equal(loaded.length, events.length);
  assert.ok(loaded.every((e) => !String(e.page ?? '').endsWith('-Reload')));
  assert.ok(!loaded.some((e) => e.carrier === 'test'));
});

test('the steps of a one-address application are pages of their own in built layouts', () => {
  const event = (step, label) => ({ type: 'page_layout', carrier: 'amwins', page: '/application/businessauto', step, session: 's', t: '2026-10-06T10:00:00Z',
    context: { state: 'FL', businessClass: 'Expediter', vehicleTypes: ['Van'] }, fields: [{ kind: 'text', label }] });
  const pages = buildLayouts([event('Vehicles', 'VIN'), event('Coverages', 'Medical payment'), event('Vehicles', 'VIN')])[0].layout.pages;
  assert.deepEqual(Object.keys(pages), ['/application/businessauto › Vehicles', '/application/businessauto › Coverages']);
  assert.equal(pages['/application/businessauto › Vehicles'].fields[0].cond, undefined, 'not a follow-up: on every layout of its step');
});

// Codex on PR #43: Progressive renumbered its questions on 2026-10-07. The same question recorded
// before (267), after (29E) and with its data-model name (0.9.9) is one field of the page; two
// questions reading the same ("City" of the business and of the owner) stay two.
test('layouts: one question across the renumbering is one field; repeated texts stay apart', () => {
  const context = { state: 'FL', businessClass: 'Expediter', vehicleTypes: ['Van'], coverages: [] };
  const layout = (t, fields) => ({ type: 'page_layout', t, session: t, carrier: 'progressive', page: 'BusinessOwnerInfo', context, fields });
  const trucker = (q, ref) => ({ q, ref, kind: 'select', label: 'Type of Trucker', options: ['Other For-Hire Trucking'] });
  const cities = (a, b) => [{ q: a, kind: 'text', label: 'City' }, { q: b, kind: 'text', label: 'City' }];
  const pages = buildLayouts([
    layout('2026-10-05T10:00:00Z', [trucker('267'), ...cities('286', '2B0')]),
    layout('2026-10-07T08:00:00Z', [trucker('29E'), ...cities('2BD', '2E7')]),
    layout('2026-10-07T12:00:00Z', [trucker('29E', 'AccountInput.SpecificTruckHaulContractType')]),
  ])[0].layout.pages;
  const fields = pages.BusinessOwnerInfo.fields;
  const truckers = fields.filter((f) => f.caption === 'Type of Trucker');
  assert.equal(truckers.length, 1);
  assert.equal(truckers[0].ref, 'AccountInput.SpecificTruckHaulContractType');
  assert.equal(fields.filter((f) => f.caption === 'City').length, 2);
});

// Codex on PR #43: a follow-up seen once on each side of the data-model names (0.9.9) and of the
// renumbering still has its two layouts each way: one trigger, one condition.
test('layouts: a condition counts its layouts from before and after names and numbers changed', () => {
  const context = { state: 'FL', businessClass: 'Expediter', vehicleTypes: ['Van'], coverages: [] };
  const layout = (t, fields) => ({ type: 'page_layout', t, session: t, carrier: 'progressive', page: 'MoreAboutBusiness', context, fields });
  const hazmat = (q, ref, selected) => ({ q, ref, kind: 'radio', label: 'Does the customer haul hazardous materials?', options: ['Yes', 'No'], selected });
  const hazClass = (q, ref) => ({ q, ref, kind: 'text', label: 'Hazardous material class' });
  const fields = buildLayouts([
    layout('2026-10-05T10:00:00Z', [hazmat('100', undefined, 'Yes'), hazClass('101')]),
    layout('2026-10-05T11:00:00Z', [hazmat('100', undefined, 'No')]),
    layout('2026-10-07T12:00:00Z', [hazmat('1A0', 'X.Hazmat', 'Yes'), hazClass('1A1', 'X.HazmatClass')]),
    layout('2026-10-07T13:00:00Z', [hazmat('1A0', 'X.Hazmat', 'No')]),
  ])[0].layout.pages.MoreAboutBusiness.fields;
  assert.equal(fields.length, 2);
  const follow = fields.find((f) => f.caption === 'Hazardous material class');
  assert.equal(follow.condition, undefined, 'not "condition unknown"');
  assert.deepEqual(follow.showWhen.is, ['Yes']);
  assert.equal(follow.showWhen.q, '1A0', 'the trigger by its current number');
});

// Codex on PR #43: two questions reading the same ("City" of the business and of the owner), the
// first missing from a layout: the second keeps its own identity.
test('layouts: a repeated text keeps its identity when the earlier one is missing', () => {
  const context = { state: 'FL', businessClass: 'Expediter', vehicleTypes: ['Van'], coverages: [] };
  const layout = (t, fields) => ({ type: 'page_layout', t, session: t, carrier: 'progressive', page: 'BusinessOwnerInfo', context, fields });
  const text = (q, label) => ({ q, kind: 'text', label });
  const fields = buildLayouts([
    layout('2026-10-05T10:00:00Z', [text('27E', 'Street Address'), text('286', 'City'), text('2A9', 'Home Address'), text('2B0', 'City')]),
    layout('2026-10-05T11:00:00Z', [text('2A9', 'Home Address'), text('2B0', 'City')]),
  ])[0].layout.pages.BusinessOwnerInfo.fields;
  const cities = fields.filter((f) => f.caption === 'City');
  assert.equal(cities.length, 2);
  assert.deepEqual(cities.map((f) => [f.q, !!f.cond]).sort(), [['286', true], ['2B0', false]], "the owner's City is on both layouts; the business's on one");
});

// Codex on PR #43: the two "City" questions recorded before data-model names join their named
// fields, each by its place (after its anchor), not left as two more fields.
test('layouts: a repeated text recorded before names joins the named field in its place', () => {
  const context = { state: 'FL', businessClass: 'Expediter', vehicleTypes: ['Van'], coverages: [] };
  const layout = (t, fields) => ({ type: 'page_layout', t, session: t, carrier: 'progressive', page: 'BusinessOwnerInfo', context, fields });
  const text = (q, label, ref) => ({ q, ref, kind: 'text', label });
  const fields = buildLayouts([
    layout('2026-10-05T10:00:00Z', [text('27E', 'Street Address'), text('286', 'City'), text('2A9', 'Home Address'), text('2B0', 'City')]),
    layout('2026-10-08T10:00:00Z', [text('2B5', 'Street Address', 'Biz.Street'), text('2BD', 'City', 'Biz.City'), text('2E0', 'Home Address', 'Home.Street'), text('2E7', 'City', 'Home.City')]),
  ])[0].layout.pages.BusinessOwnerInfo.fields;
  assert.equal(fields.length, 4);
  assert.deepEqual(fields.filter((f) => f.caption === 'City').map((f) => f.ref).sort(), ['Biz.City', 'Home.City']);
  assert.ok(fields.every((f) => !f.cond), 'each on both layouts');
});

// Progressive's Rates shows a row of the same questions for every vehicle and trailer, all with the
// same data-model name: each row is a field of its own, by its Duck Creek row, and a quote with
// one vehicle lines up with the first row of a quote with two and a trailer, also renumbered.
test('layouts: rows of a question asked per vehicle or trailer stay apart, by their row', () => {
  const context = { state: 'TN', businessClass: 'Freight Hauler', vehicleTypes: ['Semi Truck'], trailers: true, coverages: [] };
  const layout = (t, fields) => ({ type: 'page_layout', t, session: t, carrier: 'progressive', page: 'CoveragesRates', context, fields });
  const bipd = (q) => ({ q, ref: 'LineInput.RBIPDLimit', kind: 'select', label: 'Bodily Injury and Property Damage Liability', options: ['$1M CSL'], row: '8_1' });
  const unit = (q, row, label, more = []) => [
    { q, ref: 'ComprehensiveInput.Deductible', kind: 'select', label, options: ['$1,000 Deductible'], row },
    { q: (parseInt(q, 16) + 0x1d).toString(16).toUpperCase(), ref: 'RiskInput.PAValueIndicator', kind: 'checkbox', label: `${/Wilson/.test(label) ? 'Trailer' : 'Vehicle'} has no equipment`, row },
    ...more,
  ];
  const fields = buildLayouts([
    layout('2026-10-08T10:00:00Z', [bipd('1DD7'), ...unit('200D', '8_1', '2013 PETERBILT 388')]),
    layout('2026-10-08T11:00:00Z', [bipd('1DD7'), ...unit('200D', '8_1', '2016 FREIGHTLINER CASCADIA 125'), ...unit('200D', '8_2', '2018 KENWORTH T680'), ...unit('200D', '8_3', '2019 Wilson')]),
    layout('2026-10-09T10:00:00Z', [bipd('1E20'), ...unit('2056', '8_1', '2013 PETERBILT 388'), ...unit('2056', '8_2', '2019 Wilson')]),
  ])[0].layout.pages.CoveragesRates.fields;
  assert.equal(fields.filter((f) => f.ref === 'LineInput.RBIPDLimit').length, 1, 'a question asked once is one field');
  const comp = fields.filter((f) => f.ref === 'ComprehensiveInput.Deductible');
  assert.deepEqual(comp.map((f) => [f.row, f.caption, !!f.cond]), [['8_1', '2013 PETERBILT 388', false], ['8_2', '2019 Wilson', true], ['8_3', '2019 Wilson', true]]);
  assert.equal(comp[0].q, '2056', 'the row by its latest number');
  assert.deepEqual(fields.filter((f) => f.ref === 'RiskInput.PAValueIndicator').map((f) => [f.row, f.caption]),
    [['8_1', 'Vehicle has no equipment'], ['8_2', 'Trailer has no equipment'], ['8_3', 'Trailer has no equipment']]);
});

// Layouts recorded with data-model names but before rows (0.9.9 builds before PR #43's rows): a
// row joins the field first seen in its place (its order among that name's fields); a page with
// no rows recorded keeps one field per name, as before.
test('layouts: per-vehicle rows recorded before rows join the row in their place', () => {
  const context = { state: 'FL', businessClass: 'Expediter', vehicleTypes: ['Van'], coverages: [] };
  const layout = (t, fields) => ({ type: 'page_layout', t, session: t, carrier: 'progressive', page: 'CoveragesRates', context, fields });
  const comp = (label, row) => ({ q: '200D', ref: 'ComprehensiveInput.Deductible', kind: 'select', label, options: ['$1,000 Deductible'], row });
  const before = [comp('2025 RAM PROMASTER 2500'), comp('2019 MERCEDES-BENZ SPRINTER')];
  const fields = (events) => buildLayouts(events)[0].layout.pages.CoveragesRates.fields;
  const joined = fields([layout('2026-10-07T12:00:00Z', before), layout('2026-10-08T10:00:00Z', [comp('2021 FORD TRANSIT', '8_1'), comp('2020 RAM PROMASTER 3500', '8_2')])]);
  assert.deepEqual(joined.map((f) => [f.row, !!f.cond]), [['8_1', false], ['8_2', false]]);
  const unrowed = fields([layout('2026-10-07T12:00:00Z', before)]);
  assert.equal(unrowed.length, 1);
  assert.equal(unrowed[0].row, undefined);
});

// Audit 2026-10-08: the learner grouped Progressive questions by their id, which Progressive
// reassigned on 2026-10-07; its rules named the id, which the fill engine no longer finds.
const rule = (text) => new Function(`return ${text.replace(/,$/, '')}`)();
const at = (i) => new Date(Date.parse('2026-10-05T12:00:00Z') + i * 1000).toISOString();

test('learning: one question across the renumbering is one question, and its rule is found by its name', () => {
  const events = [];
  for (let i = 0; i < 6; i++) {
    const s = `r${i}`;
    const before = i < 3;
    // Before names: id 100; after the renumbering: id 2F0, with its data-model name.
    const q = before ? '100' : '2F0';
    events.push({ id: `l${i}`, t: at(i * 10), session: s, carrier: 'progressive', type: 'page_layout', page: 'MoreAboutBusiness', context: {},
      fields: [{ q, ref: before ? null : 'RiskInput.HazmatIndicator', kind: 'radio', label: 'Does the customer haul hazardous materials?', options: ['Yes', 'No'] }] });
    events.push({ id: `c${i}`, t: at(i * 10 + 1), session: s, carrier: 'progressive', type: 'field_change', page: 'MoreAboutBusiness', q,
      key: before ? q : 'ref:RiskInput.HazmatIndicator', label: 'Does the customer haul hazardous materials?', kind: 'radio', by: 'agent', to: 'No' });
  }
  const { suggestions } = learn(events, { carriers: [{ id: 'progressive', rules: [], useGenericRules: false }], minIntakes: 5 });
  assert.equal(suggestions.standard.length, 1);
  const [std] = suggestions.standard;
  assert.equal(std.intakes, 6, 'the quotes on both sides of the renumbering count together');
  assert.equal(std.field, 'RiskInput.HazmatIndicator');
  const suggested = rule(std.rule);
  assert.equal(suggested.field, 'RiskInput.HazmatIndicator');
  assert.equal(suggested.q, undefined);
  // The suggested rule claims the field, as the fill engine would pair them.
  const carrier = { id: 'progressive', rules: [suggested], useGenericRules: false };
  assert.equal(fieldStatus({ ref: 'RiskInput.HazmatIndicator', caption: 'Does the customer haul hazardous materials?', kind: 'radio' }, carrier, 'MoreAboutBusiness').status, 'filled');
  // With that rule in place, it's mapped: not suggested again.
  assert.equal(learn(events, { carriers: [carrier], minIntakes: 5 }).suggestions.standard.length, 0);
});

test('learning: two questions reading the same stay apart, and so do one quote\'s vehicles', () => {
  const events = [];
  const boi = [{ q: '27E', kind: 'text', label: 'Street Address' }, { q: '280', kind: 'radio', label: 'City' }, { q: '2A9', kind: 'text', label: 'Home Address' }, { q: '2B0', kind: 'radio', label: 'City' }];
  for (let i = 0; i < 5; i++) {
    const s = `c${i}`;
    events.push({ id: `l${i}`, t: at(i * 10), session: s, carrier: 'progressive', type: 'page_layout', page: 'BusinessOwnerInfo', context: {}, fields: boi });
    events.push({ id: `a${i}`, t: at(i * 10 + 1), session: s, carrier: 'progressive', type: 'field_change', page: 'BusinessOwnerInfo', q: '280', label: 'City', kind: 'radio', by: 'agent', to: 'Business city' });
    events.push({ id: `b${i}`, t: at(i * 10 + 2), session: s, carrier: 'progressive', type: 'field_change', page: 'BusinessOwnerInfo', q: '2B0', label: 'City', kind: 'radio', by: 'agent', to: 'Home city' });
    // Two vehicles of the quote, each its own answer.
    for (const [v, to] of [['t1:v0', 'Yes'], ['t1:v1', 'No']]) {
      events.push({ id: `v${i}${v}`, t: at(i * 10 + 3), session: s, carrier: 'progressive', type: 'field_change', page: 'AddVehicle', q: '3C0', key: 'ref:RiskInput.Refrigerated', view: v, label: 'Refrigerated?', kind: 'radio', by: 'agent', to });
    }
  }
  const s0 = finalAnswers(events).get('c0');
  assert.deepEqual([byQ(s0, '280').value, byQ(s0, '2B0').value], ['Business city', 'Home city']);
  assert.deepEqual([...s0.values()].filter((a) => a.ref === 'RiskInput.Refrigerated').map((a) => a.value), ['Yes', 'No']);
  const { suggestions } = learn(events, { carriers: [{ id: 'progressive', rules: [], useGenericRules: false }], minIntakes: 5 });
  assert.deepEqual(suggestions.standard.map((x) => x.answer).sort(), ['Business city', 'Home city'], 'each City its own; the vehicles disagree');
});

// Fable on this change: before names, Rates drew one id once per vehicle; each row is that
// question's, in its own unit, whatever the quote's vehicle count.
test('learning: Rates rows recorded before names are one question, each vehicle its own answer', () => {
  const events = [];
  const row = (q, r) => ({ q, kind: 'select', label: 'Comprehensive deductible', row: null, options: ['$500', '$1,000'], _r: r });
  for (const [s, rows] of [['three', 3], ['one', 1]]) {
    events.push({ id: `l${s}`, t: at(rows), session: s, carrier: 'progressive', type: 'page_layout', page: 'CoveragesRates', context: {},
      fields: [{ q: '1D97', kind: 'select', label: 'Bodily Injury and Property Damage Liability', options: ['$1M'] }, ...Array.from({ length: rows }, (_, r) => row('1FF2', r))] });
    for (let r = 1; r <= rows; r++) {
      events.push({ id: `c${s}${r}`, t: at(10 + r), session: s, carrier: 'progressive', type: 'field_change', page: 'CoveragesRates', q: '1FF2',
        key: r === 1 ? '1FF2' : `1FF2@${r}`, label: 'Comprehensive deductible', kind: 'select', by: 'agent', to: r === 2 ? '$500' : '$1,000' });
    }
  }
  const answers = finalAnswers(events);
  const rowsOf = (s) => [...answers.get(s).values()].filter((a) => a.q === '1FF2');
  assert.equal(new Set([...rowsOf('three'), ...rowsOf('one')].map((a) => a.question)).size, 1, 'one question in both quotes');
  assert.deepEqual(rowsOf('three').map((a) => a.value), ['$1,000', '$500', '$1,000'], 'each vehicle its own answer');
});

test('learning: a suggested rule takes the question as the page words it, not the recorder\'s guess', () => {
  const events = [];
  for (let i = 0; i < 5; i++) {
    events.push({ id: `l${i}`, t: at(i * 10), session: `w${i}`, carrier: 'progressive', type: 'page_layout', page: 'MoreAboutBusiness', context: {},
      fields: [{ q: '3A1', kind: 'radio', label: 'Does the customer pull double trailers?', options: ['Yes', 'No'] }] });
    events.push({ id: `c${i}`, t: at(i * 10 + 1), session: `w${i}`, carrier: 'progressive', type: 'field_change', page: 'MoreAboutBusiness', q: '3A1',
      label: 'Yes No', kind: 'radio', by: 'agent', to: 'No' });
  }
  const [std] = learn(events, { carriers: [{ id: 'progressive', rules: [], useGenericRules: false }], minIntakes: 5 }).suggestions.standard;
  assert.equal(std.label, 'Does the customer pull double trailers?');
  assert.equal(rule(std.rule).ask, 'Does the customer pull double trailers?');
});

// Real data 2026-10-08: UIM filled on More About Business, corrected on Rates (the same question).
test('learning: a correction counts when the fill was on another page showing the question', () => {
  const events = [
    { id: 'f', t: at(1), session: 'x', carrier: 'progressive', type: 'fill_field', page: 'MoreAboutBusiness', q: '1DD8', label: 'Underinsured Motorist Bodily Injury', controlKind: 'select', result: 'filled', path: 'coverage.uimbi', shown: '$1M' },
    { id: 'c', t: at(2), session: 'x', carrier: 'progressive', type: 'field_change', page: 'CoveragesRates', q: '1DD8', key: 'ref:LineInput.UIMBILimit', label: 'Underinsured Motorist Bodily Injury', kind: 'select', by: 'agent', autofilled: 'coverage.uimbi', vsAutofill: 'different', from: '$1M', to: '$500K' },
  ];
  const rates = [...finalAnswers(events).get('x').values()].find((a) => a.page === 'CoveragesRates');
  assert.equal(rates.corrected, true);
  assert.equal(rates.autofilled, true);
});

// Audit 2026-10-08: the sample PDF was quoted 131 times; one PDF's quotes count once.
test('learning: quotes of one intake PDF count once', () => {
  const events = [];
  for (let i = 0; i < 6; i++) {
    const s = `p${i}`;
    events.push({ id: `i${i}`, t: at(i * 10), session: s, type: 'intake_loaded', intakeId: i < 5 ? 'same-pdf' : 'other-pdf' });
    events.push({ id: `c${i}`, t: at(i * 10 + 1), session: s, carrier: 'progressive', type: 'field_change', page: 'MoreAboutBusiness', q: '3B2',
      label: 'Does the customer tow vehicles?', kind: 'radio', by: 'agent', to: 'No' });
  }
  const carriers = [{ id: 'progressive', rules: [], useGenericRules: false }];
  const r = learn(events, { carriers, minIntakes: 5 });
  assert.equal(r.quotes, 6);
  assert.equal(r.intakes, 2);
  assert.equal(r.suggestions.standard.length, 0, 'six quotes, two PDFs');
  assert.equal(learn(events, { carriers, minIntakes: 2 }).suggestions.standard[0].intakes, 2);
});

// Codex on PR #49: a log without the intake_loaded events still knows each quote's PDF, and a
// suggestion reports the support it qualified on.
test('learning: a quote\'s PDF comes from any of its events, and a suggestion counts what it rests on', () => {
  const events = [];
  for (let i = 0; i < 6; i++) {
    events.push({ id: `c${i}`, t: at(i), session: `p${i}`, intakeId: i < 5 ? 'same-pdf' : 'other-pdf', carrier: 'progressive', type: 'field_change', page: 'MoreAboutBusiness',
      q: '3B2', label: 'Does the customer tow vehicles?', kind: 'radio', by: 'agent', to: 'No' });
  }
  const carriers = [{ id: 'progressive', rules: [], useGenericRules: false }];
  assert.equal(learn(events, { carriers, minIntakes: 5 }).suggestions.standard.length, 0, 'no intake_loaded: still two PDFs');
  // A mapped question autofilled in two PDFs' quotes, typed by hand in four more: the review rests on two.
  const mapped = [];
  for (let i = 0; i < 6; i++) {
    const e = { t: at(10 + i), session: `m${i}`, intakeId: `pdf${i}`, carrier: 'progressive', page: 'AddVehicle', q: '2B9D', label: 'Farthest distance' };
    if (i < 2) {
      mapped.push({ ...e, id: `f${i}`, type: 'fill_field', controlKind: 'select', result: 'filled', path: 'x', shown: 'A' });
      mapped.push({ ...e, id: `g${i}`, type: 'field_change', kind: 'select', by: 'agent', autofilled: 'x', vsAutofill: 'different', from: 'A', to: 'B' });
    } else mapped.push({ ...e, id: `h${i}`, type: 'field_change', kind: 'select', by: 'agent', to: 'B' });
  }
  const [review] = learn(mapped, { carriers, minIntakes: 2 }).suggestions.review;
  assert.deepEqual([review.intakes, review.quotes, review.filled], [2, 2, 2]);
});

// Audit 2026-10-08: a question left to the agent who let the page's answer stand produced no
// event, so the learner never saw it. The page's last layout before the agent left it does.
function leftQuote(i, { leave = true, change = null, rows = 1, page = 'MoreAboutBusiness', carrier = 'progressive', q = '3C4', label = 'Does the customer need a certificate of insurance?' } = {}) {
  const s = `q${i}`;
  const t = (n) => at(i * 100 + n);
  const fields = Array.from({ length: rows }, () => ({ q, kind: 'radio', label, options: ['Yes', 'No'], selected: 'No' }));
  return [
    { id: `${s}i`, t: t(0), session: s, type: 'intake_loaded', intakeId: `pdf${i}` },
    { id: `${s}f`, t: t(1), session: s, carrier, type: 'fill_field', page, q, label, controlKind: 'radio', result: 'unfamiliar' },
    { id: `${s}l`, t: t(2), session: s, carrier, type: 'page_layout', page, context: {}, fields },
    ...(change ? [{ id: `${s}c`, t: t(3), session: s, carrier, type: 'field_change', page, q, label, kind: 'radio', by: 'agent', to: change }] : []),
    ...(leave ? [{ id: `${s}v`, t: t(4), session: s, carrier, type: 'page_view', page: 'CoveragesRates-Reload', from: `${page}-Reload` }] : []),
  ];
}
const noRules = [{ id: 'progressive', rules: [], useGenericRules: false }, { id: 'amwins', rules: [], useGenericRules: false }];

test('learning: the page answer an agent left a page with counts, and suggests keeping the question with the agent', () => {
  const events = Array.from({ length: 5 }, (_, i) => leftQuote(i)).flat();
  const a = byQ(finalAnswers(events).get('q0'), '3C4');
  assert.deepEqual([a.value, a.source, a.pageLeft], ['No', 'page', true]);
  const { suggestions } = learn(events, { carriers: noRules, minIntakes: 5 });
  assert.equal(suggestions.standard.length, 0, 'never a standard answer: the agent chose nothing');
  const [p] = suggestions.pageAnswer;
  assert.deepEqual([p.answer, p.intakes], ['No', 5]);
  // Known, so no longer unfamiliar, but still the agent's: a default proves nothing for a client.
  const suggested = rule(p.rule);
  assert.equal(suggested.ignore, undefined);
  assert.match(suggested.note, /The page's answer "No" was left in 5 of 5 answers \(5 quotes, 5 intake PDFs\); confirm it for this client\./);
  const carrier = { id: 'progressive', rules: [suggested], useGenericRules: false };
  assert.equal(fieldStatus({ caption: 'Does the customer need a certificate of insurance?', kind: 'radio' }, carrier, 'MoreAboutBusiness').status, 'agent');
  const [step] = buildPlan({ applicant: {}, garaging: {}, operations: {}, drivers: [], vehicles: [], trailers: [], priorInsurance: [], coverage: {}, claims: {} }, carrier, {}).filter((x) => x.kind !== 'action');
  assert.equal(step.note, suggested.note, 'the fill leaves it with the agent, with the evidence');
});

test('learning: no page answer from a page never left, from a stale layout, or from an id drawn twice without rows', () => {
  const answer = (opts) => byQ(finalAnswers(leftQuote(0, opts)).get('q0'), '3C4');
  assert.equal(answer({ leave: false }).value, undefined, 'the agent never left the page');
  const changed = answer({ change: 'Yes' });
  assert.deepEqual([changed.value, changed.source, changed.pageLeft], ['Yes', 'agent', undefined], 'the change after the layout wins');
  assert.equal(answer({ rows: 2 }).value, undefined, 'two rows of one id: which one is not known');
  // One agent who changed it to another answer: not a page answer to keep.
  const events = [...Array.from({ length: 5 }, (_, i) => leftQuote(i)).flat(), ...leftQuote(5, { change: 'Yes' })];
  assert.equal(learn(events, { carriers: noRules, minIntakes: 5 }).suggestions.pageAnswer.length, 0);
});

test('learning: questions without an id (AmWINS) get no page answers', () => {
  const events = Array.from({ length: 5 }, (_, i) => leftQuote(i, { carrier: 'amwins', q: null, page: '/application/businessauto' })).flat();
  for (const m of finalAnswers(events).values()) for (const a of m.values()) assert.equal(a.pageLeft, undefined);
});

// Codex on PR #51: what proves the page's answer stood when the agent left the page.
test('learning: a page answer needs this tab\'s own visit, the agent\'s departure, and no AI choice', () => {
  const base = leftQuote(0);
  const value = (events) => byQ(finalAnswers(events).get('q0'), '3C4')?.value;
  const withView = (events, view) => events.map((e) => (e.carrier ? { ...e, view } : e));
  assert.equal(value(withView(base, 't1')), 'No', 'one tab: as before');
  // Tab 2 drew the page last; tab 1 left it, without a layout of its own.
  const twoTabs = withView(base, 't1').map((e) => (e.type === 'page_layout' ? { ...e, view: 't2' } : e));
  assert.equal(value(twoTabs), undefined, "another tab's layout says nothing");
  // The extension's fill clicked Continue.
  const advanced = [...base.slice(0, 3), { id: 'run', t: at(3), session: 'q0', carrier: 'progressive', type: 'fill_run', page: 'MoreAboutBusiness', advanced: 'Continue' }, ...base.slice(3)];
  assert.equal(value(advanced), undefined, 'not the agent leaving');
  // An AI choice the agent accepted (the recorder is paused, so no change event).
  const ai = [...base.slice(0, 3), { id: 'ai', t: at(3), session: 'q0', carrier: 'progressive', type: 'ai_decision', page: 'MoreAboutBusiness', q: '3C4', label: 'Does the customer need a certificate of insurance?', decision: 'accepted', choice: 'No' }, ...base.slice(3)];
  assert.equal(value(ai), undefined, 'an AI answer, not the page default');
  // Back on the page (no new layout: same questions), then left again: that visit is unknown.
  const back = [...base,
    { id: 'back', t: at(5), session: 'q0', carrier: 'progressive', type: 'page_view', page: 'MoreAboutBusiness', from: 'CoveragesRates' },
    { id: 'out', t: at(6), session: 'q0', carrier: 'progressive', type: 'page_view', page: 'CoveragesRates', from: 'MoreAboutBusiness' }];
  assert.equal(value(back), undefined, 'the earlier layout may not show what the page held later');
  // A -Reload of the same page keeps its layout.
  const reload = [...base.slice(0, 3), { id: 'rl', t: at(3), session: 'q0', carrier: 'progressive', type: 'page_view', page: 'MoreAboutBusiness-Reload', from: 'MoreAboutBusiness' }, ...base.slice(3)];
  assert.equal(value(reload), 'No');
});

test('learning: a question a current rule maps gets no page-answer suggestion', () => {
  const events = Array.from({ length: 5 }, (_, i) => leftQuote(i)).flat();
  const mapped = [{ id: 'progressive', useGenericRules: false, rules: [{ page: 'MoreAboutBusiness', ask: 'Does the customer need a certificate of insurance?', kind: 'bool', value: () => false }] }];
  assert.equal(learn(events, { carriers: mapped, minIntakes: 5 }).suggestions.pageAnswer.length, 0);
});

// Codex on PR #51: a helper that navigates (the bill plan) moves on too, and the fill that clicked is
// often logged after the move (seconds later).
test('learning: no page answer when the extension clicked on the page during that visit', () => {
  const base = leftQuote(0);
  const value = (events) => byQ(finalAnswers(events).get('q0'), '3C4')?.value;
  const run = (n, extra) => ({ id: `run${n}`, t: at(n), session: 'q0', carrier: 'progressive', type: 'fill_run', page: 'MoreAboutBusiness', advanced: null, clicked: [], ...extra });
  const arrive = { id: 'arr', t: at(0.5), session: 'q0', carrier: 'progressive', type: 'page_view', page: 'MoreAboutBusiness', from: 'Start' };
  const visit = [base[0], arrive, ...base.slice(1)];
  assert.equal(value(visit), 'No', 'the agent left');
  assert.equal(value([...visit.slice(0, 4), run(3, { clicked: ['billPlan'] }), ...visit.slice(4)]), undefined, 'a helper that navigates');
  assert.equal(value([...visit, run(10, { advanced: 'Continue' })]), undefined, 'Continue logged after the move');
  assert.equal(value([...visit, run(200, { advanced: 'Continue' })]), 'No', 'a click well after the departure is another visit\'s');
  assert.equal(value([base[0], run(0.2, { clicked: ['addVehicle'] }), arrive, ...base.slice(1)]), 'No', 'a click before this visit');
});

// Codex on PR #53: a quote on the local test page logs its intake without a carrier; the whole quote
// goes, unless it also worked on a carrier. A PDF never taken to a carrier is no quote.
test('events: a test-page quote goes whole, a mixed one keeps its carrier work, an intake alone is no quote', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rater-test-sessions-'));
  fs.mkdirSync(path.join(dir, 'events'));
  const e = (id, session, type, carrier) => JSON.stringify({ id, t: `2026-10-02T15:00:0${id.length % 10}Z`, session, type, ...(carrier ? { carrier } : {}) });
  fs.writeFileSync(path.join(dir, 'events', '2026-10-02.jsonl'), [
    e('t1', 'test-only', 'intake_loaded'), e('t2', 'test-only', 'warning_checked'), e('t3', 'test-only', 'fill_run', 'test'),
    e('m1', 'mixed', 'intake_loaded'), e('m2', 'mixed', 'fill_run', 'test'), e('m3', 'mixed', 'fill_run', 'progressive'),
    e('i1', 'intake-only', 'intake_loaded'), e('i2', 'intake-only', 'intake_edit'),
  ].join('\n'));
  const loaded = loadEvents([dir]);
  assert.deepEqual(loaded.map((x) => x.id).sort(), ['i1', 'i2', 'm1', 'm3']);
  assert.deepEqual([...quoteSessions(loaded)], ['mixed'], 'an intake never taken to a carrier is loaded, but no quote');
});

// The review's Speed and AI tables split a question at Progressive's renumbering (91 of 304 rows).
test('the review names one question once, whatever its number', () => {
  const layout = (session, q, ref) => ({ id: `l${session}`, t: at(1), session, carrier: 'progressive', type: 'page_layout', page: 'AddVehicle', context: {}, fields: [{ q, ref, kind: 'radio', label: 'Is this vehicle used for hire?' }] });
  const fill = (session, q, key) => ({ id: `f${session}`, t: at(2), session, carrier: 'progressive', type: 'fill_field', page: 'AddVehicle', q, key, label: 'Is this vehicle used for hire?', result: 'filled' });
  const events = [layout('old', '2C1A', null), fill('old', '2C1A', '2C1A'), layout('new', '3F07', 'RiskInput.ForHire'), fill('new', '3F07', 'ref:RiskInput.ForHire')];
  const key = questionOf(events);
  assert.equal(key(events[1]), key(events[3]));
  assert.equal(key({ carrier: 'amwins', page: '/application/businessauto', label: 'Gender' }), 'amwins|/application/businessauto|Gender', 'without an id: page and text, as before');
});

// Codex on PR #56: two questions reading the same are two rows, each named by what tells them apart.
test('the review names two questions reading the same apart', async () => {
  const { execFileSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rater-review-'));
  fs.mkdirSync(path.join(dir, 'events'));
  const row = (id, key) => ({ id, t: at(1), session: 's', carrier: 'progressive', type: 'fill_field', page: 'BusinessOwnerInfo', q: id, key, label: 'City', result: 'filled', timing: { ms: 10, settleMs: 0, ajax: 0, revealed: 0, removed: 0, changed: 0 } });
  fs.writeFileSync(path.join(dir, 'events', '2026-10-05.jsonl'), [row('284', 'ref:PrimaryBusinessAddressInput.City'), row('2B0', 'ref:BusinessOwnerHomeAddressInput.City')].map((e) => JSON.stringify(e)).join('\n'));
  const out = path.join(dir, 'review.md');
  execFileSync(process.execPath, [new URL('../scripts/review.mjs', import.meta.url).pathname, dir, '--all', '--out', out], { stdio: 'ignore' });
  const md = fs.readFileSync(out, 'utf8');
  assert.match(md, /progressive BusinessOwnerInfo "City" `PrimaryBusinessAddressInput\.City`/);
  assert.match(md, /progressive BusinessOwnerInfo "City" `BusinessOwnerHomeAddressInput\.City`/);
});

// Codex on PR #56: two controls reading the same at once (Rates' cargo section and cargo row) stay two
// questions, even when only one has a data-model name; and a text two questions share names neither.
test('identity: controls drawn together stay apart; a shared text falls back to the id', () => {
  const layout = (session, fields) => ({ id: `l${session}`, t: at(1), session, carrier: 'progressive', type: 'page_layout', page: 'CoveragesRates', context: {}, fields });
  const cargo = { kind: 'select', label: 'Motor Trucking Cargo', options: ['$100K'] };
  const events = [layout('a', [{ ...cargo, q: '216F', ref: 'CargoInput.Section' }, { ...cargo, q: '2150' }])];
  const key = questionOf(events);
  const section = key({ session: 'a', carrier: 'progressive', page: 'CoveragesRates', q: '216F', label: 'Motor Trucking Cargo', key: 'ref:CargoInput.Section' });
  const row = key({ session: 'a', carrier: 'progressive', page: 'CoveragesRates', q: '2150', label: 'Motor Trucking Cargo', key: '2150' });
  assert.notEqual(section, row);
  // An AI decision in a quote without a layout of the page: the text names two questions there.
  const two = [layout('b', [{ ...cargo, q: '216F', ref: 'CargoInput.Section' }, { ...cargo, q: '2150', ref: 'CargoInput.Row' }])];
  const ai = (q) => questionOf(two)({ session: 'no-layout', carrier: 'progressive', page: 'CoveragesRates', q, label: 'Motor Trucking Cargo', type: 'ai_decision' });
  assert.notEqual(ai('216F'), ai('2150'), 'not one question for both');
  assert.equal(questionOf(two)({ session: 'no-layout', carrier: 'progressive', page: 'CoveragesRates', q: '3AA', label: 'A text only one question reads', type: 'ai_decision' }),
    'progressive|CoveragesRates|text:a text only one question reads', 'a text no other question shares: still by its text');
});
