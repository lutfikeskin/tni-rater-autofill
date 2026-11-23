import test from 'node:test';
import assert from 'node:assert/strict';
import { modeSaid } from '../sidepanel/panel/settings-summary.js';

// One case per autoPages × autoAdvance × checkBeforeContinue; "Let me look first" only counts while
// Continue is the panel's.
/** @type {Array<[boolean, boolean, boolean, string]>} */
const cases = [
  [true, true, true, 'Pages fill when they open; it waits for your Looks right, continue.'],
  [true, true, false, 'Pages fill when they open; it continues by itself once nothing is left for you.'],
  [true, false, true, 'Pages fill when they open; you click Continue yourself.'],
  [true, false, false, 'Pages fill when they open; you click Continue yourself.'],
  [false, true, true, 'You start each page with Fill this page; it waits for your Looks right, continue.'],
  [false, true, false, 'You start each page with Fill this page; it continues by itself once nothing is left for you.'],
  [false, false, true, 'You start each page with Fill this page; you click Continue yourself.'],
  [false, false, false, 'You start each page with Fill this page; you click Continue yourself.'],
];
for (const [autoPages, autoAdvance, checkBeforeContinue, said] of cases) {
  test(`modeSaid: autoPages ${autoPages}, autoAdvance ${autoAdvance}, checkBeforeContinue ${checkBeforeContinue}`, () => {
    assert.equal(modeSaid({ autoPages, autoAdvance, checkBeforeContinue }), said);
  });
}

test('modeSaid reads missing switches as their defaults (on)', () => {
  assert.equal(modeSaid(undefined), 'Pages fill when they open; it waits for your Looks right, continue.');
  assert.equal(modeSaid({}), modeSaid({ autoPages: true, autoAdvance: true, checkBeforeContinue: true }));
});
