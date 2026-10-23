import test from 'node:test';
import assert from 'node:assert/strict';
import { readPremium, notePremium, PREMIUM_EVENT } from '../src/premium.js';

// The pages' own words (amounts made up): GEICO's summary beside its pay plans, Progressive's Rates.
const GEICO = "View More Payment Plans\nDue Today $16,908.71\nMVR/CLUE Hasn't run\n12 Month Total Premium:  $101,287.00\nDue Today $16,908.71\n10 Additional Payments of $8,437.83\nInstallment fees will be assessed";
const PROGRESSIVE = 'Hidden Section for Global Background Style\n$12,815.00\nTotal premium amount\n$12,815.00 per year including Electronic Funds Transfer (EFT) discount';

test('the premium a carrier page quotes is read with its term and payments', () => {
  assert.deepEqual(readPremium(GEICO), { total: 101287, termMonths: 12, dueToday: 16908.71, payments: 10, payment: 8437.83 });
  assert.deepEqual(readPremium(PROGRESSIVE.replace(/\n/g, ' ')), { total: 12815, termMonths: 12, dueToday: null, payments: null, payment: null });
  assert.deepEqual(readPremium('Policy term\n$2,400.00 per 6 months'), null, 'no premium named');
  assert.deepEqual(readPremium('Estimated premium: $3,100'), { total: 3100, termMonths: null, dueToday: null, payments: null, payment: null });
});

test('no premium while the page says its rates are out of date, or shows none', () => {
  assert.equal(readPremium(`${GEICO}\nPlease Recalculate Due To Coverage Change`), null);
  assert.equal(readPremium('12 Month Total Premium: $ --.--'), null);
  assert.equal(readPremium('Total premium amount **** per year'), null);
  assert.equal(readPremium(''), null);
  assert.equal(readPremium(undefined), null);
  // A change on one line and Recalculate on another isn't a stale premium (read line by line).
  assert.ok(readPremium(`Coverage changes are saved\n${GEICO}\nRecalculate`));
});

test('a premium is logged once per change, per quote, tab and carrier; a failure logs nothing', async () => {
  const logged = [];
  const seen = new Map();
  const note = (text, key = 'q1|5|geico') => notePremium({ key, step: 'Quote & Coverages', seen, read: async () => text, log: (e) => logged.push(e) });
  assert.equal(await note(GEICO), true);
  assert.equal(await note(GEICO), false, 'the same premium again');
  assert.equal(await note(GEICO, 'q2|5|geico'), true, 'another quote');
  assert.equal(await note(GEICO.replace('101,287.00', '99,000.00')), true, 'a new premium');
  assert.equal(await note('nothing rated'), false);
  // No step (Progressive's pages): none sent.
  await notePremium({ key: 'p', seen, read: async () => GEICO, log: (e) => assert.ok(!('step' in e)) });
  assert.deepEqual(logged.map((e) => [e.type, e.step, e.total]), [[PREMIUM_EVENT, 'Quote & Coverages', 101287], [PREMIUM_EVENT, 'Quote & Coverages', 101287], [PREMIUM_EVENT, 'Quote & Coverages', 99000]]);
  assert.equal(await notePremium({ key: 'k', seen, read: async () => { throw new Error('tab closed'); }, log: () => assert.fail('logged') }), false);
});
