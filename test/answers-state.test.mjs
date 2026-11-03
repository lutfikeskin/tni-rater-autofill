import test from 'node:test';
import assert from 'node:assert/strict';
import { garagingIs, garagingNamed } from '../src/answers/state.js';

const at = (state) => ({ garaging: { state } });

test('garagingIs takes the state code in any case, never its written-out name (GEICO)', () => {
  for (const s of ['TX', 'tx', ' Tx ']) assert.equal(garagingIs(at(s), 'TX'), true, s);
  for (const s of ['FL', 'fl', ' fl ']) assert.equal(garagingIs(at(s), 'FL'), true, s);
  for (const s of ['Texas', 'TEXAS', 'Fla.', 'OK', '', '  ', null, undefined]) assert.equal(garagingIs(at(s), 'TX'), false, String(s));
  assert.equal(garagingIs(at('Florida'), 'FL'), false);
  assert.equal(garagingIs({}, 'FL'), false);
});

test('garagingNamed takes the code or the written-out name in any case, nothing else (Progressive)', () => {
  for (const [code, yes] of [['FL', ['FL', 'fl', 'Florida', 'FLORIDA', ' florida ']], ['TX', ['TX', 'tx', 'Texas', 'texas']],
    ['AR', ['AR', 'Arkansas']], ['MD', ['md', 'MARYLAND']]]) {
    for (const s of yes) assert.equal(garagingNamed(at(s), code), true, `${code} ${s}`);
  }
  for (const s of ['Fla.', 'Fla', 'Florida.', 'FL - Florida', 'TX', '', '  ', null]) assert.equal(garagingNamed(at(s), 'FL'), false, String(s));
  assert.equal(garagingNamed({}, 'TX'), false);
});
