// Prior insurance (TNI, 2026-10-26, W44-29; W44-12; W44-02 as the standard): any box of the
// intake's current insurance filled (policy type, carrier, limit or expiration date) is proof of
// prior insurance, 1-3 years at least, and the Intake step names the boxes left blank. A longer
// time with the insurer the notes give isn't shortened. AmWINS' prior-carrier rows stay NO PRIOR,
// the prior policy going in the disclosure (W44-32). Synthetic intakes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readIntakeFields } from '../src/intake.js';
import { normalizeIntake, insurerTenure } from '../src/normalize.js';
import { buildPlan } from '../src/plan.js';
import { priorInsuranceAssumed } from '../src/util.js';
import { progressive } from '../src/carriers/progressive.js';
import { amwins } from '../src/carriers/amwins.js';
import { geico } from '../src/carriers/geico.js';

// The 2026-10 form filled with made-up data (an IL expediter with a USDOT number, applied for on
// 09/15/2026), its current insurance boxes replaced per case.
const fixture = new Uint8Array(fs.readFileSync(new URL('./fixtures/sample-intake-2026-10.pdf', import.meta.url)));
const raw = await readIntakeFields(pdfjs, fixture);
const BLANK = { ins_type_1: 'Select*', ins_carrier_1: '', ins_limit_1: 'Select*', ins_exp_1: '' };
const intake = (boxes, more = {}) => normalizeIntake({ ...raw, ...BLANK, ...boxes, ...more }, { today: new Date('2026-09-15') });
// An auto policy with a carrier and a limit, a remark in the expiration box (NE, W44-12).
const NE = { ins_type_1: 'Commercial Auto', ins_carrier_1: 'Synthetic Mutual', ins_limit_1: '$1M CSL', ins_exp_1: 'dec page to follow' };
const DATED = { ...NE, ins_exp_1: '12/31/2026' };

const GEICO = {
  auto: 'Currently has auto insurance',
  years: 'Years with the current auto insurer (1-3 with a current policy)',
  bi: 'Current bodily injury limits',
};
const geicoStep = (record, name) => {
  const hits = buildPlan(record, geico, {}).filter((s) => s.name === name);
  assert.equal(hits.length, 1, name);
  return hits[0];
};
const byQ = (record, q) => buildPlan(record, progressive, {}).find((s) => s.q === q);
const amwinsPlan = (record) => buildPlan(record, amwins, {});
const howLong = (record) => amwinsPlan(record).find((s) => s.selector === '#howLongWithCurrentCarrier');
const disclosure = (record) => amwinsPlan(record).find((s) => /^Disclosure details/.test(s.name ?? '')).value ?? '';
const agents = (s) => { assert.equal(s.value, null, `${s.name}: not filled`); assert.ok(s.note, `${s.name}: has a note`); };

test('any box of the current insurance filled is proof of prior insurance (TNI, 2026-10-26, W44-29)', () => {
  const policy = (p) => ({ applicant: { applicationDate: '09/15/2026' }, priorInsurance: [{ type: null, carrier: null, limit: null, expiration: null, ...p }] });
  for (const p of [{ type: 'Commercial Auto' }, { type: 'Personal Auto' }, { carrier: 'Synthetic Mutual' }, { limit: 'State Minimum' }, { expiration: '12/31/2026' },
    { type: 'Commercial Auto', carrier: 'Synthetic Mutual', limit: '$1M CSL', expiration: 'dec page to follow' }]) {
    assert.equal(priorInsuranceAssumed(policy(p)), true, JSON.stringify(p));
  }
  // Not settled by the decision, so as before: nothing filled, no prior insurance, an expired
  // policy, a policy of another kind.
  for (const p of [{}, { carrier: 'NO POP' }, { type: 'Commercial Auto', carrier: 'Synthetic Mutual', expiration: '08/31/2026' },
    { type: 'General Liability', carrier: 'Synthetic Mutual' }, { type: 'Cargo', limit: '$1M CSL' }, { type: 'Other', carrier: 'Synthetic Mutual' }]) {
    assert.equal(priorInsuranceAssumed(policy(p)), false, JSON.stringify(p));
  }
  assert.equal(priorInsuranceAssumed({ priorInsurance: [] }), false);
});

test('the Intake step names the current insurance boxes left blank, with the proof of prior insurance assumed', () => {
  const warned = (boxes) => intake(boxes).warnings.find((w) => w.code === 'prior.incomplete');
  const partial = warned({ ins_type_1: 'Commercial Auto', ins_carrier_1: 'Synthetic Mutual' });
  assert.equal(partial.level, 'check', 'shown on the Intake step like the other checks');
  assert.equal(partial.path, 'priorInsurance[0]');
  assert.match(partial.msg, /missing the limit and expiration date/);
  assert.match(partial.msg, /proof of prior insurance \(1-3 years\)/i);
  assert.doesNotMatch(partial.msg, /Synthetic Mutual/, 'no client value');
  assert.match(warned({ ins_limit_1: '$1M CSL' }).msg, /missing the policy type, carrier and expiration date/);
  // All four filled, or none: nothing to name. A remark in the date box has its own check.
  assert.equal(warned(DATED), undefined);
  assert.equal(warned({}), undefined);
  const ne = intake(NE);
  assert.equal(ne.warnings.find((w) => w.code === 'prior.incomplete'), undefined);
  assert.ok(ne.warnings.some((w) => w.code === 'prior-expiration.invalid' && w.level === 'check'));
  // Not assumed (another kind of policy): the details are still asked for, without the assumption.
  const gl = warned({ ins_type_1: 'General Liability', ins_carrier_1: 'Synthetic Mutual' });
  assert.match(gl.msg, /missing the limit and expiration date/);
  assert.doesNotMatch(gl.msg, /proof of prior/i);
});

test('GEICO: an auto policy with a remark for its date is current auto insurance, 1-3 years, with the intake\'s limit (W44-12)', () => {
  const { record } = intake(NE);
  const auto = geicoStep(record, GEICO.auto);
  assert.deepEqual([auto.value, auto.source, auto.standard, auto.note], ['Yes', 'standard', true, null]);
  assert.deepEqual([geicoStep(record, GEICO.years).value, geicoStep(record, GEICO.years).source], ['1-3 Years', 'standard']);
  assert.deepEqual([geicoStep(record, GEICO.bi).value, geicoStep(record, GEICO.bi).source], ['$1,000,000/$1,000,000 or $1,000,000 CSL', 'derived']);
  // A dated auto policy is the intake's own answer, as before.
  const dated = geicoStep(intake(DATED).record, GEICO.auto);
  assert.deepEqual([dated.value, dated.source], ['Yes', 'derived']);
  // One box is enough; a blank limit is then the agent's, with a note naming it.
  for (const boxes of [{ ins_carrier_1: 'Synthetic Mutual' }, { ins_type_1: 'Personal Auto' }, { ins_limit_1: '$100K/$300K' }]) {
    const { record: r } = intake(boxes);
    assert.deepEqual([geicoStep(r, GEICO.auto).value, geicoStep(r, GEICO.auto).source], ['Yes', 'standard'], JSON.stringify(boxes));
    assert.equal(geicoStep(r, GEICO.years).value, '1-3 Years', JSON.stringify(boxes));
  }
  assert.equal(geicoStep(intake({ ins_limit_1: '$100K/$300K' }).record, GEICO.bi).value, '$100,000/$300,000');
  const noLimit = geicoStep(intake({ ins_carrier_1: 'Synthetic Mutual' }).record, GEICO.bi);
  agents(noLimit);
  assert.match(noLimit.note, /no limit/);
});

test('GEICO: no current insurance, an expired policy or another kind of policy stays as before', () => {
  for (const [boxes, says] of [[{}, /blank/], [{ ...DATED, ins_exp_1: '08/31/2026' }, /expired/], [{ ...DATED, ins_type_1: 'General Liability' }, /General Liability/]]) {
    const { record } = intake(boxes);
    const auto = geicoStep(record, GEICO.auto);
    agents(auto);
    assert.equal(auto.manualOnly, true);
    assert.match(auto.note, says);
    assert.doesNotMatch(auto.note, /doesn't show a current auto policy/);
    agents(geicoStep(record, GEICO.years));
  }
  const none = intake({ ins_carrier_1: 'NO POP' }).record;
  assert.equal(geicoStep(none, GEICO.auto).value, 'No');
  agents(geicoStep(none, GEICO.years));
});

test('years with the current insurer: 1-3 at least; a longer time the notes give is the agent\'s, quoted (W44-02, W44-29)', () => {
  // IL: the notes say the policy started in December 2025. Still 1-3 years.
  const il = intake(DATED, { additional_notes: 'Policy started in December 2025' }).record;
  assert.deepEqual([geicoStep(il, GEICO.years).value, geicoStep(il, GEICO.years).source], ['1-3 Years', 'standard']);
  assert.deepEqual([howLong(il).value, howLong(il).source], ['1 TO 2 YEARS', 'standard']);
  for (const line of ['Insured with Synthetic Mutual for 6 years', 'Same insurance since 2019', 'Has had this policy for five years']) {
    const r = intake(DATED, { additional_notes: line }).record;
    const years = geicoStep(r, GEICO.years);
    agents(years);
    assert.equal(years.source, 'fact');
    assert.ok(years.note.includes(line), line);
    const amwinsYears = howLong(r);
    agents(amwinsYears);
    assert.equal(amwinsYears.source, 'fact');
    assert.ok(amwinsYears.note.includes(line), line);
    // Still currently insured.
    assert.equal(geicoStep(r, GEICO.auto).value, 'Yes');
  }
  // A number of years not about insurance, or within the band, doesn't count.
  for (const line of ['3 Years', '10 years in business, CDL for 12 years', 'Insured 2 years with Synthetic Mutual']) {
    const r = intake(DATED, { additional_notes: line }).record;
    assert.equal(geicoStep(r, GEICO.years).value, '1-3 Years', line);
  }
  // AmWINS' band ends at 2 years: 3 years with the insurer is its agent's, GEICO's 1-3 still.
  const three = intake(DATED, { additional_notes: 'Insured 3 years with Synthetic Mutual' }).record;
  assert.equal(geicoStep(three, GEICO.years).value, '1-3 Years');
  agents(howLong(three));
  assert.deepEqual(insurerTenure(three), { years: 3, line: 'Insured 3 years with Synthetic Mutual' });
  assert.equal(insurerTenure(intake(DATED, { additional_notes: '3 Years' }).record), null);
});

test('Progressive: currently insured with any box filled; a blank limit or date is the agent\'s, never a remark typed (W44-29)', () => {
  for (const boxes of [NE, { ins_type_1: 'Commercial Auto' }, { ins_carrier_1: 'Synthetic Mutual' }, { ins_limit_1: '$1M CSL' }]) {
    const { record } = intake(boxes);
    assert.deepEqual([byQ(record, '81').value, byQ(record, '83').value, byQ(record, '83').source], [true, true, 'standard'], JSON.stringify(boxes));
    assert.equal(byQ(record, '81').source, 'standard', `${JSON.stringify(boxes)}: TNI's assumption, not a dated policy on the intake`);
    for (const q of ['95', '9D']) assert.equal(byQ(record, q).ignore, false, `${q}: asked`);
  }
  const ne = intake(NE).record;
  assert.equal(byQ(ne, '95').value, '$1M CSL');
  agents(byQ(ne, '9D'));
  assert.match(byQ(ne, '9D').note, /no expiration date/);
  assert.equal(byQ(ne, '9D').manualOnly, true, 'never the AI\'s');
  const generic = buildPlan(ne, progressive, {}).filter((s) => s.path === 'priorInsurance[0].expiration' && !s.q);
  assert.ok(generic.length && generic.every((s) => s.value == null && s.note), 'the label rule leaves it too');
  const typeOnly = intake({ ins_type_1: 'Commercial Auto' }).record;
  agents(byQ(typeOnly, '95'));
  assert.match(byQ(typeOnly, '95').note, /no limit/);
  // A dated policy with a limit: the intake's own answer, as before.
  const dated = intake(DATED).record;
  assert.deepEqual([byQ(dated, '81').value, byQ(dated, '81').source, byQ(dated, '9D').value], [true, 'derived', '12/31/2026']);
});

test('Progressive: nothing filled, no prior insurance or an expired policy is not currently insured, as before', () => {
  for (const boxes of [{}, { ins_carrier_1: 'NO POP' }, { ...DATED, ins_exp_1: '08/31/2026' }]) {
    const { record } = intake(boxes);
    assert.deepEqual([byQ(record, '81').value, byQ(record, '81').source], [false, 'derived'], JSON.stringify(boxes));
    assert.equal(byQ(record, '83').source, 'attestation');
    for (const q of ['95', '9D']) assert.equal(byQ(record, q).ignore, true, `${JSON.stringify(boxes)} ${q}`);
  }
});

test('AmWINS: the prior-carrier rows are NO PRIOR with prior insurance too, the policy in the disclosure (TNI, 2026-10-26, W44-32)', () => {
  for (const boxes of [DATED, NE, { ins_type_1: 'Commercial Auto', ins_limit_1: '$1M CSL' }, {}, { ins_carrier_1: 'NO POP' }]) {
    const rows = amwinsPlan(intake(boxes).record).filter((s) => /^Prior carrier/.test(s.name ?? ''));
    assert.equal(rows.length, 6, JSON.stringify(boxes));
    assert.ok(rows.every((s) => s.value === 'NO PRIOR' && s.source === 'standard'), JSON.stringify(boxes));
  }
  assert.match(disclosure(intake(DATED).record), /^POP Commercial - Synthetic Mutual - \$1M CSL - Exp Date 12\/31\/2026$/m);
  assert.match(disclosure(intake(NE).record), /^POP Commercial - Synthetic Mutual - \$1M CSL/m);
  // No carrier on the intake: the policy is still disclosed, the missing part left out.
  assert.match(disclosure(intake({ ins_type_1: 'Commercial Auto', ins_limit_1: '$1M CSL' }).record), /^POP Commercial - \$1M CSL$/m);
  for (const boxes of [{}, { ins_carrier_1: 'NO POP' }]) assert.doesNotMatch(disclosure(intake(boxes).record), /POP|prior/i, JSON.stringify(boxes));
});
