import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = {};
vm.runInNewContext(fs.readFileSync(new URL('./replay/show-when.js', import.meta.url), 'utf8'), context);
const shows = context.replayShows;

test('the replay draws a follow-up only while its trigger has an answer it was seen showing with', () => {
  const hazmat = { q: '2A1', kind: 'radio', caption: 'Hauls hazmat?' };
  const placards = { q: '2A2', kind: 'text', caption: 'Placards carried', showWhen: { q: '2A1', caption: 'Hauls hazmat?', is: ['Yes'] } };
  const fields = [hazmat, placards];
  const answered = (text) => (f) => (f === hazmat ? text : undefined);
  assert.equal(shows(placards, fields, answered('Yes')), true);
  assert.equal(shows(placards, fields, answered('No')), false);
  assert.equal(shows(placards, fields, answered(undefined)), false, 'unanswered hides it, as on the page');
  assert.equal(shows(hazmat, fields, answered(undefined)), true, 'no condition: always drawn');
  assert.equal(shows(placards, [placards], answered('No')), true, 'its trigger is not on the page: drawn as before');
  // A trigger without a question id is found by its caption.
  const unnamed = { kind: 'checkbox', caption: 'Vehicle has no equipment' };
  const value = { kind: 'text', caption: 'Equipment value', showWhen: { q: null, caption: 'Vehicle has no equipment', is: ['unchecked'] } };
  assert.equal(shows(value, [unnamed, value], (f) => (f === unnamed ? 'unchecked' : undefined)), true);
  assert.equal(shows(value, [unnamed, value], (f) => (f === unnamed ? 'checked' : undefined)), false);
});
