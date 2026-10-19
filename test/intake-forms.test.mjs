import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readIntakeFields } from '../src/intake.js';
import { normalizeIntake, intakeNotes } from '../src/normalize.js';
import { sourceFields } from '../src/intake-source.js';
import { buildNotesReview, notesWarnings } from '../src/ai/luna.js';
import { buildPlan } from '../src/plan.js';
import { amwins } from '../src/carriers/amwins.js';

// The intake form changed on 2026-10-19: the other-insurance-products box was removed, the claims
// box narrowed with an Additional Notes box beside it, "Do you take loads to Canada?" (Yes/No)
// added to the FEIN / SR22 / ELD row, and the trailer questions reworded (one interchange limit,
// the two equipment values side by side). It keeps the 2026-10-02 team driving / slip seating question, which replaced
// the license plate. Intakes on every version are read.
const pdf = (name) => new Uint8Array(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const oldRaw = await readIntakeFields(pdfjs, pdf('sample-intake.pdf'));
const octRaw = await readIntakeFields(pdfjs, pdf('multi-vehicle-intake.pdf'));
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
  assert.equal(newRaw.team_driving_or_slip_seating, 'No', 'slip seating kept from the 2026-10-02 form');
  assert.ok(!('license_plate' in newRaw) && !('interchange_limit' in newRaw));
  assert.equal(newRaw.trl_interchange, 'No');
});

test('the slip seating question is read; unanswered on intakes before it', () => {
  assert.equal(normalizeIntake(oldRaw, today).record.operations.teamDriving, null);
  const oct = normalizeIntake(octRaw, today);
  assert.equal(oct.record.operations.teamDriving, false);
  assert.ok(!oct.warnings.some((w) => w.code === 'form.unknown-fields'), 'the 2026-10-02 form has no unread field');
  assert.equal(normalizeIntake(newRaw, today).record.operations.teamDriving, false);
  assert.equal(normalizeIntake({ ...newRaw, team_driving_or_slip_seating: 'Yes' }, today).record.operations.teamDriving, true);
  assert.deepEqual(sourceFields('operations.teamDriving'), ['team_driving_or_slip_seating']);
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
  assert.equal(record.trailerInfo.interchange, false);
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
  // A coverage request Luna flags in the notes points at the notes box, one in the claims box at that box.
  const asked = (text) => notesWarnings([{ line: text, ntl: false, coverageChange: true, businessYears: null, businessSince: null, generalLiability: false }], review)[0].path;
  assert.equal(asked('Dec page will be provided'), 'notes.text');
  const claimsReview = buildNotesReview({ ...record, claims: { ...record.claims, text: 'No\nWants hired auto' } });
  assert.equal(notesWarnings([{ line: 'Wants hired auto', ntl: false, coverageChange: true, businessYears: null, businessSince: null, generalLiability: false }], claimsReview)[0].path, 'claims.text');
  const pop = normalizeIntake({ ...newRaw, ins_type_1: 'Commercial Auto', additional_notes: 'POP document unavailable' }, today).record;
  assert.match(buildPlan(pop, amwins).find((s) => s.re === '^disclosure details$').value, /POP document unavailable/);
});
