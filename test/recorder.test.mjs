import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const RECORDER = fs.readFileSync(new URL('../src/content/recorder.js', import.meta.url), 'utf8');
const FIELD_KEY = fs.readFileSync(new URL('../src/content/field-key.js', import.meta.url), 'utf8');

// The selectors the recorder asks a node about: comma-separated parts made of a tag, [attr],
// [attr=value], .class and :not(.class).
function matches(node, selector) {
  return String(selector).split(',').some((part) => {
    const nots = [...part.matchAll(/:not\(\.([\w-]+)\)/g)].map((m) => m[1]);
    const s = part.replace(/:not\([^)]*\)/g, '').trim();
    const tag = s.match(/^[a-z][\w-]*/i)?.[0];
    if (tag && tag.toUpperCase() !== node.tagName) return false;
    const classes = String(node.className ?? '').split(/\s+/);
    if ([...s.matchAll(/\.([\w-]+)/g)].some((m) => !classes.includes(m[1])) || nots.some((c) => classes.includes(c))) return false;
    return [...s.matchAll(/\[([\w-]+)(?:=([^\]]*))?\]/g)].every(([, name, value]) => {
      const actual = name === 'type' ? node.type : node.getAttribute?.(name);
      return actual != null && (value === undefined || actual === value);
    });
  });
}

class Control {
  constructor(tagName, { id = '', name = '', type = '', value = '', row = '', options = [], attrs = {}, className = '' } = {}) {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.id = id;
    this.name = name;
    this.className = className;
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
  matches(selector) { return matches(this, selector); }
  closest() { return null; }
}

// Any other element: a design-system host (GEICO's <gds-radio-button>, <gds-button>), a slotted
// span, a slot. Its text is its own and its children's, as textContent reads the light DOM.
class Element {
  constructor(tagName, { attrs = {}, text = '', children = [] } = {}) {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.attrs = new Map(Object.entries(attrs));
    this.className = this.attrs.get('class') ?? '';
    this.text = text;
    this.children = children;
    this.parentElement = null;
    for (const child of children) child.parentElement = this;
  }

  get textContent() { return this.text + this.children.map((child) => child.textContent).join(''); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  hasAttribute(name) { return this.attrs.has(name); }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  removeAttribute(name) { this.attrs.delete(name); }
  matches(selector) { return matches(this, selector); }
  querySelectorAll(selector) { return descendants(this.children).filter((n) => matches(n, selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest() { return null; }
  getClientRects() { return [{}]; }
}

const descendants = (nodes) => nodes.flatMap((n) => [n, ...descendants(n.children ?? [])]);

// An open shadow root holding `nodes`, attached to `host`.
function attachShadow(host, nodes) {
  const root = {
    host,
    children: nodes,
    querySelectorAll: (selector) => descendants(nodes).filter((n) => matches(n, selector)),
    querySelector: (selector) => root.querySelectorAll(selector)[0] ?? null,
    getElementById: (id) => descendants(nodes).find((n) => n.id === id) ?? null,
  };
  for (const node of nodes) node.getRootNode = () => root;
  host.shadowRoot = root;
  return root;
}

// A GEICO radio option as the saved pages draw it (<gds-radio-button>): the host has the group's
// name and, once picked, [checked]; its radio input is alone in the host's open shadow root, named
// like the host, with an id of its own (-shadow); the option's words are the host's [slot=label]
// child, which the input's label shows through a slot (the label itself has no text).
function gdsOption(name, n, value, words, { checked = false } = {}) {
  const label = new Element('span', { attrs: { slot: 'label' }, text: words });
  const host = new Element('gds-radio-button', { attrs: { id: `${name}${n}`, name, value, ...(checked ? { checked: '' } : {}) }, children: [label] });
  const input = new Control('input', { id: `${name}${n}-shadow`, name, type: 'radio', value });
  input.checked = checked;
  input.labels = [new Element('label', { text: '  ' })];
  const checkmark = new Element('span', { attrs: { class: 'checkmark' } });
  const root = attachShadow(host, [input, checkmark]);
  return { host, input, label, checkmark, root };
}

// Its group (<gds-radio-button-group>): the question is the [slot=legend] child, with a tooltip whose
// help text is light DOM too.
function gdsGroup(name, options, { question = '', help = '' } = {}) {
  const legend = question ? [new Element('span', { attrs: { slot: 'legend' }, children: [
    new Element('span', { text: question }),
    new Element('gds-tooltip', { children: [new Element('p', { text: help })] }),
  ] })] : [];
  const group = new Element('gds-radio-button-group', { attrs: { id: name }, children: [...legend, ...options.map((o) => o.host)] });
  attachShadow(group, [new Element('fieldset')]);
  return group;
}

// The agent's pick of an option, as it reaches the window: the pointer on the option's words (or
// in its shadow root), then the input event, retargeted to the host (composed; its change event is
// not, and never reaches the window). The page has checked the inner input; the host shows the
// pick once the page has handled the event (show()).
function pickOption(h, option, { on = option.label } = {}) {
  const inShadow = on.getRootNode?.() === option.root;
  h.emit('pointerdown', inShadow ? option.host : on, true, { composedPath: () => (inShadow ? [on, option.root, option.host] : [on, option.host]) });
  option.input.checked = true;
  h.emit('input', option.host, true, { composedPath: () => [option.input, option.root, option.host] });
}
const show = (option, ...others) => {
  for (const other of others) other.host.removeAttribute('checked');
  option.host.setAttribute('checked', '');
};

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
    // GEICO's step progress bar. Like any selector this fake doesn't know, it returns the controls
    // too: the recorder keeps only the bars.
    if (/gds-progress-bar/.test(selector ?? '')) return [...this.body.controls, ...(this.bars ?? [])];
    // Error and validation messages (the recorder's MESSAGES selector).
    if (/role=alert/.test(selector ?? '')) return [...(this.messages ?? [])];
    return [...this.body.controls];
  }
  getElementById(id) { return [...this.body.controls, ...(this.captions ?? [])].find((c) => c.id === id) ?? null; }
  createTreeWalker() { return { currentNode: null, previousNode: () => false }; }
}

// realKeys: the field keys of src/content/field-key.js (GEICO's data-model names), not this file's
// explicit stand-in.
function harness({ realKeys = false } = {}) {
  const document = new Document();
  const sent = [];
  const listeners = new Map();
  const messageListeners = new Set();
  const timers = new Map();
  const timeouts = [];
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
    // A later task: run by later(), after the page has handled the event.
    setTimeout(fn) { timeouts.push(fn); return nextTimer++; },
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
  if (realKeys) {
    delete context.__raterFieldKey;
    vm.runInNewContext(FIELD_KEY, context, { filename: 'src/content/field-key.js' });
  }
  vm.runInNewContext(RECORDER, context, { filename: 'src/content/recorder.js' });
  return {
    context,
    document,
    sent,
    tick() { for (const fn of timers.values()) fn(); },
    later() { while (timeouts.length) timeouts.shift()(); },
    // extra: more of the event, such as its composedPath.
    emit(type, target, isTrusted = true, extra = {}) {
      for (const fn of listeners.get(type) ?? []) fn({ type, target, isTrusted, ...extra });
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
  h.context.__raterRecorder.rebaseline();
  vm.runInNewContext(RECORDER, h.context, { filename: 'src/content/recorder.js' });
  field.value = 'after';
  h.tick();

  assert.equal(changes(h).length, 1, 'the reused recorder should report one change');
  assert.equal(h.context.__raterRecorder.version, 12);
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
  // A version-7 recorder still installed in the page (it didn't send a step shown by itself).
  h.context.__raterRecorder.dispose();
  h.context.__raterRecorder = { version: 7, rebaseline() {}, dispose() { disposed.push(7); } };
  vm.runInNewContext(RECORDER, h.context, { filename: 'src/content/recorder.js' });
  assert.deepEqual(disposed, [7]);
  assert.equal(h.context.__raterRecorder.version, 12);
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

// Live run 2026-10-19: going back and forth between AmWINS' Drivers and Vehicles tabs sometimes left
// the panel on the other step's report, when the step shown changed no answer and showed no new
// question. A change of the step headings is sent by itself, once.
test('a move to another step is sent when only the headings change', () => {
  const h = harness();
  const heading = (text) => [{ tagName: 'H3', textContent: text, getClientRects: () => [{}] }];
  h.document.headings = heading('Drivers');
  h.tick();
  assert.deepEqual(h.sent.filter((m) => m.event === 'step_shown').map((m) => m.step), ['Drivers']);
  h.tick();
  assert.equal(h.sent.filter((m) => m.event === 'step_shown').length, 1, 'the same step is not sent again');
  h.document.headings = heading('Vehicles');
  h.tick();
  h.document.headings = heading('Drivers');
  h.tick();
  assert.deepEqual(h.sent.filter((m) => m.event === 'step_shown').map((m) => m.step), ['Drivers', 'Vehicles', 'Drivers']);
  h.document.headings = [];
  h.tick();
  assert.equal(h.sent.filter((m) => m.event === 'step_shown').length, 3, 'no headings: nothing to send');
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

// Duck Creek (Progressive) ids: f_<letter><32 hex group><question id>_<page>_<row>, a radio's
// option numbered after its row; the question's caption is the label c_<same id>.
const DCT = 'm459E6B06C4424B0BABF82E0824D0EA8A';
const dctCaption = (id, text, note = '') => ({ id: `c_${id}`, childNodes: [
  { textContent: text },
  ...(note ? [{ textContent: note, classList: { contains: (c) => c === 'lowerLabelText' } }] : []),
] });

// Live run 2026-10-20 (AR Progressive): the agent's Yes on Rates question 222B was logged with the
// text of the cargo commodity row above it. textBefore skips labels, and the caption is one.
test('a Duck Creek question is named by its caption, as pagekit names it', () => {
  const h = harness();
  const radio = (option, value) => {
    const el = new Control('input', { id: `f_${DCT}222B_8_1_${option}-inputEl`, name: 'boolean_222B', type: 'radio', value });
    el.labels = [{ textContent: value === '1' ? 'Yes' : 'No' }];
    el.checked = false;
    return el;
  };
  const yes = radio(0, '1');
  const no = radio(1, '0');
  const limit = extField(`f_${DCT}225C_8_1-inputEl`, 'x-form-arrow-trigger');
  h.document.captions = [
    dctCaption(`${DCT}222B_8_1`, 'Does the customer earn 100% of his or her income from for hire trucking operations?', '(A note under the question.)'),
    dctCaption(`${DCT}225C_8_1`, 'General Liability'),
  ];
  h.append(yes, no, limit);
  h.context.__raterRecorder.rebaseline();

  h.emit('pointerdown', yes, true);
  yes.checked = true;
  h.emit('change', yes, true);
  limit.value = '$1,000,000/ $2,000,000 Aggregate';
  h.tick();

  const byKey = Object.fromEntries(changes(h).map((c) => [c.key, c]));
  assert.deepEqual([byKey['q:222B'].label, byKey['q:222B'].after],
    ['Does the customer earn 100% of his or her income from for hire trucking operations?', 'Yes'], 'the caption, without the note under it');
  assert.equal(byKey['q:225C'].label, 'General Liability');
});

test('a field without a caption keeps its own label', () => {
  const h = harness();
  const field = new Control('input', { id: `f_${DCT}2190_8_1-inputEl` });
  field.labels = [{ textContent: 'Own label' }];
  h.append(field);
  h.context.__raterRecorder.rebaseline();
  field.value = 'typed';
  h.tick();
  assert.equal(changes(h)[0]?.label, 'Own label');
});

// Live run 2026-10-20 (AR Progressive): the agent picked the General Liability limit and clicked
// "Done with this coverage" within one poll. The tab update reinjected the recorder and the panel
// told it to resume; both took the page as the new baseline, and an ExtJS combo pick fires no
// input/change event to flush first, so the pick was never logged.
test('a combo pick just before the recorder is reinjected is reported, once, as the agent\'s', () => {
  const h = harness();
  const limit = extField('limit', 'x-form-arrow-trigger');
  h.append(limit);
  h.context.__raterRecorder.rebaseline();

  h.emit('pointerdown', limit, true);
  limit.value = '$1,000,000/ $2,000,000 Aggregate';
  vm.runInNewContext(RECORDER, h.context, { filename: 'src/content/recorder.js' });
  h.message({ ra: 'recorder', cmd: 'resume' });
  h.tick();

  assert.deepEqual(changes(h).map((c) => [c.key, c.before, c.after, c.agent]),
    [['field:limit', '', '$1,000,000/ $2,000,000 Aggregate', true]]);
});

test('resume while not paused reports what changed since the last poll', () => {
  const h = harness();
  const limit = extField('limit', 'x-form-arrow-trigger');
  h.append(limit);
  h.context.__raterRecorder.rebaseline();
  h.emit('pointerdown', limit, true);
  limit.value = '$1,000,000/ $1,000,000 Aggregate';
  h.message({ ra: 'recorder', cmd: 'resume' });
  assert.deepEqual(changes(h).map((c) => [c.after, c.agent]), [['$1,000,000/ $1,000,000 Aggregate', true]]);
});

test('reinjection while paused leaves the fill\'s answers unreported until resume', () => {
  const h = harness();
  const name = new Control('input', { id: 'name' });
  h.append(name);
  h.context.__raterRecorder.rebaseline();
  h.message({ ra: 'recorder', cmd: 'pause' });
  name.value = 'Example LLC'; // the fill's own answer
  vm.runInNewContext(RECORDER, h.context, { filename: 'src/content/recorder.js' });
  h.message({ ra: 'recorder', cmd: 'resume' });
  h.tick();
  assert.equal(changes(h).length, 0);
});

// GEICO (sales.geico.com, saved pages 2026-10-20) draws its radios in open shadow roots, one per
// option: the recorder saw 3 of the 7 questions on Business Class & USDOT, and an agent's radio
// correction was never logged (the input event reaches the window retargeted to the host).
test('GEICO radios in shadow roots are fields in page order, and the agent\'s pick is theirs once the option shows it', async () => {
  const h = harness({ realKeys: true });
  const name = 'Id_GiveCurrentGeicoCommercialAutoPolicyYesNo_48657';
  const yes = gdsOption(name, 0, 'Yes', 'Yes', { checked: true });
  const no = gdsOption(name, 1, 'No', 'No');
  const group = gdsGroup(name, [yes, no], { question: 'Does the business have a current GEICO commercial auto policy?', help: 'Help text in a tooltip.' });
  const zip = new Control('input', { id: 'Id_GiveInitialZipCode_54827', name: 'Id_GiveInitialZipCode_54827' });
  const dot = new Control('input', { id: 'Id_GiveDepartmentOfTransportationNumber_1203', name: 'Id_GiveDepartmentOfTransportationNumber_1203', type: 'tel' });
  h.append(zip, group, yes.host, no.host, dot);
  h.tick();
  assert.deepEqual([...h.sent.find((m) => m.event === 'new_fields').keys],
    ['ref:GiveInitialZipCode', 'ref:GiveCurrentGeicoCommercialAutoPolicyYesNo', 'ref:GiveDepartmentOfTransportationNumber'],
    'the radio group at its place on the page, under its data-model name');
  assert.deepEqual(changes(h).map((c) => [c.after, c.agent]), [['Yes', false]], 'drawn already answered: the page\'s');

  // The agent picks No on its words. Its inner input is checked; Yes's stays checked too (another
  // shadow root), so the pick is read from the hosts.
  pickOption(h, no);
  await Promise.resolve();
  assert.equal(changes(h).length, 1, 'not read before the option shows the pick');
  show(no, yes);
  h.later();
  assert.deepEqual(changes(h).slice(1).map((c) => [c.key, c.label, c.kind, c.before, c.after, c.agent]),
    [['ref:GiveCurrentGeicoCommercialAutoPolicyYesNo', 'Does the business have a current GEICO commercial auto policy?', 'radio', 'Yes', 'No', true]],
    'the question without its tooltip, the option\'s words');
  h.tick();
  assert.equal(changes(h).length, 2, 'reported once');
});

test('while paused, a gesture inside a GEICO option counts for its radio; the fill\'s own click does not', () => {
  const h = harness({ realKeys: true });
  const name = 'Id_GiveDepartmentOfTransportationNumberStatus_10683';
  const yes = gdsOption(name, 0, 'Yes', 'Yes');
  const no = gdsOption(name, 1, 'No', 'No');
  h.append(gdsGroup(name, [yes, no], { question: 'Does the customer have a USDOT Number?' }), yes.host, no.host);
  h.context.__raterRecorder.rebaseline();
  // The fill clicks Yes: Chromium fires a trusted input event for it, with no gesture before it.
  h.message({ ra: 'recorder', cmd: 'pause' });
  yes.input.checked = true;
  h.emit('input', yes.host, true, { composedPath: () => [yes.input, yes.root, yes.host] });
  show(yes, no);
  h.later();
  // The agent then picks No on its radio's circle, inside the option's shadow root.
  h.advance(3_000);
  pickOption(h, no, { on: no.checkmark });
  show(no, yes);
  h.later();
  assert.equal(changes(h).length, 0, 'nothing is reported while paused');
  h.message({ ra: 'recorder', cmd: 'resume' });
  assert.deepEqual(changes(h).map((c) => [c.key, c.before, c.after, c.agent]),
    [['ref:GiveDepartmentOfTransportationNumberStatus', '', 'No', true]], 'the agent\'s pick, not the fill\'s Yes before it');
});

// A GEICO list without a legend (the two pay plan lists on Quote & Coverages) and its options'
// words: the label is not the raw name, whose render number changes on every redraw.
test('a GEICO question with no words of its own is named by its data-model name, without the render number', () => {
  const h = harness({ realKeys: true });
  const name = 'Id_GivePayPlanV2_77120';
  const full = gdsOption(name, 0, 'GEICO_PP_1Pay', 'Pay In Full');
  const monthly = gdsOption(name, 1, 'GEICO_PP_Monthly', 'Monthly');
  h.append(gdsGroup(name, [full, monthly]), full.host, monthly.host);
  h.context.__raterRecorder.rebaseline();
  pickOption(h, full);
  show(full, monthly);
  h.later();
  assert.deepEqual(changes(h).map((c) => [c.key, c.label, c.after, c.agent]), [['ref:GivePayPlanV2', 'give pay plan v2', 'Pay In Full', true]]);
});

// GEICO's buttons are <gds-button> hosts drawing a <button> around a <slot> in their shadow root. The
// window's click listener got the host, which is no button: no agent_click was ever sent.
test('an agent click on a GEICO button is reported by the words slotted into it', () => {
  const h = harness();
  const slot = new Element('slot');
  slot.assignedNodes = () => [{ textContent: '  Next ' }, new Element('gds-icon')];
  const inner = new Element('button', { attrs: { type: 'button' }, children: [new Element('span', { children: [slot] })] });
  const next = new Element('gds-button', { attrs: { appearance: 'primary' }, text: '  Next ' });
  const root = attachShadow(next, [inner]);
  const path = [slot, slot.parentElement, inner, root, next];
  h.emit('click', next, true, { composedPath: () => path });
  h.emit('click', next, false, { composedPath: () => path });
  // A tooltip's icon button: no words of its own or slotted. Its host's text is the help paragraph,
  // which is not the button's.
  const trigger = new Element('button', { attrs: { 'aria-label': 'View tooltip' }, children: [new Element('gds-icon')] });
  const tooltip = new Element('gds-tooltip', { children: [new Element('p', { text: 'A USDOT number is a number assigned by the DOT.' })] });
  h.emit('click', tooltip, true, { composedPath: () => [trigger, attachShadow(tooltip, [trigger]), tooltip] });
  assert.deepEqual(h.sent.filter((m) => m.event === 'agent_click').map((m) => m.text), ['Next']);
});

// GEICO's street box is a search box (its address suggestions); a site search and a select2 list's
// filter box are not questions.
test('an address search box is recorded; other search boxes are not', () => {
  const h = harness();
  const street = new Control('input', { id: 'Id_GiveStreet_29825', name: 'Id_GiveStreet_29825', type: 'search',
    attrs: { 'aria-autocomplete': 'list', 'aria-controls': 'address-dropdown-list' } });
  const site = new Control('input', { id: 'search-input-id', name: 'search-input', type: 'search' });
  const filter = new Control('input', { id: 'filter', type: 'search', className: 'select2-search__field',
    attrs: { 'aria-autocomplete': 'list', 'aria-controls': 'select2-x-results' } });
  h.append(street, site, filter);
  h.context.__raterRecorder.rebaseline();
  for (const box of [street, site, filter]) {
    box.value = 'typed';
    h.emit('input', box, true);
  }
  h.tick();
  assert.deepEqual(changes(h).map((c) => [c.key, c.after, c.agent]), [['field:Id_GiveStreet_29825', 'typed', true]]);
});

// Every GEICO step is /quote, and its visible headings read "Dashboard" on every step (2026-10-20
// captures): the step is the progress bar's part under way, while the page title names it too.
const stepBar = (text, value) => ({ tagName: 'GDS-PROGRESS-BAR', textContent: text, getAttribute: (n) => (n === 'value' ? String(value) : null) });
const geicoSteps = (current) => ['Business Class & USDOT', 'Business & Owner Info', 'Vehicles', 'Drivers & Incidents']
  .map((step, i, all) => stepBar(step, i < all.indexOf(current) ? 100 : step === current ? 50 : 0));

test('a GEICO step is the progress bar\'s part under way, only while the page title names it', () => {
  const h = harness();
  const field = select({ id: 'yrsInBusiness' });
  h.append(field);
  h.context.__raterRecorder.rebaseline();
  h.document.headings = [{ tagName: 'H3', textContent: 'Dashboard', getClientRects: () => [{}] }];
  h.document.bars = geicoSteps('Business & Owner Info');
  h.document.title = 'GEICO Business & Owner Info';
  const change = (value) => {
    field.value = value;
    h.emit('change', field, true);
    h.tick();
    return h.sent.filter((m) => m.event === 'field_changes').at(-1).step;
  };
  assert.equal(change('1'), 'Business & Owner Info', 'the bar, not the headings');
  assert.deepEqual(h.sent.filter((m) => m.event === 'step_shown').map((m) => m.step), ['Business & Owner Info']);
  // Next: the bar has moved on before the title (or the other way round): no step is named.
  h.document.bars = geicoSteps('Vehicles');
  assert.equal(change('3'), undefined);
  h.document.title = 'GEICO Vehicles';
  assert.equal(change('5+'), 'Vehicles');
  assert.deepEqual(h.sent.filter((m) => m.event === 'step_shown').map((m) => m.step), ['Business & Owner Info', 'Vehicles']);
  // Two parts under way can't name one step.
  h.document.bars = [stepBar('Vehicles', 50), stepBar('Drivers & Incidents', 50)];
  assert.equal(change('1'), undefined);
});

// The panel closed and opened again attaches to the recorder already in the page, which had sent the
// step before: on GEICO the step is the only thing telling the panel where the agent is.
test('told to resume while not paused, the recorder sends the step on screen again', () => {
  const h = harness();
  h.document.bars = geicoSteps('Vehicles');
  h.document.title = 'GEICO Vehicles';
  h.tick();
  h.tick();
  assert.equal(h.sent.filter((m) => m.event === 'step_shown').length, 1);
  vm.runInNewContext(RECORDER, h.context, { filename: 'src/content/recorder.js' });
  h.message({ ra: 'recorder', cmd: 'resume' });
  assert.deepEqual(h.sent.filter((m) => m.event === 'step_shown').map((m) => m.step), ['Vehicles', 'Vehicles']);
  h.tick();
  assert.equal(h.sent.filter((m) => m.event === 'step_shown').length, 2, 'then once again, as before');
});

// GEICO draws every vehicle's, trailer's and driver's form at /quote, one at a time: each batch of
// changes says which unit forms are on screen as the kit in the recorder's world reads them
// (pagekit unitFormsNow), so the panel files an edit under its form, also before any fill has read it.
test('field changes carry the unit forms on screen as the kit reads them, else null', async () => {
  const h = harness();
  const year = select({ id: 'year' });
  h.append(year);
  h.context.__raterRecorder.rebaseline();
  const last = () => h.sent.filter((m) => m.event === 'field_changes').at(-1);
  const change = (value) => {
    year.value = value;
    h.emit('change', year, true);
    h.tick();
    return last();
  };
  // No kit in this world (Progressive's runs in the page's own): null.
  assert.equal(change('1').forms, null);
  let forms = [{ list: 'trailers', id: 'Id_GiveOtherVehicleType_51200' }];
  h.context.__raterKit = { unitFormsNow: () => forms };
  assert.deepEqual(change('3').forms, forms);
  // None on screen (the owner check under Vehicles): none.
  forms = [];
  assert.deepEqual(change('5+').forms, []);
  // A kit without it (another build), or one that fails: null, and the change is still sent.
  h.context.__raterKit = {};
  assert.equal(change('1').forms, null);
  h.context.__raterKit = { unitFormsNow: () => { throw new Error('unreadable'); } };
  const failed = change('3');
  assert.deepEqual([failed.forms, Array.from(failed.changes, (c) => c.after)], [null, ['3']]);
  // Also on a discrete pick flushed at once, and with the agent's edits reported on resume.
  forms = [{ list: 'vehicles', id: 'Id_YesNoPreQuoteHaveFullVinActivity_85493' }];
  h.context.__raterKit = { unitFormsNow: () => forms };
  h.emit('pointerdown', year, true);
  year.value = '5+';
  h.emit('change', year, true);
  await Promise.resolve();
  assert.deepEqual([Array.from(last().changes, (c) => c.after), last().forms], [['5+'], forms]);
  h.message({ ra: 'recorder', cmd: 'pause' });
  h.emit('pointerdown', year, true);
  year.value = '1';
  h.emit('change', year, true);
  await Promise.resolve();
  forms = [{ list: 'drivers', id: 'Id_GiveDriverRelationshipToBusiness_34002' }];
  h.message({ ra: 'recorder', cmd: 'resume' });
  assert.deepEqual([Array.from(last().changes, (c) => [c.after, c.agent]), last().forms], [[['1', true]], forms]);
});

// FL live run 6, 2026-10-21: GEICO drew the vehicle list, which has no question, 5–7 s after the
// Next that saved a vehicle's form, so nothing told the panel. The recorder says when a unit list the
// kit knows is drawn or its rows change (pagekit unitListsNow), also one drawn during a fill.
test('a unit list drawn or changed is sent once, by the step on screen', () => {
  const h = harness();
  const shown = () => h.sent.filter((m) => m.event === 'list_shown');
  let lists = '';
  h.context.__raterKit = { unitListsNow: () => lists };
  h.tick();
  assert.equal(shown().length, 0, 'no list');
  lists = '#summaryPage-AddCommercialVehicle:1';
  h.tick();
  h.tick();
  assert.equal(shown().length, 1, 'drawn: once');
  assert.ok('step' in shown()[0] && shown()[0].page, 'with the page and the step on screen');
  // Gone (the next unit's form) and drawn again with another row, during a fill: sent after it.
  lists = '';
  h.tick();
  h.message({ ra: 'recorder', cmd: 'pause' });
  lists = '#summaryPage-AddCommercialVehicle:2';
  h.tick();
  assert.equal(shown().length, 1, 'nothing while paused');
  h.message({ ra: 'recorder', cmd: 'resume' });
  h.tick();
  assert.equal(shown().length, 2);
  // A kit without it (another build), or one that fails: nothing.
  h.context.__raterKit = {};
  h.tick();
  h.context.__raterKit = { unitListsNow: () => { throw new Error('unreadable'); } };
  h.tick();
  assert.equal(shown().length, 2);
});
