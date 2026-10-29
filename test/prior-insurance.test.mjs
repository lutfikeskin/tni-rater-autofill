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
  assert.match(partial.msg, /Missing the limit and expiration date/);
  assert.match(partial.msg, /proof of prior insurance \(1-3 years\)/i);
  assert.doesNotMatch(partial.msg, /Synthetic Mutual/, 'no client value');
  assert.match(warned({ ins_limit_1: '$1M CSL' }).msg, /Missing the policy type, carrier and expiration date/);
  // All four filled, or none: nothing to name. A remark in the date box has its own check.
  assert.equal(warned(DATED), undefined);
  assert.equal(warned({}), undefined);
  const ne = intake(NE);
  assert.equal(ne.warnings.find((w) => w.code === 'prior.incomplete'), undefined);
  assert.ok(ne.warnings.some((w) => w.code === 'prior-expiration.invalid' && w.level === 'check'));
  // Not assumed (another kind of policy): the details are still asked for, without the assumption.
  const gl = warned({ ins_type_1: 'General Liability', ins_carrier_1: 'Synthetic Mutual' });
  assert.match(gl.msg, /Missing the limit and expiration date/);
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
    // least"). AmWINS' 1 TO 2 and 2 TO 3 share 2, so 2 years is 2 TO 3 there (round 3, T4:
    // confirmed).
    ['Has had this policy for five years', '5-10 Years', 'MORE THAN 3 YEARS'],
    ['Insured 5 years with Synthetic Mutual', '5-10 Years', 'MORE THAN 3 YEARS'],
    ['Insured 10 years with Synthetic Mutual', '10+ Years', 'MORE THAN 3 YEARS'],
    ['Insured 10+ years with Synthetic Mutual', '10+ Years', 'MORE THAN 3 YEARS'],
    ['Insured 2 years with Synthetic Mutual', '1-3 Years', '2 TO 3 YEARS'],
    ['Insured with Synthetic Mutual for two years', '1-3 Years', '2 TO 3 YEARS'],
    // R8: "about", "around" or "approximately" N is N, then placed by the edge rule above.
    ['Insured about 3 years with Synthetic Mutual', '1-3 Years', '2 TO 3 YEARS'],
    ['Around 5 years with the same insurer', '5-10 Years', 'MORE THAN 3 YEARS'],
    ['Approximately 10 years insured with Synthetic Mutual', '10+ Years', 'MORE THAN 3 YEARS'],
    ['Insured about 2 years with Synthetic Mutual', '1-3 Years', '2 TO 3 YEARS'],
    // Round 3, T5: "roughly N" is N too (until then half a year either side, often the agent's).
    ['Insured roughly 5 years with Synthetic Mutual', '5-10 Years', 'MORE THAN 3 YEARS'],
    ['Insured roughly 3 years with Synthetic Mutual', '1-3 Years', '2 TO 3 YEARS'],
    ['Roughly 2 years with the same insurer', '1-3 Years', '2 TO 3 YEARS'],
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
  // R8: about N is N. Round 5, V6: N+ is "over N", with no end (until then N or more).
  assert.deepEqual(tenureOf('Insured about 3 years with Synthetic Mutual'), { years: 3, least: 3, line: 'Insured about 3 years with Synthetic Mutual' });
  assert.deepEqual(tenureOf('Insured 10+ years with Synthetic Mutual'), { years: Infinity, least: 10.1, line: 'Insured 10+ years with Synthetic Mutual' });
  assert.equal(tenureOf('3 Years'), null);
  // Round 3, T5: roughly N is N, as about N is.
  assert.deepEqual(tenureOf('Insured roughly 5 years with Synthetic Mutual'), { years: 5, least: 5, line: 'Insured roughly 5 years with Synthetic Mutual' });
  // T5's counterexample: the other qualifiers the reader knows keep their meaning ("close to N" and
  // "almost N" under N). Round 5, V6: "5ish" and "5 or so" are read now, as "about 5" (below).
  assert.deepEqual(tenureOf('Insured close to 5 years with Synthetic Mutual'), { years: 4.9, least: 4, line: 'Insured close to 5 years with Synthetic Mutual' });
});

// TNI, 2026-10-27 (round 5, V6): the hedges before or after a time with the insurer read as their
// words. "~", "approx." / "approx" / "approximately", "abt", "est." / "estimated", "circa", "Nish",
// "N or so" and "give or take" are "about N" (N); ">", "N plus" and "N+" are "over N" (no end);
// "<" is "under N" (anything below it). Each gives what that word gives.
test('the tenure reader reads hedges as their words: about N, over N, under N (round 5, V6)', () => {
  const tenureOf = (line) => insurerTenure(intake(DATED, { additional_notes: line }).record);
  const about5 = ['Insured ~5 years with Synthetic Mutual', 'Insured ~ 5 yrs with Synthetic Mutual', 'Insured approx. 5 years with Synthetic Mutual',
    'Insured approx 5 years with Synthetic Mutual', 'Insured abt 5 years with Synthetic Mutual', 'Insured est. 5 years with Synthetic Mutual',
    'Insured estimated 5 years with Synthetic Mutual', 'Insured circa 5 years with Synthetic Mutual', 'Insured 5ish years with Synthetic Mutual',
    'Insured 5 or so years with Synthetic Mutual', 'Insured 5 years or so with Synthetic Mutual', 'Insured 5 years give or take with Synthetic Mutual',
    'Insured give or take 5 years with Synthetic Mutual', 'Insured fiveish years with Synthetic Mutual'];
  for (const line of about5) {
    assert.deepEqual(tenureOf(line), { years: 5, least: 5, line }, line);
    // As "about 5 years": GEICO's 5-10 Years, AmWINS' MORE THAN 3 YEARS.
    const r = intake(DATED, { additional_notes: line }).record;
    assert.deepEqual([geicoStep(r, GEICO.years).value, geicoStep(r, GEICO.years).source], ['5-10 Years', 'derived'], line);
    assert.deepEqual([howLong(r).value, howLong(r).source], ['MORE THAN 3 YEARS', 'derived'], line);
  }
  // About N on an edge: as "about 3" (GEICO 1-3, AmWINS 2 TO 3) and "about 2" (AmWINS 2 TO 3).
  for (const [line, geicoBand, amwinsBand] of [['Insured ~3 years with Synthetic Mutual', '1-3 Years', '2 TO 3 YEARS'],
    ['Insured 2ish years with Synthetic Mutual', '1-3 Years', '2 TO 3 YEARS'], ['Insured 3 or so years with Synthetic Mutual', '1-3 Years', '2 TO 3 YEARS']]) {
    const r = intake(DATED, { additional_notes: line }).record;
    assert.deepEqual([geicoStep(r, GEICO.years).value, howLong(r).value], [geicoBand, amwinsBand], line);
  }
  // Over N: ">5", "5 plus" and "5+" as "over 5": no end, so GEICO's question is the agent's (5-10
  // or 10+), AmWINS' MORE THAN 3 YEARS.
  for (const line of ['Insured >5 years with Synthetic Mutual', 'Insured > 5 years with Synthetic Mutual', 'Insured 5 plus years with Synthetic Mutual',
    'Insured 5+ years with Synthetic Mutual', 'Insured over 5 years with Synthetic Mutual']) {
    assert.deepEqual(tenureOf(line), { years: Infinity, least: 5.1, line }, line);
    const r = intake(DATED, { additional_notes: line }).record;
    agents(geicoStep(r, GEICO.years));
    assert.ok(geicoStep(r, GEICO.years).note.includes(line), line);
    assert.deepEqual([howLong(r).value, howLong(r).source], ['MORE THAN 3 YEARS', 'derived'], line);
  }
  assert.equal(howLong(intake(DATED, { additional_notes: 'Insured >10 years with Synthetic Mutual' }).record).value, 'MORE THAN 3 YEARS');
  assert.equal(geicoStep(intake(DATED, { additional_notes: 'Insured >10 years with Synthetic Mutual' }).record, GEICO.years).value, '10+ Years');
  // Under N: "<5" as "under 5": anything below 5, so both carriers' questions are the agent's
  // (GEICO 1-3 or 3-5; AmWINS 1 TO 2 to MORE THAN 3). "<1 year" stays within 1-3 / 1 TO 2 (R6).
  for (const line of ['Insured <5 years with Synthetic Mutual', 'Insured under 5 years with Synthetic Mutual']) {
    assert.deepEqual(tenureOf(line), { years: 4.9, least: 0, line }, line);
    const r = intake(DATED, { additional_notes: line }).record;
    agents(geicoStep(r, GEICO.years));
    agents(howLong(r));
  }
  const under1 = intake(DATED, { additional_notes: 'Insured <1 year with Synthetic Mutual' });
  assert.deepEqual([geicoStep(under1.record, GEICO.years).value, howLong(under1.record).value], ['1-3 Years', '1 TO 2 YEARS']);
  assert.equal(under1.warnings.find((w) => w.code === 'prior.tenure'), undefined);
  // "Some", "ca.", "maybe" and "up to": the maintainer's answers of 2026-10-27, the test below.
  // A hedge on a line that doesn't name insurance doesn't count.
  assert.equal(tenureOf('About 5ish years in this line of work'), null);
  assert.equal(tenureOf('~5 years'), null);
});

// TNI, 2026-10-27 (round 5, V7): a range of years ("3-5 years", "3 to 5 years", "three to five
// years") gives an answer only when both ends give the same one on that carrier's question;
// otherwise the agent's, the line quoted. Until then the last figure was read.
test('a range of years with the insurer: an answer only when both ends give the same one (round 5, V7)', () => {
  const tenureOf = (line) => insurerTenure(intake(DATED, { additional_notes: line }).record);
  assert.deepEqual(tenureOf('Insured 3-5 years with Synthetic Mutual'), { years: 5, least: 3, line: 'Insured 3-5 years with Synthetic Mutual' });
  assert.deepEqual(tenureOf('Insured three to five years with Synthetic Mutual'), { years: 5, least: 3, line: 'Insured three to five years with Synthetic Mutual' });
  // [line, GEICO's answer (null: the agent's), AmWINS' answer (null: the agent's)]
  for (const [line, geicoBand, amwinsBand] of [
    // Ends in different bands on both carriers' questions or on one.
    ['Insured 3-5 years with Synthetic Mutual', null, null],
    ['Insured 3 to 5 years with Synthetic Mutual', null, null],
    ['Insured three to five years with Synthetic Mutual', null, null],
    ['Insured 3 - 5 yrs with Synthetic Mutual', null, null],
    ['Insured 4-6 years with Synthetic Mutual', null, 'MORE THAN 3 YEARS'],
    ['Insured 1-3 years with Synthetic Mutual', '1-3 Years', null],
    ['Insured 1-2 years with Synthetic Mutual', '1-3 Years', null],
    ['Insured 8-12 years with Synthetic Mutual', null, 'MORE THAN 3 YEARS'],
    // Both ends the same answer: that answer.
    ['Insured 6-8 years with Synthetic Mutual', '5-10 Years', 'MORE THAN 3 YEARS'],
    ['Insured six to eight years with Synthetic Mutual', '5-10 Years', 'MORE THAN 3 YEARS'],
    ['Insured 12-15 years with Synthetic Mutual', '10+ Years', 'MORE THAN 3 YEARS'],
    ['Insured 2-3 years with Synthetic Mutual', '1-3 Years', '2 TO 3 YEARS'],
    ['Insured 3.5 to 4.5 years with Synthetic Mutual', '3-5 Years', 'MORE THAN 3 YEARS'],
  ]) {
    const r = intake(DATED, { additional_notes: line }).record;
    const years = geicoStep(r, GEICO.years);
    if (geicoBand) assert.equal(years.value, geicoBand, line);
    else {
      agents(years);
      assert.equal(years.source, 'fact', line);
      assert.ok(years.note.includes(line), line);
    }
    const step = howLong(r);
    if (amwinsBand) assert.equal(step.value, amwinsBand, line);
    else {
      agents(step);
      assert.equal(step.source, 'fact', line);
      assert.ok(step.note.includes(line), line);
    }
  }
  // Counterexamples: a single figure still reads as itself; a hyphenated "5-year" isn't a range
  // (and isn't read, as before).
  assert.deepEqual(tenureOf('Insured 5 years with Synthetic Mutual'), { years: 5, least: 5, line: 'Insured 5 years with Synthetic Mutual' });
  assert.equal(tenureOf('Has a 5-year policy with Synthetic Mutual'), null);
});

// TNI, 2026-10-27 (round 5, V8): on AmWINS a General Liability, Cargo or Other policy (not proof of
// prior, answer 8) with a time with the insurer in the notes: how long with the current carrier is
// the agent's, as on GEICO. An auto policy with a time keeps its band.
test('AmWINS: a General Liability, Cargo or Other policy with a time with the insurer in the notes is the agent\'s, as GEICO (round 5, V8)', () => {
  for (const type of ['General Liability', 'Cargo', 'Other']) {
    for (const line of ['Insured with Synthetic Mutual for 6 years', 'Insured 2 years with Synthetic Mutual', 'Insured about 1 year with Synthetic Mutual']) {
      const { record: r, warnings } = intake({ ...DATED, ins_type_1: type }, { additional_notes: line });
      const step = howLong(r);
      agents(step);
      assert.deepEqual([step.ignore, step.source, step.manualOnly], [false, 'fact', true], `${type}: ${line}`);
      assert.ok(step.note.includes(type), `${type}: ${line}`);
      assert.ok(step.note.includes(line), `${type}: ${line}`);
      // GEICO: the agent's already (not an auto policy).
      agents(geicoStep(r, GEICO.years));
      const shown = warnings.find((w) => w.code === 'prior.tenure');
      if (shown) assert.doesNotMatch(shown.msg, /take the band/, `${type}: ${line}`);
    }
    // Without a time in the notes: 1 TO 2 YEARS, as before (answer 11).
    const noTime = howLong(intake({ ...DATED, ins_type_1: type }).record);
    assert.deepEqual([noTime.value, noTime.source], ['1 TO 2 YEARS', 'standard'], type);
  }
  // Counterexamples: an auto policy, or one with no type, with a time keeps its band.
  for (const boxes of [DATED, { ...DATED, ins_type_1: 'Personal Auto' }, { ...DATED, ins_type_1: 'Select*' }]) {
    const { record: r, warnings } = intake(boxes, { additional_notes: 'Insured with Synthetic Mutual for 6 years' });
    assert.deepEqual([howLong(r).value, howLong(r).source], ['MORE THAN 3 YEARS', 'derived'], JSON.stringify(boxes));
    assert.match(warnings.find((w) => w.code === 'prior.tenure').msg, /band is filled/);
  }
});

// TNI, 2026-10-26 (round 3, T6): an expired policy with a time with the insurer in the notes:
// AmWINS' how long with the current carrier is the agent's, as GEICO's years with the insurer is
// (an expired policy isn't current, answer 7).
test('AmWINS: an expired policy with a time with the insurer in the notes leaves how long with the current carrier to the agent, as GEICO (round 3, T6)', () => {
  const EXPIRED = { ...DATED, ins_exp_1: '08/31/2026' };
  // TNI, 2026-10-27 (round 5, V9: confirmed): any time, under 2 years too ("about 1 year", "under
  // 1 year"): the agent's.
  for (const line of ['Insured with Synthetic Mutual for 6 years', 'Insured 10 years with Synthetic Mutual', 'Insured 2 years with Synthetic Mutual',
    'Same insurer since 2023', 'Insured about 1 year with Synthetic Mutual', 'Insured under 1 year with Synthetic Mutual']) {
    const { record: r, warnings } = intake(EXPIRED, { additional_notes: line });
    const step = howLong(r);
    agents(step);
    assert.deepEqual([step.ignore, step.source, step.manualOnly], [false, 'fact', true], line);
    assert.match(step.note, /expired/, line);
    assert.ok(step.note.includes(line), line);
    // GEICO unchanged: its years with the insurer is the agent's, the policy having expired.
    const years = geicoStep(r, GEICO.years);
    agents(years);
    assert.match(years.note, /expired/, line);
    // The Intake step, where it shows the line, doesn't promise a band for it.
    const shown = warnings.find((w) => w.code === 'prior.tenure');
    if (shown) {
      assert.match(shown.msg, /expired/, line);
      assert.doesNotMatch(shown.msg, /take the band/, line);
    }
  }
  // Counterexamples: a current policy with the same lines keeps its band (above); an expired
  // policy with no time in the notes keeps 1 TO 2 YEARS (answer 11: asked whatever the prior
  // insurance), GEICO's question still the agent's.
  for (const [line, band, source] of [['Insured with Synthetic Mutual for 6 years', 'MORE THAN 3 YEARS', 'derived'], ['Insured 2 years with Synthetic Mutual', '2 TO 3 YEARS', 'derived']]) {
    const r = intake(DATED, { additional_notes: line }).record;
    assert.deepEqual([howLong(r).value, howLong(r).source], [band, source], line);
    assert.match(intake(DATED, { additional_notes: line }).warnings.find((w) => w.code === 'prior.tenure').msg, /band is filled/, line);
  }
  const expiredNoTime = intake(EXPIRED).record;
  assert.deepEqual([howLong(expiredNoTime).value, howLong(expiredNoTime).source, howLong(expiredNoTime).note], ['1 TO 2 YEARS', 'standard', null]);
  agents(geicoStep(expiredNoTime, GEICO.years));
  // No prior insurance with no time in the notes: 1 TO 2 YEARS, as before (answer 11).
  assert.equal(howLong(intake({ ins_carrier_1: 'NO POP' }).record).value, '1 TO 2 YEARS');
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

// A line that names insurance can give a time that isn't with the insurer: claims-free years, CDL
// or driving years, years in business, a vehicle's age, a lapse, an expiration (PR #194 review).
// That time is no tenure to take a band from: both carriers' how-long questions are the agent's,
// the line quoted, never a band read from it.
test('a time on a line about something else besides insurance is the agent\'s, never a band (PR #194 review)', () => {
  for (const line of ['No insurance claims in 5 years', 'Currently insured. CDL for 12 years', 'In business 8 years, currently insured with Synthetic Mutual',
    'POP on file. Truck is 10 years', 'Currently insured. Business started in 2019', 'Owner has 10 years driving, needs insurance for 2 trucks',
    'Policy expires in 2 years', 'Clean record 5 years. Current insurance with Synthetic Mutual.']) {
    const r = intake(DATED, { additional_notes: line }).record;
    agents(geicoStep(r, GEICO.years));
    assert.ok(geicoStep(r, GEICO.years).note.includes(line), line);
    agents(howLong(r));
    assert.ok(howLong(r).note.includes(line), line);
    assert.equal(geicoStep(r, GEICO.auto).value, 'Yes', `${line}: still currently insured`);
  }
  // No prior insurance, and notes saying how long without it: AmWINS' question isn't 2 TO 3 YEARS.
  const nopop = intake({ ins_carrier_1: 'NO POP' }, { additional_notes: 'No insurance for 2 years' }).record;
  agents(howLong(nopop));
  // Counterexample: a time with the insurer on its own line keeps its band beside such a line.
  const both = intake(DATED, { additional_notes: 'Insured with Synthetic Mutual for 6 years\nCDL for 12 years' }).record;
  assert.deepEqual([geicoStep(both, GEICO.years).value, howLong(both).value], ['5-10 Years', 'MORE THAN 3 YEARS']);
});

// The maintainer, 2026-10-27 (answers to the PR's questions): "some N" and "ca. N" years are N, as
// "about N"; "maybe N" and "up to N" years make the line the agent's, whatever N (no band).
test('"some" and "ca." N years are N; "maybe" and "up to" N years leave the line to the agent (the maintainer, 2026-10-27)', () => {
  const tenureOf = (line) => insurerTenure(intake(DATED, { additional_notes: line }).record);
  for (const line of ['Insured some 5 years with Synthetic Mutual', 'Insured ca. 5 years with Synthetic Mutual']) {
    assert.deepEqual(tenureOf(line), { years: 5, least: 5, line }, line);
    const r = intake(DATED, { additional_notes: line }).record;
    assert.deepEqual([geicoStep(r, GEICO.years).value, geicoStep(r, GEICO.years).source], ['5-10 Years', 'derived'], line);
    assert.deepEqual([howLong(r).value, howLong(r).source], ['MORE THAN 3 YEARS', 'derived'], line);
  }
  // On an edge, as "about 3" (GEICO 1-3, AmWINS 2 TO 3).
  const some3 = intake(DATED, { additional_notes: 'Insured some 3 years with Synthetic Mutual' }).record;
  assert.deepEqual([geicoStep(some3, GEICO.years).value, howLong(some3).value], ['1-3 Years', '2 TO 3 YEARS']);
  // "Maybe" and "up to": the agent's on both carriers, the line quoted, a short time too.
  for (const line of ['Insured maybe 5 years with Synthetic Mutual', 'Insured up to 5 years with Synthetic Mutual',
    'Insured maybe 1 year with Synthetic Mutual', 'Insured up to 1 year with Synthetic Mutual', 'Maybe 3-5 years with the same insurer']) {
    const { record: r, warnings } = intake(DATED, { additional_notes: line });
    const years = geicoStep(r, GEICO.years);
    agents(years);
    assert.equal(years.source, 'fact', line);
    assert.ok(years.note.includes(line), line);
    agents(howLong(r));
    assert.equal(howLong(r).source, 'fact', line);
    assert.ok(howLong(r).note.includes(line), line);
    assert.ok(warnings.find((w) => w.code === 'prior.tenure')?.msg.includes(`"${line}"`), line);
    assert.equal(geicoStep(r, GEICO.auto).value, 'Yes', `${line}: still currently insured`);
  }
  // Counterexamples: not on a line about insurance, not read; a plain time keeps its band.
  assert.equal(tenureOf('Maybe 5 years'), null);
  assert.equal(tenureOf('Up to 5 years'), null);
  const plain = intake(DATED, { additional_notes: 'Insured 5 years with Synthetic Mutual' }).record;
  assert.deepEqual([geicoStep(plain, GEICO.years).value, howLong(plain).value], ['5-10 Years', 'MORE THAN 3 YEARS']);
});

// The maintainer, 2026-10-27 (answers to the PR's questions): two figures joined by "between …
// and", "or", or "N years to M years" are a range, as V7's "3-5 years": an answer only when both
// ends give the same one on that carrier's question, otherwise the agent's, the line quoted. Until
// then each figure was read alone and the longest kept.
test('"between 3 and 5 years", "3 or 4 years" and "1 year to 2 years" are ranges, as V7 (the maintainer, 2026-10-27)', () => {
  const tenureOf = (line) => insurerTenure(intake(DATED, { additional_notes: line }).record);
  assert.deepEqual(tenureOf('Insured between 3 and 5 years with Synthetic Mutual'), { years: 5, least: 3, line: 'Insured between 3 and 5 years with Synthetic Mutual' });
  assert.deepEqual(tenureOf('Insured 3 or 4 years with Synthetic Mutual'), { years: 4, least: 3, line: 'Insured 3 or 4 years with Synthetic Mutual' });
  assert.deepEqual(tenureOf('Insured 1 year to 2 years with Synthetic Mutual'), { years: 2, least: 1, line: 'Insured 1 year to 2 years with Synthetic Mutual' });
  // [line, GEICO's answer (null: the agent's), AmWINS' answer (null: the agent's)]
  for (const [line, geicoBand, amwinsBand] of [
    // Ends in different bands on both carriers' questions or on one.
    ['Insured between 3 and 5 years with Synthetic Mutual', null, null],
    ['Insured between three and five years with Synthetic Mutual', null, null],
    ['Insured 3 or 4 years with Synthetic Mutual', null, null],
    ['Insured 1 year to 2 years with Synthetic Mutual', '1-3 Years', null],
    ['Insured 3 years or 4 years with Synthetic Mutual', null, null],
    ['Insured between 4 years and 6 years with Synthetic Mutual', null, 'MORE THAN 3 YEARS'],
    // Both ends the same answer: that answer.
    ['Insured between 6 and 8 years with Synthetic Mutual', '5-10 Years', 'MORE THAN 3 YEARS'],
    ['Insured 6 or 7 years with Synthetic Mutual', '5-10 Years', 'MORE THAN 3 YEARS'],
    ['Insured 12 years to 15 years with Synthetic Mutual', '10+ Years', 'MORE THAN 3 YEARS'],
    ['Insured 2 or 3 years with Synthetic Mutual', '1-3 Years', '2 TO 3 YEARS'],
  ]) {
    const r = intake(DATED, { additional_notes: line }).record;
    const years = geicoStep(r, GEICO.years);
    if (geicoBand) assert.equal(years.value, geicoBand, line);
    else {
      agents(years);
      assert.equal(years.source, 'fact', line);
      assert.ok(years.note.includes(line), line);
    }
    const step = howLong(r);
    if (amwinsBand) assert.equal(step.value, amwinsBand, line);
    else {
      agents(step);
      assert.equal(step.source, 'fact', line);
      assert.ok(step.note.includes(line), line);
    }
  }
  // Counterexamples: "N or so" is a hedge, not a range; "5 years to date" is the one figure ("N
  // years or more": the follow-up test below); "and" without "between" joins no range.
  assert.deepEqual(tenureOf('Insured 3 or so years with Synthetic Mutual'), { years: 3, least: 3, line: 'Insured 3 or so years with Synthetic Mutual' });
  assert.deepEqual(tenureOf('Insured 5 years to date with Synthetic Mutual'), { years: 5, least: 5, line: 'Insured 5 years to date with Synthetic Mutual' });
  assert.deepEqual(tenureOf('Insured 2 and 6 years with Synthetic Mutual'), { years: 6, least: 6, line: 'Insured 2 and 6 years with Synthetic Mutual' });
});

// The maintainer, 2026-10-27 (answer to the PR's follow-up): "perhaps N years", "possibly N years"
// and a trailing "N years maybe" make the line the agent's, like "maybe N" (any time, no band);
// "N years or more" is "N+", over N. Other words not named stay as they are.
test('"perhaps", "possibly" and a trailing "maybe" leave the line to the agent; "N years or more" is over N (the maintainer, 2026-10-27, follow-up)', () => {
  const tenureOf = (line) => insurerTenure(intake(DATED, { additional_notes: line }).record);
  for (const line of ['Insured perhaps 5 years with Synthetic Mutual', 'Insured possibly 5 years with Synthetic Mutual', 'Insured 5 years maybe with Synthetic Mutual',
    'Insured with Synthetic Mutual 5 years, maybe', 'Insured possibly 1 year with Synthetic Mutual', 'Insured 1 year maybe with Synthetic Mutual']) {
    const { record: r, warnings } = intake(DATED, { additional_notes: line });
    assert.deepEqual(tenureOf(line), { years: Infinity, least: 0, line }, line);
    const years = geicoStep(r, GEICO.years);
    agents(years);
    assert.equal(years.source, 'fact', line);
    assert.ok(years.note.includes(line), line);
    agents(howLong(r));
    assert.equal(howLong(r).source, 'fact', line);
    assert.ok(howLong(r).note.includes(line), line);
    assert.ok(warnings.find((w) => w.code === 'prior.tenure')?.msg.includes(`"${line}"`), line);
  }
  // "N years or more" as "N+": over N, no end. [line, least, GEICO's answer (null: the agent's), AmWINS' answer]
  for (const [line, least, geicoBand, amwinsBand] of [
    ['Insured 6 years or more with Synthetic Mutual', 6.1, null, 'MORE THAN 3 YEARS'],
    ['Insured 3 years or more with Synthetic Mutual', 3.1, null, 'MORE THAN 3 YEARS'],
    ['Insured 10 years or more with Synthetic Mutual', 10.1, '10+ Years', 'MORE THAN 3 YEARS'],
  ]) {
    assert.deepEqual(tenureOf(line), { years: Infinity, least, line }, line);
    const r = intake(DATED, { additional_notes: line }).record;
    const years = geicoStep(r, GEICO.years);
    if (geicoBand) assert.deepEqual([years.value, years.source], [geicoBand, 'derived'], line);
    else {
      agents(years);
      assert.ok(years.note.includes(line), line);
    }
    assert.deepEqual([howLong(r).value, howLong(r).source], [amwinsBand, 'derived'], line);
    // The same answers as "N+".
    const plus = intake(DATED, { additional_notes: line.replace(' years or more', '+ years') }).record;
    assert.deepEqual([geicoStep(plus, GEICO.years).value, howLong(plus).value], [years.value, howLong(r).value], line);
  }
  // Counterexamples: words not named stay as they are (the number alone); "N years or so" stays
  // about N; "maybe" on a line without insurance isn't read.
  assert.deepEqual(tenureOf('Insured probably 5 years with Synthetic Mutual'), { years: 5, least: 5, line: 'Insured probably 5 years with Synthetic Mutual' });
  assert.deepEqual(tenureOf('Insured 5 years perhaps with Synthetic Mutual'), { years: 5, least: 5, line: 'Insured 5 years perhaps with Synthetic Mutual' });
  assert.deepEqual(tenureOf('Insured 6 years or so with Synthetic Mutual'), { years: 6, least: 6, line: 'Insured 6 years or so with Synthetic Mutual' });
  assert.equal(tenureOf('5 years maybe'), null);
});
