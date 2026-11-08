// @ts-nocheck -- not type-checked yet (audit 2026-11-07, QA-08): fix its errors and take this line out
import test from 'node:test';
import assert from 'node:assert/strict';
import { garagingIs } from '../src/answers/state.js';
import { parseEdit } from '../src/normalize.js';

const at = (state) => ({ garaging: { state } });

test('garagingIs takes the state code in any case, never its written-out name', () => {
  for (const s of ['TX', 'tx', ' Tx ']) assert.equal(garagingIs(at(s), 'TX'), true, s);
  for (const s of ['FL', 'fl', ' fl ']) assert.equal(garagingIs(at(s), 'FL'), true, s);
  for (const s of ['Texas', 'TEXAS', 'Fla.', 'OK', '', '  ', null, undefined]) assert.equal(garagingIs(at(s), 'TX'), false, String(s));
  assert.equal(garagingIs(at('Florida'), 'FL'), false);
  assert.equal(garagingIs({}, 'FL'), false);
});

// TNI, 2026-11-03 (Karar 2): a state the agent edits in the panel is saved as its code, so every
// carrier's state rules, which read only the code, see a typed name too.
test('a state typed in the panel is saved as its code; text that isn\'t a state stays as written', () => {
  for (const [typed, code] of [['Florida', 'FL'], [' florida ', 'FL'], ['FLORIDA', 'FL'], ['fl', 'FL'], ['New  York', 'NY'], ['Washington DC', 'DC'], ['texas', 'TX']]) {
    assert.equal(parseEdit('state', typed), code, typed);
    assert.equal(garagingIs(at(parseEdit('state', typed)), code), true, typed);
  }
  assert.equal(parseEdit('state', 'Fla'), 'FLA', 'not a state: kept, upper-cased');
  assert.equal(parseEdit('state', '  '), null);
});
