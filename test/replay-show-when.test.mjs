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

test('the replay finds a trigger by its identity and compares answers as layouts do', () => {
  const first = { kind: 'checkbox', caption: 'Same as mailing', dataId: 'mailing1' };
  const second = { kind: 'checkbox', caption: 'Same as mailing', dataId: 'mailing2' };
  const follow = { kind: 'text', caption: 'Garaging street', showWhen: { q: null, dataId: 'mailing2', caption: 'Same as mailing', is: ['unchecked'] } };
  const fields = [first, second, follow];
  const texts = new Map([[first, 'checked'], [second, 'unchecked']]);
  assert.equal(shows(follow, fields, (f) => texts.get(f)), true, 'its own trigger, not the first field with that caption');
  texts.set(second, 'checked');
  assert.equal(shows(follow, fields, (f) => texts.get(f)), false);
  const yes = { q: '2A2', caption: 'Placards', showWhen: { q: '2A1', caption: 'Hauls hazmat?', is: ['YES'] } };
  assert.equal(shows(yes, [{ q: '2A1', caption: 'Hauls hazmat?' }, yes], () => 'Yes '), true, 'case and spacing aside');
});

test('a follow-up of a hidden follow-up is hidden too, and a caption-only trigger matches its kind', () => {
  const owned = { q: '2B1', caption: 'Owned or leased?' };
  const leased = { q: '2B2', caption: 'Lease company', showWhen: { q: '2B1', caption: 'Owned or leased?', is: ['Leased'] } };
  const address = { q: '2B3', caption: 'Lease company address', showWhen: { q: '2B2', caption: 'Lease company', is: ['Other'] } };
  const fields = [owned, leased, address];
  const answers = new Map([[owned, 'Leased'], [leased, 'Other']]);
  assert.equal(shows(address, fields, (f) => answers.get(f)), true);
  answers.set(owned, 'Owned');
  assert.equal(shows(address, fields, (f) => answers.get(f)), false, 'its trigger is hidden, its old answer no longer counts');
  const box = { kind: 'checkbox', caption: 'Same as mailing' };
  const text = { kind: 'text', caption: 'Same as mailing' };
  const follow = { kind: 'text', caption: 'Street', showWhen: { q: null, kind: 'checkbox', caption: 'Same as mailing', is: ['unchecked'] } };
  assert.equal(shows(follow, [text, box, follow], (f) => (f === box ? 'unchecked' : 'unchecked')), true);
  assert.equal(shows(follow, [text, box, follow], (f) => (f === box ? 'checked' : 'unchecked')), false, 'the checkbox, not the text box with that caption');
});
