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

  querySelectorAll() { return [...this.body.controls]; }
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
  assert.equal(h.context.__raterRecorder.version, 3);
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
