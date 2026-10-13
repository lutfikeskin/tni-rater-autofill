import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const RECORDER = fs.readFileSync(new URL('../src/content/recorder.js', import.meta.url), 'utf8');

class Control {
  constructor(tagName, { id = '', name = '', type = '', value = '', row = '', options = [], attrs = {} } = {}) {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.id = id;
    this.name = name;
    this.type = type || (this.tagName === 'INPUT' ? 'text' : '');
    this.disabled = false;
    this.labels = [];
    this.options = options;
    this._value = String(value ?? '');
    this.attrs = new Map();
    if (id) this.attrs.set('id', id);
    if (name) this.attrs.set('name', name);
    if (row) this.attrs.set('data-row', row);
    for (const [name, attr] of Object.entries(attrs)) this.attrs.set(name, attr);
    this.getClientRects = () => [{}];
  }

  get value() { return this._value; }
  set value(value) { this._value = String(value ?? ''); }
  get selectedOptions() { return this.options.filter((option) => String(option.value) === this._value); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  closest() { return null; }
}

class Document {
  constructor() {
    this.body = { controls: [], append: (...controls) => this.body.controls.push(...controls),
      replaceChild: (next, old) => {
        const index = this.body.controls.indexOf(old);
        if (index < 0) throw new Error('missing control');
        this.body.controls[index] = next;
      } };
    this.title = 'Synthetic recorder page';
  }

  // Headings (the recorder's stepKey) are asked for apart from the controls.
  querySelectorAll(selector) {
    if (/^h1/.test(selector ?? '')) return [...(this.headings ?? [])];
    // Error and validation messages (the recorder's MESSAGES selector).
    if (/role=alert/.test(selector ?? '')) return [...(this.messages ?? [])];
    return [...this.body.controls];
  }
  getElementById(id) { return this.body.controls.find((c) => c.id === id) ?? null; }
  createTreeWalker() { return { currentNode: null, previousNode: () => false }; }
}

function harness() {
  const document = new Document();
  const sent = [];
  const listeners = new Map();
  const messageListeners = new Set();
  const timers = new Map();
  let nextTimer = 1;
  let now = 1_000;
  const FakeDate = class extends Date { static now() { return now; } };
  const context = {
    document,
    location: { origin: 'https://synthetic.example', pathname: '/rater', search: '?pageName=Quote' },
    window: null,
    top: null,
    NodeFilter: { SHOW_TEXT: 4 },
    URLSearchParams,
    Date: FakeDate,
    addEventListener(type, fn) { (listeners.get(type) ?? (listeners.set(type, new Set()), listeners.get(type))).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    setInterval(fn) { const id = nextTimer++; timers.set(id, fn); return id; },
    clearInterval(id) { timers.delete(id); },
    chrome: {
      runtime: {
        id: 'synthetic-extension',
        sendMessage(message) { sent.push(message); return Promise.resolve(); },
        onMessage: {
          addListener(fn) { messageListeners.add(fn); },
          removeListener(fn) { messageListeners.delete(fn); },
        },
      },
    },
    // This mirrors the production helper's contract; production injection supplies the real
    // structural row key, while this harness keeps the key evidence explicit and deterministic.
    __raterFieldKey(el, { q } = {}) {
      if (q) return `q:${q}`;
      const row = el.getAttribute('data-row');
      if (row) return `row:${row}`;
      return `field:${el.name || el.id}`;
    },
  };
  context.window = context;
  context.top = context;
  vm.runInNewContext(RECORDER, context, { filename: 'src/content/recorder.js' });
  return {
    context,
    document,
    sent,
    tick() { for (const fn of timers.values()) fn(); },
    emit(type, target, isTrusted = true) {
      for (const fn of listeners.get(type) ?? []) fn({ type, target, isTrusted });
    },
    message(message) { for (const fn of messageListeners) fn(message); },
    append(...controls) { document.body.append(...controls); },
    replace(next, old) { document.body.replaceChild(next, old); },
    advance(ms) { now += ms; },
  };
}

const select = (options = {}) => new Control('select', {
  options: [{ text: 'Select one', value: '' }, { text: '1', value: '1' }, { text: '3', value: '3' }, { text: '5+', value: '5+' }],
  ...options,
});

function changes(h) {
  return h.sent.filter((message) => message.event === 'field_changes').flatMap((message) => message.changes);
}

test('coalesces multi-keystroke text input into one final manual event', async () => {
  const h = harness();
  const field = new Control('input', { id: 'notes', value: 'before' });
  h.append(field);
  h.context.__raterRecorder.rebaseline();

  field.value = 'b';
  h.emit('input', field, true);
  field.value = 'be';
  h.emit('input', field, true);
  field.value = 'beta';
  h.emit('input', field, true);
  await Promise.resolve();

  assert.equal(changes(h).length, 0, 'typing does not enqueue one event per keystroke');
  h.tick();
  const event = changes(h).find((change) => change.key === 'field:notes');
  assert.equal(changes(h).filter((change) => change.key === 'field:notes').length, 1);
  assert.deepEqual({ key: event.key, before: event.before, after: event.after, agent: event.agent },
    { key: 'field:notes', before: 'before', after: 'beta', agent: true });
});

test('discrete choice flushes immediately without flushing deferred text', async () => {
  const h = harness();
  const text = new Control('input', { id: 'notes', value: 'before' });
  const choice = select({ id: 'choice' });
  h.append(text, choice);
  h.context.__raterRecorder.rebaseline();

  text.value = 'typed';
  h.emit('input', text, true);
  choice.value = '3';
  h.emit('change', choice, true);
  await Promise.resolve();

  assert.equal(changes(h).find((change) => change.key === 'field:choice')?.agent, true);
  assert.equal(changes(h).some((change) => change.key === 'field:notes'), false);
  h.tick();
  assert.equal(changes(h).filter((change) => change.key === 'field:notes').length, 1);
});

test('a delayed trusted native select change marks only that control as manual', () => {
  const h = harness();
  const years = select({ id: 'yrsInBusiness' });
  const scripted = new Control('input', { id: 'scripted', value: 'before' });
  h.append(years, scripted);
  h.context.__raterRecorder.rebaseline();

  h.advance(10_000); // outside the old pointer/keydown gesture window
  years.value = '3';
  h.emit('change', years, true);
  scripted.value = 'page-filled'; // unrelated page mutation in the same polling window
  h.tick();

  assert.equal(changes(h).find((change) => change.key === 'field:yrsInBusiness')?.agent, true);
  assert.equal(changes(h).find((change) => change.key === 'field:scripted')?.agent, false);
});

test('immediate recorder reinjection flushes a trusted change before rebaseline', () => {
  const h = harness();
  const years = select({ id: 'yrsInBusiness' });
  h.append(years);
  h.context.__raterRecorder.rebaseline();

  years.value = '3';
  h.emit('change', years, true);
  // ensureRecorder can reinject while the follow-up Fill action is being started. The pending
  // trusted event must be emitted before that rebaseline replaces the prior snapshot.
  h.context.__raterRecorder.rebaseline();

  assert.equal(changes(h).find((change) => change.key === 'field:yrsInBusiness')?.agent, true);
});

test('trusted input flush reports a blank follow-up revealed before reinjection', () => {
  const h = harness();
  const answer = new Control('input', { id: 'answer' });
  h.append(answer);
  h.context.__raterRecorder.rebaseline();

  answer.value = 'selected';
  h.emit('input', answer, true);
  h.append(new Control('input', { id: 'follow-up' }));
  h.context.__raterRecorder.rebaseline();

  const event = h.sent.find((message) => message.event === 'new_fields');
  assert.equal(event?.keys?.join(','), 'field:follow-up');
});

test('gesture fallback is restricted to the exact trusted control', () => {
  const h = harness();
  const manual = new Control('input', { id: 'manual', value: 'before' });
  const scripted = new Control('input', { id: 'scripted', value: 'before' });
  h.append(manual, scripted);
  h.context.__raterRecorder.rebaseline();

  h.emit('pointerdown', manual, true);
  manual.value = 'manual value';
  scripted.value = 'page value';
  h.tick();

  assert.equal(changes(h).find((change) => change.key === 'field:manual')?.agent, true);
  assert.equal(changes(h).find((change) => change.key === 'field:scripted')?.agent, false);
});

test('an ExtJS option click resolves its related combo, not an unrelated field', () => {
  const h = harness();
  const combo = select({ id: 'combo', attrs: { 'aria-controls': 'combo-popup' } });
  const unrelated = new Control('input', { id: 'unrelated', value: 'before' });
  h.append(combo, unrelated);
  h.context.document.activeElement = combo;
  h.context.__raterRecorder.rebaseline();

  const popup = {
    id: 'combo-popup',
    getAttribute(name) { return name === 'id' ? this.id : null; },
  };
  const option = {
    tagName: 'DIV',
    closest(selector) {
      if (selector === 'input, select, textarea') return null;
      if (selector.includes('[role=option]')) return this;
      if (selector.includes('[role=listbox]')) return popup;
      return null;
    },
    getAttribute() { return null; },
  };
  h.emit('pointerdown', option, true);
  combo.value = '3';
  unrelated.value = 'page value';
  h.tick();

  assert.equal(changes(h).find((change) => change.key === 'field:combo')?.agent, true);
  assert.equal(changes(h).find((change) => change.key === 'field:unrelated')?.agent, false);
});

test('a trusted event followed by a script overwrite does not authorize the final value', () => {
  const h = harness();
  const field = new Control('input', { id: 'answer', value: 'before' });
  h.append(field);
  h.context.__raterRecorder.rebaseline();

  field.value = 'manual';
  h.emit('input', field, true);
  field.value = 'lookup result';
  h.tick();

  assert.equal(changes(h)[0]?.agent, false);
});

test('an already-filled field that appears after the baseline is page-originated', () => {
  const h = harness();
  h.context.__raterRecorder.rebaseline();
  const restored = new Control('input', { id: 'restored', value: 'saved answer' });
  h.append(restored);
  h.tick();

  assert.equal(changes(h)[0]?.agent, false);
});

test('helper keys keep anonymous repeated rows distinct across redraws', () => {
  const h = harness();
  const first = select({ row: 'vehicle-1' });
  const second = select({ row: 'vehicle-2' });
  h.append(first, second);
  h.context.__raterRecorder.rebaseline();

  first.value = '1';
  second.value = '3';
  h.emit('change', first, true);
  h.emit('change', second, true);
  h.tick();
  assert.deepEqual(changes(h).map((change) => change.key).sort(), ['row:vehicle-1', 'row:vehicle-2']);

  const redrawn = select({ row: 'vehicle-1', value: '1' });
  h.replace(redrawn, first);
  h.context.__raterRecorder.rebaseline();
  redrawn.value = '5+';
  h.emit('change', redrawn, true);
  h.tick();
  assert.equal(changes(h).at(-1)?.key, 'row:vehicle-1');
});

test('same-version reinjection rebaselines without adding a second active timer', () => {
  const h = harness();
  const field = new Control('input', { id: 'answer', value: 'before' });
  h.append(field);
  vm.runInNewContext(RECORDER, h.context, { filename: 'src/content/recorder.js' });
  field.value = 'after';
  h.tick();

  assert.equal(changes(h).length, 1, 'the reused recorder should report one change');
  assert.equal(h.context.__raterRecorder.version, 7);
});

test('pause and resume rebaseline the page before recording a later change', () => {
  const h = harness();
  const field = new Control('input', { id: 'answer', value: 'before' });
  h.append(field);
  h.context.__raterRecorder.rebaseline();
  h.message({ ra: 'recorder', cmd: 'pause' });
  field.value = 'while paused';
  h.tick();
  h.message({ ra: 'recorder', cmd: 'resume' });
  field.value = 'after resume';
  h.tick();

  assert.equal(changes(h)[0]?.before, 'while paused');
  assert.equal(changes(h)[0]?.after, 'after resume');
});

test('questions that go away are reported, so the panel can record the page again', () => {
  const h = harness();
  const answer = new Control('input', { id: 'answer' });
  const followUp = new Control('input', { id: 'follow-up' });
  h.append(answer, followUp);
  h.context.__raterRecorder.rebaseline();
  // The answer hides its follow-up question (disabled or hidden: the recorder no longer sees it).
  followUp.disabled = true;
  h.tick();
  assert.deepEqual(h.sent.filter((m) => m.event === 'removed_fields').map((m) => [...m.keys]), [['field:follow-up']]);
  h.tick();
  assert.equal(h.sent.filter((m) => m.event === 'removed_fields').length, 1, 'reported once');
});

// An ExtJS field: an input in a trigger wrap with an arrow (combo) or calendar (date) trigger.
function extField(id, trigger, value = '') {
  const input = new Control('input', { id, value });
  const wrap = { querySelector: (selector) => (selector === '.x-form-trigger' ? { className: `x-form-trigger ${trigger}` } : null) };
  input.closest = (selector) => (selector === '.x-form-trigger-wrap' ? wrap : null);
  return input;
}

test('an ExtJS combo is reported as a combo, so its typed text is not logged as a choice', () => {
  const h = harness();
  const model = extField('model', 'x-form-arrow-trigger');
  const effective = extField('effective', 'x-form-date-trigger');
  const native = select({ id: 'native' });
  h.append(model, effective, native);
  h.context.__raterRecorder.rebaseline();

  model.value = 'Trans';
  effective.value = '10/05/2026';
  native.value = '3';
  h.tick();

  const byKey = Object.fromEntries(changes(h).map((change) => [change.key, change]));
  assert.deepEqual([byKey['field:model'].kind, byKey['field:model'].combo, byKey['field:model'].after], ['select', true, 'Trans']);
  assert.deepEqual([byKey['field:effective'].kind, byKey['field:effective'].combo], ['text', undefined], 'a date picker stays text');
  assert.deepEqual([byKey['field:native'].kind, byKey['field:native'].combo], ['select', undefined], 'a native select is a choice as before');
});

test('an older recorder is replaced, so changes carry what the current one reports', () => {
  const h = harness();
  const disposed = [];
  // A version-6 recorder still installed in the page (it didn't report the agent's clicks).
  h.context.__raterRecorder.dispose();
  h.context.__raterRecorder = { version: 6, rebaseline() {}, dispose() { disposed.push(6); } };
  vm.runInNewContext(RECORDER, h.context, { filename: 'src/content/recorder.js' });
  assert.deepEqual(disposed, [6]);
  assert.equal(h.context.__raterRecorder.version, 7);
});

test('a recorder orphaned by an extension reload is replaced, not reused', () => {
  const h = harness();
  const old = h.context.__raterRecorder;
  vm.runInNewContext(RECORDER, h.context, { filename: 'src/content/recorder.js' });
  assert.equal(h.context.__raterRecorder, old, 'a live recorder of this version is reused');
  // The extension is reloaded: the old recorder's runtime is gone.
  const runtime = h.context.chrome.runtime;
  h.context.chrome.runtime = {};
  assert.equal(old.alive(), false);
  h.context.chrome.runtime = runtime;
  old.alive = () => false;
  vm.runInNewContext(RECORDER, h.context, { filename: 'src/content/recorder.js' });
  assert.notEqual(h.context.__raterRecorder, old);
  assert.equal(h.context.__raterRecorder.alive(), true);
});

// Contract 1 (audit 2026-10-08): a change on a one-address application (AmWINS) names the step it
// was on, as pagekit's stepKey reads the visible headings; the panel keeps it only for such carriers.
test('field changes name the visible step headings, when the page has any', () => {
  const h = harness();
  const field = select({ id: 'bodyType', value: '1' });
  h.append(field);
  h.context.__raterRecorder.rebaseline();
  field.value = '3';
  h.emit('change', field, true);
  h.tick();
  let message = h.sent.filter((m) => m.event === 'field_changes').at(-1);
  assert.equal(message.step, undefined, 'no headings: no step');
  h.document.headings = [
    { tagName: 'H3', textContent: ' Vehicles ', getClientRects: () => [{}] },
    { tagName: 'H1', textContent: 'Hidden title', getClientRects: () => [] },
    { tagName: 'H2', textContent: 'Unit 1', getClientRects: () => [{}] },
  ];
  field.value = '5+';
  h.emit('change', field, true);
  h.tick();
  message = h.sent.filter((m) => m.event === 'field_changes').at(-1);
  assert.equal(message.step, 'Vehicles / Unit 1');
  assert.equal(message.changes[0].after, '5+');
});

// Codex reproduction (2026-10-08): a trusted change made while paused produced no event and
// became the baseline, so the panel never protected it.
test('an agent edit while paused is reported as theirs on resume; the extension\'s own answers are not', async () => {
  const h = harness();
  const years = select({ id: 'yrsInBusiness' });
  const name = new Control('input', { id: 'name' });
  h.append(years, name);
  h.context.__raterRecorder.rebaseline();
  h.message({ ra: 'recorder', cmd: 'pause' });
  // The fill types the name (no trusted event) and reveals a question; the agent picks the years
  // and answers the revealed question meanwhile.
  name.value = 'Example LLC';
  h.emit('pointerdown', years, true);
  years.value = '3';
  h.emit('change', years, true);
  const revealed = select({ id: 'radius' });
  h.append(revealed);
  h.emit('keydown', revealed, true);
  revealed.value = '5+';
  h.emit('change', revealed, true);
  await Promise.resolve();
  h.tick();
  assert.equal(changes(h).length, 0, 'nothing is reported while paused');
  h.message({ ra: 'recorder', cmd: 'resume' });
  assert.deepEqual(changes(h).map((c) => [c.key, c.before, c.after, c.agent]),
    [['field:yrsInBusiness', '', '3', true], ['field:radius', '', '5+', true]]);
  assert.equal(h.sent.filter((m) => m.event === 'new_fields').length, 0, 'the fill answered what it revealed');
  // The baseline moved on with the resume: a later change starts from what the fill typed.
  name.value = 'Example Inc';
  h.tick();
  const later = changes(h).at(-1);
  assert.deepEqual([later.key, later.before, later.after, later.agent], ['field:name', 'Example LLC', 'Example Inc', false]);
});

test('an untrusted change while paused, or a trusted one the page replaced, is not the agent\'s on resume', async () => {
  const h = harness();
  const notes = new Control('input', { id: 'notes', value: 'before' });
  const years = select({ id: 'yrsInBusiness' });
  h.append(notes, years);
  h.context.__raterRecorder.rebaseline();
  h.message({ ra: 'recorder', cmd: 'pause' });
  notes.value = 'by the page';
  h.emit('input', notes, false);
  h.emit('pointerdown', years, true);
  years.value = '3';
  h.emit('change', years, true);
  years.value = '1'; // a page script changed it after the agent's pick
  await Promise.resolve();
  h.message({ ra: 'recorder', cmd: 'resume' });
  assert.equal(h.sent.filter((m) => m.event === 'field_changes').length, 0);
  notes.value = 'after';
  h.tick();
  assert.deepEqual(changes(h).map((c) => [c.key, c.before, c.after, c.agent]), [['field:notes', 'by the page', 'after', false]]);
});

// Codex review (2026-10-09): Chromium fires trusted input/change for the kit's own .click() on a
// radio or checkbox. While paused, such an event with no gesture before it is the fill's answer.
test('while paused, a trusted change with no gesture before it is the fill\'s own click, not the agent\'s', async () => {
  const h = harness();
  const radius = select({ id: 'radius' });
  const years = select({ id: 'yrsInBusiness' });
  h.append(radius, years);
  h.context.__raterRecorder.rebaseline();
  h.emit('pointerdown', years, true); // an old gesture, before the fill started
  h.advance(5_000);
  h.message({ ra: 'recorder', cmd: 'pause' });
  radius.value = '5+';
  h.emit('input', radius, true);
  h.emit('change', radius, true);
  await Promise.resolve();
  h.message({ ra: 'recorder', cmd: 'resume' });
  assert.equal(h.sent.filter((m) => m.event === 'field_changes').length, 0, 'the fill\'s answer is not reported as the agent\'s');
  // With a gesture just before it, the same change while paused is the agent's.
  h.message({ ra: 'recorder', cmd: 'pause' });
  h.advance(1_000);
  h.emit('pointerdown', years, true);
  h.advance(500);
  years.value = '3';
  h.emit('input', years, true);
  h.emit('change', years, true);
  await Promise.resolve();
  h.message({ ra: 'recorder', cmd: 'resume' });
  assert.deepEqual(changes(h).map((c) => [c.key, c.before, c.after, c.agent]), [['field:yrsInBusiness', '', '3', true]]);
});

// Codex review on b62188f: an agent edit on one field starts a follow-up fill about 600 ms later;
// the fill's click on another radio within the 2 s is not the agent's, the gesture was elsewhere.
test('while paused, a trusted change counts only when the last gesture was on that control or its label', async () => {
  const h = harness();
  const years = select({ id: 'yrsInBusiness' });
  const hazmatYes = new Control('input', { id: 'hazmatYes', name: 'hazmat', type: 'radio', value: 'Yes' });
  const hazmatNo = new Control('input', { id: 'hazmatNo', name: 'hazmat', type: 'radio', value: 'No' });
  hazmatYes.checked = false;
  hazmatNo.checked = false;
  h.append(years, hazmatYes, hazmatNo);
  h.context.__raterRecorder.rebaseline();
  // The agent picks the years; that change is reported at once, as theirs.
  h.emit('pointerdown', years, true);
  years.value = '3';
  h.emit('change', years, true);
  await Promise.resolve();
  assert.deepEqual(changes(h).map((c) => [c.key, c.after, c.agent]), [['field:yrsInBusiness', '3', true]]);
  // The follow-up fill starts and clicks the hazmat radio, which fires trusted input/change.
  h.advance(600);
  h.message({ ra: 'recorder', cmd: 'pause' });
  h.advance(200);
  hazmatNo.checked = true;
  h.emit('input', hazmatNo, true);
  h.emit('change', hazmatNo, true);
  await Promise.resolve();
  h.message({ ra: 'recorder', cmd: 'resume' });
  assert.equal(changes(h).length, 1, 'the fill\'s radio click is not reported as the agent\'s');
  // A gesture on the label of a radio in the group, then a change on the radio: the agent's.
  const label = { tagName: 'LABEL', htmlFor: 'hazmatYes', getAttribute: () => null, closest() { return this; } };
  h.message({ ra: 'recorder', cmd: 'pause' });
  h.advance(300);
  h.emit('pointerdown', label, true);
  hazmatNo.checked = false;
  hazmatYes.checked = true;
  h.emit('input', hazmatYes, true);
  h.emit('change', hazmatYes, true);
  await Promise.resolve();
  h.message({ ra: 'recorder', cmd: 'resume' });
  assert.deepEqual(changes(h).slice(1).map((c) => [c.key, c.before, c.after, c.agent]), [['field:hazmat', 'No', 'Yes', true]]);
});

test('a new error or validation message is reported once, without its text', () => {
  const h = harness();
  const message = (text) => ({ textContent: text, getClientRects: () => [{}] });
  h.document.messages = [message('Enter your email')];
  h.context.__raterRecorder.rebaseline();
  h.tick();
  assert.equal(h.sent.filter((m) => m.event === 'new_messages').length, 0, 'messages already on the page are no news');
  // A Continue the carrier refused.
  h.document.messages = [message('Enter your email'), message('This field is required')];
  h.tick();
  h.tick();
  const sent = h.sent.filter((m) => m.event === 'new_messages');
  assert.deepEqual(sent.map((m) => Object.keys(m).sort()), [['event', 'page', 'ra']], 'once, and never the message text');
  // A message going away is no news either; a hidden one isn't shown.
  h.document.messages = [{ textContent: 'Hidden', getClientRects: () => [] }];
  h.tick();
  assert.equal(h.sent.filter((m) => m.event === 'new_messages').length, 1);
});

test('a button the agent clicks is reported by its text; the extension\'s own clicks are not', () => {
  const h = harness();
  const button = { value: '', textContent: '  Recalculate  ', closest: (sel) => (/button/.test(sel) ? button : null) };
  h.emit('click', button, true);
  h.emit('click', button, false);
  h.emit('click', { closest: () => null }, true);
  const clicks = h.sent.filter((m) => m.event === 'agent_click');
  assert.deepEqual(clicks.map((m) => m.text), ['Recalculate'], 'one trusted click on a button; nothing for an untrusted click or one on no button');
  assert.ok(clicks[0].page);
});
