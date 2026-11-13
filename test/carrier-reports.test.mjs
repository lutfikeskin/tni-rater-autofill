import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CARRIERS } from '../src/carriers.js';
import { CARRIER_REPORTS, REPORT_KEYS, carrierRefusal } from '../scripts/lib/carrier-reports.mjs';
import { signals } from '../scripts/lib/signals.mjs';

// Audit 2026-11-07, LEARN-17: what the reports know of a carrier was spread over signals.mjs,
// layouts.mjs, coverage.mjs and events.mjs, so a new carrier quietly lost its done quotes, its mock
// check or its portal filter. Now each carrier has one entry, every key said (null where it doesn't
// apply), and a carrier without one fails here.
test('every carrier the extension quotes tells the reports each of its pages and its mock', () => {
  // The local test page's events never reach the reports (events.mjs loadEvents).
  const quoted = CARRIERS.filter((c) => c.id !== 'test').map((c) => c.id);
  assert.deepEqual(Object.keys(CARRIER_REPORTS).sort(), [...quoted].sort());
  for (const id of quoted) {
    for (const key of REPORT_KEYS) assert.notEqual(CARRIER_REPORTS[id][key], undefined, `${id}.${key}: say it, or null where it doesn't apply`);
    const { mock } = CARRIER_REPORTS[id];
    if (mock) assert.ok(fs.existsSync(new URL(`../${mock}`, import.meta.url)), `${id}'s mock ${mock}`);
  }
  // GEICO's quote is done on its stop steps, read from its config: a step added there is done too.
  const geico = CARRIERS.find((c) => c.id === 'geico');
  for (const step of Object.keys(geico.stopSteps)) assert.ok(CARRIER_REPORTS.geico.finalPage.test(`/quote › ${step}`), step);
  assert.equal(CARRIER_REPORTS.geico.finalPage.test('/quote › Quote & Coverages'), false);
  // Its printed quote proposal too (W48-03), and only that page.
  assert.ok(CARRIER_REPORTS.geico.finalPage.test('/PrintQuote'));
  assert.equal(CARRIER_REPORTS.geico.finalPage.test('/PrintQuoteHistory'), false);
});

// W48-03: a decline is the carrier's own stop, read from its config: a stop page, or a stop screen
// marked `stopped`. A stop step or a screen that is the agent's is not.
test("a carrier's refusal is its stop page or its stopped screen, never the agent's step or screen", () => {
  for (const c of CARRIERS) {
    for (const page of Object.keys(c.stopPages ?? {})) assert.ok(carrierRefusal(c.id, `stop: ${page}`), `${c.id} ${page}`);
    for (const step of Object.keys(c.stopSteps ?? {})) assert.equal(carrierRefusal(c.id, `stop: ${step}`), false, `${c.id} ${step}`);
    for (const [name, s] of Object.entries(c.stopButtons ?? {})) assert.equal(carrierRefusal(c.id, `stop: ${name}`), s.stopped === true, `${c.id} ${name}`);
  }
  assert.ok(carrierRefusal('progressive', 'stop: DeclinationNotice'));
  assert.ok(carrierRefusal('geico', 'stop: GEICO referral'));
  assert.equal(carrierRefusal('geico', 'stop: USDOT Number'), false);
  // Another carrier's stop, a blocker that is no stop, or an unknown carrier: no refusal.
  assert.equal(carrierRefusal('geico', 'stop: DeclinationNotice'), false);
  assert.equal(carrierRefusal('progressive', 'needs you: DeclinationNotice'), false);
  assert.equal(carrierRefusal('nobody', 'stop: GEICO referral'), false);
});

test('a quote reaching a carrier\'s final page or click is done, and its login page is counted', () => {
  let t = Date.parse('2026-10-06T12:00:00Z');
  const e = (session, carrier, x) => ({ id: `${session}-${t}`, t: new Date(t += 1000).toISOString(), receivedAt: new Date(t).toISOString(), session, v: '0.9.9', carrier, ...x });
  const quote = (session, carrier, pages, extra = []) => [
    e(session, undefined, { type: 'intake_loaded', state: 'MD' }),
    e(session, carrier, { type: 'fill_run', page: pages[0], blockers: 0, blockerList: [] }),
    ...pages.map((page) => e(session, carrier, { type: 'page_view', page })),
    ...extra.map((x) => e(session, carrier, x)),
  ];
  const s = signals([
    ...quote('g', 'geico', ['/quote', '/quote › MVR & CLUE']),
    ...quote('p', 'progressive', ['AddVehicle', 'PrintEmailFax'], [{ type: 'agent_click', page: 'PrintEmailFax', text: 'Print / Send' }]),
    ...quote('a', 'amwins', ['/application/businessauto', '/auth/login']),
  ], { since: '2026-10-06' });
  assert.deepEqual([s.outcomes.geico.done, s.outcomes.progressive.done, s.outcomes.amwins.done, s.outcomes.amwins.loginInterrupted], [1, 1, 0, 1]);
});
