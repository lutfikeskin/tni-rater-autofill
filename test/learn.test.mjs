import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEvents } from '../scripts/lib/events.mjs';
import { learn, finalAnswers } from '../scripts/lib/learn.mjs';
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

test('final answers track who answered each question', () => {
  const answers = finalAnswers(week(1));
  const s0 = answers.get('s0');
  assert.equal(s0.get('progressive|q9A01').value, 'No');
  assert.equal(s0.get('progressive|q9A01').source, 'agent');
  const dist = s0.get('progressive|q2B9D');
  assert.equal(dist.corrected, true);
  assert.equal(dist.correction, '"More than 500 miles" → "500 miles"');
  assert.equal(s0.get('progressive|q2C05').source, 'autofill');
});

test('learning suggests standard answers, per-state answers, mappings and reviews', () => {
  const { quotes, suggestions } = learn(week(10), { carriers: CARRIERS, minQuotes: 5 });
  assert.equal(quotes, 10);
  const std = suggestions.standard.find((s) => s.q === '9A01');
  assert.equal(std.answer, 'No');
  assert.equal(std.share, 1);
  assert.match(std.rule, /q: '9A01'.*kind: 'bool', value: \(\) => false/);
  const byState = suggestions.byState.find((s) => s.q === '9A02');
  assert.deepEqual(byState.perState.map((p) => `${p.state}:${p.value}`).sort(), ['MD:Zone 1', 'VA:Zone 7']);
  const map = suggestions.mapping.find((s) => s.q === '9A03');
  assert.equal(map.path, 'garaging.city');
  const review = suggestions.review.find((s) => s.q === '2B9D');
  assert.equal(review.corrected, 6);
  assert.equal(review.filled, 10);
  assert.ok(!suggestions.review.some((s) => s.q === '2C05'), 'accepted rules are not flagged');
  assert.ok(!suggestions.standard.some((s) => s.q === '2B9D'), 'mapped questions are not re-suggested');
});

test('too few quotes: no suggestions', () => {
  const { suggestions } = learn(week(3), { carriers: CARRIERS, minQuotes: 5 });
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
  const loaded = loadEvents([dir, exportFile]);
  assert.equal(loaded.length, events.length);
  assert.ok(loaded.every((e) => !String(e.page ?? '').endsWith('-Reload')));
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
