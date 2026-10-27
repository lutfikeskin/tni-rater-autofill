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

// TNI, 2026-10-26 (answer to PR question 10): a longer time with the insurer the notes give picks
// the carrier's matching band, the line quoted on the Intake step (prior.tenure); a time the
// carrier's bands can't place in one of them stays the agent's. GEICO's bands: 1-3, 3-5, 5-10, 10+
// Years; AmWINS': 1 TO 2, 2 TO 3, MORE THAN 3 YEARS. The sample intake is applied for on 09/15/2026.
test('years with the current insurer: 1-3 at least; a longer time the notes give picks the carrier\'s band, quoted (W44-02, W44-29)', () => {
  // IL: the notes say the policy started in December 2025. Still 1-3 years, and nothing to show.
  const il = intake(DATED, { additional_notes: 'Policy started in December 2025' });
  assert.deepEqual([geicoStep(il.record, GEICO.years).value, geicoStep(il.record, GEICO.years).source], ['1-3 Years', 'standard']);
  assert.deepEqual([howLong(il.record).value, howLong(il.record).source], ['1 TO 2 YEARS', 'standard']);
  assert.equal(il.warnings.find((w) => w.code === 'prior.tenure'), undefined);
  for (const [line, geicoBand, amwinsBand] of [
    ['Insured with Synthetic Mutual for 6 years', '5-10 Years', 'MORE THAN 3 YEARS'],
    ['Same insurance since 2019', '5-10 Years', 'MORE THAN 3 YEARS'], // 6.7 to 7.7 years
    ['Insured 4 years with Synthetic Mutual', '3-5 Years', 'MORE THAN 3 YEARS'],
    ['With Synthetic Mutual 12 yrs, same policy', '10+ Years', 'MORE THAN 3 YEARS'],
    ['Insured over 10 years with Synthetic Mutual', '10+ Years', 'MORE THAN 3 YEARS'],
    ['Policy for almost 5 years', '3-5 Years', 'MORE THAN 3 YEARS'],
    // Within GEICO's 1-3 years, past AmWINS' 1 TO 2.
    ['Insured 2.5 years with Synthetic Mutual', '1-3 Years', '2 TO 3 YEARS'],
    ['Insured 3 years with Synthetic Mutual', '1-3 Years', '2 TO 3 YEARS'],
    // TNI, 2026-10-26 (round 2, R5): a time on a band edge takes the upper band: exactly 5 years
    // is GEICO's 5-10, exactly 10 or "10+" its 10+. Exactly 3 stays 1-3 (the decision's "1-3 at
    // least"). AmWINS' 1 TO 2 and 2 TO 3 share 2, so 2 years is 2 TO 3 there.
    ['Has had this policy for five years', '5-10 Years', 'MORE THAN 3 YEARS'],
    ['Insured 5 years with Synthetic Mutual', '5-10 Years', 'MORE THAN 3 YEARS'],
    ['Insured 10 years with Synthetic Mutual', '10+ Years', 'MORE THAN 3 YEARS'],
    ['Insured 10+ years with Synthetic Mutual', '10+ Years', 'MORE THAN 3 YEARS'],
    ['Insured 2 years with Synthetic Mutual', '1-3 Years', '2 TO 3 YEARS'],
    // R8: "about", "around" or "approximately" N is N, then placed by the edge rule above.
    ['Insured about 3 years with Synthetic Mutual', '1-3 Years', '2 TO 3 YEARS'],
    ['Around 5 years with the same insurer', '5-10 Years', 'MORE THAN 3 YEARS'],
    ['Approximately 10 years insured with Synthetic Mutual', '10+ Years', 'MORE THAN 3 YEARS'],
    ['Insured about 2 years with Synthetic Mutual', '1-3 Years', '2 TO 3 YEARS'],
  ]) {
    const { record: r, warnings } = intake(DATED, { additional_notes: line });
    const years = geicoStep(r, GEICO.years);
    assert.deepEqual([years.value, years.source, years.note], [geicoBand, geicoBand === '1-3 Years' ? 'standard' : 'derived', null], line);
    assert.deepEqual([howLong(r).value, howLong(r).source, howLong(r).note], [amwinsBand, 'derived', null], line);
    // Where it was read: a check on the Intake step quoting the line.
    const shown = warnings.find((w) => w.code === 'prior.tenure');
    assert.equal(shown?.level, 'check', line);
    assert.equal(shown.path, 'notes.text');
    assert.ok(shown.msg.includes(`"${line}"`), line);
    // Still currently insured.
    assert.equal(geicoStep(r, GEICO.auto).value, 'Yes');
  }
  // The claims box's other lines count too, the check pointing at it.
  const claims = intake(DATED, { claims_details: 'No\nInsured with Synthetic Mutual for 6 years' });
  assert.equal(geicoStep(claims.record, GEICO.years).value, '5-10 Years');
  assert.equal(claims.warnings.find((w) => w.code === 'prior.tenure')?.path, 'claims.text');
  // A time the bands can't place in one of them: the agent's, the line quoted. A year alone is
  // anywhere in it; "over N" and "N+" have no end (R8: they stay at least N, the edge rule placing
  // their start).
  for (const [line, amwinsBand] of [
    ['Policy since 2021', 'MORE THAN 3 YEARS'], // 4.7 to 5.7 years
    ['Insured over 3 years with Synthetic Mutual', 'MORE THAN 3 YEARS'],
    ['Insured 5+ years with Synthetic Mutual', 'MORE THAN 3 YEARS'], // 5-10 or 10+
    ['Insured over 5 years with Synthetic Mutual', 'MORE THAN 3 YEARS'],
    ['Same insurer since 2023', null], // 2.7 to 3.7 years
    ['Insured 2+ years with Synthetic Mutual', null], // 2 TO 3 or MORE THAN 3; GEICO 1-3 to 10+
    // Not settled by R8 (it names about, around and approximately): as before, half a year either side.
    ['Insured roughly 5 years with Synthetic Mutual', 'MORE THAN 3 YEARS'],
  ]) {
    const r = intake(DATED, { additional_notes: line }).record;
    const years = geicoStep(r, GEICO.years);
    agents(years);
    assert.equal(years.source, 'fact');
    assert.ok(years.note.includes(line), line);
    if (amwinsBand) assert.deepEqual([howLong(r).value, howLong(r).source], [amwinsBand, 'derived'], line);
    else {
      agents(howLong(r));
      assert.equal(howLong(r).source, 'fact');
      assert.ok(howLong(r).note.includes(line), line);
    }
  }
  // A number of years not about insurance, or within the band, doesn't count. A time under 1 year
  // keeps 1-3 / 1 TO 2 YEARS: only a longer one overrides (round 2, R6).
  for (const line of ['3 Years', '10 years in business, CDL for 12 years', 'Insured under 1 year with Synthetic Mutual', 'Insured about 1 year with Synthetic Mutual']) {
    const { record: r, warnings } = intake(DATED, { additional_notes: line });
    assert.deepEqual([geicoStep(r, GEICO.years).value, geicoStep(r, GEICO.years).source], ['1-3 Years', 'standard'], line);
    assert.deepEqual([howLong(r).value, howLong(r).source], ['1 TO 2 YEARS', 'standard'], line);
    assert.equal(warnings.find((w) => w.code === 'prior.tenure'), undefined, line);
  }
  // The notes don't make an expired policy current: GEICO's question stays the agent's, on a band
  // edge too.
  for (const line of ['Insured with Synthetic Mutual for 6 years', 'Insured 10 years with Synthetic Mutual']) {
    agents(geicoStep(intake({ ...DATED, ins_exp_1: '08/31/2026' }, { additional_notes: line }).record, GEICO.years));
  }
  const tenureOf = (line) => insurerTenure(intake(DATED, { additional_notes: line }).record);
  assert.deepEqual(tenureOf('Insured 3 years with Synthetic Mutual'), { years: 3, least: 3, line: 'Insured 3 years with Synthetic Mutual' });
  // R8: about N is N; N+ is at least N, with no end.
  assert.deepEqual(tenureOf('Insured about 3 years with Synthetic Mutual'), { years: 3, least: 3, line: 'Insured about 3 years with Synthetic Mutual' });
  assert.deepEqual(tenureOf('Insured 10+ years with Synthetic Mutual'), { years: Infinity, least: 10, line: 'Insured 10+ years with Synthetic Mutual' });
  assert.equal(tenureOf('3 Years'), null);
});

// TNI, 2026-10-26 (answer to PR question 11): AmWINS asks how long with the current carrier of a
// client with a DOT or MC number; there it is 1 TO 2 YEARS, unless the notes give another time
// (above). The maintainer: it is asked only then, so no prior insurance doesn't change it.
// TNI, 2026-10-26 (round 2, R7): AmWINS shows the question with a federal filing required, also
// without a DOT or MC number; it is answered whenever the page shows it.
test('AmWINS: how long with the current carrier is 1 TO 2 YEARS whenever the page asks it, a federal filing without a DOT or MC number too', () => {
  for (const more of [{}, { dot_number: '', mc_number: '765432' }, { mc_number: '765432' },
    // R7: a federal filing required (the sample intake's) with no number.
    { dot_number: '', mc_number: '' }]) {
    const step = howLong(intake(DATED, more).record);
    assert.deepEqual([step.ignore, step.value, step.source], [false, '1 TO 2 YEARS', 'standard'], JSON.stringify(more));
  }
  const none = howLong(intake({ ins_carrier_1: 'NO POP' }).record);
  assert.deepEqual([none.ignore, none.value], [false, '1 TO 2 YEARS']);
  // R7 with the notes' longer band.
  const longer = intake(DATED, { dot_number: '', mc_number: '', additional_notes: 'Insured with Synthetic Mutual for 6 years' }).record;
  assert.equal(longer.operations.filingsRequired, true);
  assert.deepEqual([howLong(longer).ignore, howLong(longer).value, howLong(longer).source], [false, 'MORE THAN 3 YEARS', 'derived']);
  // Without a federal filing the page doesn't show it, so nothing is answered: the saved page has
  // the question in the block "Is a Federal Filing Required?" Yes opens (app-rel-id fillingRequired,
  // hidden until then), and the fill engine answers only the fields the page shows.
  const page = fs.readFileSync(new URL('./fixtures/amwins/application.html', import.meta.url), 'utf8');
  const block = page.indexOf('<div app-rel-id="fillingRequired" class="app-hide">');
  assert.ok(block > 0, 'the filing block');
  const question = page.indexOf('id="howLongWithCurrentCarrier"');
  assert.ok(question > block && !page.slice(block, question).includes('<div class="card'), 'the question is inside the filing block');
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
  // A remark in the date box is no date: no "Exp Date" (TNI, 2026-10-26: answer to PR question 12).
  assert.match(disclosure(intake(NE).record), /^POP Commercial - Synthetic Mutual - \$1M CSL$/m);
  assert.doesNotMatch(disclosure(intake(NE).record), /Exp Date|dec page/);
  // No carrier on the intake: the policy is still disclosed, the missing part left out.
  assert.match(disclosure(intake({ ins_type_1: 'Commercial Auto', ins_limit_1: '$1M CSL' }).record), /^POP Commercial - \$1M CSL$/m);
  for (const boxes of [{}, { ins_carrier_1: 'NO POP' }]) assert.doesNotMatch(disclosure(intake(boxes).record), /POP|prior/i, JSON.stringify(boxes));
});
