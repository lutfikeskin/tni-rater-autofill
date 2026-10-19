import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readIntakeFields } from '../src/intake.js';
import { normalizeIntake, intakeNotes } from '../src/normalize.js';
import { sourceFields } from '../src/intake-source.js';
import { buildNotesReview } from '../src/ai/luna.js';
import { buildPlan } from '../src/plan.js';
import { amwins } from '../src/carriers/amwins.js';

// The intake form changed on 2026-10-19: the other-insurance-products box was removed, the claims
// box narrowed with an Additional Notes box beside it, and "Do you take loads to Canada?" (Yes/No)
// added to the FEIN / SR22 / ELD row. Intakes on either form are read.
const pdf = (name) => new Uint8Array(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const oldRaw = await readIntakeFields(pdfjs, pdf('sample-intake.pdf'));
const newRaw = await readIntakeFields(pdfjs, pdf('sample-intake-2026-10.pdf'));
const today = { today: new Date('2026-10-19') };

test('the 2026-10 form has the Additional Notes box and the Canada question, and no other-products box', () => {
  assert.equal(newRaw.loads_to_canada, 'Yes');
  assert.match(newRaw.additional_notes, /Financed/);
  for (const name of ['cross_personal_auto', 'cross_life', 'cross_homeowners', 'cross_renters', 'cross_other', 'cross_other_text']) {
    assert.ok(name in oldRaw, `${name} is on the old form`);
    assert.ok(!(name in newRaw), `${name} is gone from the new form`);
  }
  assert.ok(!('loads_to_canada' in oldRaw) && !('additional_notes' in oldRaw));
});

test('an intake on the old form reads as before: Canada unanswered, no additional notes', () => {
  const { record, warnings, error } = normalizeIntake(oldRaw, today);
  assert.equal(error, undefined);
  assert.equal(record.operations.canadaLoads, null, 'unanswered, not No');
  assert.equal(record.notes.text, null);
  assert.equal(record.claims.hasClaims, false);
  assert.equal(record.operations.vehicleOwnership, 'Financed', 'from the claims box notes, as before');
  assert.deepEqual(record.crossSell, []);
  assert.ok(!warnings.some((w) => w.code === 'form.unknown-fields'));
});

test('an intake on the new form: Canada answered, the notes read like the claims box notes', () => {
  const { record, warnings, error } = normalizeIntake(newRaw, today);
  assert.equal(error, undefined);
  assert.equal(record.operations.canadaLoads, true);
  assert.equal(record.claims.text, 'No');
  assert.equal(record.claims.hasClaims, false);
  assert.equal(record.claims.notes, null);
  assert.match(record.notes.text, /^3 Years\nFinanced\n/);
  assert.equal(record.operations.vehicleOwnership, 'Financed', 'the blank ownership box answered from Additional Notes');
  assert.ok(warnings.some((w) => w.code === 'coverage.ntl' && /Needs NTL too/.test(w.msg)), 'an NTL mention in the notes is a check item');
  assert.ok(!warnings.some((w) => w.code === 'form.unknown-fields'));
  assert.ok(!warnings.some((w) => w.code === 'claims.blank'));
  assert.deepEqual(record.crossSell, []);
  assert.deepEqual(sourceFields('operations.canadaLoads'), ['loads_to_canada']);
  assert.deepEqual(sourceFields('notes.text'), ['additional_notes']);
  assert.deepEqual(sourceFields('coverage.ntl'), ['claims_details', 'additional_notes']);
});

test('the Canada dropdown left on Select* is unanswered; No is No', () => {
  assert.equal(normalizeIntake({ ...newRaw, loads_to_canada: 'Select*' }, today).record.operations.canadaLoads, null);
  assert.equal(normalizeIntake({ ...newRaw, loads_to_canada: 'No' }, today).record.operations.canadaLoads, false);
});

test('the ownership box still wins over the notes; a blank claims box with notes is still flagged blank', () => {
  const leased = normalizeIntake({ ...newRaw, veh_ownership: 'Leased' }, today).record;
  assert.equal(leased.operations.vehicleOwnership, 'Leased');
  const { record, warnings } = normalizeIntake({ ...newRaw, claims_details: '' }, today);
  assert.equal(record.claims.hasClaims, null);
  assert.ok(warnings.some((w) => w.code === 'claims.blank'));
  assert.equal(record.operations.vehicleOwnership, 'Financed');
});

test('Luna reads the claims box and the Additional Notes box; AmWINS reads POP notes from either', () => {
  const { record } = normalizeIntake(newRaw, today);
  assert.equal(intakeNotes(record), `No\n${record.notes.text}`);
  const review = buildNotesReview(record);
  assert.ok(review.lines.includes('Needs NTL too'));
  assert.equal(review.quoted, 'Needs NTL too');
  const pop = normalizeIntake({ ...newRaw, ins_type_1: 'Commercial Auto', additional_notes: 'POP document unavailable' }, today).record;
  assert.match(buildPlan(pop, amwins).find((s) => s.re === '^disclosure details$').value, /POP document unavailable/);
});
