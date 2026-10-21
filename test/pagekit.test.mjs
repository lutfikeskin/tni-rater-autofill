import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { buildPlan } from '../src/plan.js';
import { collectItems } from '../src/ai/common.js';
import { progressive } from '../src/carriers/progressive.js';
import { amwins } from '../src/carriers/amwins.js';
import { fieldChangeEvent, redactor } from '../src/usage.js';
import { assistContextKey } from '../src/ai/common.js';

// This is a deliberately small DOM/ExtJS replay.  It exercises the injected MAIN-world
// script itself, without a browser session, real quote data, or customer identifiers.
const PAGEKIT = fs.readFileSync(new URL('../src/content/pagekit.js', import.meta.url), 'utf8');
const FIELD_KEY = fs.readFileSync(new URL('../src/content/field-key.js', import.meta.url), 'utf8');
const RECORDER = fs.readFileSync(new URL('../src/content/recorder.js', import.meta.url), 'utf8');

// A virtual clock for the fill engine's waits (sleep, settle, the retry loops that read Date.now()).
// Whenever the event loop would otherwise sit idle (every promise continuation has run and only
// timers remain), it moves to the earliest due timer and fires that one; the next fires on the next
// idle turn, so continuations interleave as they do with real timers, and each polling loop sees
// as many ticks as in real time. A 6 s settle takes microseconds; this file took 150 s on real
// timers (audit 2026-10-08, finding 15). The engine's context gets this clock's setTimeout,
// clearTimeout and Date; the timers this file's own tests set (a list that loads late, a page that
// clears a value) are on the same clock, so their order against the engine's waits is kept.
function virtualClock() {
  let now = Date.now();
  let seq = 0;
  let armed = null;
  const timers = new Map();
  const fire = () => {
    armed = null;
    let next = null;
    for (const t of timers.values()) if (!next || t.due < next.due || (t.due === next.due && t.seq < next.seq)) next = t;
    if (!next) return;
    timers.delete(next.seq);
    if (next.due > now) now = next.due;
    arm();
    next.fn(...next.args);
  };
  const arm = () => { if (!armed && timers.size) armed = setImmediate(fire); };
  class VirtualDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  return {
    Date: VirtualDate,
    setTimeout(fn, ms = 0, ...args) {
      const id = ++seq;
      timers.set(id, { seq: id, due: now + Math.max(0, Number(ms) || 0), fn, args });
      arm();
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
}
const clock = virtualClock();
// This module's own timers run on the clock too (shadows the globals for the whole file).
const { setTimeout, clearTimeout } = clock;

function attrSelector(node, selector) {
  const attrs = [...selector.matchAll(/\[\s*([^\]=~*^$|\s]+)(?:\s*([~*^$|]?=)\s*["']?([^\]"']*)["']?)?\s*\]/g)];
  return attrs.every(([, name, op, raw]) => {
    const actual = node.getAttribute(name);
    if (actual == null) return false;
    if (!op) return true;
    const wanted = String(raw).trim();
    if (op === '=') return actual === wanted;
    if (op === '*=') return actual.includes(wanted);
    if (op === '~=') return actual.split(/\s+/).includes(wanted);
    if (op === '^=') return actual.startsWith(wanted);
    if (op === '$=') return actual.endsWith(wanted);
    return false;
  });
}

function matchesSimple(node, selector) {
  selector = selector.trim();
  if (!selector || selector === '*') return true;
  for (const not of selector.matchAll(/:not\(([^()]*)\)/g)) {
    if (matchesSimple(node, not[1])) return false;
  }
  selector = selector.replace(/:not\([^()]*\)/g, '');
  const tag = selector.match(/^([a-z][\w-]*)/i)?.[1];
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  const id = selector.match(/#([\w-]+)/)?.[1];
  if (id && node.id !== id) return false;
  for (const cls of selector.matchAll(/\.([\w-]+)/g)) {
    if (!node.className.split(/\s+/).includes(cls[1])) return false;
  }
  return attrSelector(node, selector);
}

function matchesSelector(node, selector) {
  // The pagekit selectors used by this test are comma-separated simple selectors.
  return selector.split(',').some((part) => matchesSimple(node, part));
}

class FakeNode {
  constructor(tagName, props = {}) {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.parentElement = null;
    this.ownerDocument = null;
    this.id = props.id ?? '';
    this.name = props.name ?? '';
    this.type = props.type ?? (this.tagName === 'INPUT' ? 'text' : '');
    this.className = props.className ?? '';
    this.disabled = !!props.disabled;
    this.readOnly = !!props.readOnly;
    this.required = !!props.required;
    this.checked = !!props.checked;
    this.style = {};
    this.dataset = {};
    this._attrs = new Map();
    this._listeners = new Map();
    this._textContent = props.textContent ?? '';
    this.labels = [];
    for (const [key, value] of Object.entries(props.attrs ?? {})) this.setAttribute(key, value);
    if (props.ariaLabel) this.setAttribute('aria-label', props.ariaLabel);
    if (props.role) this.setAttribute('role', props.role);
    if (this.id) this.setAttribute('id', this.id);
    if (this.name) this.setAttribute('name', this.name);
    if (this.type) this.setAttribute('type', this.type);
  }

  get textContent() {
    return this._textContent + this.children.map((c) => c.textContent).join('');
  }

  set textContent(value) { this._textContent = String(value ?? ''); }

  get attributes() {
    return [...this._attrs.entries()].map(([name, value]) => ({ name, value }));
  }

  // Its shadow root when it is in one (top-level shadow children have a parentNode, no
  // parentElement, as in a browser), else its document.
  getRootNode() {
    let n = this;
    while (n.parentElement) n = n.parentElement;
    return n.parentNode instanceof FakeShadowRoot ? n.parentNode : this.ownerDocument ?? this;
  }

  // An open shadow root (GEICO draws its radios and buttons in them): reached through shadowRoot,
  // never by a querySelectorAll of the page.
  attachShadow() {
    this.shadowRoot = new FakeShadowRoot(this);
    return this.shadowRoot;
  }

  get classList() { return { contains: (name) => this.className.split(/\s+/).includes(name) }; }

  get nextElementSibling() {
    const siblings = this.parentElement?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (!node) continue;
      node.parentElement = this;
      // The whole subtree joins this document (a radio group appended with its radios), shadow
      // roots included.
      const adopt = (n) => { n.ownerDocument = this.ownerDocument; for (const c of n.children ?? []) adopt(c); if (n.shadowRoot) adopt(n.shadowRoot); };
      adopt(node);
      this.children.push(node);
    }
    return nodes.at(-1);
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
    this.parentElement = null;
  }

  replaceChild(next, old) {
    const i = this.children.indexOf(old);
    if (i < 0) throw new Error('old child is not present');
    next.parentElement = this;
    next.ownerDocument = this.ownerDocument;
    this.children[i] = next;
    old.parentElement = null;
    return old;
  }

  querySelectorAll(selector) {
    const out = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }

  matches(selector) { return matchesSelector(this, selector); }

  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }

  contains(node) {
    for (let p = node; p; p = p.parentElement ?? p.parentNode ?? null) if (p === this) return true;
    return false;
  }

  getClientRects() { return this._visible === false ? [] : [{ width: 1, height: 1 }]; }
  focus() {}
  blur() {}

  addEventListener(type, fn) {
    const list = this._listeners.get(type) ?? [];
    list.push(fn);
    this._listeners.set(type, list);
  }

  removeEventListener(type, fn) {
    this._listeners.set(type, (this._listeners.get(type) ?? []).filter((x) => x !== fn));
  }

  dispatchEvent(event) {
    event.target ??= this;
    for (const fn of this._listeners.get(event.type) ?? []) fn.call(this, event);
    this.ownerDocument?._dispatch(event);
    return true;
  }

  click() {
    if (this.disabled) return;
    if (this.type === 'checkbox') this.checked = !this.checked;
    if (this.type === 'radio') {
      const root = this.getRootNode();
      for (const other of root.querySelectorAll('input[type=radio]')) {
        if (other !== this && other.name === this.name) other.checked = false;
      }
      this.checked = true;
    }
    this.onclick?.({ target: this, type: 'click', isTrusted: false });
    this.dispatchEvent({ type: 'click', bubbles: true, isTrusted: false, target: this });
  }

  getAttribute(name) {
    if (name === 'id') return this.id || null;
    if (name === 'name') return this.name || null;
    if (name === 'type') return this.type || null;
    return this._attrs.get(name) ?? null;
  }

  setAttribute(name, value) {
    value = String(value);
    this._attrs.set(name, value);
    if (name === 'id') this.id = value;
    if (name === 'name') this.name = value;
    if (name === 'type') this.type = value;
  }

  removeAttribute(name) { this._attrs.delete(name); }
  hasAttribute(name) { return this._attrs.has(name); }

  compareDocumentPosition() { return 4; }
}

class InputNode extends FakeNode {
  constructor(props = {}) {
    super('input', props);
    this._value = props.value ?? '';
    this.maxLength = props.maxLength ?? 0;
  }

  get value() { return this._value; }
  set value(value) { this._value = String(value ?? ''); }
}

class TextareaNode extends InputNode {
  constructor(props = {}) { super(props); this.tagName = 'TEXTAREA'; }
}

class OptionNode extends FakeNode {
  constructor(text, value = text) {
    super('option', { textContent: text });
    this.text = text;
    this.value = value;
  }
}

class SelectNode extends FakeNode {
  constructor(options, props = {}) {
    super('select', props);
    this.options = options.map((o) => o instanceof OptionNode ? o : new OptionNode(o.text ?? o, o.value ?? o));
    this._value = props.value ?? '';
    this.append(...this.options);
  }

  get value() { return this._value; }
  set value(value) { this._value = String(value ?? ''); }
  get selectedOptions() { return this.options.filter((o) => o.value === this._value); }
}

class FakeDocument extends FakeNode {
  constructor() {
    super('#document');
    this.nodeType = 9;
    this.ownerDocument = this;
    this.body = new FakeNode('body');
    this.body.ownerDocument = this;
    this.head = new FakeNode('head');
    this.head.ownerDocument = this;
    this.title = 'Synthetic Progressive page';
    this._listeners = new Map();
    this.append(this.head, this.body);
  }

  getRootNode() { return this; }
  getElementById(id) { return this.querySelectorAll('*').find((el) => el.id === id) ?? null; }
  createElement(tag) { const el = new FakeNode(tag); el.ownerDocument = this; return el; }
  createTreeWalker() { return { nextNode: () => false, currentNode: null }; }

  addEventListener(type, fn) {
    super.addEventListener(type, fn);
    this._onAddEvent?.(type, fn);
  }

  _dispatch(event) {
    for (const fn of this._listeners.get(event.type) ?? []) fn.call(this, event);
  }
}

class FakeShadowRoot extends FakeNode {
  constructor(host) {
    super('#shadow-root');
    this.nodeType = 11;
    this.host = host;
    this.ownerDocument = host.ownerDocument;
  }

  getRootNode() { return this; }
  getElementById(id) { return this.querySelectorAll('*').find((el) => el.id === id) ?? null; }

  append(...nodes) {
    super.append(...nodes);
    for (const node of nodes) if (node) { node.parentElement = null; node.parentNode = this; }
    return nodes.at(-1);
  }
}

// A <slot>: it shows its host's children for its name, and the host's own text in the default one.
class FakeSlot extends FakeNode {
  constructor(name = '') { super('slot', name ? { attrs: { name } } : {}); }

  assignedNodes() {
    const host = this.getRootNode().host;
    if (!host) return [];
    const name = this.getAttribute('name') ?? '';
    const nodes = host.children.filter((c) => (c.getAttribute('slot') ?? '') === name);
    return !name && host._textContent ? [{ nodeType: 3, textContent: host._textContent }, ...nodes] : nodes;
  }
}

function makeInput(props = {}) { return new InputNode(props); }

function extCmp(id, input, { caption = 'Synthetic question', required = false, value = '', onSet } = {}) {
  const cmp = {
    id,
    dctCaption: caption,
    dctRequired: required,
    el: { dom: input },
    _value: value,
    _handlers: new Map(),
    getValue() { return this._value; },
    getRawValue() { return this._value; },
    on(event, fn) {
      const handlers = this._handlers.get(event) ?? [];
      handlers.push(fn);
      this._handlers.set(event, handlers);
    },
    fireEvent(event, ...args) {
      for (const fn of this._handlers.get(event) ?? []) fn(...args);
    },
    setValue(next) {
      this._value = String(next ?? '');
      this.el.dom.value = this._value;
      onSet?.(this, this._value);
    },
  };
  return cmp;
}

function harness({ ext = false, pathname = '/rater', search = '' } = {}) {
  const document = new FakeDocument();
  const location = { origin: 'https://synthetic.example', pathname, search };
  const context = {
    document,
    location,
    URLSearchParams,
    crypto,
    window: null,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    NodeFilter: { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 },
    CSS: { escape: (value) => String(value).replace(/[^a-z0-9_-]/gi, '\\$&') },
    getComputedStyle: () => ({ visibility: 'visible' }),
    MutationObserver: class { observe() {} disconnect() {} },
    Event: class { constructor(type, init = {}) { this.type = type; this.bubbles = !!init.bubbles; this.isTrusted = false; } },
    FocusEvent: class { constructor(type) { this.type = type; } },
    HTMLInputElement: InputNode,
    HTMLTextAreaElement: TextareaNode,
    HTMLSelectElement: SelectNode,
    // The engine waits on the virtual clock (see virtualClock): its sleep() and every Date.now() loop.
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    Date: clock.Date,
  };
  context.window = context;
  context.top = context;
  if (ext) {
    const components = new Map();
    context.Ext = {
      getCmp: (id) => components.get(id) ?? null,
      Ajax: { isLoading: () => false },
      _components: components,
    };
  }
  vm.runInNewContext(FIELD_KEY, context, { filename: 'src/content/field-key.js' });
  vm.runInNewContext(PAGEKIT, context, { filename: 'src/content/pagekit.js' });
  return { context, document, kit: context.__raterKit };
}

function recorderHarness(document = new FakeDocument()) {
  const sent = [];
  const listeners = [];
  let tick;
  const context = {
    document,
    location: { origin: 'https://synthetic.example', pathname: '/rater', search: '?pageName=AddVehicle' },
    window: null,
    NodeFilter: { SHOW_TEXT: 4 },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    URLSearchParams,
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    setInterval: (fn) => { tick = fn; return 1; },
    clearInterval() {},
    chrome: {
      runtime: {
        id: 'synthetic-extension',
        sendMessage: (message) => { sent.push(message); return Promise.resolve(); },
        onMessage: { addListener() {} },
      },
    },
  };
  context.window = context;
  context.top = context;
  vm.runInNewContext(FIELD_KEY, context, { filename: 'src/content/field-key.js' });
  vm.runInNewContext(RECORDER, context, { filename: 'src/content/recorder.js' });
  // A real (trusted) click or key press by the agent.
  return { context, document, sent, tick: () => tick?.(), trusted: target => listeners.filter(l => l.type === 'pointerdown').forEach(({ fn }) => fn({ isTrusted: true, target })) };
}

// A Progressive field as the live page draws it: the question the rule written from this id
// finds (its data-model name, else its question text), unless the test says otherwise.
function liveIdentity(question) {
  const rule = progressive.rules.find((r) => r.q === question);
  return { ref: rule?.field, caption: [].concat(rule?.ask ?? [])[0] };
}

// The data-model name of the field the rule written from this id finds (for fields built under other numbers).
const refOf = (question) => liveIdentity(question).ref;

// The data-model name a step finds that field by.
const fieldOf = (question) => liveIdentity(question).ref ?? `Test.${question}`;

// Radios grouped under their question, as the page draws them.
function radioGroup(question, ...radios) {
  const group = new FakeNode('div', { attrs: { role: 'radiogroup', 'aria-label': question } });
  group.append(...radios);
  return group;
}

function addExtText(h, prefix, question, options = {}) {
  const live = liveIdentity(question);
  options = { ...options, ref: options.ref ?? live.ref, caption: options.caption ?? live.caption };
  const group = 'A'.repeat(32);
  const id = `f_${prefix}${group}${question}_${options.row ?? '1_1'}`;
  // Duck Creek's data-model name on the input: how a rule finds the field (never its number).
  const input = makeInput({ id, ariaLabel: options.caption ?? `Question ${question}`, value: options.value ?? '', attrs: { fieldref: options.ref ?? `Test.${question}` } });
  const cmp = extCmp(id, input, options);
  h.context.Ext._components.set(id, cmp);
  h.document.body.append(input);
  return { input, cmp, id };
}

function addButton(h, text, { className = '', disabled = false } = {}) {
  const button = new FakeNode('button', { textContent: text, className, disabled });
  h.document.body.append(button);
  return button;
}

test('reinjection reuses the installed pagekit and preserves its state', () => {
  const h = harness();
  vm.runInNewContext(PAGEKIT, h.context);
  assert.equal(h.context.__raterKit, h.kit);
});

test('anonymous repeated carrier fields have distinct keys and protecting one does not skip the others', async () => {
  const h = harness();
  const garage = new FakeNode('div', { id: 'garagePanel' });
  const state = new SelectNode([{ text: '', value: '' }, { text: 'New Jersey', value: 'NJ' }], { attrs: { 'data-id': 'state' } });
  garage.append(state); h.document.body.append(garage);
  const rows = Array.from({ length: 3 }, (_, i) => {
    const row = new FakeNode('div', { id: `priorCarrierCoveragePanel${i}` });
    const carrier = new SelectNode([{ text: '', value: '' }, { text: 'NO PRIOR', value: 'np' }, { text: 'ALLIANZ', value: 'allianz' }],
      { required: true, attrs: { 'data-id': 'carrierName' } });
    row.append(carrier); h.document.body.append(row);
    return { row, carrier };
  });
  const keys = [state, ...rows.map(x => x.carrier)].map(el => h.context.__raterFieldKey(el));
  assert.equal(new Set(keys).size, 4);
  assert.ok(keys.every(Boolean));
  const plan = rows.map((_, i) => ({ id: `prior${i}`, path: `prior${i}`, withOption: 'NO PRIOR', kind: 'choice', value: 'NO PRIOR' }));
  const report = await h.kit.fill(plan, { skip: [keys[0]], maxRounds: 5 });
  assert.deepEqual(rows.map(x => x.carrier.value), ['np', 'np', 'np']);
  assert.equal(report.filled.length, 3);
  // Redrawn controls in the same row retain their identity, without sharing another row's edit.
  const previous = rows[1].carrier;
  const replacement = new SelectNode([{ text: '', value: '' }, { text: 'NO PRIOR', value: 'np' }, { text: 'ALLIANZ', value: 'allianz' }],
    { required: true, attrs: { 'data-id': 'carrierName' } });
  rows[1].row.replaceChild(replacement, previous);
  assert.equal(h.context.__raterFieldKey(replacement), keys[2]);
  replacement.value = 'allianz';
  rows[0].carrier.value = ''; rows[2].carrier.value = '';
  await h.kit.fill(plan, { skip: [keys[2]], maxRounds: 5, replaceChoices: true });
  assert.deepEqual([rows[0].carrier.value, replacement.value, rows[2].carrier.value], ['np', 'allianz', 'np']);
});

test('a checkbox repeated per row under one name gets a key per row: an answer or edit stays on its vehicle', async () => {
  // AmWINS' Vehicle Coverages: every row's box is named "medicalPaymentExclude"; only the id
  // (medicalPaymentExclude<row>_<box>_) carries the row, and the label is the same on each.
  const h = harness();
  const boxes = [0, 1, 2].map((row) => {
    const box = makeInput({ type: 'checkbox', name: 'medicalPaymentExclude', id: `medicalPaymentExclude${row}_0_`, ariaLabel: 'Exclude Medical Payments' });
    h.document.body.append(box);
    return box;
  });
  const keys = boxes.map((el) => h.context.__raterFieldKey(el));
  assert.deepEqual(keys, ['medicalPaymentExclude#1', 'medicalPaymentExclude#2', 'medicalPaymentExclude#3']);
  const [ok] = await h.kit.answer([{ key: keys[2], label: 'Exclude Medical Payments', value: 'checked' }]);
  assert.equal(ok.ok, true);
  assert.deepEqual(boxes.map((b) => b.checked), [false, false, true], 'the third vehicle\'s answer lands on its own row');
  boxes[2].checked = false;
  const plan = [0, 1, 2].map((n) => ({ id: `exclude${n}`, path: `exclude${n}`, re: '^ex\\w*de\\b.*medical', kind: 'bool', value: true, name: 'Exclude' }));
  await h.kit.fill(plan, { skip: [keys[1]], maxRounds: 3 });
  assert.deepEqual(boxes.map((b) => b.checked), [true, false, true], 'an edit on one row protects only that row');
  // An edit saved by an older build under the shared name could be any row's: it protects them all.
  boxes.forEach((b) => { b.checked = false; });
  const legacy = await h.kit.fill(plan, { skip: ['medicalPaymentExclude'], maxRounds: 3 });
  assert.deepEqual(boxes.map((b) => b.checked), [false, false, false]);
  assert.deepEqual([...legacy.skipped].map((x) => x.key), keys);
  // Radios and boxes whose id doesn't extend their name keep the name.
  assert.equal(h.context.__raterFieldKey(makeInput({ type: 'radio', name: 'isNonProfit', id: 'isNonProfit1_0_' })), 'isNonProfit');
  assert.equal(h.context.__raterFieldKey(makeInput({ type: 'checkbox', name: 'accept', id: 'accept' })), 'accept');
});

// 2026-10-08 live AmWINS run: one intake vehicle and a trailer the agent added as a second vehicle
// row. The carrier's body-type rule answered the first row; the generic "body type" label rule
// then gave the second row the first vehicle's type. Inside a carrier's row sections, label rules
// never answer: a row the intake doesn't describe stays the agent's.
test('a generic label rule never answers inside a carrier row section', async () => {
  const run = async (notWithin) => {
    const h = harness();
    const panel = new FakeNode('div', { id: 'vehiclesPanel' });
    const rows = [0, 1].map((i) => makeInput({ id: `bodyType${i}`, ariaLabel: 'Body Type' }));
    panel.append(...rows);
    const outside = makeInput({ id: 'fleetType', ariaLabel: 'Vehicle Type' });
    h.document.body.append(panel, outside);
    const plan = [
      { id: 'carrier', path: 'amwins.q76', selector: '#bodyType0', kind: 'text', value: 'Pickup Truck', name: 'Body type' },
      { id: 'generic', path: 'vehicles[0].type', re: '(vehicle|body|truck) type', kind: 'text', value: 'Pickup Truck', name: 'Type', notWithin },
    ];
    const report = await h.kit.fill(plan, { maxRounds: 3 });
    return { values: [...rows, outside].map((x) => x.value), report };
  };
  const before = await run(null);
  assert.deepEqual(before.values, ['Pickup Truck', 'Pickup Truck', ''], 'without the fence: the second row gets the first vehicle\'s type');
  const after = await run(['#vehiclesPanel']);
  assert.deepEqual(after.values, ['Pickup Truck', '', 'Pickup Truck'], 'fenced: the row stays the agent\'s; outside the section the rule still answers');
});

test('an agent-confirmed missing-intake choice is resolved while prefilled values and explicit notes still require review', async () => {
  const plan = [{ id: 'years', path: 'applicant.yearsInBusiness', selector: '#yrsInBusiness', kind: 'choice', value: null, name: 'Years in business' }];
  const h = harness();
  const years = new SelectNode([{ text: '', value: '' }, { text: '3', value: '3' }], { id: 'yrsInBusiness', ariaLabel: 'Years in Business' });
  years.value = '3'; h.document.body.append(years);
  const unconfirmed = await h.kit.fill(plan, { maxRounds: 3 });
  assert.equal(unconfirmed.noData.length, 1, 'a page value alone does not prove the missing client fact');
  const confirmed = await h.kit.fill(plan, { skip: ['yrsInBusiness'], maxRounds: 3 });
  assert.equal(confirmed.noData.length, 0);
  assert.equal(confirmed.blockers.length, 0);
  assert.equal(years.value, '3');
  const review = await h.kit.fill([{ ...plan[0], value: '3', note: 'Confirm the source before continuing.' }], { maxRounds: 3 });
  assert.equal(review.noData.length, 1, 'the missing-data fix must not erase intentional review notes');
});

test('anonymous radio options share one answer key while separate groups stay distinct', async () => {
  const h = harness();
  const groups = ['First question', 'Second question'].map((label, i) => {
    const group = new FakeNode('fieldset', { id: `anonymousGroup${i}`, role: 'radiogroup', ariaLabel: label });
    const yes = makeInput({ type: 'radio', value: 'Yes' });
    const no = makeInput({ type: 'radio', value: 'No' });
    group.append(yes, no); h.document.body.append(group);
    return { yes, no };
  });
  const keyOf = el => h.context.__raterFieldKey(el);
  assert.equal(keyOf(groups[0].yes), keyOf(groups[0].no));
  assert.notEqual(keyOf(groups[0].yes), keyOf(groups[1].yes));
  const recorder = recorderHarness(h.document);
  recorder.trusted(groups[0].no);
  groups[0].no.checked = true;
  recorder.tick();
  const edit = recorder.sent.filter(m => m.event === 'field_changes').flatMap(m => m.changes).find(c => c.agent);
  assert.equal(edit?.key, keyOf(groups[0].yes), 'the non-first option uses the fill engine group key');
  const plan = ['First question', 'Second question'].map((label, i) => ({ id: `question${i}`, path: `question${i}`, re: `^${label}$`, kind: 'bool', value: null, name: label }));
  const report = await h.kit.fill(plan, { skip: [edit.key], maxRounds: 3 });
  assert.equal(report.noData.length, 1);
  assert.equal(report.noData[0].key, keyOf(groups[1].yes));
});

test('an existing blank driver row prevents a duplicate Add Driver action', async () => {
  const h = harness();
  h.document.body.append(makeInput({ id: 'secondDriver', ariaLabel: 'Second driver' }));
  const button = addButton(h, 'Add Driver');
  let clicks = 0;
  button.addEventListener('click', () => clicks++);
  const report = await h.kit.fill([{ id: 'add2', kind: 'action', action: 'addDriver1', text: '^add driver$',
    after: [], unlessSelector: '#secondDriver', pages: [] }], {});
  assert.equal(clicks, 0);
  assert.equal(report.halted, false);
});

test('DOT lookup chooses the matching business, not the first returned name', async () => {
  const h = harness({ ext: true, search: '?pageName=BusinessOwnerInfo' });
  const field = addExtText(h, 'c', '22F', { caption: 'Business Name', required: true });
  const records = ['Other Example LLC', 'Sample Test LLC', 'Enter a different Business Name'].map(label => ({ get: () => label }));
  Object.assign(field.cmp, { displayField: 'label', valueField: 'label', store: { getRange: () => records } });
  const record = { applicant: { name: 'Sample Test LLC', dot: '12345678' }, garaging: {}, operations: {}, drivers: [], vehicles: [], priorInsurance: [], coverage: {}, claims: {} };
  const plan = buildPlan(record, progressive).filter(s => s.q === '22F');
  const report = await h.kit.fill(plan, {});
  assert.equal(field.cmp.getValue(), 'Sample Test LLC');
  assert.equal(report.failed.length, 0);
});

test('vehicle-named additional coverage q200F is mapped and does not block Rates filling', async () => {
  for (const current of ['', 'Not selected']) {
    const h = harness({ ext: true, search: '?pageName=CoveragesRates' });
    const field = addExtText(h, 'c', '200F', { caption: '2022 FORD TRANSIT', required: true, value: current });
    const records = ['', 'Not selected', '$100 Deductible', '$1,000 Deductible'].map((label) => ({ get: () => label }));
    Object.assign(field.cmp, { displayField: 'label', valueField: 'label', store: { getRange: () => records } });
    const record = { applicant: {}, garaging: {}, operations: {}, drivers: [], vehicles: [{ year: 2022, make: 'FORD', model: 'TRANSIT' }], priorInsurance: [], coverage: {}, claims: {} };
    const report = await h.kit.fill(buildPlan(record, progressive), {});
    assert.equal(report.halted, false);
    assert.equal(report.unknown.length, 0);
    assert.equal(field.cmp.getValue(), 'Not selected');
    assert.equal(report.filled.length, current ? 0 : 1);
  }
});

test('TX refrigeration options fill from the intake without an AI review stop', async () => {
  for (const selected of [null, false, true]) {
    const h = harness({ search: '?pageName=CoveragesRates' });
    const radios = ['Yes, match Motor Truck Cargo limits', 'No'].map((value, i) => makeInput({
      id: i ? 'reefer-no' : `f_U${'A'.repeat(32)}215C_1_1`, name: 'string_215C', type: 'radio', value,
    }));
    const group = new FakeNode('div', { attrs: { role: 'radiogroup', 'aria-label': 'Does the customer require Refrigeration Breakdown coverage?' } });
    group.append(...radios);
    h.document.body.append(group);
    const record = { applicant: {}, garaging: {}, operations: {}, drivers: [], vehicles: [], priorInsurance: [], coverage: { reeferBreakdown: selected }, claims: {} };
    const plan = buildPlan(record, progressive).filter(s => s.q === '215C');
    const report = await h.kit.fill(plan, { replaceChoices: true });
    assert.equal(radios.find(r => r.checked)?.value, selected === true ? 'Yes, match Motor Truck Cargo limits' : 'No');
    assert.equal(report.blockers.length, 0);
    assert.equal(report.unknown.length, 0);
    if (selected === true) {
      record.coverage.reeferBreakdown = false;
      await h.kit.fill(buildPlan(record, progressive).filter(s => s.q === '215C'), { replaceChoices: true, skip: ['215C'] });
      assert.equal(radios[0].checked, true, 'an agent override remains protected');
    }
  }
});

// Codex on PR #43: an edit an older build kept under a question id saved before a renumbering
// names another question now, and the corrected one has a new number. While such a key is kept,
// an answer already on the page is left as it is and flagged, never replaced.
test('an edit kept under an old question id leaves answers on the page as they are', async () => {
  for (const skip of [[], ['3C01']]) {
    const h = harness({ search: '?pageName=CoveragesRates' });
    const radios = ['Yes, match Motor Truck Cargo limits', 'No'].map((value, i) => makeInput({
      id: i ? 'reefer-no' : `f_U${'A'.repeat(32)}9ABC_1_1`, name: 'string_9ABC', type: 'radio', value,
    }));
    const group = new FakeNode('div', { attrs: { role: 'radiogroup', 'aria-label': 'Does the customer require Refrigeration Breakdown coverage?' } });
    group.append(...radios);
    h.document.body.append(group);
    radios[1].checked = true; // the agent's No, kept under the question's old number
    const record = { applicant: {}, garaging: {}, operations: {}, drivers: [], vehicles: [], priorInsurance: [], coverage: { reeferBreakdown: true }, claims: {} };
    const report = await h.kit.fill(buildPlan(record, progressive).filter(s => s.q === '215C'), { replaceChoices: true, skip });
    if (!skip.length) { assert.equal(radios[0].checked, true, 'without such a key, a pre-selected answer is replaced'); continue; }
    assert.equal(radios[1].checked, true, 'the answer on the page is kept');
    assert.equal(report.filled.length, 0);
    assert.match(report.checks[0]?.note ?? '', /older version/);
  }
});

test('Freight Hauler searches the remote business dropdown and verifies a collapsed General Freight summary', async () => {
  for (const offered of ['General Freight Hauler', 'General Freight Trucking']) {
    const h = harness({ ext: true, search: '?pageName=BusinessOwnerInfo' });
    const structure = new SelectNode([{ text: 'Individual / Sole Proprietor', value: 'individual' }], { id: `f_c${'A'.repeat(32)}22D_1_1`, ariaLabel: 'How is the customer\'s business structured?', attrs: { fieldref: 'AccountInput.BusinessStructure' } });
    structure.value = 'individual';
    h.document.body.append(structure);
    const business = addExtText(h, 'c', '239', { caption: 'Business type list', onSet: () => {
      h.document.body.replaceChild(new FakeNode('div', { textContent: offered }), business.input);
      h.document.body.innerText = `Business\n${offered}\nEdit`;
    } });
    let records = [{ get: () => 'Accountant' }];
    const searches = [];
    Object.assign(business.cmp, {
      displayField: 'label', valueField: 'label', store: { getRange: () => records, isLoading: () => false },
      doQuery: (query) => { searches.push(query); records = [{ get: () => offered }]; },
    });
    const record = { applicant: {}, garaging: {}, operations: { businessClass: 'Freight Hauler', whatHaul: 'General freight hauler' }, drivers: [], vehicles: [], priorInsurance: [], coverage: {}, claims: {} };
    const report = await h.kit.fill(buildPlan(record, progressive), {});
    assert.equal(report.halted, false);
    assert.deepEqual(searches, ['General Freight Hauler']);
    assert.ok(report.filled.some((field) => field.q === '239'));
  }
});

test('currency formatting preserves accepted vehicle values but rejects a different amount', async () => {
  for (const displayed of ['$25,000.00', '$250,000.00']) {
    const h = harness({ ext: true });
    const field = addExtText(h, 'c', '2CE8', { caption: 'Vehicle value', onSet: (cmp) => {
      cmp._value = displayed;
      cmp.el.dom.value = displayed;
    } });
    const report = await h.kit.fill([{ id: 'value', q: '2CE8', field: fieldOf('2CE8'), path: 'vehicles[0].value', kind: 'money', value: 25000 }]);
    assert.equal(report.halted, false);
    assert.equal(report.filled.length, displayed === '$25,000.00' ? 1 : 0);
    assert.equal(report.failed.length, displayed === '$25,000.00' ? 0 : 1, 'a different amount is reported, not silently accepted');
    assert.equal(field.input.value, displayed);
  }
});

test('Duck Creek uppercase U/P component prefixes expose stable question ids', async () => {
  const h = harness({ ext: true });
  const u = addExtText(h, 'U', '1A01', { caption: 'Upper U' });
  const p = addExtText(h, 'P', '1A02', { caption: 'Upper P' });
  const report = await h.kit.fill([
    { id: 'u', q: '1A01', field: fieldOf('1A01'), path: 'synthetic.u', name: 'U', kind: 'text', value: 'one' },
    { id: 'p', q: '1A02', field: fieldOf('1A02'), path: 'synthetic.p', name: 'P', kind: 'text', value: 'two' },
  ], { maxRounds: 4 });
  assert.equal(Array.from(report.filled, (x) => x.q).join(','), '1A01,1A02');
  assert.equal(u.cmp.getValue(), 'one');
  assert.equal(p.cmp.getValue(), 'two');
  assert.equal(report.halted, false);
});

test('recorder reports uppercase Duck Creek question ids from the executed parser', () => {
  const h = recorderHarness();
  const input = makeInput({ id: `f_U${'B'.repeat(32)}2D0A_1_1`, ariaLabel: 'Synthetic recorder field', value: 'before' });
  h.document.body.append(input);
  // The recorder snapshot runs during initialization. Rebaseline after adding the field, then
  // invoke its real interval callback after a synthetic page change.
  h.context.__raterRecorder.rebaseline();
  input.value = 'after';
  h.tick();
  const event = h.sent.find((message) => message.event === 'field_changes');
  assert.ok(event, 'recorder emitted a field change');
  assert.equal(event.changes[0].q, '2D0A');
});

test('accepted answers survive a server redraw and are marked on the fresh control', async () => {
  const h = harness({ ext: true });
  const field = addExtText(h, 'U', '2B01', { caption: 'Redrawn field' });
  field.cmp.setValue = function setValue(value) {
    this._value = String(value);
    const replacement = makeInput({ id: field.id, ariaLabel: 'Redrawn field', value: String(value), attrs: { fieldref: fieldOf('2B01') } });
    this.el.dom.parentElement.replaceChild(replacement, this.el.dom);
    this.el.dom = replacement;
  };
  const report = await h.kit.fill([{ id: 'redraw', q: '2B01', field: fieldOf('2B01'), path: 'redraw.value', kind: 'text', value: 'accepted' }], { maxRounds: 2 });
  const fresh = h.document.getElementById(field.id);
  assert.equal(fresh.value, 'accepted');
  assert.equal(report.filled.length, 1);
  assert.equal(report.failed.length, 0);
  assert.equal(fresh.getAttribute('data-rater-autofill'), 'filled');
});

test('a server redraw that rejects the answer is flagged and keeps the helper from running', async () => {
  const h = harness({ ext: true });
  const field = addExtText(h, 'P', '2B02', { caption: 'Rejected field' });
  field.cmp.setValue = function setValue() {
    this._value = 'server value';
    const replacement = makeInput({ id: field.id, ariaLabel: 'Rejected field', value: 'server value', attrs: { fieldref: fieldOf('2B02') } });
    this.el.dom.parentElement.replaceChild(replacement, this.el.dom);
    this.el.dom = replacement;
  };
  const helper = addButton(h, 'Lookup VIN');
  const report = await h.kit.fill([
    { id: 'reject', q: '2B02', field: fieldOf('2B02'), path: 'rejected.value', kind: 'text', value: 'intake value' },
    { id: 'lookup', kind: 'action', action: 'lookupVin', text: 'Lookup VIN', pages: [], after: ['rejected.value'], afterActions: [], afterPages: [], unless: [], immediate: false },
  ], { maxRounds: 2 });
  assert.equal(report.halted, false);
  assert.equal(report.filled.length, 0);
  assert.ok(report.failed.some((x) => x.path === 'rejected.value'));
  assert.equal(helper._clicked, undefined, 'Lookup VIN waits until its field holds the intended value');
  assert.ok(report.blockers.some((b) => /failed/.test(b)));
});

test('unfamiliar required controls warn in yellow without blocking known fields or helpers', async () => {
  const h = harness();
  const known = makeInput({ id: 'known', ariaLabel: 'Known field' });
  const unknown = makeInput({ id: 'unknown', ariaLabel: 'Unfamiliar required question', required: true });
  h.document.body.append(known, unknown);
  const helper = addButton(h, 'Verify USDOT');
  helper.onclick = () => { helper._clicked = true; };
  const report = await h.kit.fill([
    { id: 'known-step', selector: '#known', path: 'known', kind: 'text', value: 'known answer' },
    { id: 'helper', kind: 'action', action: 'verifyDot', text: 'Verify USDOT', pages: [], after: [], afterActions: [], afterPages: [], unless: [] },
  ], { maxRounds: 4 });
  assert.equal(report.halted, false);
  assert.equal(known.value, 'known answer');
  assert.equal(unknown.value, '');
  assert.equal(unknown.getAttribute('data-rater-autofill'), 'needs');
  assert.ok(unknown.style.outline.includes('#d97706'));
  assert.ok(report.unknown.some((x) => /Unfamiliar required/.test(x.label)));
  assert.equal(helper._clicked, true);
});

// Design review 2026-10-10: a TNI standard (gender MALE, None of the above: an assumption, not an
// intake fact) is marked apart from intake answers; a standard the agent must confirm stays amber.
test('a TNI standard gets its own mark, an intake answer the filled green, and a standard to confirm the check color', async () => {
  const h = harness();
  const name = makeInput({ id: 'name', ariaLabel: 'Business Name' });
  const gender = new SelectNode([{ text: '', value: '' }, { text: 'MALE', value: 'M' }, { text: 'FEMALE', value: 'F' }], { id: 'gender', ariaLabel: 'Gender' });
  const marital = new SelectNode([{ text: '', value: '' }, { text: 'SINGLE', value: 'S' }, { text: 'MARRIED', value: 'M' }], { id: 'marital', ariaLabel: 'Marital Status' });
  h.document.body.append(name, gender, marital);
  const plan = [
    { id: 'n', selector: '#name', path: 'x.name', name: 'Business name', kind: 'text', value: 'Synthetic Hauling' },
    { id: 'g', selector: '#gender', path: 'x.gender', name: 'Gender', kind: 'choice', value: 'MALE', standard: true },
    { id: 'm', selector: '#marital', path: 'x.marital', name: 'Marital status', kind: 'choice', value: 'SINGLE', standard: true, reviewRequired: true, warn: 'Review mode: confirm this standard answer.' },
  ];
  const report = await h.kit.fill(plan, { maxRounds: 4 });
  assert.equal(report.filled.length, 3);
  assert.equal(name.getAttribute('data-rater-autofill'), 'filled');
  assert.equal(name.style.outline, '2px solid #16a34a');
  assert.equal(name.getAttribute('title'), 'Rater Autofill: filled from intake: Business name');
  assert.equal(gender.getAttribute('data-rater-autofill'), 'standard');
  assert.equal(gender.style.outline, '2px solid #2f6fd6');
  assert.equal(gender.getAttribute('title'), 'Rater Autofill: TNI standard answer, not from the intake: Gender');
  assert.equal(marital.getAttribute('data-rater-autofill'), 'needs', 'a standard to confirm is a check item');
  assert.equal(marital.style.outline, '2px dashed #d97706');
  assert.equal(marital.getAttribute('title'), 'Rater Autofill: Review mode: confirm this standard answer.');
  // A follow-up fill that keeps the marks leaves them as they were (the answers already in), and
  // the standard to confirm is still a check.
  const again = await h.kit.fill(plan, { maxRounds: 2, keepMarks: true });
  assert.equal(again.filled.length, 0);
  assert.equal(name.style.outline, '2px solid #16a34a');
  assert.equal(gender.style.outline, '2px solid #2f6fd6');
  assert.equal(marital.style.outline, '2px dashed #d97706');
  assert.equal(h.kit.clear(), 3);
  assert.equal(gender.style.outline, '');
  assert.equal(gender.getAttribute('data-rater-autofill'), null);
});

test('the side panel key shows the page marks in the page kit colors', () => {
  const css = fs.readFileSync(new URL('../sidepanel/sidepanel.css', import.meta.url), 'utf8');
  const colors = [...PAGEKIT.match(/const COLORS = \{([^}]*)\}/)[1].matchAll(/(\w+): '(#[0-9a-f]{6})'/gi)];
  assert.deepEqual(colors.map(([, status]) => status).sort(), ['ai', 'failed', 'filled', 'needs', 'standard']);
  for (const [, status, hex] of colors) {
    assert.equal(css.match(new RegExp(`--mark-${status}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1].toLowerCase(), hex.toLowerCase(), status);
    assert.match(css, new RegExp(`\\.mark\\.${status} \\{[^}]*var\\(--mark-${status}\\)`), status);
  }
});

test('repeated question ids without a vehicle hint stay yellow, and a hint picks the right row', async () => {
  const h = harness({ ext: true });
  const first = addExtText(h, 'U', '3C01', { caption: '2021 FORD TRANSIT 350', row: '8_1' });
  const second = addExtText(h, 'P', '3C01', { caption: '2019 ISUZU NPR HD', row: '8_2' });
  const report = await h.kit.fill([
    { id: 'duplicate-step', q: '3C01', field: fieldOf('3C01'), path: 'vehicles[0].value', kind: 'text', value: '45000' },
  ], { maxRounds: 2 });
  assert.equal(report.halted, false);
  assert.equal(first.input.value, '');
  assert.equal(second.input.value, '');
  assert.ok(report.unknown.length >= 2);
  // With the step's vehicle's year/make/model, the matching row is filled.
  const hinted = await h.kit.fill([
    { id: 'hinted-step', q: '3C01', field: fieldOf('3C01'), path: 'vehicles[1].value', kind: 'text', value: '45000', vehicleHint: ['2019', 'isuzu', 'npr hd'], activeVehicle: false },
  ], { maxRounds: 2 });
  assert.equal(second.input.value, '45000');
  assert.equal(first.input.value, '');
  assert.equal(hinted.filled.length, 1);
});

// Progressive's Rates with three vehicles (2026-10-05 FL run): every vehicle's row is answered,
// and a question without the vehicle in its label goes to its own row's vehicle.
test('per-vehicle Rates rows each get their own vehicle, including rows without the vehicle in the label', async () => {
  const h = harness({ ext: true });
  const vehicles = [
    { name: '2025 RAM PROMASTER 2500', hint: ['2025', 'ram', 'promaster 2500'], value: '31000' },
    { name: '2019 MERCEDES-BENZ SPRINTER', hint: ['2019', 'mercedes benz', 'sprinter'], value: '17000' },
    { name: '2016 FREIGHTLINER CASCADIA 125', hint: ['2016', 'freightliner', 'cascadia'], value: '22000' },
  ];
  const rows = vehicles.map((v, i) => ({
    rental: addExtText(h, 'c', '1FF2', { caption: v.name, row: `8_${i + 1}` }),
    worth: addExtText(h, 'r', '2091', { caption: 'If this vehicle was sold today, how much would it be worth?', row: `8_${i + 1}` }),
  }));
  const plan = vehicles.flatMap((v, i) => [
    { id: `rental-${i}`, q: '1FF2', field: fieldOf('1FF2'), path: 'progressive.q1FF2', kind: 'text', value: `rental ${i}`, vehicleHint: v.hint, activeVehicle: i === 2 },
    { id: `worth-${i}`, q: '2091', field: fieldOf('2091'), path: `vehicles[${i}].value`, kind: 'text', value: v.value, vehicleHint: v.hint, activeVehicle: i === 2 },
  ]);
  // A label fallback for the active (last) vehicle must not take the first row's box.
  plan.push({ id: 'fallback', q: '2CE8', field: fieldOf('2CE8'), path: 'vehicles[2].value', kind: 'text', value: '22000', re: 'sold today' });
  const report = await h.kit.fill(plan, { maxRounds: 12 });
  assert.equal(report.halted, false);
  assert.deepEqual(rows.map((r) => r.rental.input.value), ['rental 0', 'rental 1', 'rental 2']);
  assert.deepEqual(rows.map((r) => r.worth.input.value), ['31000', '17000', '22000']);
  assert.equal(report.unknown.length, 0);
});

// Codex on PR #21: an agent edit on one vehicle's row must not protect the other vehicles' rows.
test('each vehicle row of a repeated question has its own field key', async () => {
  const h = harness({ ext: true });
  const ram = addExtText(h, 'c', '1FF2', { caption: '2025 RAM PROMASTER 2500', row: '8_1' });
  const sprinter = addExtText(h, 'c', '1FF2', { caption: '2019 MERCEDES-BENZ SPRINTER', row: '8_2' });
  const report = await h.kit.fill([
    { id: 'ram', q: '1FF2', field: fieldOf('1FF2'), path: 'progressive.q1FF2', kind: 'text', value: 'ram rental', vehicleHint: ['2025', 'ram', 'promaster 2500'], activeVehicle: false },
    { id: 'sprinter', q: '1FF2', field: fieldOf('1FF2'), path: 'progressive.q1FF2', kind: 'text', value: 'sprinter rental', vehicleHint: ['2019', 'mercedes benz', 'sprinter'], activeVehicle: true },
  ], { maxRounds: 4, skip: ['1FF2@2'] });
  assert.equal(sprinter.input.value, '', 'the row an older build kept under its question id (1FF2@2) is left alone');
  assert.equal(ram.input.value, 'ram rental', 'the other vehicle still fills');
  assert.deepEqual(Array.from(report.filled, (x) => x.key), [`ref:${fieldOf('1FF2')}`], 'keyed by the data-model name; the first row has no @row');
  // Kept under the data-model name, the edit stays with its question whatever its number.
  const h2 = harness({ ext: true });
  const ram2 = addExtText(h2, 'c', '1FF2', { caption: '2025 RAM PROMASTER 2500', row: '8_1' });
  const sprinter2 = addExtText(h2, 'c', '2A07', { caption: '2019 MERCEDES-BENZ SPRINTER', row: '8_2', ref: fieldOf('1FF2') });
  await h2.kit.fill([
    { id: 'ram', q: '1FF2', field: fieldOf('1FF2'), path: 'progressive.q1FF2', kind: 'text', value: 'ram rental', vehicleHint: ['2025', 'ram', 'promaster 2500'], activeVehicle: false },
    { id: 'sprinter', q: '1FF2', field: fieldOf('1FF2'), path: 'progressive.q1FF2', kind: 'text', value: 'sprinter rental', vehicleHint: ['2019', 'mercedes benz', 'sprinter'], activeVehicle: true },
  ], { maxRounds: 4, skip: [`ref:${fieldOf('1FF2')}@2`] });
  assert.equal(sprinter2.input.value, '');
  assert.equal(ram2.input.value, 'ram rental');
});

test('two vehicles that read the same leave their rows to the agent', async () => {
  const h = harness({ ext: true });
  const first = addExtText(h, 'c', '1FF2', { caption: '2025 RAM PROMASTER 2500', row: '8_1' });
  const second = addExtText(h, 'c', '1FF2', { caption: '2025 RAM PROMASTER 2500', row: '8_2' });
  const hint = ['2025', 'ram', 'promaster 2500'];
  const report = await h.kit.fill([
    { id: 'a', q: '1FF2', field: fieldOf('1FF2'), path: 'progressive.q1FF2', kind: 'text', value: 'A', vehicleHint: hint, activeVehicle: true },
    { id: 'b', q: '1FF2', field: fieldOf('1FF2'), path: 'progressive.q1FF2', kind: 'text', value: 'B', vehicleHint: hint, activeVehicle: false },
  ], { maxRounds: 3 });
  assert.equal(first.input.value, '');
  assert.equal(second.input.value, '');
  assert.equal(report.filled.length, 0);
  // A year alone isn't enough to name a row.
  const h2 = harness({ ext: true });
  const ford = addExtText(h2, 'c', '1FF2', { caption: '2025 FORD TRANSIT', row: '8_1' });
  await h2.kit.fill([{ id: 'c', q: '1FF2', field: fieldOf('1FF2'), path: 'progressive.q1FF2', kind: 'text', value: 'C', vehicleHint: hint, activeVehicle: true }], { maxRounds: 2 });
  assert.equal(ford.input.value, '');
  // Codex on PR #21: an intake vehicle with one identifier can't name a row, even a unique match.
  const h3 = harness({ ext: true });
  const sprinter = addExtText(h3, 'c', '1FF2', { caption: '2019 MERCEDES-BENZ SPRINTER', row: '8_1' });
  addExtText(h3, 'c', '1FF2', { caption: '2016 FREIGHTLINER CASCADIA 125', row: '8_2' });
  await h3.kit.fill([{ id: 'd', q: '1FF2', field: fieldOf('1FF2'), path: 'progressive.q1FF2', kind: 'text', value: 'D', vehicleHint: ['sprinter'], activeVehicle: true }], { maxRounds: 2 });
  assert.equal(sprinter.input.value, '');
});

test('a page showing one vehicle at a time is answered by the active vehicle only', async () => {
  const h = harness({ ext: true });
  const worth = addExtText(h, 'r', '2091', { caption: 'If this vehicle was sold today, how much would it be worth?', row: '4_1' });
  const report = await h.kit.fill([
    { id: 'first', q: '2091', field: fieldOf('2091'), path: 'vehicles[0].value', kind: 'text', value: '31000', vehicleHint: ['2025', 'ram', 'promaster 2500'], activeVehicle: false },
    { id: 'second', q: '2091', field: fieldOf('2091'), path: 'vehicles[1].value', kind: 'text', value: '17000', vehicleHint: ['2019', 'mercedes benz', 'sprinter'], activeVehicle: true },
  ], { maxRounds: 3 });
  assert.equal(worth.input.value, '17000');
  assert.equal(report.filled.length, 1);
});

// Codex on PR #21: an earlier vehicle the intake doesn't describe (no year/make/model) has no
// hint, and must not take the box of the vehicle being added.
test('a per-vehicle step without year/make/model answers only as the active vehicle, and names no row', async () => {
  let h = harness({ ext: true });
  const worth = addExtText(h, 'r', '2091', { caption: 'If this vehicle was sold today, how much would it be worth?', row: '4_1' });
  await h.kit.fill([
    { id: 'undescribed', q: '2091', field: fieldOf('2091'), path: 'vehicles[0].value', kind: 'text', value: '31000', vehicleHint: null, activeVehicle: false },
    { id: 'active', q: '2091', field: fieldOf('2091'), path: 'vehicles[1].value', kind: 'text', value: '17000', vehicleHint: ['2019', 'mercedes benz', 'sprinter'], activeVehicle: true },
  ], { maxRounds: 3 });
  assert.equal(worth.input.value, '17000');
  // On Rates (rows named by their vehicle) it can't pick a row, even its own.
  h = harness({ ext: true });
  const row = addExtText(h, 'c', '1FF2', { caption: '2025 RAM PROMASTER 2500', row: '8_1' });
  const report = await h.kit.fill([
    { id: 'undescribed-rates', q: '1FF2', field: fieldOf('1FF2'), path: 'progressive.q1FF2', kind: 'text', value: 'rental', vehicleHint: null, activeVehicle: true },
  ], { maxRounds: 2 });
  assert.equal(row.input.value, '');
  assert.equal(report.filled.length, 0);
});

test('rows of several vehicles without their names are not given to the active vehicle', async () => {
  const h = harness({ ext: true });
  addExtText(h, 'c', '1FF2', { caption: 'Rental Reimbursement', row: '8_1' });
  addExtText(h, 'c', '1FF2', { caption: 'Rental Reimbursement', row: '8_2' });
  // Only the second vehicle has this one; nothing on the page says which vehicle that is.
  const loan = addExtText(h, 'c', '2007', { caption: 'Loan/Lease', row: '8_2' });
  const hint = (v) => (v ? ['2016', 'freightliner', 'cascadia'] : ['2019', 'mercedes benz', 'sprinter']);
  const report = await h.kit.fill([0, 1].flatMap((v) => [
    { id: `rental-${v}`, q: '1FF2', field: fieldOf('1FF2'), path: 'progressive.q1FF2', kind: 'text', value: 'rental', vehicleHint: hint(v), activeVehicle: v === 1 },
    { id: `loan-${v}`, q: '2007', field: fieldOf('2007'), path: 'progressive.q2007', kind: 'text', value: 'loan', vehicleHint: hint(v), activeVehicle: v === 1 },
  ]), { maxRounds: 4 });
  assert.equal(loan.input.value, '');
  assert.equal(report.filled.length, 0);
});

test('step.ignore makes a known optional question safe to leave untouched', async () => {
  const h = harness();
  const ignored = makeInput({ id: 'ignored', ariaLabel: 'Known optional suffix' });
  h.document.body.append(ignored);
  const report = await h.kit.fill([
    { id: 'ignored-step', selector: '#ignored', path: 'driver.suffix', kind: 'text', value: null, ignore: true },
  ], { maxRounds: 2 });
  assert.equal(report.halted, false);
  assert.equal(report.unknown.length, 0);
  assert.equal(ignored.value, '');
  assert.equal(report.filled.length, 0);
});

test('agent skip protects a corrected field while a later field can fill', async () => {
  const h = harness();
  const corrected = makeInput({ id: 'corrected', ariaLabel: 'Agent corrected' });
  const next = makeInput({ id: 'next', ariaLabel: 'Next field' });
  h.document.body.append(corrected, next);
  corrected.value = 'agent choice';
  next.value = '';
  const report = await h.kit.fill([
    { id: 'corrected-step', selector: '#corrected', path: 'corrected', kind: 'text', value: 'intake choice' },
    { id: 'next-step', selector: '#next', path: 'next', kind: 'text', value: 'filled later' },
  ], { skip: ['corrected'], maxRounds: 3 });
  assert.equal(report.halted, false);
  assert.equal(corrected.value, 'agent choice');
  assert.equal(next.value, 'filled later');
  assert.ok(report.filled.some((x) => x.path === 'next'));
});

test('ignored reviews leave unknown, repeated and invalid fields untouched while other fields fill', async () => {
  const h = harness({ ext: true });
  const first = addExtText(h, 'U', '3C01', { caption: 'Repeated vehicle field', value: 'agent value' });
  const second = addExtText(h, 'P', '3C01', { caption: 'Repeated vehicle field', value: 'other value' });
  first.input.setAttribute('aria-invalid', 'true');
  const unknown = makeInput({ id: 'unknown-required', ariaLabel: 'Unknown required', required: true });
  const next = makeInput({ id: 'next', ariaLabel: 'Next field' });
  h.document.body.append(unknown, next);
  const report = await h.kit.fill([
    { id: 'duplicate-step', q: '3C01', field: fieldOf('3C01'), path: 'vehicle.value', kind: 'text', value: '45000' },
    { id: 'next-step', selector: '#next', path: 'next', kind: 'text', value: 'filled later' },
  ], { skip: ['3C01', 'unknown-required'], maxRounds: 3 });
  assert.equal(report.halted, false);
  assert.equal(report.unknown.length, 0);
  assert.equal(report.leftRequired.length, 0);
  assert.equal(report.failed.length, 0);
  assert.equal(first.input.value, 'agent value');
  assert.equal(second.input.value, 'other value');
  assert.equal(unknown.value, '');
  assert.equal(next.value, 'filled later');
  assert.equal(report.skipped.length, 3);
});

test('selected Agent Fax Cover Page is preserved without stopping Print-page filling', async () => {
  const h = harness({ search: '?pageName=PrintEmailFax' });
  const faxCover = makeInput({ id: `f_c${'A'.repeat(32)}32CE_1_1`, ariaLabel: 'Agent Fax Cover Page', type: 'checkbox', checked: true });
  const print = makeInput({ id: `f_c${'A'.repeat(32)}32CC_1_1`, ariaLabel: 'Print', type: 'checkbox' });
  h.document.body.append(faxCover, print);
  const record = { applicant: {}, garaging: {}, operations: {}, drivers: [], vehicles: [], priorInsurance: [], coverage: {}, claims: {} };
  const report = await h.kit.fill(buildPlan(record, progressive), {});
  assert.equal(report.halted, false);
  assert.equal(report.unknown.length, 0);
  assert.equal(faxCover.checked, true);
  assert.equal(print.checked, true);
});

// TNI 2026-10-07: Chrome opens the quote PDF only after the agent's own click, so the Print page
// is filled (document, Print, fax cover kept) and Print/Send is left to the agent.
test('the Print page is filled and Print/Send is left to the agent, preserving fax cover', async () => {
  const h = harness({ search: '?pageName=PrintEmailFax' });
  const quote = makeInput({ id: `f_c${'A'.repeat(32)}32B0_1_1`, name: 'docs_32B0', type: 'radio', value: 'Insurance Quote (with all bill plans)', checked: true });
  const docs = makeInput({ id: 'doc-set', name: 'docs_32B0', type: 'radio', value: 'Document Set' });
  const print = makeInput({ id: `f_c${'A'.repeat(32)}32CC_1_1`, ariaLabel: 'Print', type: 'checkbox', checked: true });
  const cover = makeInput({ id: `f_c${'A'.repeat(32)}32CE_1_1`, ariaLabel: 'Agent Fax Cover Page', type: 'checkbox', checked: true });
  // Progressive ticked Email (Codex on PR #43): the agent's Print/Send must not send the quote.
  const email = makeInput({ id: `f_c${'A'.repeat(32)}32D0_1_1`, ariaLabel: 'Email', type: 'checkbox', checked: true });
  const fax = makeInput({ id: `f_c${'A'.repeat(32)}32DD_1_1`, ariaLabel: 'Fax', type: 'checkbox' });
  h.document.body.append(quote, docs, print, cover, email, fax);
  const button = addButton(h, 'Print/Send');
  let clicks = 0;
  button.onclick = () => clicks++;
  const record = { applicant: {}, garaging: {}, operations: {}, drivers: [], vehicles: [], priorInsurance: [], coverage: {}, claims: {} };
  const report = await h.kit.fill(buildPlan(record, progressive), { doneActions: [], replaceChoices: progressive.replaceChoices });
  assert.equal(clicks, 0, "the agent's click");
  assert.equal(quote.checked, true);
  assert.equal(print.checked, true);
  assert.equal(cover.checked, true);
  assert.equal(email.checked, false);
  assert.equal(fax.checked, false);
  assert.equal(report.unknown.length, 0);
  assert.equal(report.actions.length, 0);
});

test('action prerequisites are conjunctive and unsafe Start Quote buttons never click', async () => {
  const h = harness();
  const first = makeInput({ id: 'first', ariaLabel: 'First prerequisite' });
  const second = makeInput({ id: 'second', ariaLabel: 'Second prerequisite' });
  h.document.body.append(first, second);
  const recalc = addButton(h, 'Recalculate');
  recalc.onclick = () => { recalc._clicked = true; };
  const start = addButton(h, 'Start Quote');
  start.onclick = () => { start._clicked = true; };
  const plan = [
    { id: 'first-step', selector: '#first', path: 'first', kind: 'text', value: 'one' },
    { id: 'second-step', selector: '#second', path: 'second', kind: 'text', value: 'two' },
    { id: 'recalc', kind: 'action', action: 'recalculate', text: 'Recalculate', pages: [], after: ['first', 'second'], afterActions: [], afterPages: [], unless: [] },
    { id: 'start', kind: 'action', action: 'startQuote', text: 'Start Quote', pages: [], after: ['first'], afterActions: [], afterPages: [], unless: [] },
  ];
  const report = await h.kit.fill(plan, { maxRounds: 5 });
  assert.equal(report.halted, false);
  assert.equal(first.value, 'one');
  assert.equal(second.value, 'two');
  assert.equal(recalc._clicked, true, 'recalculate waits for every prerequisite');
  assert.equal(start._clicked, undefined, 'Start Quote remains the agent navigation decision');
  assert.equal(report.actions.filter((x) => x.id === 'startQuote').length, 0);
});

// The vehicle tile (2026-10-05: a Semi Truck found no tile and the panel said nothing).
test('a helper the agent must otherwise do says so when it cannot be clicked, and a unique one never guesses', async () => {
  const tile = (text, missing) => ({ id: 'tile', kind: 'action', action: 'vehicleTile:2', text, unique: true, label: 'Vehicle type', missing,
    path: 'action.vehicleTile', name: 'Click vehicleTile', pages: [], after: [], afterActions: [], afterPages: [], unless: [] });
  const page = () => {
    const h = harness();
    for (const name of ['Truck Tractor', 'Box Truck', 'Cargo Van']) addButton(h, name).onclick = function () { this._clicked = true; };
    return h;
  };
  // No tile for this type: nothing clicked, the agent is told.
  let h = page();
  let report = await h.kit.fill([tile(null, 'Tanker isn\'t matched to a Progressive tile yet: pick the vehicle yourself.')], { maxRounds: 2 });
  assert.equal(report.actions.length, 0);
  assert.deepEqual(Array.from(report.noData, (x) => [x.label, x.note]), [['Vehicle type', 'Tanker isn\'t matched to a Progressive tile yet: pick the vehicle yourself.']]);
  assert.ok(report.blockers.includes('needs you: Vehicle type'));
  // A mapped type whose tile isn't on the page: also told.
  h = page();
  report = await h.kit.fill([tile('reefer|refrigerat', 'No reefer tile here.')], { maxRounds: 2 });
  assert.deepEqual(Array.from(report.noData, (x) => x.note), ['No reefer tile here.']);
  // Two matching tiles: the agent's pick, not the first one.
  h = page();
  report = await h.kit.fill([tile('truck', 'Two tiles match.')], { maxRounds: 2 });
  assert.equal(report.actions.length, 0);
  assert.deepEqual(Array.from(report.noData, (x) => x.note), ['Two tiles match.']);
  // The tile is there: clicked, no note.
  h = page();
  report = await h.kit.fill([tile('^Truck Tractor$', 'unused')], { maxRounds: 2 });
  assert.deepEqual(Array.from(report.actions, (x) => x.text), ['Truck Tractor']);
  assert.equal(report.noData.length, 0);
});

// 2026-10-07 FL run: after the tile opened Add Vehicle, the tile page's report listed Add
// Vehicle's still-empty safety questions ("needs you: Anti-Lock Brakes?").
test('a helper that opens the next page leaves that page\'s questions to its own fill', async () => {
  const h = harness({ ext: true, search: '?pageName=MostCommonVehicles' });
  addButton(h, 'Cargo Van').onclick = () => {
    h.context.location.search = '?pageName=AddVehicle';
    addExtText(h, 'c', '2BA1', { required: true });
  };
  const report = await h.kit.fill([
    { id: 'tile', kind: 'action', action: 'vehicleTile:0', text: '^Cargo Van$', unique: true, label: 'Vehicle type', missing: 'Pick the vehicle yourself.',
      path: 'action.vehicleTile', name: 'Click vehicleTile', pages: [], after: [], afterActions: [], afterPages: [], unless: [] },
    { id: 'abs', q: '2BA1', field: fieldOf('2BA1'), path: 'progressive.q2BA1', name: 'Anti-lock brakes', kind: 'text', ignore: true, emptyNote: 'Answer it yourself.', value: null },
  ], { maxRounds: 3 });
  assert.deepEqual(Array.from(report.actions, (x) => x.text), ['Cargo Van']);
  assert.equal(report.navigatedTo, 'AddVehicle');
  assert.equal(report.noData.length, 0);
  assert.equal(report.leftRequired.length, 0);
  assert.deepEqual(Array.from(report.blockers), []);
});

// 2026-10-07 FL run: the commodity list fills in only after its category is picked, and its
// first try found it empty ("failed: " with no name, as the list has no caption).
test('a list that loads after another answer is given time; an unlabeled field is named after its rule', async () => {
  for (const late of [true, false]) {
    const h = harness({ ext: true, search: '?pageName=CoveragesRates' });
    // Drawn with a blank caption, as Progressive draws it.
    const list = addExtText(h, 'c', '216B', { caption: ' ' });
    const commodities = ['', 'Appliances', 'Other Consumer Goods'].map((label) => ({ get: () => label }));
    let records = late ? [] : commodities.slice(0, 2);
    Object.assign(list.cmp, { displayField: 'label', valueField: 'label', store: { getRange: () => records, isLoading: () => false } });
    if (late) setTimeout(() => { records = commodities; }, 600);
    const report = await h.kit.fill([{ id: 'commodity', q: '216B', field: fieldOf('216B'), path: 'progressive.q216B', name: 'Cargo commodity', kind: 'choice', value: 'Other Consumer Goods' }], { maxRounds: 3 });
    if (late) {
      assert.equal(list.cmp.getValue(), 'Other Consumer Goods', 'picked once the list loaded');
      assert.equal(report.failed.length, 0);
    } else {
      assert.equal(report.failed.length, 1, 'a loaded list without the answer fails at once');
      assert.ok(report.blockers.includes('failed: Cargo commodity'), 'named after its rule');
    }
  }
});

// TN live run, 2026-10-07: the trailer page carries the vehicle's data-model names (RiskInput.VIN,
// RiskInput.NonPAValue). Each page gets its own unit's answers, never the other's.
test('the trailer page gets the trailer\'s answers and the vehicle page the vehicle\'s, under the same names', async () => {
  const record = {
    applicant: {}, garaging: { street: '1 Test Way', city: 'Testville', state: 'TN', zip: '37000' },
    operations: { businessClass: 'Freight Hauler', radius: 'Unlimited' }, drivers: [], priorInsurance: [], coverage: {}, claims: {},
    vehicles: [{ type: 'Semi Truck', year: 2013, make: 'PETERBILT', model: '388', vin: '1XPWD40X1DD000001', value: 60000 }],
    trailers: [{ type: 'Flatbed', year: 2019, make: 'WILSON', vin: '1W1MAFZB0KA000002', value: 45000 }], trailerInfo: {},
  };
  for (const [page, vin, value] of [['AddTrailer', '1W1MAFZB0KA000002', '45000'], ['AddVehicle', '1XPWD40X1DD000001', '60000']]) {
    const h = harness({ ext: true, search: `?pageName=${page}` });
    const box = addExtText(h, 'c', page === 'AddTrailer' ? '2A29' : '2B20', { caption: page === 'AddTrailer' ? 'VIN' : 'Vehicle Identification Number (VIN)', ref: 'RiskInput.VIN', row: '8_3' });
    const worth = addExtText(h, 'c', page === 'AddTrailer' ? '2B04' : '2CE8', { ref: 'RiskInput.NonPAValue', row: '8_3',
      caption: `If this ${page === 'AddTrailer' ? 'trailer' : 'vehicle'} was sold today, how much would it be worth (excluding any permanently attached equipment)?` });
    const report = await h.kit.fill(buildPlan(record, progressive, { trailers: 0, vehicles: 0 }), { maxRounds: 8 });
    assert.deepEqual([box.input.value, worth.input.value], [vin, value], page);
    assert.equal(report.unknown.length, 0, page);
    assert.equal(report.reworded.length, 0, `${page}: found by its own rule, so its wording is as expected`);
  }
});

// The trailer's Rates row ("2019 Wilson") next to the vehicle's: each gets its own unit's answer.
test('Rates rows of a vehicle and a trailer each get their own answer', async () => {
  const record = {
    applicant: {}, garaging: { state: 'TN' }, operations: {}, drivers: [], priorInsurance: [], coverage: {}, claims: {},
    vehicles: [{ type: 'Semi Truck', year: 2013, make: 'PETERBILT', model: '388', value: 60000 }],
    trailers: [{ type: 'Flatbed', year: 2019, make: 'WILSON', value: 45000 }], trailerInfo: {},
  };
  const h = harness({ ext: true, search: '?pageName=CoveragesRates' });
  const options = ['Not selected', '$40 per day, $1,200 max', '$50 per day, $1,500 max'].map((label) => ({ get: () => label }));
  const rows = ['2013 PETERBILT 388', '2019 Wilson'].map((caption, i) => {
    const row = addExtText(h, 'c', '1FF2', { caption, ref: 'RentalInput.Limit', row: `8_${i + 1}` });
    Object.assign(row.cmp, { displayField: 'label', valueField: 'label', store: { getRange: () => options } });
    return row;
  });
  const report = await h.kit.fill(buildPlan(record, progressive, {}).filter((s) => /^(TR)?1FF2$/.test(s.q ?? '')), { maxRounds: 6 });
  assert.deepEqual(rows.map((r) => r.cmp.getValue()), ['$40 per day, $1,200 max', 'Not selected']);
  assert.equal(report.unknown.length, 0);
});

// Add Trailer sits in a menu, so it's not on the page once the trailer is in: its "add it yourself"
// note is only for a trailer not entered yet.
test('a helper\'s "do it yourself" note is not shown once what it adds is already in', async () => {
  const addTrailer = { id: 'add', kind: 'action', action: 'addTrailer:0', text: '^add trailer$', label: 'Trailer', missing: 'Add the trailer yourself.',
    pages: [], after: [], afterActions: ['lookupVin:0'], afterPages: [], unless: [], unlessActions: ['trailerEntered:0'] };
  for (const [done, notes] of [[['lookupVin:0'], 1], [['lookupVin:0', 'trailerEntered:0'], 0]]) {
    const h = harness();
    const report = await h.kit.fill([addTrailer], { maxRounds: 2, doneActions: done });
    assert.equal(report.noData.length, notes, done.join(' '));
  }
  // Codex on PR #43: opened but never entered (the trailer page left): the agent finishes it.
  const opened = { ...addTrailer, doneWhen: ['trailerEntered:0'], unfinished: 'Add Trailer was opened, but this trailer was never entered.' };
  for (const [done, notes] of [[['lookupVin:0', 'addTrailer:0'], ['Add Trailer was opened, but this trailer was never entered.']], [['lookupVin:0', 'addTrailer:0', 'trailerEntered:0'], []]]) {
    const h = harness();
    addButton(h, 'Continue');
    const report = await h.kit.fill([opened], { maxRounds: 2, doneActions: done });
    assert.deepEqual(Array.from(report.noData, (x) => x.note), notes, done.join(' '));
  }
});

// Codex on PR #43: a question we leave as the page has it, found by its data-model name, whose
// wording changed: the agent checks what the page has (it holds Continue).
test('a left-alone question whose wording changed is a check for the agent', async () => {
  const h = harness({ ext: true, search: '?pageName=BusinessOwnerInfo' });
  addExtText(h, 'c', '194', { caption: 'When does the customer want coverage to begin?', value: '10/08/2026' });
  const report = await h.kit.fill([{ id: 'start', q: '194', field: fieldOf('194'), ask: ['When should this Progressive Commercial Auto policy start?'], path: 'progressive.q194', name: 'Policy start date', kind: 'text', ignore: true, value: null }], { maxRounds: 2 });
  assert.equal(report.checks.length, 1);
  assert.match(report.checks[0].note, /wording of this question changed/);
  assert.ok(report.blockers.some((b) => /^check: /.test(b)));
  // Its wording as expected: left alone, nothing to check.
  const h2 = harness({ ext: true, search: '?pageName=BusinessOwnerInfo' });
  addExtText(h2, 'c', '194', { value: '10/08/2026' });
  const same = await h2.kit.fill([{ id: 'start', q: '194', field: fieldOf('194'), ask: [liveIdentity('194').caption], path: 'progressive.q194', name: 'Policy start date', kind: 'text', ignore: true, value: null }], { maxRounds: 2 });
  assert.equal(same.checks.length, 0);
});

test('listed() says which VINs the page shows, as whole runs', () => {
  const h = harness();
  h.document.body.innerText = 'Vehicles on the quote:\nVehicle 1\n2013\nPETERBILT 388\n1XPWD40X1DD000001\nEdit\nRemove';
  assert.deepEqual(Array.from(h.kit.listed(['1xpwd40x1dd000001', '1W1MAFZB0KA000002', '0X1DD000001', null])), [true, false, false, false]);
  // Names: every word, whole, on one line (one driver).
  h.document.body.innerText = 'Here are the drivers on the quote:\nJordan Avery Sample\nEdit';
  assert.deepEqual(Array.from(h.kit.listed([['Jordan', 'Sample'], ['Jordan', 'Samples'], ['Jo', 'Sample']])), [true, false, false]);
  // Codex on PR #43: a first name from one driver and a last name from another is not a driver.
  h.document.body.innerText = 'Here are the drivers on the quote:\nJordan Example\nEdit\nCasey Sample\nEdit';
  assert.deepEqual(Array.from(h.kit.listed([['Jordan', 'Sample'], ['Casey', 'Sample']])), [false, true]);
});

// Codex on PR #43: a Yes / No question that became a text box is never typed "Yes" into.
test('a yes/no answer is never typed into a text box with its question\'s wording', async () => {
  const h = harness();
  const box = makeInput({ id: 'hazmat', ariaLabel: 'Does the customer haul hazardous materials?' });
  h.document.body.append(box);
  const report = await h.kit.fill([{ id: 'hz', path: 'operations.hazmat', name: 'Hauls hazmat', kind: 'bool', ask: ['Does the customer haul hazardous materials?'], value: false }], { maxRounds: 2 });
  assert.equal(box.value, '');
  assert.equal(report.filled.length, 0);
  assert.equal(report.unknown.length, 1, 'left for the agent as unfamiliar');
});

// SC 2026-10-07: "View bill plan options" clicked right after UM/UIM were cleared did nothing, and
// the panel waited for the bill plan forever. A button the carrier refuses while a required
// question is empty waits for it, and says so.
test('a Rates button waits while a required question on the page is empty', async () => {
  const h = harness({ ext: true, search: '?pageName=CoveragesRates' });
  const um = addExtText(h, 'c', '1E68', { caption: 'Uninsured Motorist Bodily Injury & Property Damage', ref: 'LineInput.UMBIPDLimit', required: true });
  const button = addButton(h, 'View bill plan options');
  button.onclick = () => { button._clicked = true; };
  const billPlan = { id: 'bp', kind: 'action', action: 'billPlan', text: '^view bill plan options$', pages: ['CoveragesRates'], after: [], afterActions: [], afterPages: [], unless: [], waitRequired: true };
  let report = await h.kit.fill([billPlan], { maxRounds: 2 });
  assert.equal(button._clicked, undefined);
  assert.ok(report.blockers.some((b) => /^button: billPlan \(waiting for Uninsured Motorist Bodily Injury & Property Damage answered\)$/.test(b)));
  um.cmp.setValue('$100k CSL w/ $200 Deductible');
  um.input.value = '$100k CSL w/ $200 Deductible';
  report = await h.kit.fill([billPlan], { maxRounds: 2 });
  assert.equal(button._clicked, true);
});

// TNI 2026-10-20 (PR #110 review): GL asked for on the intake is the agent's to add on Rates (what
// its "+" opens hasn't been recorded). That needs-you item holds Print until the agent has been to
// the bill plan (`settledByPages`), which they open after adding GL; then it is settled.
test('a needs-you helper item holds later helpers until the agent has been to the page that settles it', async () => {
  const run = async (visitedPages) => {
    const h = harness({ ext: true, search: '?pageName=CoveragesRates' });
    const button = addButton(h, 'Print, Email, Fax');
    button.onclick = () => { button._clicked = true; };
    const glItem = { id: 'gl', kind: 'action', action: 'glRates', baseAction: 'glRates', label: 'General liability', pages: ['CoveragesRates'], text: null,
      missing: 'Add general liability yourself, then open the bill plan options.', after: [], afterActions: [], afterPages: [], unless: [], heldBy: [], settledByPages: ['ChangePaymentPlan'] };
    const print = { id: 'pr', kind: 'action', action: 'print', baseAction: 'print', text: '^print, email, fax$', pages: ['CoveragesRates'], after: [], afterActions: [], afterPages: ['ChangePaymentPlan'], unless: [], heldBy: ['glRates'] };
    const report = await h.kit.fill([glItem, print], { maxRounds: 2, visitedPages });
    return { report, clicked: !!button._clicked, blockers: Array.from(report.blockers).join(' | ') };
  };
  let r = await run([]);
  assert.equal(r.clicked, false);
  assert.ok(r.report.noData.some((x) => x.label === 'General liability' && /Add general liability yourself/.test(x.note)), r.blockers);
  assert.ok(r.report.blockers.includes('needs you: General liability'), r.blockers);
  assert.match(r.blockers, /button: print \(waiting for [^)]*General liability resolved/);
  // Back from the bill plan: the item is settled, and Print runs.
  r = await run(['ChangePaymentPlan']);
  assert.equal(r.clicked, true, r.blockers);
  assert.doesNotMatch(r.blockers, /General liability/);
});

// SC 2026-10-07: a trailer rule's data-model name (RiskInput.PAValue, kept to Add Trailer) left the
// vehicle's own question for that field on Add Vehicle unclaimed. A name fenced off a page claims
// nothing there.
test('a data-model name fenced off this page does not keep a text rule from its field', async () => {
  const h = harness({ ext: true, search: '?pageName=AddVehicle' });
  addExtText(h, 'c', '2D50', { caption: 'What is the value of the permanently attached equipment?', ref: 'Test.SomeOtherName' });
  const report = await h.kit.fill([
    { id: 'trailer', q: '2AFC', field: 'Test.SomeOtherName', ask: ['What is the value of the permanently attached equipment?'], pages: ['AddTrailer'], pageOnly: true, path: 'progressive.q2AFC', kind: 'money', ignore: true },
    { id: 'vehicle', q: '2CE0', ask: ['What is the value of the permanently attached equipment?'], pages: ['AddVehicle'], path: 'progressive.q2CE0', kind: 'text', ignore: true },
  ], { maxRounds: 2 });
  assert.equal(report.unknown.length, 0);
});

// TNI 2026-10-20 (W43-02): with no ZIP on the intake, the vehicle or trailer ZIP Progressive put
// there is left, not asked on every vehicle. A field still empty when the fill ends is the agent's,
// and an intake ZIP still fills (or is flagged when the page says another).
test('vehicle ZIP: Progressive\'s own ZIP is left when the intake has none; empty at the end stays the agent\'s', async () => {
  const zipRun = async (intakeZip, pageZip, { page = 'AddVehicle', caption = 'Zip code where the vehicle is located', vinSets } = {}) => {
    const record = { applicant: { name: 'Sample Test LLC' }, garaging: { zip: intakeZip }, operations: {}, drivers: [], vehicles: [{ vin: '1FTBW3XM5HKA00001', type: 'Van' }], trailers: [{ vin: '1GRAA0621FB000001', type: 'Dry Van' }], priorInsurance: [], coverage: {}, claims: {} };
    const h = harness({ ext: true, search: `?pageName=${page}` });
    const zip = addExtText(h, 'c', '2C02', { caption, ref: 'RiskInput.PrimaryZIP', required: true, value: pageZip });
    zip.input.value = pageZip;
    const fields = ['RiskInput.PrimaryZIP'];
    // The page changing the ZIP while the fill answers another question (the VIN).
    if (vinSets != null) {
      addExtText(h, 'c', '2C01', { caption: 'Vehicle Identification Number (VIN)', ref: 'RiskInput.VIN', row: '8_3', onSet: () => zip.cmp.setValue(vinSets) });
      fields.push('RiskInput.VIN');
    }
    const steps = buildPlan(record, progressive).filter((s) => fields.includes(s.field) && s.pages?.includes(page));
    assert.equal(steps.length, fields.length, page);
    return { zip, report: await h.kit.fill(steps, { maxRounds: 4 }) };
  };
  for (const page of ['AddVehicle', 'AddTrailer']) {
    // No intake ZIP, Progressive filled it: left, nothing for the agent.
    let { zip, report } = await zipRun(null, '18042', { page });
    assert.equal(zip.cmp.getValue(), '18042', page);
    assert.equal(report.noData.length, 0, page);
    assert.equal(report.failed.length, 0, page);
    assert.equal(report.blockers.length, 0, `${page}: ${report.blockers.join(' | ')}`);
    // No intake ZIP and an empty field: the agent's, with the note.
    ({ report } = await zipRun(null, '', { page }));
    assert.equal(report.noData.length, 1, page);
    assert.match(report.noData[0].note, /no garaging ZIP/);
    assert.ok(report.blockers.length >= 1, page);
  }
  // Emptied by the page later in the fill: the agent's. Filled by the page later: not.
  let { zip, report } = await zipRun(null, '18042', { vinSets: '' });
  assert.equal(zip.cmp.getValue(), '');
  assert.equal(report.noData.length, 1, 'emptied after it was left');
  ({ zip, report } = await zipRun(null, '', { vinSets: '18042' }));
  assert.equal(zip.cmp.getValue(), '18042');
  assert.equal(report.noData.length, 0, 'filled by the page before the fill ended');
  // The question reads differently now: what the page has is the agent's to check.
  ({ report } = await zipRun(null, '18042', { caption: 'Garaging ZIP for this vehicle' }));
  assert.equal(report.checks.length, 1);
  assert.match(report.checks[0].note, /wording of this question changed/);
  // An intake ZIP fills an empty field...
  ({ zip, report } = await zipRun('17101', ''));
  assert.equal(zip.cmp.getValue(), '17101');
  assert.equal(report.kept.length, 0);
  // ...and a different one on the page is flagged, not kept quietly.
  ({ report } = await zipRun('17101', '18042'));
  assert.ok(report.kept.some((x) => x.differs), 'page ZIP differs from the intake: flagged');
});

// SC 2026-10-07: the equipment amount showed until "no equipment" was ticked, then went away; it
// stayed listed as unfamiliar. A question gone by the end of the fill isn't the agent's.
test('an unfamiliar question that went away during the fill is not reported', async () => {
  const h = harness({ ext: true, search: '?pageName=AddVehicle' });
  const amount = addExtText(h, 'c', '9999', { caption: 'A brand new amount question', ref: 'Test.Brand.New' });
  const box = makeInput({ id: 'noequip', type: 'checkbox', ariaLabel: 'Vehicle has no equipment' });
  box.onclick = () => { amount.input.remove(); };
  h.document.body.append(box);
  const report = await h.kit.fill([{ id: 'none', selector: '#noequip', path: 'progressive.q2CE3', kind: 'bool', value: true }], { maxRounds: 4 });
  assert.equal(box.checked, true);
  assert.equal(report.unknown.length, 0);
  assert.ok(!report.blockers.some((b) => /^unfamiliar/.test(b)));
  // Codex on PR #43: a field that looked renamed and then went away doesn't hold Continue either.
  const r = harness({ ext: true, search: '?pageName=BusinessOwnerInfo' });
  const odd = addExtText(r, 'c', '9998', { caption: 'Agent Code', ref: 'AgencyInfo.SomethingRenamed' });
  const tick = makeInput({ id: 'tick', type: 'checkbox', ariaLabel: 'Tick me' });
  tick.onclick = () => { odd.input.remove(); };
  r.document.body.append(tick);
  const renamed = await r.kit.fill([
    { id: 'agent', q: '18F', field: 'AgencyInfo.AgencyCodeAgent', ask: ['Agent Code'], pages: ['BusinessOwnerInfo'], path: 'progressive.q18F', kind: 'text', ignore: true },
    { id: 'tick', selector: '#tick', path: 'x.tick', kind: 'bool', value: true },
  ], { maxRounds: 4 });
  assert.equal(renamed.renamed.length, 0);
  assert.equal(renamed.pageChanged, false);
});

// PR #17 review: a click on Add Non-Trucking Liability that the page dropped must not count.
test('a helper verified by its link going away counts only when the link is gone', async () => {
  const ntl = { id: 'ntl', kind: 'action', action: 'addNtl', text: '^add non-?trucking liability( instead)?\\??$', verify: 'gone',
    pages: [], after: [], afterActions: [], afterPages: [], unless: [] };
  let h = harness();
  let link = addButton(h, 'Add Non-Trucking Liability instead?');
  link.onclick = () => link.remove();
  let report = await h.kit.fill([ntl], { maxRounds: 3 });
  assert.deepEqual(Array.from(report.actions, (x) => x.id), ['addNtl']);
  assert.ok(!report.blockers.some((b) => /addNtl/.test(b)));
  // The page kept the link (the click was lost in a redraw): not done, and the agent sees it.
  h = harness();
  link = addButton(h, 'Add Non-Trucking Liability instead?');
  link.onclick = () => {};
  report = await h.kit.fill([ntl], { maxRounds: 3 });
  assert.equal(report.actions.length, 0);
  assert.ok(report.blockers.includes('button: addNtl'), Array.from(report.blockers).join(' | '));
  // Codex on PR #22: left on screen but disabled is not gone.
  h = harness();
  link = addButton(h, 'Add Non-Trucking Liability instead?');
  link.onclick = () => { link.disabled = true; };
  report = await h.kit.fill([ntl], { maxRounds: 3 });
  assert.equal(report.actions.length, 0);
  assert.ok(report.blockers.includes('button: addNtl'));
  // NTL added earlier in the quote, then set back to No: a "needs you" item, never a click.
  h = harness();
  const kept = { id: 'kept', kind: 'action', action: 'ntlStillAdded', text: null, label: 'Non-trucking liability', missing: 'remove it yourself',
    path: 'action.ntlStillAdded', name: 'Click ntlStillAdded', pages: [], after: [], afterActions: ['addNtl'], afterPages: [], unless: [] };
  report = await h.kit.fill([kept], { maxRounds: 2 });
  assert.equal(report.noData.length, 0, 'not before NTL was added');
  report = await h.kit.fill([kept], { maxRounds: 2, doneActions: ['addNtl'] });
  assert.deepEqual(Array.from(report.noData, (x) => x.note), ['remove it yourself']);
  // Codex on PR #22: while it's open the later Rates helpers wait; once the page offers Add NTL
  // again (the agent removed it) the item is settled and they run.
  const heldKept = { ...kept, resolvedBy: '^add non-?trucking liability( instead)?\\??$' };
  const billPlan = { id: 'bill', kind: 'action', action: 'billPlan', baseAction: 'billPlan', text: '^view bill plan options$', heldBy: ['ntlStillAdded'],
    pages: [], after: [], afterActions: [], afterPages: [], unless: [] };
  const withBase = { ...heldKept, baseAction: 'ntlStillAdded', heldBy: [] };
  h = harness();
  const bill = addButton(h, 'View bill plan options');
  bill.onclick = () => { bill._clicked = true; };
  report = await h.kit.fill([withBase, billPlan], { maxRounds: 3, doneActions: ['addNtl'] });
  assert.equal(bill._clicked, undefined, 'held while NTL is still on the quote');
  assert.ok(report.blockers.some((b) => /billPlan \(waiting for Non-trucking liability resolved\)/.test(b)), Array.from(report.blockers).join(' | '));
  addButton(h, 'Add Non-Trucking Liability instead?');
  report = await h.kit.fill([withBase, billPlan], { maxRounds: 3, doneActions: ['addNtl'] });
  assert.equal(bill._clicked, true, 'NTL removed: the bill plan runs');
  assert.equal(report.noData.length, 0, 'and the item is settled');
  // Codex on PR #22: Yes, No, removed by hand, Yes again: the link is back, so it's clicked again.
  h = harness();
  link = addButton(h, 'Add Non-Trucking Liability instead?');
  link.onclick = () => link.remove();
  report = await h.kit.fill([ntl], { maxRounds: 3, doneActions: ['addNtl'] });
  assert.deepEqual(Array.from(report.actions, (x) => x.id), ['addNtl'], 're-armed while its link is on the page');
});

function coverageActionPlan() {
  return [
    { id: 'limit', selector: '#liab-limit', path: 'coverage.autoLiabLimit', kind: 'text', value: '1M CSL' },
    { id: 'recalc', kind: 'action', action: 'recalculate', text: '^recalculate$', pages: ['CoveragesRates'], after: ['coverage.autoLiabLimit'], afterActions: [], afterPages: [], unless: [], needsRecalculation: true, verify: 'premium' },
    { id: 'bill', kind: 'action', action: 'billPlan', text: '^(view )?bill plan options?$', pages: ['CoveragesRates'], after: [], afterAny: ['coverage.autoLiabLimit'], afterActions: ['recalculate'], afterPages: [], unless: [], needsPremium: true },
  ];
}

function premiumHarness({ recalcResult = 'Total premium: $12,345.67', billDisabled = false } = {}) {
  const h = harness({ search: '?pageName=CoveragesRates' });
  const limit = makeInput({ id: 'liab-limit', ariaLabel: 'Liability limit', value: '1M CSL' });
  h.document.body.append(limit);
  h.document.body.innerText = 'Rates changed **** — please recalculate';
  const recalc = addButton(h, 'Recalculate');
  recalc.onclick = () => { recalc._clicked = true; h.document.body.innerText = recalcResult; };
  let bill;
  if (billDisabled) {
    const wrapper = new FakeNode('div', { className: 'x-btn-disabled' });
    bill = new FakeNode('button', { textContent: 'View bill plan options' });
    wrapper.append(bill);
    h.document.body.append(wrapper);
  } else {
    bill = addButton(h, 'View bill plan options');
  }
  bill.onclick = () => { bill._clicked = true; };
  return { h, recalc, bill };
}

test('bill plans wait for recalculate and a fresh visible premium', async () => {
  const good = premiumHarness();
  const report = await good.h.kit.fill(coverageActionPlan(), { maxRounds: 4 });
  assert.equal(good.recalc._clicked, true);
  assert.equal(good.bill._clicked, true);
  assert.equal(Array.from(report.actions, (x) => x.id).join(','), 'recalculate,billPlan');
  assert.equal(report.halted, false);

  for (const recalcResult of ['Rates changed **** — please recalculate', 'Rates refreshed']) {
    const stale = premiumHarness({ recalcResult });
    const blocked = await stale.h.kit.fill(coverageActionPlan(), { maxRounds: 4 });
    assert.equal(stale.recalc._clicked, true);
    assert.equal(stale.bill._clicked, undefined, `bill plan remains blocked for: ${recalcResult}`);
    assert.equal(blocked.halted, false);
    assert.ok(Array.from(blocked.invalidatedActions).includes('recalculate'));
    assert.ok(blocked.blockers.some((b) => /button/.test(b)), 'the agent sees the button is waiting');
  }

  const disabled = premiumHarness({ billDisabled: true });
  const disabledReport = await disabled.h.kit.fill(coverageActionPlan(), { maxRounds: 4 });
  assert.equal(disabled.recalc._clicked, true);
  assert.equal(disabled.bill._clicked, undefined);
  assert.equal(disabledReport.halted, false);
});

function cargoPlan() {
  return [
    { id: 'cargo-value', q: '216F', field: fieldOf('216F'), path: 'progressive.q216F', kind: 'text', value: '$100000/$1000', cargo: 'limit' },
    { id: 'done', kind: 'action', action: 'doneCargo', text: '^done with this coverage$', pages: ['CoveragesRates'], after: [], afterAny: ['progressive.q216F'], afterActions: [], afterPages: [], unless: [], verify: 'cargoClosed' },
  ];
}

test('cargo Done verifies a collapsed retained result and rejects expanded or changed cargo', async () => {
  const accepted = harness({ ext: true, search: '?pageName=CoveragesRates' });
  addExtText(accepted, 'U', '216F', { caption: 'Motor truck cargo limit and deductible', value: '$100000/$1000' });
  const acceptedButton = addButton(accepted, 'Done with this coverage');
  acceptedButton.onclick = () => { acceptedButton._clicked = true; };
  const acceptedReport = await accepted.kit.fill(cargoPlan(), { maxRounds: 5 });
  assert.equal(acceptedButton._clicked, true);
  assert.equal(acceptedReport.halted, false);
  assert.equal(Array.from(acceptedReport.actions, (x) => x.id).join(','), 'doneCargo');

  const expanded = harness({ ext: true, search: '?pageName=CoveragesRates' });
  addExtText(expanded, 'U', '216F', { caption: 'Motor truck cargo limit and deductible', value: '$100000/$1000' });
  addExtText(expanded, 'P', '216A', { caption: 'Cargo commodity', value: 'Consumer Goods' });
  const expandedButton = addButton(expanded, 'Done with this coverage');
  expandedButton.onclick = () => { expandedButton._clicked = true; };
  const expandedReport = await expanded.kit.fill([
    ...cargoPlan(),
    { id: 'commodity', q: '216A', field: fieldOf('216A'), path: 'progressive.q216A', kind: 'text', value: null, ignore: true, cargo: 'section' },
  ], { maxRounds: 5 });
  assert.equal(expandedButton._clicked, true);
  assert.equal(expandedReport.halted, false);
  assert.equal(Array.from(expandedReport.invalidatedActions).includes('doneCargo'), true);
  assert.equal(Array.from(expandedReport.actions).length, 0);

  const changed = harness({ ext: true, search: '?pageName=CoveragesRates' });
  addExtText(changed, 'U', '216F', { caption: 'Motor truck cargo limit and deductible', value: '$50000/$500' });
  const changedButton = addButton(changed, 'Done with this coverage');
  changedButton.onclick = () => { changedButton._clicked = true; };
  const changedReport = await changed.kit.fill(cargoPlan(), { maxRounds: 5 });
  assert.equal(changedButton._clicked, undefined, 'a retained but different cargo answer cannot unlock Done');
  assert.equal(Array.from(changedReport.actions).length, 0);
  assert.equal(changedReport.halted, false);
  assert.ok(changedReport.blocked.some((b) => b.id === 'doneCargo'));
});

// General liability's Done (TNI 2026-10-20): verified once its section's questions are gone and
// the row keeps the limit; a question still open leaves Done to be tried again.
function glPlan() {
  return [
    { id: 'gl-limit', q: '21D1', field: 'LineInput.GeneralLiabilityLimit', path: 'progressive.q21D1', kind: 'text', value: '$1,000,000/ $2,000,000 Aggregate', gl: 'limit' },
    { id: 'gl-other', q: '21F3', field: 'GeneralLiabilityInput.GeneralLiabilityTruckOtherBusiness', path: 'progressive.q21F3', kind: 'text', value: null, ignore: true, gl: 'section' },
    { id: 'done', kind: 'action', action: 'doneGl', text: '^done with this coverage$', pages: ['CoveragesRates'], after: ['progressive.q21D1'], afterAny: [], afterActions: [], afterPages: [], unless: [], verify: 'glClosed' },
  ];
}

test('general liability Done verifies a closed section that keeps the limit', async () => {
  const closed = harness({ ext: true, search: '?pageName=CoveragesRates' });
  addExtText(closed, 'U', '2211', { caption: 'General Liability', ref: 'LineInput.GeneralLiabilityLimit', value: '$1,000,000/ $2,000,000 Aggregate' });
  const closedButton = addButton(closed, 'Done with this coverage');
  closedButton.onclick = () => { closedButton._clicked = true; };
  const closedReport = await closed.kit.fill(glPlan(), { maxRounds: 5 });
  assert.equal(closedButton._clicked, true);
  assert.equal(Array.from(closedReport.actions, (x) => x.id).join(','), 'doneGl');
  assert.equal(closedReport.halted, false);

  const open = harness({ ext: true, search: '?pageName=CoveragesRates' });
  addExtText(open, 'U', '225C', { caption: 'General Liability', ref: 'LineInput.GeneralLiabilityLimit', value: '$1,000,000/ $2,000,000 Aggregate' });
  addExtText(open, 'P', '2233', { caption: 'Does the customer operate businesses other than the for hire trucking operations?', ref: 'GeneralLiabilityInput.GeneralLiabilityTruckOtherBusiness', value: 'No' });
  const openButton = addButton(open, 'Done with this coverage');
  openButton.onclick = () => { openButton._clicked = true; };
  const openReport = await open.kit.fill(glPlan(), { maxRounds: 5 });
  assert.equal(openButton._clicked, true);
  assert.ok(Array.from(openReport.invalidatedActions).includes('doneGl'), 'its questions still showing: not done');
  assert.equal(Array.from(openReport.actions).length, 0);

  const empty = harness({ ext: true, search: '?pageName=CoveragesRates' });
  addExtText(empty, 'U', '225C', { caption: 'General Liability', ref: 'LineInput.GeneralLiabilityLimit', value: '' });
  const emptyButton = addButton(empty, 'Done with this coverage');
  emptyButton.onclick = () => { emptyButton._clicked = true; };
  const emptyPlan = glPlan();
  emptyPlan[0].value = null;
  const emptyReport = await empty.kit.fill(emptyPlan, { maxRounds: 5 });
  assert.equal(emptyButton._clicked, undefined, 'Done waits for a limit');
  assert.ok(emptyReport.blocked.some((b) => b.id === 'doneGl'));
});

test('trusted agent gesture plus input protects the edit and reports no filled answer', async () => {
  const h = harness();
  const edit = makeInput({ id: 'agent-edit', ariaLabel: 'Agent corrected value' });
  const later = makeInput({ id: 'later', ariaLabel: 'Later value' });
  h.document.body.append(edit, later);
  let injected = false;
  h.document._onAddEvent = (type) => {
    if (type !== 'input' || injected) return;
    injected = true;
    edit.dispatchEvent({ type: 'pointerdown', target: edit, isTrusted: true });
    edit.value = 'agent value';
    edit.dispatchEvent({ type: 'input', target: edit, isTrusted: true });
  };
  const report = await h.kit.fill([
    { id: 'edit-step', selector: '#agent-edit', path: 'agent.edit', kind: 'text', value: 'intake value' },
    { id: 'later-step', selector: '#later', path: 'later', kind: 'text', value: 'should not fill' },
  ], { maxRounds: 4 });
  assert.equal(edit.value, 'agent value');
  assert.equal(later.value, '');
  assert.equal(report.halted, true);
  assert.equal(Array.from(report.protectedKeys).includes('agent-edit'), true);
  assert.equal(report.filled.length, 0);
});

// Codex review on b62188f: the kit's own click on a radio or checkbox fires trusted input/change
// in Chromium. An agent gesture elsewhere just before it is not an edit of that question.
test('during a fill, a trusted change counts as an agent edit only when the gesture was on that control or its label', async () => {
  const run = async (gesture) => {
    const h = harness();
    const notes = makeInput({ id: 'notes', ariaLabel: 'Notes' });
    const box = makeInput({ id: 'cb', type: 'checkbox', ariaLabel: 'Hauls hazmat' });
    const label = new FakeNode('label', { textContent: 'Hauls hazmat', attrs: { for: 'cb' } });
    h.document.body.append(notes, label, box);
    box.addEventListener('click', () => {
      gesture({ notes, label, box }).dispatchEvent({ type: 'pointerdown', isTrusted: true });
      box.dispatchEvent({ type: 'change', target: box, isTrusted: true });
    });
    const report = await h.kit.fill([
      { id: 'cb-step', selector: '#cb', path: 'hazmat', kind: 'checkbox', value: true },
      { id: 'notes-step', selector: '#notes', path: 'notes', kind: 'text', value: 'from the intake' },
    ], { maxRounds: 4 });
    return { report, box, notes };
  };
  const elsewhere = await run(({ notes }) => notes);
  assert.equal(elsewhere.report.halted, false, 'a gesture on another field does not halt the fill');
  assert.deepEqual([...elsewhere.report.protectedKeys], []);
  assert.equal(elsewhere.box.checked, true);
  assert.equal(elsewhere.notes.value, 'from the intake');
  const onLabel = await run(({ label }) => label);
  assert.equal(onLabel.report.halted, true, 'a gesture on the checkbox\'s label then a change on it is the agent\'s');
  assert.equal([...onLabel.report.protectedKeys].length, 1);
  assert.equal(onLabel.notes.value, '');
});

test('portal-invalid retained answers are flagged and keep helpers waiting', async () => {
  const h = harness();
  const invalid = makeInput({ id: 'invalid', ariaLabel: 'Retained portal answer', value: 'retained', attrs: { 'aria-invalid': 'true' } });
  h.document.body.append(invalid);
  const helper = addButton(h, 'Lookup VIN');
  helper.onclick = () => { helper._clicked = true; };
  const report = await h.kit.fill([
    { id: 'invalid-step', selector: '#invalid', path: 'vehicle.answer', kind: 'text', value: 'retained' },
    { id: 'helper', kind: 'action', action: 'lookupVin', text: 'Lookup VIN', pages: [], after: ['vehicle.answer'], afterActions: [], afterPages: [], unless: [] },
  ], { maxRounds: 3 });
  assert.equal(report.halted, false);
  assert.equal(helper._clicked, undefined);
  assert.ok(report.failed.some((x) => /invalid/i.test(x.reason)));
});

test('non-int numeric choices do not round a requested amount to a larger option', async () => {
  const h = harness();
  const amount = new SelectNode([
    { text: '$2,000', value: '2000' },
    { text: '$10,000', value: '10000' },
  ], { id: 'amount', ariaLabel: 'Requested deductible' });
  h.document.body.append(amount);
  const report = await h.kit.fill([
    { id: 'amount-step', selector: '#amount', path: 'coverage.amount', kind: 'choice', value: 1000 },
  ], { maxRounds: 1 });
  assert.equal(amount.value, '');
  assert.equal(report.halted, false);
  assert.equal(report.filled.length, 0);
  assert.ok(report.failed.some((x) => x.path === 'coverage.amount'));
});

test('integer radius values still choose a covering band', async () => {
  const h = harness();
  const radius = new SelectNode([
    { text: '500 miles', value: '500' },
    { text: 'More than 500 miles', value: '501' },
  ], { id: 'radius', ariaLabel: 'Farthest distance' });
  h.document.body.append(radius);
  const report = await h.kit.fill([
    { id: 'radius-step', selector: '#radius', path: 'operations.radius', kind: 'int', value: 501 },
  ], { maxRounds: 4 });
  assert.equal(radius.value, '501');
  assert.equal(report.filled.length, 1);
  assert.equal(report.halted, false);
});

test('decoded vehicle values are verified without overwriting a mismatch', async () => {
  const h = harness();
  const make = makeInput({ id: 'make', ariaLabel: 'Make', value: 'Different make' });
  h.document.body.append(make);
  const report = await h.kit.fill([
    { id: 'make-step', selector: '#make', path: 'vehicles[0].make', kind: 'text', value: 'Expected make', verifyOnly: true },
  ]);
  assert.equal(make.value, 'Different make');
  assert.equal(report.halted, false);
  assert.equal(report.filled.length, 0);
  assert.ok(report.failed.some((x) => /differs/.test(x.reason)));
});

test('roadside chooses the first Selected option and preserves an existing selected variant', async () => {
  for (const current of ['', 'second']) {
    const h = harness();
    const roadside = new SelectNode([
      { text: 'Not selected', value: 'none' },
      { text: 'Selected with $100 deductible', value: 'first' },
      { text: 'Selected with $0 deductible', value: 'second' },
    ], { id: 'roadside', ariaLabel: 'Roadside' });
    roadside.value = current;
    h.document.body.append(roadside);
    const report = await h.kit.fill([
      { id: 'roadside-step', selector: '#roadside', path: 'coverage.roadside', kind: 'selected-option', value: 'Selected' },
    ], { replaceChoices: true });
    assert.equal(roadside.value, current || 'first');
    assert.equal(report.halted, false);
  }
});

test('Print/Send cannot send email even when the delivery checkbox is otherwise ignored', async () => {
  const h = harness();
  const email = makeInput({ id: 'email', type: 'checkbox', ariaLabel: 'Email', checked: true });
  h.document.body.append(email);
  const button = addButton(h, 'Print/Send');
  button.onclick = () => { button._clicked = true; };
  const report = await h.kit.fill([
    { id: 'email-step', selector: '#email', path: 'delivery.email', kind: 'bool', ignore: true },
    { id: 'print', kind: 'action', action: 'printSend', text: '^print/send$', pages: [], after: [], afterActions: [], afterPages: [], unless: [] },
  ]);
  assert.equal(button._clicked, undefined);
  assert.equal(report.halted, false);
  assert.ok(report.blocked.some((b) => b.id === 'printSend' && /email|fax/i.test(b.why)));
});


test('standard business and home ZIP/City controls sharing an intake path remain recognized', async () => {
  const h = harness({ ext: true, search: '?pageName=BusinessOwnerInfo' });
  // As the page lays them out: the business address, then the owner's home address.
  addExtText(h, 'P', '27E', { caption: 'Street Address' });
  const business = [addExtText(h, 'P', '284', { caption: 'Zip Code', required: true }), addExtText(h, 'P', '286', { caption: 'City', required: true })];
  addExtText(h, 'U', '2A9', { caption: 'Home Address' });
  const home = [addExtText(h, 'U', '2AE', { caption: 'ZIP Code', required: true }), addExtText(h, 'U', '2B0', { caption: 'City', required: true })];
  const controls = [...home, ...business];
  const record = {
    applicant: { name: 'Example LLC', owner1: 'Test Owner' },
    garaging: { street: '1 Example St', city: 'Example City', zip: '21000' },
    operations: { businessClass: 'Expediter' },
    drivers: [], vehicles: [], trailers: [], priorInsurance: [],
    coverage: { cargo: false, gl: false }, claims: {},
  };
  const report = await h.kit.fill(buildPlan(record, progressive), {});
  assert.equal(report.halted, false);
  assert.equal(report.unknown.length, 0);
  assert.equal(report.filled.filter((x) => /zip|city/i.test(x.name)).length, 4);
  assert.deepEqual(controls.map(({ input }) => input.value), ['21000', 'Example City', '21000', 'Example City']);
});

// Codex on PR #43: the business ZIP/City are found by their data-model names even when the Street
// Address box isn't drawn (an address suggestion collapsed it); the anchor only tells texts apart.
test('business ZIP/City found by name need no Street Address anchor', async () => {
  const h = harness({ ext: true, search: '?pageName=BusinessOwnerInfo' });
  const business = [addExtText(h, 'P', '284', { caption: 'Zip Code', required: true }), addExtText(h, 'P', '286', { caption: 'City', required: true })];
  const record = { applicant: {}, garaging: { street: '1 Example St', city: 'Example City', zip: '21000' }, operations: {}, drivers: [], vehicles: [], trailers: [], priorInsurance: [], coverage: {}, claims: {} };
  const report = await h.kit.fill(buildPlan(record, progressive).filter((s) => ['284', '286'].includes(s.q)), {});
  assert.equal(report.unknown.length, 0);
  assert.deepEqual(business.map(({ input }) => input.value), ['21000', 'Example City']);
});

test('blank optional address detail and blank DOT do not stop standard business-page filling', async () => {
  for (const unit of [null, 'Suite 4']) {
    const h = harness({ search: '?pageName=BusinessOwnerInfo' });
    const detail = makeInput({ id: 'address-detail', ariaLabel: 'Apt, Building, Floor, Suite, etc.' });
    const street = makeInput({ id: `f_U${'A'.repeat(32)}27E_1_1`, ariaLabel: 'Street address', attrs: { fieldref: 'PrimaryBusinessAddressOutputNonShredded.StreetAddressDup' } });
    const name = makeInput({ id: `f_U${'A'.repeat(32)}230_1_1`, ariaLabel: 'Business name', attrs: { fieldref: 'AccountInput.BusinessName' } });
    const dotNumber = makeInput({ id: `f_U${'A'.repeat(32)}1F3_1_1`, ariaLabel: 'USDOT Number associated with the customer\'s business:', attrs: { fieldref: 'USDOTInput.NumberCollection' } });
    const dot = new SelectNode([
      { text: 'Yes - the customer has a USDOT number', value: 'yes' },
      { text: 'Not Yet - but the customer has applied/will apply for a USDOT number within 60 days', value: 'pending' },
      { text: 'No - and the customer will not have a USDOT number', value: 'no' },
    ], { id: `f_U${'A'.repeat(32)}1ED_1_1`, ariaLabel: 'Does the customer have a USDOT Number?', attrs: { fieldref: 'USDOTInput.Question' } });
    h.document.body.append(detail, street, dot, name, dotNumber);
    const record = {
      // The intake says no USDOT number is coming (a blank 60-day answer would leave the question to the agent).
      applicant: { name: 'Example LLC', dot: null, mcDotWithin60Days: false, owner1: 'Test Owner' },
      garaging: { street: '1 Example St', city: 'Example City', zip: '21000', unit },
      operations: { businessClass: 'Expediter' },
      drivers: [], vehicles: [], trailers: [], priorInsurance: [],
      coverage: { cargo: false, gl: false }, claims: {},
    };
    const report = await h.kit.fill(buildPlan(record, progressive), {});
    assert.equal(report.halted, false);
    assert.equal(report.noData.length, 0);
    assert.equal(detail.value, unit ?? '');
    // No suggestion list on this page: the street alone goes back in, flagged for the agent.
    assert.equal(street.value, '1 Example St');
    assert.ok(report.failed.some((x) => /no address suggestion/.test(x.reason)));
    assert.equal(dot.value, 'no');
    assert.equal(name.value, 'Example LLC');
    assert.equal(dotNumber.value, '');
  }
});

test('For Hire Trucking collapses to a verified summary and the revealed trucker dropdown fills', async () => {
  for (const summary of ['For Hire Trucking', 'Other For-Hire Trucking', '']) {
    const h = harness({ ext: true, search: '?pageName=BusinessOwnerInfo' });
    const trucker = new SelectNode([
      { text: 'Other For-Hire Trucking', value: 'other' },
      { text: 'Household Goods Mover', value: 'household' },
    ], { id: `f_U${'A'.repeat(32)}267_1_1`, ariaLabel: 'Type of Trucker', attrs: { fieldref: 'AccountInput.SpecificTruckHaulContractType' } });
    const record = {
      applicant: { name: 'Example LLC', owner1: 'Test Owner' },
      garaging: { street: '1 Example St', city: 'Example City', zip: '21000', unit: null },
      operations: { businessClass: 'Expediter' },
      drivers: [], vehicles: [], trailers: [], priorInsurance: [],
      coverage: { cargo: false, gl: false }, claims: {},
    };
    const business = addExtText(h, 'U', '239', {
      caption: 'Business Type',
      onSet: () => {
        h.document.body.replaceChild(trucker, business.input);
        h.document.body.innerText = `Business\n${summary}\nType of Trucker`;
      },
    });
    const option = { get: (key) => key === 'label' ? 'For Hire Trucking' : 'for-hire' };
    Object.assign(business.cmp, {
      displayField: 'label', valueField: 'id', store: { getRange: () => [option] },
      getRawValue() { return this._value ? 'For Hire Trucking' : ''; },
    });
    const report = await h.kit.fill(buildPlan(record, progressive));
    assert.equal(report.halted, false);
    assert.equal(trucker.value, 'other', 'the revealed dropdown fills either way');
    assert.equal(report.filled.length, summary === 'For Hire Trucking' ? 2 : 1);
    assert.equal(report.failed.length, summary === 'For Hire Trucking' ? 0 : 1, 'a summary that does not match is reported');
  }
});

test('home address takes the first offered option with or without DOT and collapses manual boxes', async () => {
  for (const hasDot of [false, true]) {
    const h = harness({ search: '?pageName=BusinessOwnerInfo' });
    const record = {
      applicant: { name: 'Example LLC', dot: hasDot ? '1234567' : null, owner1: 'Test Owner' },
      garaging: { street: '10 Test Road', city: 'Example City', zip: '21000', unit: null },
      operations: { businessClass: 'Expediter' },
      drivers: [], vehicles: [], trailers: [], priorInsurance: [],
      coverage: { cargo: false, gl: false }, claims: {},
    };
    const home = { fieldref: refOf('2A5') };
    const manual = makeInput({ id: 'manual-home', name: 'home_2A5', type: 'radio', value: 'Enter a different address', checked: true, attrs: home });
    const primary = makeInput({ id: `f_U${'A'.repeat(32)}2A5_1_1`, name: 'home_2A5', type: 'radio', value: '10 Test Road Example City MD 21000 (Primary Business Address)', attrs: home });
    const usdot = makeInput({ id: 'usdot-home', name: 'home_2A5', type: 'radio', value: '20 Registered Road Example City MD 21000 (USDOT address)', attrs: home });
    const street = makeInput({ id: `f_U${'A'.repeat(32)}2AA_1_1`, ariaLabel: 'Business Owner Home Address Input Non Shredded Address For PB Address' });
    const zip = makeInput({ id: `f_U${'A'.repeat(32)}2AE_1_1`, ariaLabel: 'ZIP Code' });
    const city = makeInput({ id: `f_U${'A'.repeat(32)}2B0_1_1`, ariaLabel: 'City' });
    h.document.body.append(radioGroup('Home Address', ...(hasDot ? [usdot] : []), primary, manual), street, zip, city);
    primary.onclick = () => {
      h.document.body.children = h.document.body.children.filter((node) => ![street, zip, city].includes(node));
    };
    const report = await h.kit.fill(buildPlan(record, progressive), { replaceChoices: true });
    assert.equal(report.halted, false);
    // The first option on the page, whatever it says.
    assert.equal((hasDot ? usdot : primary).checked, true);
    assert.equal((hasDot ? primary : usdot).checked, false);
    assert.equal(manual.checked, false);
    if (!hasDot) assert.equal(street.value, '', 'manual boxes must not be filled before selecting the offered address');
  }
});

test('home address retains manual entry when no address suggestion is offered', async () => {
  const h = harness({ search: '?pageName=BusinessOwnerInfo' });
  const manual = makeInput({ id: `f_U${'A'.repeat(32)}2A5_1_1`, name: 'home_2A5', type: 'radio', value: 'Enter a different address', checked: true, attrs: { fieldref: 'BusinessOwnerHomeAddressInputNonShredded.AddressOptionsForPrimaryBsnsAdrs' } });
  h.document.body.append(radioGroup('Home Address', manual));
  const record = { applicant: {}, garaging: {}, operations: {}, drivers: [], vehicles: [], priorInsurance: [], coverage: {}, claims: {} };
  const report = await h.kit.fill(buildPlan(record, progressive), { replaceChoices: true });
  assert.equal(report.halted, false);
  assert.equal(manual.checked, true);
  assert.equal(report.filled.length, 0);
});

test('home address uses offered USDOT address when Primary Business Address is absent', async () => {
  const h = harness({ search: '?pageName=BusinessOwnerInfo' });
  const offered = makeInput({ id: `f_U${'A'.repeat(32)}2A5_1_1`, name: 'home_2A5', type: 'radio', value: '10 Test Road Example City MD 21000 (USDOT address)', attrs: { fieldref: 'BusinessOwnerHomeAddressInputNonShredded.AddressOptionsForPrimaryBsnsAdrs' } });
  const manual = makeInput({ id: 'manual-home', name: 'home_2A5', type: 'radio', value: 'Enter a different address', checked: true });
  h.document.body.append(radioGroup('Home Address', offered, manual));
  const record = { applicant: {}, garaging: {}, operations: {}, drivers: [], vehicles: [], priorInsurance: [], coverage: {}, claims: {} };
  const report = await h.kit.fill(buildPlan(record, progressive), { replaceChoices: true });
  assert.equal(report.halted, false);
  assert.equal(offered.checked, true);
  assert.equal(manual.checked, false);
});

test('unfamiliar questions carry their options for the AI, and answer() puts in a choice and marks it purple', async () => {
  const h = harness();
  const commodity = new SelectNode([
    { text: 'Select one', value: '' },
    { text: 'Consumer Goods', value: 'cg' },
    { text: 'Building Materials', value: 'bm' },
  ], { id: 'commodity', ariaLabel: 'Commodity category' });
  h.document.body.append(commodity);
  const report = await h.kit.fill([], { maxRounds: 1 });
  const item = report.unknown.find((x) => x.label === 'Commodity category');
  assert.deepEqual([...item.options], ['Consumer Goods', 'Building Materials']);
  assert.equal(item.current, null);

  const [ok] = await h.kit.answer([{ key: item.key, label: item.label, value: 'Consumer Goods' }]);
  assert.equal(ok.ok, true);
  assert.equal(commodity.value, 'cg');
  assert.equal(commodity.getAttribute('data-rater-autofill'), 'ai');
  assert.ok(commodity.style.outline.includes('#7c3aed'));

  const [gone] = await h.kit.answer([{ key: 'missing', label: 'Nope', value: 'Yes' }]);
  assert.equal(gone.ok, false);
  assert.match(gone.reason, /no longer on this page/);
  const [bad] = await h.kit.answer([{ key: item.key, label: item.label, value: 'Livestock' }]);
  assert.equal(bad.ok, false);
  assert.equal(commodity.value, 'cg');
});

test('AI banner lists pending selections at the bottom of the page and markKey re-marks a field', async () => {
  const h = harness();
  const field = new SelectNode([{ text: 'Yes', value: 'y' }, { text: 'No', value: 'n' }], { id: 'tow', ariaLabel: 'Tows for others' });
  h.document.body.append(field);
  h.kit.aiBanner(['Tows for others: No']);
  const banner = h.document.body.children.find((c) => c.id === 'rater-autofill-ai-banner');
  assert.ok(banner, 'banner added');
  assert.match(banner.children[0].textContent, /AI selected 1 answer/);
  h.kit.aiBanner([]);
  assert.equal(h.document.body.children.some((c) => c.id === 'rater-autofill-ai-banner'), false);
  const report = await h.kit.fill([], { maxRounds: 1 });
  const key = report.unknown[0].key;
  assert.equal(h.kit.markKey(key, 'Tows for others', 'needs', 'AI choice rejected'), true);
  assert.equal(field.getAttribute('data-rater-autofill'), 'needs');
  assert.equal(h.kit.markKey('nope', 'x', 'needs', 'n'), false);
});

// Design review, good-to-have #3: step 3 listed what's left by kind (unfamiliar, failed, missing,
// …), so its order changed between fills and didn't follow the page. Each item carries its
// field's place on the page, read at the end of the fill (a question revealed above the others
// counts); an item without a field (a helper to click by hand) has none.
test('report items carry the place of their field on the page, in document order', async () => {
  const h = harness();
  const first = makeInput({ id: 'first', ariaLabel: 'Unfamiliar one' });
  const checked = makeInput({ id: 'checked', ariaLabel: 'Filled with a check' });
  const missing = makeInput({ id: 'missing', ariaLabel: 'Missing answer' });
  const bad = new SelectNode([{ text: '', value: '' }, { text: 'Yes', value: 'y' }, { text: 'No', value: 'n' }], { id: 'bad', ariaLabel: 'Bad choice' });
  const required = makeInput({ id: 'required', ariaLabel: 'Required unfamiliar', required: true });
  h.document.body.append(first, checked, missing, bad, required);
  // Answering one draws a new question above them all.
  checked.addEventListener('change', () => {
    if (h.document.getElementById('revealed')) return;
    const revealed = makeInput({ id: 'revealed', ariaLabel: 'Revealed above' });
    revealed.parentElement = h.document.body;
    revealed.ownerDocument = h.document;
    h.document.body.children.unshift(revealed);
  });
  const report = await h.kit.fill([
    { id: 'checked', selector: '#checked', path: 'a', kind: 'text', value: 'x', warn: 'Check it.' },
    { id: 'missing', selector: '#missing', path: 'b', kind: 'text', value: null },
    { id: 'bad', selector: '#bad', path: 'c', kind: 'choice', value: 'Maybe' },
    { id: 'tile', kind: 'action', action: 'tile', label: 'Vehicle tile', text: 'Add vehicle', pages: [], after: [], afterActions: [], afterPages: [], unless: [], missing: 'Click the vehicle tile yourself.' },
  ], { maxRounds: 6 });
  const at = (list, label) => list.find((x) => x.label === label)?.order;
  assert.deepEqual([at(report.unknown, 'Revealed above'), at(report.unknown, 'Unfamiliar one'), at(report.checks, 'Filled with a check'),
    at(report.noData, 'Missing answer'), at(report.failed, 'Bad choice'), at(report.leftRequired, 'Required unfamiliar'), at(report.unknown, 'Required unfamiliar')],
  [0, 1, 2, 3, 4, 5, 5]);
  const tile = report.noData.find((x) => x.label === 'Vehicle tile');
  assert.ok(tile, 'the helper is left for the agent');
  assert.equal('order' in tile, false, 'a helper has no field on the page');
});

// "Show on page" in step 3 (good-to-have #3): the field comes into view and its mark is ringed for
// a moment, then put back as it was. Nothing on the page changes: no value, no click, no focus,
// no event.
test('reveal scrolls a field into view and rings its mark briefly, changing nothing on the page', async () => {
  const h = harness();
  const field = new SelectNode([{ text: '', value: '' }, { text: 'Yes', value: 'y' }], { id: 'tow', ariaLabel: 'Tows for others' });
  const closed = makeInput({ id: 'closed', ariaLabel: 'In a section closed since' });
  h.document.body.append(field, closed);
  const report = await h.kit.fill([], { maxRounds: 1 });
  const keyOf = (label) => report.unknown.find((x) => x.label === label).key;
  const outline = field.style.outline;
  assert.ok(outline, 'marked by the fill');
  field.style.boxShadow = 'inset 0 0 1px red';
  const scrolled = [];
  const touched = [];
  field.scrollIntoView = (options) => scrolled.push(options);
  field.focus = () => touched.push('focus');
  field.click = () => touched.push('click');
  field.dispatchEvent = (event) => { touched.push(event.type); return true; };
  assert.equal(h.kit.reveal(keyOf('Tows for others'), 'Tows for others'), true);
  assert.deepEqual(scrolled.map((o) => ({ ...o })), [{ block: 'center' }]);
  assert.match(field.style.boxShadow, /^0 0 0 4px /);
  assert.equal(field.style.outline, outline, 'its mark stays');
  // Shown again while ringed: what was there before is still what comes back.
  h.kit.reveal(keyOf('Tows for others'), 'Tows for others');
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(field.style.boxShadow, 'inset 0 0 1px red');
  // A shadow the page sets meanwhile is the page's: left as it is.
  h.kit.reveal(keyOf('Tows for others'), 'Tows for others');
  field.style.boxShadow = 'page shadow';
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(field.style.boxShadow, 'page shadow');
  assert.deepEqual([field.value, touched], ['', []], 'no value, click, focus or event');
  // Not on screen now (a section closed since the fill) or not on the page: not found here.
  closed._visible = false;
  assert.equal(h.kit.reveal(keyOf('In a section closed since'), 'In a section closed since'), false);
  assert.equal(h.kit.reveal('nope', 'x'), false);
  assert.equal(closed.style.boxShadow, undefined);
});

// The side panel reads back what the page shows for answers it lists. Reading changes nothing:
// no value, mark, click, focus or event.
test('readBack reports what each field shows now, row by row, and changes nothing on the page', () => {
  const h = harness({ ext: true });
  const text = makeInput({ id: 'dot', ariaLabel: 'USDOT number', value: '1234567' });
  const list = new SelectNode([{ text: 'Select one', value: '' }, { text: 'Yes', value: 'y' }, { text: 'No', value: 'n' }], { id: 'tow', ariaLabel: 'Tows for others', value: 'n' });
  const ticked = makeInput({ id: 'federal', ariaLabel: 'Federal filing', type: 'checkbox', checked: true });
  const unticked = makeInput({ id: 'state', ariaLabel: 'State filing', type: 'checkbox' });
  const blank = makeInput({ id: 'blank', ariaLabel: 'Empty box' });
  h.document.body.append(text, list, ticked, unticked, blank);
  // Rows of one question: one key, told apart by their labels.
  const first = addExtText(h, 'U', '3C01', { caption: '2021 FORD TRANSIT 350', value: '45000' });
  const second = addExtText(h, 'P', '3C01', { caption: '2019 ISUZU NPR HD', value: '30000' });
  const keys = new Map(h.kit.signature().split('\n').map((line) => line.split('|')).map(([key, label]) => [label, key]));
  assert.equal(keys.get('2021 FORD TRANSIT 350'), keys.get('2019 ISUZU NPR HD'), 'the rows share a key');
  const elements = [text, list, ticked, unticked, blank, first.input, second.input];
  const touched = [];
  for (const el of elements) {
    el.focus = () => touched.push('focus');
    el.click = () => touched.push('click');
    el.dispatchEvent = (event) => { touched.push(event.type); return true; };
  }
  const values = () => elements.map((el) => [el.value, el.checked, el.getAttribute('data-rater-autofill'), el.style.outline]);
  const before = values();
  const ask = (label) => ({ key: keys.get(label), label });
  const read = h.kit.readBack([
    ask('USDOT number'), ask('Tows for others'), ask('Federal filing'), ask('State filing'), ask('Empty box'),
    ask('2019 ISUZU NPR HD'), ask('2021 FORD TRANSIT 350'), { key: 'not-on-this-page', label: 'Elsewhere' },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(read)), [
    { key: keys.get('USDOT number'), label: 'USDOT number', shown: '1234567', empty: false },
    { key: keys.get('Tows for others'), label: 'Tows for others', shown: 'No', empty: false },
    { key: keys.get('Federal filing'), label: 'Federal filing', shown: 'checked', empty: false },
    { key: keys.get('State filing'), label: 'State filing', shown: 'unchecked', empty: true },
    { key: keys.get('Empty box'), label: 'Empty box', shown: '', empty: true },
    { key: keys.get('2019 ISUZU NPR HD'), label: '2019 ISUZU NPR HD', shown: '30000', empty: false },
    { key: keys.get('2021 FORD TRANSIT 350'), label: '2021 FORD TRANSIT 350', shown: '45000', empty: false },
  ].map((x) => ({ ...x, agrees: null })), 'the unknown key is left out; no steps, no judgement');
  // With the steps that filled them, the kit judges as fill does (audit 2026-10-10): an address the
  // page wrote in its own format agrees; a box holding something else doesn't.
  const steps = [
    { id: 'addr', kind: 'address-suggest', value: '5001 Sheridan Street Davenport, IA, USA' },
    { id: 'dot', kind: 'text', value: '7654321' },
  ];
  const judged = h.kit.readBack([{ ...ask('USDOT number'), stepId: 'addr' }, { ...ask('USDOT number'), stepId: 'dot' }, { ...ask('Empty box'), stepId: 'addr' }, { ...ask('Tows for others'), stepId: 'gone' }], steps);
  assert.deepEqual(JSON.parse(JSON.stringify(judged.map((x) => x.agrees))), [true, false, false, null]);
  assert.deepEqual(values(), before, 'no value or mark changed');
  assert.deepEqual(touched, [], 'no click, focus or event');
});

test('home address box: whole address typed, first suggestion picked, ZIP/city then checked', async () => {
  const h = harness({ search: '?pageName=BusinessOwnerInfo' });
  const address = makeInput({ id: `f_U${'A'.repeat(32)}2A9_1_1`, ariaLabel: 'Home Address' });
  const zip = makeInput({ id: `f_U${'A'.repeat(32)}2AE_1_1`, ariaLabel: 'ZIP Code' });
  const city = makeInput({ id: `f_U${'A'.repeat(32)}2B0_1_1`, ariaLabel: 'City' });
  h.document.body.append(address, zip, city);
  // The page's suggestion list: appears after typing; picking an entry fills ZIP and city.
  address.addEventListener('keyup', () => {
    const pick = (text, z) => {
      const item = new FakeNode('li', { textContent: text, role: 'option' });
      item.onclick = () => { address.value = text; zip.value = z; city.value = 'Springfield'; };
      return item;
    };
    h.document.body.append(pick('125 MAPLE LEAF DR APT 4, SPRINGFIELD IL 62704', '62704'), pick('125 MAPLE LEAF CT, SPRINGFIELD IL 62711', '62711'));
  });
  const record = {
    applicant: {}, garaging: { street: '125 Maple Leaf Dr', unit: 'Apt 4', city: 'Springfield', state: 'IL', zip: '62704' },
    operations: {}, drivers: [], vehicles: [], priorInsurance: [], coverage: {}, claims: {},
  };
  const report = await h.kit.fill(buildPlan(record, progressive), { maxRounds: 8 });
  assert.equal(address.value, '125 MAPLE LEAF DR APT 4, SPRINGFIELD IL 62704');
  assert.equal(zip.value, '62704');
  assert.ok(report.filled.some((x) => /home address/i.test(x.name)));
  assert.equal(report.failed.length, 0);
  assert.ok(!report.kept.some((x) => x.differs), 'suggested ZIP/city agree with the intake');
});

test('home address box without a suggestion is flagged for the agent', async () => {
  const h = harness({ search: '?pageName=BusinessOwnerInfo' });
  const address = makeInput({ id: `f_U${'A'.repeat(32)}2A9_1_1`, ariaLabel: 'Home Address' });
  h.document.body.append(address);
  const record = { applicant: {}, garaging: { street: '1 Nowhere Rd', city: 'X', state: 'IL', zip: '60000' }, operations: {}, drivers: [], vehicles: [], priorInsurance: [], coverage: {}, claims: {} };
  const report = await h.kit.fill(buildPlan(record, progressive), { maxRounds: 3 });
  const failed = report.failed.find((x) => /home address/i.test(x.name));
  assert.match(failed.reason, /no address suggestion/);
  assert.equal(address.getAttribute('data-rater-autofill'), 'failed');
});

test('Add Vehicle inside the Add menu: the menu is opened first, then Add Vehicle clicked', async () => {
  const h = harness({ search: '?pageName=VehicleSummary' });
  const add = addButton(h, 'Add');
  const addVehicle = addButton(h, 'Add Vehicle');
  addVehicle._visible = false;
  add.onclick = () => { addVehicle._visible = true; add._opened = (add._opened ?? 0) + 1; };
  addVehicle.onclick = () => { addVehicle._clicked = true; };
  const record = { applicant: {}, garaging: {}, operations: {}, drivers: [], vehicles: [{ type: 'Van', vin: '1FTBR3X87MKA12345' }], priorInsurance: [], coverage: {}, claims: {} };
  const report = await h.kit.fill(buildPlan(record, progressive), { maxRounds: 4 });
  assert.equal(add._opened, 1);
  assert.equal(addVehicle._clicked, true);
  assert.deepEqual(Array.from(report.actions, (x) => x.id), ['addVehicle:0:menu', 'addVehicle:0']);
});

test('business type list picks For Hire Trucking when offered, else General Freight Trucking', async () => {
  const record = { applicant: {}, garaging: {}, operations: { businessClass: 'Expediter' }, drivers: [], vehicles: [], priorInsurance: [], coverage: {}, claims: {} };
  for (const offered of [false, true]) {
    const h = harness({ search: '?pageName=BECAPopup' });
    const names = [
      'Expediters/Hotshotters Express delivery of packages or time sensitive materials over a 50-mile radius.',
      ...(offered ? ['For Hire Trucking Haul goods for others.'] : []),
      'General Freight Trucking Haul general goods (processed food, miscellaneous dry goods, etc.).',
    ];
    const radios = names.map((value, i) => makeInput({ id: i ? `bt-${i}` : `f_U${'A'.repeat(32)}36_1_1`, name: 'bt_36', type: 'radio', value }));
    h.document.body.append(radioGroup('Business Type Label', ...radios));
    const report = await h.kit.fill(buildPlan(record, progressive), { maxRounds: 3 });
    const picked = radios.find((r) => r.checked)?.value ?? '';
    assert.match(picked, offered ? /^For Hire Trucking/ : /^General Freight Trucking/);
    assert.equal(report.failed.length, 0);
  }
});

test('an empty unfamiliar question keeps Continue from being clicked, even when not marked required', async () => {
  for (const answered of [false, true]) {
    const h = harness({ search: '?pageName=MoreAboutBusiness' });
    const odd = new SelectNode([{ text: '', value: '' }, { text: 'Yes', value: 'y' }, { text: 'No', value: 'n' }], { id: 'odd', ariaLabel: 'Some new optional question' });
    if (answered) odd.value = 'n';
    const next = addButton(h, 'Continue');
    next.onclick = () => { next._clicked = true; };
    h.document.body.append(odd);
    const report = await h.kit.fill([], { maxRounds: 2, advance: { text: '^continue$' } });
    assert.equal(!!next._clicked, answered, answered ? 'answered: Continue' : 'unanswered: wait for the agent');
    assert.equal(report.blockers.some((b) => /Some new optional question/.test(b)), !answered);
  }
});

test('a ZIP+4 from the carrier agrees with the intake ZIP', async () => {
  const h = harness();
  const zip = makeInput({ id: 'zip', ariaLabel: 'Zip code where the vehicle is located', value: '17101-1234' });
  h.document.body.append(zip);
  const report = await h.kit.fill([{ id: 'zip-step', selector: '#zip', path: 'garaging.zip', kind: 'text', value: '17101' }], { maxRounds: 1 });
  assert.ok(!report.kept.some((x) => x.differs), 'not "the page says something different"');
  assert.equal(report.blockers.length, 0);
});

test('Recalculate is skipped (not waited for) when the rates are current, and Print goes ahead', async () => {
  const h = harness({ search: '?pageName=CoveragesRates' });
  h.document.body.innerText = 'Total premium: $4,321.00';
  const print = addButton(h, 'Print, Email, Fax');
  print.onclick = () => { print._clicked = true; };
  const report = await h.kit.fill([
    { id: 'recalc', kind: 'action', action: 'recalculate', text: '^recalculate$', pages: ['CoveragesRates'], after: [], afterActions: [], afterPages: [], unless: [], needsRecalculation: true },
    { id: 'print', kind: 'action', action: 'print', text: '^print, email, fax$', pages: ['CoveragesRates'], after: [], afterActions: [], afterPages: [], unless: [], needsPremium: true },
  ], { maxRounds: 3 });
  assert.equal(print._clicked, true);
  assert.ok(!report.blocked.some((b) => b.id === 'recalculate'));
});

test('a helper that waited earlier in the fill and was clicked later does not keep Continue waiting', async () => {
  const h = harness({ search: '?pageName=AddVehicle' });
  const vin = makeInput({ id: 'vin', ariaLabel: 'VIN' });
  const lookup = addButton(h, 'Lookup VIN');
  lookup.onclick = () => { lookup._clicked = true; };
  const next = addButton(h, 'Continue');
  next.onclick = () => { next._clicked = true; };
  h.document.body.append(vin);
  const report = await h.kit.fill([
    { id: 'vin-step', selector: '#vin', path: 'vehicles[0].vin', kind: 'text', value: '1FTBR3X87MKA12345' },
    { id: 'lookup', kind: 'action', action: 'lookupVin:0', text: '^lookup vin$', pages: [], after: ['vehicles[0].vin'], afterActions: [], afterPages: [], unless: [], immediate: true },
  ], { maxRounds: 6, advance: { text: '^continue$' } });
  assert.equal(lookup._clicked, true);
  assert.equal(report.blocked.length, 0);
  assert.equal(next._clicked, true, 'nothing left: Continue');
});

// SC live run (2026-10-19), second vehicle: Progressive looked the VIN up by itself once it was
// typed and the Look up button went away, yet the panel still said "Buttons waiting: lookupVin
// (waiting for vehicles[1].vin)".
test('a lookup whose button the page took away once the VIN was typed is not left waiting', async () => {
  const h = harness({ search: '?pageName=AddVehicle' });
  const vin = makeInput({ id: 'vin', ariaLabel: 'VIN' });
  const lookup = addButton(h, 'Lookup VIN');
  vin.addEventListener('change', () => { lookup.remove(); });
  h.document.body.append(vin);
  const report = await h.kit.fill([
    { id: 'vin-step', selector: '#vin', path: 'vehicles[1].vin', kind: 'text', value: '1FTBR3X87MKA12345' },
    { id: 'lookup', kind: 'action', action: 'lookupVin:1', text: '^lookup vin$', pages: [], after: ['vehicles[1].vin'], afterActions: [], afterPages: [], unless: [], immediate: true },
  ], { maxRounds: 6 });
  assert.equal(vin.value, '1FTBR3X87MKA12345');
  assert.equal(report.blocked.length, 0, report.blockers.join(' | '));
  assert.ok(!report.blockers.some((b) => /lookupVin/.test(b)), 'Continue isn\'t held by it');
  // Done by the page, not clicked: recorded like a result already shown, so a helper that follows
  // it on a later page (Add Trailer after every vehicle's lookup) doesn't wait for it (review of PR #98).
  assert.equal(JSON.stringify(report.actions.filter((x) => x.id === 'lookupVin:1').map((x) => x.alreadyShown)), '[true]');
});

test('each filled answer carries its timing and side effects (revealed / removed / changed)', async () => {
  const h = harness();
  const first = makeInput({ id: 'first', ariaLabel: 'First question' });
  const second = makeInput({ id: 'second', ariaLabel: 'Second question' });
  // Answering the first reveals a new question, like a Progressive follow-up.
  first.addEventListener('change', () => { if (!h.document.body.children.some((n) => n.id === 'follow')) h.document.body.append(makeInput({ id: 'follow', ariaLabel: 'Follow-up' })); });
  h.document.body.append(first, second);
  const report = await h.kit.fill([
    { id: 'a', selector: '#first', path: 'x.first', kind: 'text', value: 'one' },
    { id: 'b', selector: '#second', path: 'x.second', kind: 'text', value: 'two' },
  ], { maxRounds: 4 });
  const [a, b] = ['x.first', 'x.second'].map((p) => report.filled.find((x) => x.path === p));
  assert.ok(a.timing.ms >= 0 && a.timing.settleMs >= 0);
  assert.equal(a.timing.revealed, 1, 'the follow-up question appeared');
  assert.equal(b.timing.revealed + b.timing.removed + b.timing.changed, 0, 'independent answer');
});

test('Google address autocomplete (hidden .pac-item list): first suggestion picked with arrow down + enter', async () => {
  const h = harness({ search: '?pageName=BusinessOwnerInfo' });
  const street = makeInput({ id: `f_U${'A'.repeat(32)}27E_1_1`, ariaLabel: 'Street Address', attrs: { fieldref: 'PrimaryBusinessAddressOutputNonShredded.StreetAddressDup' } });
  const zip = makeInput({ id: `f_U${'A'.repeat(32)}284_1_1`, ariaLabel: 'Zip Code', attrs: { fieldref: 'PrimaryBusinessAddressInput.ZipCode' } });
  const city = makeInput({ id: `f_U${'A'.repeat(32)}286_1_1`, ariaLabel: 'City', attrs: { fieldref: 'PrimaryBusinessAddressInput.City' } });
  h.document.body.append(street, zip, city);
  // Google keeps its list hidden while the box isn't focused; the items exist anyway.
  const container = new FakeNode('div', { className: 'pac-container' });
  container._visible = false;
  h.document.body.append(container);
  street.addEventListener('input', () => {
    for (const t of ['5001 Sheridan Street Davenport, IA, USA', '5001 Sheridan Road Sunol, CA, USA']) {
      const item = new FakeNode('div', { className: 'pac-item', textContent: t });
      item._visible = false;
      container.append(item);
    }
  });
  let downs = 0;
  street.addEventListener('keydown', (e) => {
    if (e.keyCode === 40) downs++;
    if (e.keyCode === 13 && downs) { street.value = '5001 Sheridan St'; zip.value = '52806'; city.value = 'Davenport'; }
  });
  const record = { applicant: {}, garaging: { street: '5001 Sheridan St', city: 'Davenport', state: 'IA', zip: '52806' }, operations: {}, drivers: [], vehicles: [], priorInsurance: [], coverage: {}, claims: {} };
  const report = await h.kit.fill(buildPlan(record, progressive), { maxRounds: 8 });
  assert.equal(street.value, '5001 Sheridan St');
  assert.equal(zip.value, '52806');
  assert.equal(report.failed.length, 0);
  assert.ok(!report.kept.some((x) => x.differs));
});

test('labels: our own mark tooltip and a date picker calendar are never taken as the question', async () => {
  const h = harness();
  const wrapper = new FakeNode('div');
  const field = makeInput({ id: 'agnecyName' });
  wrapper.append(field);
  h.document.body.append(wrapper);
  // A first fill marks the unfamiliar field with our tooltip.
  await h.kit.fill([], { maxRounds: 1 });
  assert.match(field.getAttribute('title') ?? '', /^Rater Autofill:/);
  const again = await h.kit.fill([], { maxRounds: 1, keepMarks: true });
  assert.equal(again.unknown[0].label, 'agnecy name', 'falls back to the field id, not our tooltip');
});

test('type-ahead list (select2): types the search, picks the single result that matches; several or none go to the agent', async () => {
  for (const [results, expectOk] of [[['484122 - General freight trucking, long-distance, less-than-truckload (LTL)', '484121 - General freight trucking, long-distance, truckload'], true], [['484110 - Local'], false]]) {
    const h = harness();
    const select = new SelectNode([{ text: '', value: '' }], { id: 'classCodeAndDescription', ariaLabel: 'Classification' });
    const container = new FakeNode('span', { className: 'select2 select2-container' });
    const opener = new FakeNode('span', { className: 'select2-selection' });
    container.append(opener);
    h.document.body.append(select, container);
    opener.addEventListener('mousedown', () => {
      const search = makeInput({ className: 'select2-search__field' });
      search.className = 'select2-search__field';
      search.addEventListener('keyup', () => {
        for (const text of results) {
          const li = new FakeNode('li', { className: 'select2-results__option', textContent: text });
          li.addEventListener('mouseup', () => { select.append(new FakeNode('option', { textContent: text })); select.options = [...select.options, { text, value: text.slice(0, 6) }]; select.value = text.slice(0, 6); });
          h.document.body.append(li);
        }
      });
      h.document.body.append(search);
    });
    const report = await h.kit.fill([{ id: 'cls', selector: '#classCodeAndDescription', path: 'x.cls', kind: 'search-select', value: '484122', search: '484122' }], { maxRounds: 3 });
    if (expectOk) assert.equal(report.filled.length, 1, JSON.stringify(report.failed));
    else assert.match(report.failed[0].reason, /no confident match/);
  }
});

test('a dropdown with no usable label is found by one of its options', async () => {
  const h = harness();
  const carrier = new SelectNode([{ text: '', value: '' }, { text: 'ALLIANZ', value: 'a' }, { text: 'NO PRIOR', value: 'np' }], { id: 'x1', ariaLabel: 'Delete Coverage' });
  h.document.body.append(carrier);
  await h.kit.fill([{ id: 'np', withOption: 'NO PRIOR', path: 'x.np', kind: 'choice', value: 'NO PRIOR' }], { maxRounds: 2 });
  assert.equal(carrier.value, 'np');
});

test('an answer the page clears or overwrites after it was kept is given again; a step marked replace overwrites a lookup value', async () => {
  const h = harness();
  const year = makeInput({ id: 'licenseYear', ariaLabel: 'License Year (First issued)' });
  const body = makeInput({ id: 'bodyType', ariaLabel: 'Body Type', value: 'STRAIGHT TRUCK' });
  h.document.body.append(year, body);
  let cleared = 0;
  year.addEventListener('change', () => { if (!cleared++) setTimeout(() => { year.value = ''; }, 300); });
  const report = await h.kit.fill([
    { id: 'year', selector: '#licenseYear', path: 'x.year', kind: 'text', value: '1985' },
    { id: 'body', selector: '#bodyType', path: 'x.body', kind: 'text', value: 'Box Truck', replace: true },
  ], { maxRounds: 8 });
  assert.equal(year.value, '1985', 'filled again after the page cleared it');
  assert.equal(body.value, 'Box Truck', "the intake's body type replaces the lookup's");
  assert.equal(report.failed.length, 0, JSON.stringify(report.failed));
  assert.ok(!report.kept.some((x) => x.differs));
});

test('Save & Continue counts as Continue; Save & Exit and Submit never do', async () => {
  for (const [text, expected] of [['Save & Continue', true], ['Save & Exit', false], ['Submit', false]]) {
    const h = harness({ pathname: '/application/businessauto' });
    const button = addButton(h, text);
    button.onclick = () => { button._clicked = true; };
    await h.kit.fill([], { maxRounds: 1, advance: { text: '^(save\\s*(&|and)\\s*continue|save & exit|submit)$' } });
    assert.equal(!!button._clicked, expected, text);
  }
});

test('a field the page fills itself (emptyNote) is flagged only when it stays empty', async () => {
  for (const value of ['', '14500']) {
    const h = harness();
    const gvw = makeInput({ id: 'gvw', ariaLabel: 'Gross Vehicle Weight (GVW)', value });
    h.document.body.append(gvw);
    const report = await h.kit.fill([{ id: 'gvw', selector: '#gvw', path: 'x.gvw', kind: 'text', ignore: true, emptyNote: 'enter it yourself' }], { maxRounds: 2 });
    assert.equal(report.noData.length, value ? 0 : 1, value || 'empty');
    assert.equal(report.unknown.length, 0);
  }
});

test('a default to confirm (warn) is filled, flagged yellow and holds Continue until the agent changes or dismisses it', async () => {
  const h = harness();
  const marital = new SelectNode([{ text: '', value: '' }, { text: 'SINGLE', value: 'S' }, { text: 'MARRIED', value: 'M' }], { id: 'marital', ariaLabel: 'Marital Status' });
  const next = addButton(h, 'Save & Continue');
  next.onclick = () => { next._clicked = true; };
  h.document.body.append(marital);
  const step = { id: 'm', selector: '#marital', path: 'x.marital', kind: 'choice', value: 'MARRIED', warn: 'Married was picked. Check it.' };
  const first = await h.kit.fill([step], { maxRounds: 3, advance: { text: '^save & continue$' } });
  assert.equal(marital.value, 'M');
  assert.equal(first.checks.length, 1);
  assert.ok(first.blockers.some((b) => /^check: /.test(b)));
  assert.ok(!next._clicked, 'Continue waits for the agent');
  const again = await h.kit.fill([step], { maxRounds: 3, advance: { text: '^save & continue$' } });
  assert.equal(again.checks.length, 1, 'still flagged on a later fill while it is our default');
  assert.ok(!next._clicked);
  await h.kit.fill([step], { maxRounds: 3, skip: [again.checks[0].key], advance: { text: '^save & continue$' } });
  assert.ok(next._clicked, 'dismissed (or changed) by the agent: Continue');
});

// Live review 2026-10-09: a long fill had no way to stop it. The panel's Stop halts it the way an
// agent edit does: what is in stays, nothing more is filled, and Continue isn't clicked.
test('Stop halts a running fill after the answer going in; progress counts what is in', async () => {
  const h = harness();
  const a = makeInput({ id: 'a', ariaLabel: 'First' });
  const b = makeInput({ id: 'b', ariaLabel: 'Second' });
  const c = makeInput({ id: 'c', ariaLabel: 'Third' });
  const next = addButton(h, 'Continue');
  next.onclick = () => { next._clicked = true; };
  h.document.body.append(a, b, c);
  let during = null;
  b.addEventListener('change', () => { during = h.kit.progress(); assert.equal(h.kit.stop(), true); });
  assert.equal(h.kit.progress(), null, 'no fill running');
  assert.equal(h.kit.stop(), false, 'nothing to stop');
  const steps = [['a', 'one'], ['b', 'two'], ['c', 'three']].map(([id, value]) => ({ id, selector: `#${id}`, path: `x.${id}`, kind: 'text', value }));
  const report = await h.kit.fill(steps, { maxRounds: 3, advance: { text: '^continue$' } });
  assert.equal(during?.filled, 1);
  assert.equal(a.value, 'one');
  assert.equal(c.value, '', 'nothing after Stop is filled');
  assert.equal(report.halted, true);
  assert.match(report.reason, /You stopped the fill/);
  assert.ok(!next._clicked, 'Continue is not clicked');
  assert.equal(h.kit.progress(), null, 'the fill is over');
});

test('batch mode answers every visible question in one round and still checks each answer', async () => {
  const h = harness();
  const a = makeInput({ id: 'a', ariaLabel: 'First' });
  const b = makeInput({ id: 'b', ariaLabel: 'Second' });
  const c = makeInput({ id: 'c', ariaLabel: 'Third' });
  h.document.body.append(a, b, c);
  c.addEventListener('change', () => { c.value = 'something else'; });
  const steps = [['a', 'one'], ['b', 'two'], ['c', 'three']].map(([id, value]) => ({ id, selector: `#${id}`, path: `x.${id}`, kind: 'text', value }));
  const report = await h.kit.fill(steps, { maxRounds: 6, batch: true });
  assert.deepEqual([a.value, b.value], ['one', 'two']);
  assert.equal(report.filled.length, 2);
  assert.equal(report.failed.length, 1, 'a page that rejects an answer is still reported');
  assert.ok(report.rounds <= 4, `rounds: ${report.rounds}`);
});

test('an answer the page marks invalid after another change is picked again, then left to the agent if it stays invalid', async () => {
  for (const sticky of [false, true]) {
    const h = harness();
    const limit = makeInput({ id: 'limit', ariaLabel: 'Liability limit' });
    const pip = makeInput({ id: 'pip', ariaLabel: 'PIP' });
    h.document.body.append(limit, pip);
    let sets = 0;
    limit.addEventListener('change', () => { sets++; if (!sticky) limit.setAttribute('aria-invalid', 'false'); });
    pip.addEventListener('change', () => { limit.setAttribute('aria-invalid', 'true'); });
    const report = await h.kit.fill([
      { id: 'l', selector: '#limit', path: 'x.limit', kind: 'text', value: '$1M' },
      { id: 'p', selector: '#pip', path: 'x.pip', kind: 'text', value: '$10k' },
    ], { maxRounds: 10 });
    if (!sticky) {
      assert.ok(sets >= 2, 'limit given again after PIP invalidated it');
      assert.equal(report.failed.length, 0, JSON.stringify(report.failed));
    } else assert.ok(report.failed.some((x) => x.key === 'limit'), 'still invalid: the agent\'s');
  }
});

test('rates helpers wait while the liability limit differs from the intake; a limit the agent set counts as resolved', async () => {
  for (const agentSet of [false, true]) {
    const h = harness({ search: '?pageName=CoveragesRates' });
    const limit = makeInput({ id: 'liab-limit', ariaLabel: 'Liability limit', value: '500k CSL' });
    h.document.body.append(limit);
    h.document.body.innerText = 'Rates changed **** — please recalculate';
    const recalc = addButton(h, 'Recalculate');
    recalc.onclick = () => { recalc._clicked = true; h.document.body.innerText = 'Total premium: $12,345.67'; };
    const report = await h.kit.fill([
      { id: 'limit', selector: '#liab-limit', path: 'coverage.autoLiabLimit', kind: 'text', value: '1M CSL' },
      { id: 'recalc', kind: 'action', action: 'recalculate', text: '^recalculate$', pages: ['CoveragesRates'], after: ['coverage.autoLiabLimit'], afterActions: [], afterPages: [], unless: [], needsRecalculation: true, verify: 'premium' },
    ], { maxRounds: 4, skip: agentSet ? ['liab-limit'] : [] });
    assert.equal(!!recalc._clicked, agentSet, agentSet ? 'the agent chose the limit: Recalculate' : 'limit differs from the intake: Recalculate waits');
    if (!agentSet) {
      assert.ok(report.blocked.some((b) => b.id === 'recalculate' && /waiting for coverage\.autoLiabLimit/.test(b.why)), 'says what it waits for');
      assert.ok(report.blockers.some((b) => /^button: recalculate \(waiting for coverage\.autoLiabLimit\)$/.test(b)));
    }
  }
});

test('a DOT lookup listing the matching business name twice still counts as one match', async () => {
  const h = harness({ ext: true, search: '?pageName=BusinessOwnerInfo' });
  const field = addExtText(h, 'c', '22F', { caption: 'Business Name', required: true });
  const records = ['Sample Test LLC', 'Sample Test, LLC', 'Enter a different Business Name'].map((label) => ({ get: () => label }));
  Object.assign(field.cmp, { displayField: 'label', valueField: 'label', store: { getRange: () => records } });
  const record = { applicant: { name: 'Sample Test LLC', dot: '12345678' }, garaging: {}, operations: {}, drivers: [], vehicles: [], priorInsurance: [], coverage: {}, claims: {} };
  const report = await h.kit.fill(buildPlan(record, progressive).filter((s) => s.q === '22F'), {});
  assert.equal(field.cmp.getValue(), 'Sample Test LLC');
  assert.ok(!report.noData.some((x) => x.reviewOnly), 'not reported as a different identity');
  assert.equal(report.failed.length, 0);
});

// TNI 2026-10-20 (W43-01): Business Owner Info once Verify USDOT found the number: "belongs to the
// customer's business" (q20F) and the Business Name choice (q22F) listing the lookup's registered
// name. `shown`: when the page draws that name: before the fill ('first'), right after the Yes
// ('yes'), that many ms after it, or when a later question is answered ('later'). `later`: what
// the page does when each of its later questions is answered (one function per question; each is
// drawn once the one before it is answered), which gives the page rounds after these. `address`:
// the registered Business Address choice (q277) is on the page too.
const BELONGS = 'Does this USDOT Number belong to the customer\'s business?';
async function belongsPage({ applicant = { name: 'Sample Test LLC' }, registered = null, shown = 'first', already = '', invalid = false, address = false, later = null, options = {} } = {}) {
  const choices = (field, labels) => {
    const records = labels.map((label) => ({ get: () => label }));
    Object.assign(field.cmp, { displayField: 'label', valueField: 'label', store: { getRange: () => records } });
  };
  // A supported class: Continue would be clicked if nothing held it.
  const record = { applicant: { dot: '12345678', ...applicant }, garaging: {}, operations: { businessClass: 'Expediter' }, drivers: [], vehicles: [], priorInsurance: [], coverage: {}, claims: {} };
  const h = harness({ ext: true, search: '?pageName=BusinessOwnerInfo' });
  let name = null;
  const showName = () => {
    if (!registered || name) return;
    name = addExtText(h, 'c', '22F', { caption: 'Business Name', required: true });
    choices(name, [registered, 'Enter a different Business Name']);
  };
  if (shown === 'first') showName();
  // Progressive may show the registered name only once "belongs" is Yes.
  const onSet = (_, v) => {
    if (v !== 'Yes') return;
    if (shown === 'yes') showName();
    else if (typeof shown === 'number') setTimeout(showName, shown);
  };
  const belongs = addExtText(h, 'd', '20F', { caption: BELONGS, required: true, value: already, onSet });
  choices(belongs, ['Yes', 'No']);
  if (invalid) belongs.input.setAttribute('aria-invalid', 'true');
  const plan = buildPlan(record, progressive).filter((s) => ['20F', '22F', ...(address ? ['277'] : [])].includes(s.q));
  const addressField = address ? addExtText(h, 'f', '277', { caption: 'Business Address', required: true }) : null;
  if (addressField) choices(addressField, ['100 Sample Street', 'Enter a different address']);
  const laters = [].concat(later ?? []);
  const questions = laters.map((then, i) => addExtText(h, `e${i}`, `E0${i}`, { caption: `Synthetic later question ${i + 1}`,
    onSet: () => { then({ belongs, address: addressField, showName }); if (questions[i + 1]) h.document.body.append(questions[i + 1].input); } }));
  for (const q of questions.slice(1)) q.input.remove();
  questions.forEach((q, i) => plan.push({ id: `later${i}`, selector: `#${q.id}`, path: `test.later${i}`, name: `Later question ${i + 1}`, kind: 'text', value: 'later' }));
  const next = addButton(h, 'Continue');
  next.onclick = () => { next._clicked = true; };
  const report = await h.kit.fill(plan, options);
  const held = (re) => report.blockers.some((b) => b.includes(BELONGS) && re.test(b));
  return { belongs: belongs.cmp.getValue(), name: name?.cmp.getValue() ?? null, report, held, continued: !!next._clicked,
    own: (list, label = BELONGS) => list.filter((x) => x.label === label) };
}
const identity = (x) => x.reviewOnly && /differs from the intake/.test(x.note);

// The registered name differs from the intake's, before or after the Yes: then it and the Business
// Name are the agent's, and Continue waits. With no name on the intake to check, it's the agent's
// too, and an answer already on the page (Progressive never pre-selects one) is kept.
test('USDOT belongs: Yes when the registered name matches or is not shown; a different name, none to check, or an answer there is the agent\'s', async () => {
  // The registered name matches, or isn't shown: TNI's standard Yes.
  for (const registered of [null, 'Sample Test LLC']) {
    const r = await belongsPage({ registered });
    assert.equal(r.belongs, 'Yes', `registered name ${registered ?? 'not shown'}`);
    assert.ok(r.report.filled.some((x) => x.standard && x.label === BELONGS), 'filled as TNI\'s standard');
    assert.equal(r.report.blockers.length, 0, r.report.blockers.join(' | '));
  }
  // A different registered name shown first: neither is answered; this question holds Continue.
  let r = await belongsPage({ registered: 'Another Carrier Inc' });
  assert.deepEqual([r.belongs, r.name], ['', '']);
  assert.equal(r.own(r.report.noData).filter(identity).length, 1);
  assert.ok(r.held(/./), r.report.blockers.join(' | '));
  // Shown only after the Yes: the Yes stays on the page, but it is the agent's to verify too, and
  // the Business Name isn't picked.
  r = await belongsPage({ registered: 'Another Carrier Inc', shown: 'yes' });
  assert.equal(r.belongs, 'Yes');
  assert.ok(!r.report.filled.some((x) => x.label === BELONGS), 'not reported as filled');
  assert.equal(r.own(r.report.noData).filter(identity).length, 1);
  assert.equal(r.name, '');
  assert.equal(r.own(r.report.noData, 'Business Name').filter(identity).length, 1);
  assert.ok(r.held(/./), r.report.blockers.join(' | '));
  // No business or owner name on the intake: nothing to compare, so not answered.
  r = await belongsPage({ applicant: {}, registered: 'Another Carrier Inc', shown: 'yes' });
  assert.equal(r.belongs, '');
  assert.ok(r.own(r.report.noData).some((x) => x.manualOnly && /no business or owner name/.test(x.note ?? '')));
  assert.ok(r.held(/./), r.report.blockers.join(' | '));
  // An answer already there is a person's, also where Progressive's pre-selected choices are replaced.
  r = await belongsPage({ registered: 'Sample Test LLC', already: 'No', options: { replaceChoices: true } });
  assert.equal(r.belongs, 'No');
  assert.ok(r.own(r.report.checks).some((x) => /already has another answer/.test(x.note)));
  assert.ok(r.held(/./), r.report.blockers.join(' | '));
});

// Review of PR #102: the paths around those answers never turn them into a filled Yes, or move
// one the agent has made their own.
test('USDOT belongs: an invalid answer, a late registered name and an agent edit keep the identity check', async () => {
  // A person's "No" the page marks invalid is still kept, never replaced by the standard Yes.
  let r = await belongsPage({ registered: 'Sample Test LLC', already: 'No', invalid: true, options: { replaceChoices: true } });
  assert.equal(r.belongs, 'No');
  assert.ok(!r.report.filled.some((x) => x.label === BELONGS), 'not reported as filled');
  assert.equal(r.own(r.report.failed).length, 1);
  assert.ok(r.own(r.report.checks).some((x) => /already has another answer/.test(x.note)));
  // Answers the identity check left to the agent once a different name showed, then marked invalid:
  // flagged once, not given again (each try listed them again).
  const invalidAfter = ({ belongs, address }) => { for (const field of [belongs, address]) field.input.setAttribute('aria-invalid', 'true'); };
  r = await belongsPage({ registered: 'Another Carrier Inc', shown: 'later', address: true, later: [({ showName }) => showName(), invalidAfter] });
  assert.equal(r.belongs, 'Yes');
  for (const label of [BELONGS, 'Business Address']) {
    assert.equal(r.own(r.report.noData, label).filter(identity).length, 1, `${label}: ${JSON.stringify(r.own(r.report.noData, label))}`);
    assert.equal(r.own(r.report.noData, label).length, 1, label);
    assert.equal(r.own(r.report.failed, label).length, 1, label);
  }
  // A registered name drawn while the fill waits before Continue: the Yes is the agent's to
  // verify, and Continue isn't clicked.
  r = await belongsPage({ registered: 'Another Carrier Inc', shown: 600, options: { advance: { text: '^continue$' } } });
  assert.equal(r.continued, false, r.report.blockers.join(' | '));
  assert.equal(r.own(r.report.noData).filter(identity).length, 1);
  assert.ok(r.held(/^needs you/), r.report.blockers.join(' | '));
  // The agent changed the Yes before a different name showed: their answer stays theirs, not a
  // "needs you" item.
  const edit = ({ belongs, showName }) => {
    belongs.input.dispatchEvent({ type: 'pointerdown', target: belongs.input, isTrusted: true });
    belongs.cmp._value = 'No';
    belongs.input.value = 'No';
    belongs.input.dispatchEvent({ type: 'change', target: belongs.input, isTrusted: true });
    showName();
  };
  r = await belongsPage({ registered: 'Another Carrier Inc', shown: 'later', later: edit });
  assert.equal(r.belongs, 'No');
  assert.equal(r.report.halted, true);
  assert.equal(r.own(r.report.noData).length, 0, JSON.stringify(r.own(r.report.noData)));
});

test('AI answers refuse changed values, options, sections and page snapshots', async () => {
  const h = harness();
  const field = new SelectNode([
    { text: 'Select one', value: '' }, { text: 'Consumer Goods', value: 'cg' }, { text: 'Building Materials', value: 'bm' },
  ], { id: 'commodity', ariaLabel: 'Commodity category' });
  h.document.body.append(field);
  const report = await h.kit.fill([], { maxRounds: 1 });
  const item = report.unknown.find(x => x.label === 'Commodity category');
  const expected = { kind: item.controlKind, section: item.section || null, options: [...item.options], current: item.current };
  const answer = { key: item.key, label: item.label, value: 'Consumer Goods', expected };
  const snapshot = h.kit.decisionSnapshot();
  field.value = 'bm';
  const [changed] = await h.kit.answer([answer], [snapshot]);
  assert.equal(changed.ok, false);
  assert.equal(field.value, 'bm', 'manual choice is preserved');
  const [valueChanged] = await h.kit.answer([answer]);
  assert.equal(valueChanged.ok, false);
  field.value = '';
  const [optionsChanged] = await h.kit.answer([{ ...answer, expected: { ...expected, options: ['Other'] } }]);
  assert.equal(optionsChanged.ok, false);
  const [sectionChanged] = await h.kit.answer([{ ...answer, expected: { ...expected, section: 'Other vehicle' } }]);
  assert.equal(sectionChanged.ok, false);
  const [fresh] = await h.kit.answer([answer], [h.kit.decisionSnapshot()]);
  assert.equal(fresh.ok, true);
  assert.equal(field.value, 'cg');
});

test('fields that reappear already answered (a step shown again) are never counted as the agent\'s edits', () => {
  const h = recorderHarness();
  const existing = makeInput({ id: 'existing', ariaLabel: 'Existing question', value: 'before' });
  h.document.body.append(existing);
  h.context.__raterRecorder.rebaseline();
  h.trusted(existing);
  // The agent clicks Prev: the earlier step comes back with its saved answers, and they edit one field.
  h.document.body.append(makeInput({ id: 'restored', ariaLabel: 'Restored question', value: 'saved answer' }));
  existing.value = 'after';
  h.tick();
  const changes = h.sent.filter((m) => m.event === 'field_changes').flatMap((m) => m.changes);
  assert.equal(changes.find((c) => c.key === 'existing')?.agent, true, 'a real edit is still the agent\'s');
  assert.equal(changes.find((c) => c.key === 'restored')?.agent, false, 'reappearing with a value is the page');
});

test('a capture keeps up to 250 choices per question and says when a list was cut', () => {
  const h = harness();
  const long = new SelectNode(Array.from({ length: 300 }, (_, i) => ({ text: `Business type ${i + 1}`, value: `b${i}` })), { id: 'bizType', ariaLabel: 'Business type list' });
  const short = new SelectNode([{ text: 'Yes', value: 'Y' }, { text: 'No', value: 'N' }], { id: 'hazmat', ariaLabel: 'Hazmat' });
  h.document.body.append(long, short);
  const byId = Object.fromEntries(h.kit.capture(null, []).controls.map((c) => [c.id, c]));
  assert.equal(byId.bizType.options.length, 250);
  assert.equal(byId.bizType.options.at(-1), 'Business type 250');
  assert.equal(byId.bizType.optionsTruncated, true);
  assert.deepEqual([...byId.hazmat.options], ['Yes', 'No']);
  assert.equal(byId.hazmat.optionsTruncated, undefined);
});

test('a capture only reads the page: no DOM writes, events, focus, values or widget calls', () => {
  const h = harness({ ext: true });
  const { cmp } = addExtText(h, 'a', '2B9D', { caption: 'Farthest distance', value: '500 miles' });
  const state = new SelectNode([{ text: '', value: '' }, { text: 'Florida', value: 'FL' }], { id: 'garageState', ariaLabel: 'Garaging state', value: 'FL' });
  const name = makeInput({ id: 'dba', ariaLabel: 'Doing business as', value: 'typed text' });
  const group = new FakeNode('fieldset', { id: 'hazmatGroup', role: 'radiogroup', ariaLabel: 'Hauls hazmat?' });
  const yes = makeInput({ type: 'radio', name: 'hazmat', value: 'Yes', checked: true });
  const no = makeInput({ type: 'radio', name: 'hazmat', value: 'No' });
  group.append(yes, no);
  h.document.body.append(state, name, group);
  addButton(h, 'Continue');

  // Everything a page (or a session-replay script watching it) could see change.
  const look = () => JSON.stringify(h.document.querySelectorAll('*').map((n) => [n.tagName, n.id, n.className, n.value, n.checked,
    n.disabled, n._textContent, [...n._attrs], Object.entries(n.style), n.children.length]));
  const before = look();
  const writes = [];
  const spy = (target, names) => names.forEach((m) => {
    const original = target[m];
    target[m] = function (...args) { writes.push(m); return original.apply(this, args); };
  });
  const methods = ['append', 'remove', 'replaceChild', 'setAttribute', 'removeAttribute', 'dispatchEvent', 'click', 'focus', 'blur', 'addEventListener'];
  const saved = methods.map((m) => [m, FakeNode.prototype[m]]);
  spy(FakeNode.prototype, methods);
  spy(cmp, ['setValue', 'fireEvent']);
  Object.assign(cmp, { validate: () => writes.push('validate'), isValid: () => { writes.push('isValid'); return true; }, focus: () => writes.push('cmp.focus') });
  try {
    const page = h.kit.capture([{ id: 'state', path: 'garaging.state', kind: 'choice', value: 'Florida' }], ['typed text']);
    assert.ok(page.controls.length >= 4, `captured ${page.controls.length} controls`);
    assert.ok(!JSON.stringify(page).includes('typed text'), 'typed text is never captured');
  } finally {
    saved.forEach(([m, fn]) => { FakeNode.prototype[m] = fn; });
  }
  assert.deepEqual(writes, [], 'capture called something that changes the page');
  assert.equal(look(), before, 'the page looks exactly as before');
});

test('a fill reports each combo\'s choices under the key the recorder gives its changes', async () => {
  const h = harness({ ext: true, search: '?pageName=AddVehicle' });
  // ExtJS combos as Duck Creek draws them: the input in a trigger wrap with an arrow trigger.
  const combo = (question, caption, labels) => {
    const id = `f_c${'A'.repeat(32)}${question}_1_1`;
    const input = makeInput({ id, ariaLabel: caption });
    const cmp = extCmp(id, input, { caption });
    const records = labels.map((label) => ({ get: () => label }));
    Object.assign(cmp, { displayField: 'label', valueField: 'label', store: { getRange: () => records } });
    h.context.Ext._components.set(id, cmp);
    const wrap = new FakeNode('div', { className: 'x-form-trigger-wrap' });
    wrap.append(input, new FakeNode('div', { className: 'x-form-trigger x-form-arrow-trigger' }));
    h.document.body.append(wrap);
    return input;
  };
  const model = combo('2C1A', 'Model', ['', 'Transit 150', 'Transit 350', 'Transit 350']);
  combo('2C1B', 'Agent of record', ['Pat Agent']);
  addExtText(h, 'c', '2C1C', { caption: 'Stated amount' });
  const report = await h.kit.fill([], { maxRounds: 1 });
  const key = h.context.__raterFieldKey(model, { q: '2C1A' });
  assert.deepEqual(JSON.parse(JSON.stringify(report.choices)), [[key, ['Transit 150', 'Transit 350']]],
    'combos only, without agency staff lists');

  const recorder = recorderHarness(h.document);
  const choices = new Map(report.choices.map(([k, options]) => [k, new Set(options)]));
  const logged = () => {
    const change = recorder.sent.filter((m) => m.event === 'field_changes').flatMap((m) => m.changes).at(-1);
    assert.equal(change.key, key);
    assert.equal(change.combo, true);
    return fieldChangeEvent(change, { record: { vehicles: [{ model: 'Transit 350' }] }, filled: new Map(), redact: redactor([]), choices });
  };
  recorder.trusted(model);
  model.value = 'Trans';
  recorder.tick();
  const typed = logged();
  assert.deepEqual([typed.kind, typed.change, 'to' in typed], ['text', 'entered', false], 'a search is not logged');
  recorder.trusted(model);
  model.value = 'Transit 350';
  recorder.tick();
  const picked = logged();
  assert.deepEqual([picked.kind, picked.from, picked.to], ['text', undefined, undefined], 'the typed search on the other side still is not');
  assert.deepEqual(picked.matchesIntake, ['vehicles[0].model']);
  recorder.trusted(model);
  model.value = 'Transit 150';
  recorder.tick();
  const repicked = logged();
  assert.deepEqual([repicked.kind, repicked.from, repicked.to], ['select', 'Transit 350', 'Transit 150']);
});

test('a kit left in the page by another build (an extension reload or update) is replaced', () => {
  const h = harness();
  const old = h.kit;
  vm.runInNewContext(PAGEKIT, h.context);
  assert.equal(h.context.__raterKit, old, 'the same build is reused');
  old.build = 'older-build';
  h.context.__raterFieldKey.build = 'older-build';
  const oldKey = h.context.__raterFieldKey;
  vm.runInNewContext(FIELD_KEY, h.context);
  vm.runInNewContext(PAGEKIT, h.context);
  assert.notEqual(h.context.__raterKit, old);
  assert.notEqual(h.context.__raterFieldKey, oldKey);
  assert.equal(h.context.__raterKit.build, 'source');
});

test('on a carrier stop page (Progressive DeclinationNotice) the kit fills and clicks nothing', async () => {
  const step = { id: 'zip-step', selector: '#zip', path: 'garaging.zip', kind: 'text', value: '17101' };
  const record = { applicant: {}, garaging: {}, operations: {}, drivers: [], vehicles: [], priorInsurance: [], coverage: {}, claims: {} };
  const [action] = buildPlan(record, { id: 'synthetic', useGenericRules: false, rules: [], actions: [{ id: 'go', text: '^go$' }] }).filter((s) => s.kind === 'action');
  for (const page of ['DeclinationNotice', 'BusinessOwnerInfo']) {
    const h = harness({ search: `?pageName=${page}` });
    const zip = makeInput({ id: 'zip', ariaLabel: 'Zip code' });
    const go = addButton(h, 'Go');
    const next = addButton(h, 'Continue');
    let clicks = 0;
    go.onclick = () => clicks++;
    next.onclick = () => clicks++;
    h.document.body.append(zip);
    const report = await h.kit.fill([step, action], { maxRounds: 3, advance: { text: '^continue$' }, stopPages: Object.keys(progressive.stopPages) });
    if (page === 'DeclinationNotice') {
      assert.equal(report.halted, true);
      assert.match(report.reason, /stopped this quote/);
      assert.equal(zip.value, '', 'nothing typed');
      assert.equal(clicks, 0, 'no helper and no Continue');
      assert.deepEqual([...report.filled, ...report.actions], []);
    } else {
      // Any other page fills as before.
      assert.equal(report.halted, false);
      assert.equal(zip.value, '17101');
    }
  }
});

test('a capture names the step on screen from its visible headings', () => {
  const h = harness();
  h.document.body.append(new FakeNode('h3', { textContent: 'Vehicles' }), makeInput({ id: 'vin', ariaLabel: 'VIN' }));
  assert.equal(h.kit.capture(null, []).step, 'Vehicles');
});

test('a capture keeps the messages on screen and any open dropdown list, never a staff list', () => {
  const h = harness();
  const vehicleType = makeInput({ id: 'type', ariaLabel: 'Vehicle type', attrs: { 'aria-controls': 'typeList' } });
  const producer = makeInput({ id: 'producer', ariaLabel: 'Producer', attrs: { 'aria-controls': 'producerList' } });
  const list = (id, items) => {
    const l = new FakeNode('ul', { id, role: 'listbox' });
    l.append(...items.map((t) => new FakeNode('li', { role: 'option', textContent: t })));
    return l;
  };
  h.document.body.append(vehicleType, producer, list('typeList', ['Cargo Van', 'Box Truck']), list('producerList', ['JANE DOE-1']),
    new FakeNode('div', { role: 'alert', textContent: 'VIN for Jordan Avery is not valid' }));
  const page = h.kit.capture(null, ['Jordan Avery']);
  assert.deepEqual(JSON.parse(JSON.stringify(page.openLists.map((l) => [l.label, l.options]))), [['Vehicle type', ['Cargo Van', 'Box Truck']], ['Producer', []]]);
  assert.deepEqual([...page.messages], ['VIN for [client] is not valid']);
});

test('a capture takes typed text out of messages, and keeps no choices of a list whose question is unknown', () => {
  const h = harness({ ext: true });
  const vin = makeInput({ id: 'vin', ariaLabel: 'VIN', value: '1HGBH41JXMN109186' });
  const phone = makeInput({ id: 'phone', ariaLabel: 'Phone', value: '555 201 0199' });
  const orphan = new FakeNode('div', { id: 'boundlist-1', className: 'x-boundlist' });
  orphan.append(new FakeNode('li', { className: 'x-boundlist-item', textContent: 'JANE DOE-1' }));
  const owned = new FakeNode('div', { id: 'boundlist-2', className: 'x-boundlist' });
  owned.append(new FakeNode('li', { className: 'x-boundlist-item', textContent: 'Cargo Van' }));
  h.context.Ext._components.set('boundlist-2', { pickerField: { dctCaption: 'Vehicle type', queryMode: 'local' } });
  // A lookup filled from what was typed (a remote store): its results are not kept.
  const lookup = new FakeNode('div', { id: 'boundlist-3', className: 'x-boundlist' });
  lookup.append(new FakeNode('li', { className: 'x-boundlist-item', textContent: '12 Corrected Rd, Tampa' }));
  h.context.Ext._components.set('boundlist-3', { pickerField: { dctCaption: 'Garaging address', queryMode: 'remote' } });
  // Text typed into a combo the page treats as a choice is taken out of messages too.
  const { input: business } = addExtText(h, 'c', '2D1', { caption: 'Business name' });
  business.value = 'Corrected Hauling Co';
  h.document.body.append(vin, phone, orphan, owned, lookup,
    new FakeNode('div', { role: 'alert', textContent: 'VIN 1HGBH41JXMN109186 not found; call 555 201 0199' }),
    new FakeNode('div', { role: 'alert', textContent: 'No match for CORRECTED  hauling co' }));
  const page = h.kit.capture(null, []);
  assert.deepEqual([...page.messages], ['VIN [typed] not found; call [typed]', 'No match for [typed]']);
  assert.deepEqual(JSON.parse(JSON.stringify(page.openLists.map((l) => [l.label, l.options]))),
    [[null, []], ['Vehicle type', ['Cargo Van']], ['Garaging address', []]]);
});

test('typed text is taken out of messages from boxes question discovery skips: search boxes, editable regions', () => {
  const h = harness();
  const search = makeInput({ id: 'lookup', type: 'search', ariaLabel: 'Find a customer', value: 'Rivera Logistics' });
  const notes = new FakeNode('div', { attrs: { contenteditable: 'true' }, textContent: 'Dock at 4 Pier Rd' });
  h.document.body.append(search, notes,
    new FakeNode('div', { role: 'alert', textContent: 'No customer named rivera logistics; check Dock at 4 Pier Rd' }));
  assert.deepEqual([...h.kit.capture(null, []).messages], ['No customer named [typed]; check [typed]']);
});

// Progressive renumbered every question on 2026-10-07 (Agent Code 18F became 1C6, Type of Trucker
// 267 became 29E, and 267 became Business Name). Questions are found by their data-model name or
// their text, so the same page with other numbers fills the same way, and no answer goes to the
// question that now has an old number.
test('Progressive questions are found by name or text: renumbered, the same answers go to the same questions', async () => {
  const record = {
    applicant: { name: 'Example LLC', dot: null, owner1: 'Test Owner' },
    garaging: { street: '1 Example St', city: 'Example City', zip: '21000', unit: null },
    operations: { businessClass: 'Expediter' },
    drivers: [], vehicles: [], trailers: [], priorInsurance: [],
    coverage: { cargo: false, gl: false }, claims: {},
  };
  const page = (shift) => {
    const h = harness({ ext: true, search: '?pageName=BusinessOwnerInfo' });
    const id = (q) => (parseInt(q, 16) + shift).toString(16).toUpperCase();
    const agent = addExtText(h, 'U', id('18F'), { caption: 'Agent Code', value: 'AGENT-1', ref: refOf('18F') });
    const name = addExtText(h, 'U', id('230'), { caption: 'Business Name', ref: refOf('230') });
    const trucker = new SelectNode([{ text: 'Other For-Hire Trucking', value: 'other' }, { text: 'Household Goods Mover', value: 'hhg' }],
      { id: `f_U${'A'.repeat(32)}${id('267')}_1_1`, ariaLabel: 'Type of Trucker', attrs: { fieldref: refOf('267') } });
    h.document.body.append(trucker);
    addExtText(h, 'U', id('27E'), { caption: 'Street Address', ref: refOf('27E') });
    const zip = addExtText(h, 'U', id('284'), { caption: 'Zip Code', ref: refOf('284') });
    const city = addExtText(h, 'U', id('286'), { caption: 'City', ref: refOf('286') });
    return { h, agent, name, trucker, zip, city };
  };
  const results = [];
  for (const shift of [0, 0x37]) {
    const p = page(shift);
    const report = await p.h.kit.fill(buildPlan(record, progressive), {});
    assert.equal(report.halted, false);
    assert.deepEqual(Array.from(report.unknown, (x) => x.label), [], `nothing unfamiliar with shift ${shift}`);
    results.push([p.agent.input.value, p.name.input.value, p.trucker.value, p.zip.input.value, p.city.input.value]);
  }
  assert.deepEqual(results[0], ['AGENT-1', 'Example LLC', 'other', '21000', 'Example City']);
  assert.deepEqual(results[1], results[0]);
});

test('an old question number now on another question gets nothing from the rule written for it', async () => {
  // Live on 2026-10-07: 267 (the rule "Type of trucker") is Business Name, 2BB (owner date of
  // birth) is the business Zip Code.
  const h = harness({ ext: true, search: '?pageName=BusinessOwnerInfo' });
  const name = addExtText(h, 'U', '267', { caption: 'Business Name', ref: refOf('230') });
  addExtText(h, 'U', '2B5', { caption: 'Street Address', ref: refOf('27E') });
  const zip = addExtText(h, 'U', '2BB', { caption: 'Zip Code', ref: refOf('284') });
  const record = {
    applicant: { name: 'Example LLC', owner1: 'Test Owner' },
    garaging: { street: '1 Example St', city: 'Example City', zip: '21000' },
    operations: { businessClass: 'Expediter' },
    drivers: [{ first: 'Test', last: 'Owner', dob: '01/02/1980' }], vehicles: [], trailers: [], priorInsurance: [],
    coverage: { cargo: false, gl: false }, claims: {},
  };
  const report = await h.kit.fill(buildPlan(record, progressive), {});
  assert.equal(name.input.value, 'Example LLC');
  assert.equal(zip.input.value, '21000');
  assert.ok(!report.filled.some((x) => ['progressive.q267', 'progressive.q2BB'].includes(x.path)), 'the old numbers answer nothing');
});

test('a step with only a question number finds nothing', async () => {
  const h = harness({ ext: true });
  const field = addExtText(h, 'U', '3A01', { caption: 'Some question' });
  const report = await h.kit.fill([{ id: 'n', q: '3A01', path: 'synthetic.n', kind: 'text', value: 'x' }], { maxRounds: 2 });
  assert.equal(field.input.value, '');
  assert.equal(report.filled.length, 0);
  assert.equal(report.unknown.length, 1);
});

test('the cargo row and the cargo section both read "Motor Trucking Cargo": each gets the cargo answer', async () => {
  const h = harness({ ext: true, search: '?pageName=CoveragesRates' });
  const limits = ['Not selected', '$100k with a $1,000 Deductible'].map((label) => ({ get: () => label }));
  const row = addExtText(h, 'c', '2150', { caption: 'Motor Trucking Cargo' });
  const section = addExtText(h, 'c', '216F', { caption: 'Motor Trucking Cargo' });
  for (const f of [row, section]) Object.assign(f.cmp, { displayField: 'label', valueField: 'label', store: { getRange: () => limits } });
  const record = { applicant: {}, garaging: {}, operations: {}, drivers: [], vehicles: [], priorInsurance: [], coverage: { cargo: true, cargoLimit: 100000, cargoDeductible: 1000 }, claims: {} };
  const plan = buildPlan(record, progressive).filter((s) => ['2150', '216F'].includes(s.q));
  const report = await h.kit.fill(plan, { maxRounds: 4 });
  assert.equal(row.cmp.getValue(), '$100k with a $1,000 Deductible');
  assert.equal(section.cmp.getValue(), '$100k with a $1,000 Deductible');
  assert.equal(report.unknown.length, 0);
});

// Fable on PR #43: a field found by its data-model name whose question reads differently now is
// answered but flagged; a known wording on a field whose data-model name isn't the rule's is a
// probable rename, left with the agent; a text rule never takes a field another rule knows by name.
test('a reworded question is answered and flagged; a renamed field is reported and left; names beat texts', async () => {
  const record = {
    applicant: { name: 'Example LLC', owner1: 'Test Owner' }, garaging: { street: '1 Example St', city: 'Example City', zip: '21000' },
    operations: { businessClass: 'Expediter' }, drivers: [], vehicles: [], trailers: [], priorInsurance: [], coverage: {}, claims: {},
  };
  const plan = buildPlan(record, progressive).filter((s) => ['230', '233'].includes(s.q));
  // Business Name under its data-model name, with new wording: answered, and the agent checks it.
  let h = harness({ ext: true, search: '?pageName=BusinessOwnerInfo' });
  const name = addExtText(h, 'U', '267', { caption: 'Legal Business Name', ref: refOf('230') });
  let report = await h.kit.fill(plan, {});
  assert.equal(name.input.value, 'Example LLC');
  assert.equal(report.reworded.length, 1);
  assert.ok(report.checks.some((x) => /wording of this question changed/.test(x.note)));
  assert.equal(name.input.getAttribute('data-rater-autofill'), 'needs');
  // The same wording under another data-model name: probably renamed, so nothing is typed.
  h = harness({ ext: true, search: '?pageName=BusinessOwnerInfo' });
  const renamed = addExtText(h, 'U', '267', { caption: 'Business Name', ref: 'AccountInput.LegalBusinessName' });
  report = await h.kit.fill(plan, {});
  assert.equal(renamed.input.value, '');
  assert.deepEqual(Array.from(report.renamed, (x) => [x.name, x.now]), [['Business / sole proprietor name', 'AccountInput.LegalBusinessName']]);
  assert.equal(renamed.input.getAttribute('data-rater-autofill'), 'needs');
  assert.ok(Array.from(report.unknown, (x) => x.label).includes('Business Name'), 'left for the agent');
  // DBA Name's box known by name; a text rule reading "DBA Name" can't take it.
  h = harness({ ext: true, search: '?pageName=BusinessOwnerInfo' });
  const dba = addExtText(h, 'U', '26A', { caption: 'DBA Name', ref: refOf('233') });
  report = await h.kit.fill([...plan, { id: 'text-dba', q: '9999', ask: ['DBA Name'], pages: ['BusinessOwnerInfo'], path: 'synthetic.dba', kind: 'text', value: 'NOPE' }], {});
  assert.equal(dba.input.value, '');
  assert.equal(report.unknown.length, 0);
});

// OK live run, 2026-10-07: what Progressive's Rates says, in its own words. "Total premium amount
// $… per year" is a current premium; "please "recalculate"" / "Recalculate to see coverage cost"
// are out-of-date rates.
test("Progressive's premium and stale-rates wording are recognized", async () => {
  const good = premiumHarness({ recalcResult: 'Total premium amount $12,815.00 per year including Electronic Funds Transfer (EFT) discount' });
  good.h.document.body.innerText = 'The coverages have changed, please "recalculate" to see your rate.';
  await good.h.kit.fill(coverageActionPlan(), { maxRounds: 4 });
  assert.equal(good.recalc._clicked, true, 'quoted "recalculate" is out of date');
  assert.equal(good.bill._clicked, true, '"Total premium amount $…" is a current premium');
  const cost = premiumHarness({ recalcResult: 'Total premium amount $9,000.00 per year' });
  cost.h.document.body.innerText = 'Recalculate to see coverage cost';
  await cost.h.kit.fill(coverageActionPlan(), { maxRounds: 4 });
  assert.equal(cost.recalc._clicked, true);
  assert.equal(cost.bill._clicked, true);
});

test('ZIP+4 on either side is the same ZIP', async () => {
  for (const [page, intake] of [['74129-1234', '74129'], ['74129', '74129-1234'], ['74129-5678', '74129-1234']]) {
    const h = harness({ ext: true, search: '?pageName=AddVehicle' });
    const zip = addExtText(h, 'U', '2B92', { caption: 'Zip code where the vehicle is located', value: page });
    const report = await h.kit.fill([{ id: 'zip', q: '2B92', field: fieldOf('2B92'), path: 'garaging.zip', kind: 'text', value: intake }], { maxRounds: 2 });
    assert.equal(report.kept.some((x) => x.differs), false, `${page} vs ${intake}`);
    assert.equal(zip.input.value, page, 'left as the page has it');
  }
  const h = harness({ ext: true, search: '?pageName=AddVehicle' });
  addExtText(h, 'U', '2B92', { caption: 'Zip code where the vehicle is located', value: '74130' });
  const report = await h.kit.fill([{ id: 'zip', q: '2B92', field: fieldOf('2B92'), path: 'garaging.zip', kind: 'text', value: '74129-1234' }], { maxRounds: 2 });
  assert.equal(report.kept.some((x) => x.differs), true, 'another ZIP still differs');
});

test('Continue is not clicked on a page whose questions have not drawn yet', async () => {
  const plan = [{ id: 'name', q: '230', field: fieldOf('230'), pages: ['BusinessOwnerInfo'], path: 'applicant.name', kind: 'text', value: 'Example LLC' }];
  const empty = harness({ ext: true, search: '?pageName=BusinessOwnerInfo' });
  const start = addButton(empty, 'Ok, start quote.');
  start.onclick = () => { start._clicked = true; };
  await empty.kit.fill(plan, { maxRounds: 2, advance: { text: '^(continue|ok,? start quote\\.?)\\W*$' } });
  assert.equal(start._clicked, undefined, 'nothing drawn yet: no Continue');
  // A list page with no questions of its own still continues.
  const list = harness({ ext: true, search: '?pageName=DriverSummary' });
  const next = addButton(list, 'Continue');
  next.onclick = () => { next._clicked = true; };
  await list.kit.fill(plan, { maxRounds: 2, advance: { text: '^(continue|ok,? start quote\\.?)\\W*$' } });
  assert.equal(next._clicked, true);
});

test('a button that shows only once the page took an answer: the answer is picked again, once', async () => {
  const h = harness({ ext: true, search: '?pageName=CoveragesRates' });
  const commodity = new SelectNode([{ text: '', value: '' }, { text: 'Other Consumer Goods', value: 'ocg' }],
    { id: `f_c${'A'.repeat(32)}21AB_1_1`, attrs: { fieldref: 'MTCargoCommodityCategories.MTCargoListOfCommodities' } });
  commodity.value = 'ocg';
  h.document.body.append(commodity);
  let picks = 0;
  commodity.addEventListener('change', () => { picks++; if (picks === 1) { const done = addButton(h, 'Done with this coverage'); done.onclick = () => { done._clicked = true; h.done = done; }; } });
  const plan = [
    { id: 'commodity', q: '216B', field: 'MTCargoCommodityCategories.MTCargoListOfCommodities', path: 'progressive.q216B', kind: 'choice', value: 'Other Consumer Goods', cargo: 'section' },
    { id: 'done', kind: 'action', action: 'doneCargo', text: '^done with this coverage$', pages: ['CoveragesRates'], after: ['progressive.q216B'], afterAny: [], afterActions: [], afterPages: [], unless: [], nudge: 'progressive.q216B' },
  ];
  await h.kit.fill(plan, { maxRounds: 6 });
  assert.equal(picks, 1, 'picked again once');
  assert.equal(h.done?._clicked, true, 'then Done');
  // On ExtJS the re-pick hands the select listeners the picked record, as a real pick does.
  const x = harness({ ext: true, search: '?pageName=CoveragesRates' });
  const list = addExtText(x, 'c', '216B', { caption: ' ', value: 'Other Consumer Goods' });
  const records = ['', 'Other Consumer Goods'].map((label) => ({ label, get: () => label }));
  Object.assign(list.cmp, { displayField: 'label', valueField: 'label', store: { getRange: () => records } });
  const got = [];
  list.cmp.on('select', (cmp, rec) => { got.push(rec); if (rec?.label === 'Other Consumer Goods') { const done = addButton(x, 'Done with this coverage'); done.onclick = () => { done._clicked = true; x.done = done; }; } });
  await x.kit.fill(plan, { maxRounds: 6 });
  assert.equal(got.length, 1);
  assert.equal(got[0], records[1], 'the record, not its value');
  assert.equal(x.done?._clicked, true);
});

test('a question whose wording carries a date is not flagged as reworded when the date moves', async () => {
  // An expediter: outside the supported classes the standard No would be a check item (review mode).
  const record = { applicant: {}, garaging: {}, operations: { businessClass: 'Expediter' }, drivers: [{ first: 'Test', last: 'Driver' }], vehicles: [], trailers: [], priorInsurance: [], coverage: {}, claims: { hasClaims: false } };
  const plan = buildPlan(record, progressive).filter((s) => ['28F5', '299D'].includes(s.q));
  const h = harness({ search: '?pageName=AddDriver' });
  const yesNo = (ref, question) => radioGroup(question, ...['Yes', 'No'].map((value) => makeInput({ name: `r_${ref}`, type: 'radio', value, attrs: { fieldref: ref } })));
  const accidents = yesNo('DriverInput.AnyAccidentsViolationsPastExpYears', 'Has this driver had any accidents, claims or violations in the past 3 years? (since 11/2023)');
  const defensive = yesNo('DriverInput.DefensiveDriverDiscount', 'Defensive Driver Discount');
  h.document.body.append(accidents, defensive);
  const report = await h.kit.fill(plan, { maxRounds: 4, replaceChoices: true });
  assert.equal(report.reworded.length, 0);
  assert.equal(report.checks.length, 0);
  assert.equal(accidents.children.find((r) => r.checked)?.value, 'No');
  assert.equal(defensive.children.find((r) => r.checked)?.value, 'No', 'defensive driver discount: standard No');
  assert.equal(report.unknown.length, 0);
});

// AmWINS' vehicle rows after Import Valid Records: each row shows a VIN, in the import's order,
// not the intake's. A step with a `witness` takes the row whose VIN is its unit's; a unit whose
// VIN is on no row (rejected by the import) or on two stays the agent's, named without its VIN.
// (The harness matches simple selectors only, so the rows' controls are found by data-id alone.)
function vehicleRows(h, vins) {
  const panel = new FakeNode('div', { id: 'vehiclesPanel' });
  const rows = vins.map((vin, i) => {
    const row = new FakeNode('div', { className: 'app-rp-section', attrs: { 'data-id': String(i) } });
    const box = new FakeNode('div');
    const vinInput = makeInput({ ariaLabel: 'VIN', value: vin, attrs: { 'data-id': 'vin' } });
    const body = makeInput({ ariaLabel: 'Body Type', attrs: { 'data-id': 'bodyType' } });
    box.append(vinInput, body);
    row.append(box);
    panel.append(row);
    return { row, vin: vinInput, body };
  });
  h.document.body.append(panel);
  return rows;
}
const VINS = ['1FTBR3X87MKA00001', '1FTBR3X87MKA00002', '1FTBR3X87MKA00003'];
const witnessPlan = (vins = VINS) => vins.flatMap((vin, i) => [
  { id: `vin${i}`, selector: '[data-id="vin"]', path: `vehicles[${i}].vin`, kind: 'text', value: vin, trustPage: true, name: 'VIN', witness: { selector: '[data-id="vin"]', path: `vehicles[${i}].vin`, value: vin } },
  { id: `body${i}`, selector: '[data-id="bodyType"]', path: `amwins.q${i}`, kind: 'text', value: ['Box Truck', 'Cargo Van', 'Pickup Truck'][i], name: 'Body type', witness: { selector: '[data-id="vin"]', path: `vehicles[${i}].vin`, value: vin } },
]);

test('rows in another order than the intake: each unit\'s answers land on the row with its VIN', async () => {
  const h = harness();
  const rows = vehicleRows(h, [VINS[2], VINS[1], VINS[0]]);
  const report = await h.kit.fill(witnessPlan(), { maxRounds: 8 });
  assert.deepEqual(rows.map((r) => r.body.value), ['Pickup Truck', 'Cargo Van', 'Box Truck']);
  assert.equal(report.filled.length, 3, JSON.stringify(report.failed));
  assert.equal(report.noData.length, 0);
  assert.ok(!report.kept.some((x) => x.differs), 'the VIN the page shows is the intake\'s: kept, no flag');
  assert.deepEqual(rows.map((r) => r.vin.value), [VINS[2], VINS[1], VINS[0]], 'trustPage: the page\'s VIN stays');
  assert.equal(report.blockers.length, 0);
});

test('a VIN the import rejected has no row: that unit stays the agent\'s, named without its VIN; the others fill', async () => {
  const h = harness();
  const rows = vehicleRows(h, [VINS[0], VINS[2]]);
  const plan = witnessPlan();
  // A vehicle whose VIN isn't on the intake either: that is said instead.
  plan.push({ id: 'body3', selector: '[data-id="bodyType"]', path: 'amwins.q3', kind: 'text', value: 'Van', name: 'Body type', witness: { selector: '[data-id="vin"]', path: 'vehicles[3].vin', value: null } });
  const report = await h.kit.fill(plan, { maxRounds: 8 });
  assert.deepEqual(rows.map((r) => r.body.value), ['Box Truck', 'Pickup Truck']);
  assert.deepEqual(Array.from(report.noData, (x) => `${x.label}: ${x.note}`), [
    'Vehicle 2: the row for vehicle 2 (its VIN) wasn\'t found; check the rows and answer its questions yourself.',
    'Vehicle 4: the intake has no VIN for vehicle 4; check the rows and answer its questions yourself.',
  ], 'one note per unit, no VIN in it');
  assert.ok(!JSON.stringify(report.noData).includes(VINS[1]));
  assert.ok(report.blockers.some((b) => /needs you: Vehicle 2/.test(b)), report.blockers.join(' | '));
  assert.equal(report.failed.length, 0);
});

test('two rows with one VIN, or rows without VINs (before the import), give that unit no row', async () => {
  let h = harness();
  let rows = vehicleRows(h, [VINS[0], VINS[1], VINS[1]]);
  let report = await h.kit.fill(witnessPlan(VINS.slice(0, 2)), { maxRounds: 6 });
  assert.deepEqual(rows.map((r) => r.body.value), ['Box Truck', '', '']);
  assert.deepEqual(Array.from(report.noData, (x) => x.label), ['Vehicle 2']);
  // Rows not yet imported show no VIN: nothing is typed into any of them.
  h = harness();
  rows = vehicleRows(h, ['', '', '']);
  report = await h.kit.fill(witnessPlan(), { maxRounds: 6 });
  assert.deepEqual(rows.map((r) => r.body.value), ['', '', '']);
  assert.deepEqual(Array.from(report.noData, (x) => x.label), ['Vehicle 1', 'Vehicle 2', 'Vehicle 3']);
  // Without rows on the page (another step of the application) nothing is said.
  h = harness();
  report = await h.kit.fill(witnessPlan(), { maxRounds: 3 });
  assert.equal(report.noData.length, 0);
});

test('a row showing a VIN the intake doesn\'t have: left as it is, one check naming its place, Continue held', async () => {
  const h = harness();
  const extra = '1FTBR3X87MKA00099';
  const rows = vehicleRows(h, [VINS[0], VINS[1], VINS[2], extra]);
  const report = await h.kit.fill(witnessPlan(), { maxRounds: 8 });
  assert.deepEqual(rows.map((r) => r.body.value), ['Box Truck', 'Cargo Van', 'Pickup Truck', ''], 'the extra row is never answered');
  assert.equal(rows[3].vin.value, extra, 'nor changed');
  assert.equal(report.unknown.length, 0, 'its questions are known ones, not unfamiliar');
  assert.equal(report.noData.length, 0);
  assert.deepEqual(Array.from(report.checks, (x) => x.label), ['Vehicle row 4 on the page']);
  assert.ok(!JSON.stringify(report.checks).includes('00099'), 'no client value in the check');
  assert.ok(report.blockers.includes('check: Vehicle row 4 on the page'), report.blockers.join(' | '));
  // A blank row next to the imported ones (not imported yet) is no vehicle: nothing to check.
  const h2 = harness();
  vehicleRows(h2, [VINS[0], VINS[1], VINS[2], '']);
  const plain = await h2.kit.fill(witnessPlan(), { maxRounds: 8 });
  assert.equal(plain.checks.length, 0);
  assert.equal(plain.blockers.length, 0, plain.blockers.join(' | '));
});

test('extra-row acknowledgement survives redraw and reorder, holds Continue until confirmed', async () => {
  const h = harness();
  const extra = '1FTBR3X87MKA00099';
  const rows = vehicleRows(h, [...VINS, extra]);
  const next = addButton(h, 'Continue');
  let advances = 0;
  next.onclick = () => advances++;
  const options = { maxRounds: 8, advance: { text: '^Continue$' } };
  const held = await h.kit.fill(witnessPlan(), options);
  const key = held.checks[0].key;
  assert.ok(key, 'the check must expose a dismissible acknowledgement key');
  assert.ok(!key.includes(extra), 'the key contains no VIN');
  assert.equal(advances, 0);
  rows[0].row.parentElement.remove();
  const redrawn = vehicleRows(h, [extra, VINS[2], VINS[0], VINS[1]]);
  const heldAgain = await h.kit.fill(witnessPlan(), options);
  assert.equal(heldAgain.checks[0].key, key, 'same vehicle, new DOM and position');
  assert.equal(advances, 0);
  const accepted = await h.kit.fill(witnessPlan(), { ...options, skip: [key] });
  assert.equal(accepted.checks.length, 0);
  assert.equal(accepted.blockers.length, 0, accepted.blockers.join(' | '));
  assert.equal(advances, 1);
  assert.equal(redrawn[0].vin.value, extra);
  assert.equal(redrawn[0].body.value, '', 'acknowledgement does not answer the extra vehicle');
  redrawn[0].vin.value = '1FTBR3X87MKA00098';
  const replaced = await h.kit.fill(witnessPlan(), { ...options, skip: [key] });
  assert.equal(replaced.checks.length, 1);
  assert.notEqual(replaced.checks[0].key, key, 'a replacement vehicle needs its own decision');
  assert.equal(advances, 1);
});

test('extra-row acknowledgement is separate for duplicates and expires in a new document', async () => {
  const extra = '1FTBR3X87MKA00099';
  const h = harness();
  const rows = vehicleRows(h, [...VINS, extra]);
  const first = await h.kit.fill(witnessPlan(), { maxRounds: 8 });
  const key = first.checks[0].key;
  assert.ok(key);
  rows[0].row.parentElement.remove();
  vehicleRows(h, [...VINS, extra, extra]);
  const duplicates = await h.kit.fill(witnessPlan(), { maxRounds: 8, skip: [key] });
  assert.equal(duplicates.checks.length, 2, 'a duplicate invalidates the earlier single-row decision');
  const keys = Array.from(duplicates.checks, x => x.key);
  assert.equal(new Set(keys).size, 2, 'each extra row has its own acknowledgement');
  const partial = await h.kit.fill(witnessPlan(), { maxRounds: 8, skip: [keys[0]] });
  assert.equal(partial.checks.length, 1);
  assert.equal(partial.checks[0].key, keys[1]);
  const accepted = await h.kit.fill(witnessPlan(), { maxRounds: 8, skip: keys });
  assert.equal(accepted.checks.length, 0);
  const fresh = harness();
  vehicleRows(fresh, [...VINS, extra, extra]);
  const newDocument = await fresh.kit.fill(witnessPlan(), { maxRounds: 8, skip: keys });
  assert.equal(newDocument.checks.length, 2, 'old quote acknowledgements never apply in another document');
  assert.ok(newDocument.checks.every(x => !keys.includes(x.key)));
});

test('extra-row acknowledgement expires after removal even if the same VIN returns', async () => {
  const extra = '1FTBR3X87MKA00099';
  const h = harness();
  const rows = vehicleRows(h, [...VINS, extra]);
  const first = await h.kit.fill(witnessPlan(), { maxRounds: 8 });
  const skip = [first.checks[0].key];
  rows[3].row.remove();
  const removed = await h.kit.fill(witnessPlan(), { maxRounds: 8, skip });
  assert.equal(removed.checks.length, 0);
  rows[0].row.parentElement.append(rows[3].row);
  const returned = await h.kit.fill(witnessPlan(), { maxRounds: 8, skip });
  assert.equal(returned.checks.length, 1, 'returning vehicle requires a new decision');
  assert.notEqual(returned.checks[0].key, skip[0]);
});

test('duplicate extra-row acknowledgement follows its DOM row and redraw needs fresh confirmation', async () => {
  const extra = '1FTBR3X87MKA00099';
  const h = harness();
  const rows = vehicleRows(h, [...VINS, extra, extra]);
  const first = await h.kit.fill(witnessPlan(), { maxRounds: 8 });
  const skip = [first.checks[0].key];
  const otherKey = first.checks[1].key;
  const panel = rows[0].row.parentElement;
  rows[3].row.remove();
  panel.append(rows[3].row);
  const reordered = await h.kit.fill(witnessPlan(), { maxRounds: 8, skip });
  assert.equal(reordered.checks.length, 1);
  assert.equal(reordered.checks[0].label, 'Vehicle row 4 on the page', 'the unreviewed row is still blocked');
  assert.equal(reordered.checks[0].key, otherKey);
  panel.remove();
  vehicleRows(h, [...VINS, extra, extra]);
  const redrawn = await h.kit.fill(witnessPlan(), { maxRounds: 8, skip: [...skip, otherKey] });
  assert.equal(redrawn.checks.length, 2, 'same-VIN duplicates cannot be identified across DOM replacement');
});

// A helper verified by what it shows: `revealed` (a question appeared or an answer changed since
// the click) and `{ appears }` (more of a selector than before). Nothing shown: unclicked and
// tried again, twice; then the agent is told to do it.
const revealAction = (verify) => ({ id: 'look', kind: 'action', action: 'lookupVin:0', baseAction: 'lookupVin', path: 'action.lookupVin', name: 'Click lookupVin', text: '^look ?up( vin)?$', pages: [], after: [], afterActions: [], afterPages: [], unless: [], immediate: true, verify });

test('verify revealed: a question appearing or an answer changing counts; a redraw of the same page does not', async () => {
  let h = harness();
  let vin = makeInput({ id: 'vin', ariaLabel: 'VIN', value: VINS[0] });
  h.document.body.append(vin);
  let button = addButton(h, 'Lookup VIN');
  button.onclick = () => { button._clicks = (button._clicks ?? 0) + 1; h.document.body.append(makeInput({ id: 'year', ariaLabel: 'Year', value: '2022' })); };
  let report = await h.kit.fill([revealAction('revealed')], { maxRounds: 4 });
  assert.deepEqual(Array.from(report.actions, (a) => a.id), ['lookupVin:0']);
  assert.equal(button._clicks, 1);
  assert.equal(report.blockers.length, 0);
  // A changed answer (the decoded weight) counts too.
  h = harness();
  const weight = makeInput({ id: 'gvw', ariaLabel: 'Gross vehicle weight', value: '' });
  h.document.body.append(weight);
  button = addButton(h, 'Lookup VIN');
  button.onclick = () => { weight.value = '14500'; };
  report = await h.kit.fill([revealAction('revealed')], { maxRounds: 4 });
  assert.deepEqual(Array.from(report.actions, (a) => a.id), ['lookupVin:0']);
  // The same questions redrawn with the same answers: no result. Three clicks, then the agent's,
  // and the page's other questions still fill around it.
  h = harness();
  vin = makeInput({ id: 'vin', ariaLabel: 'VIN', value: VINS[0] });
  const zip = makeInput({ id: 'zip', ariaLabel: 'Zip code where the vehicle is located' });
  h.document.body.append(vin, zip);
  button = addButton(h, 'Lookup VIN');
  button.onclick = () => {
    button._clicks = (button._clicks ?? 0) + 1;
    const fresh = makeInput({ id: 'vin', ariaLabel: 'VIN', value: vin.value });
    h.document.body.replaceChild(fresh, vin);
    vin = fresh;
  };
  report = await h.kit.fill([revealAction('revealed'), { id: 'zip', selector: '#zip', path: 'garaging.zip', kind: 'text', value: '21000', name: 'ZIP' }], { maxRounds: 8 });
  assert.equal(button._clicks, 3, 'clicked, and tried twice more');
  assert.equal(report.actions.length, 0);
  assert.equal(zip.value, '21000', 'the rest of the page fills around the helper left to the agent');
  assert.equal(report.filled.length, 1);
  assert.ok(report.blockers.includes('button: lookupVin:0'), report.blockers.join(' | '));
  assert.deepEqual(Array.from(report.noData, (x) => [x.label, x.note]), [['lookupVin', 'Clicked three times, but the page never showed its result: do it yourself, then fill again.']]);
  assert.ok(report.invalidatedActions.includes('lookupVin:0'));
});

// A lookup the agent ran before Fill (Codex on PR #66): its result already shows for the VIN on
// the page, so it is done without a click; a click alone never counts.
const shownPlan = (vin) => [
  { id: 'vin', selector: '#vin', path: 'vehicles[0].vin', kind: 'text', value: vin, name: 'VIN' },
  { id: 'year', selector: '#year', path: 'vehicles[0].year', kind: 'text', value: '2022', name: 'Year', verifyOnly: true },
  { id: 'make', selector: '#make', path: 'vehicles[0].make', kind: 'text', value: 'Freightliner', name: 'Make', verifyOnly: true },
  { id: 'model', selector: '#model', path: 'vehicles[0].model', kind: 'text', value: 'Cascadia', name: 'Model', verifyOnly: true },
  { ...revealAction('revealed'), after: ['vehicles[0].vin'], shownBy: { all: ['vehicles[0].year', 'vehicles[0].make', 'vehicles[0].model'], any: [], answered: true } },
];
const decodedPage = (h, { vin = VINS[0], year = '2022', make = 'FREIGHTLINER', model = 'CASCADIA', yearAttrs = {} } = {}) => {
  const els = {
    vin: makeInput({ id: 'vin', ariaLabel: 'VIN', value: vin }),
    year: makeInput({ id: 'year', ariaLabel: 'Year', value: year, attrs: yearAttrs }),
    make: makeInput({ id: 'make', ariaLabel: 'Make', value: make }),
    model: makeInput({ id: 'model', ariaLabel: 'Model', value: model }),
  };
  h.document.body.append(els.vin, els.year, els.make, els.model);
  return els;
};

test('verify revealed: a lookup already shown for the VIN on the page is done without a click', async () => {
  const h = harness();
  decodedPage(h);
  const button = addButton(h, 'Lookup VIN');
  button.onclick = () => { button._clicks = (button._clicks ?? 0) + 1; };
  const report = await h.kit.fill(shownPlan(VINS[0]), { maxRounds: 8 });
  assert.equal(button._clicks ?? 0, 0, 'not clicked again');
  assert.deepEqual(Array.from(report.actions, (a) => [a.id, a.alreadyShown]), [['lookupVin:0', true]]);
  assert.equal(report.blockers.length, 0, report.blockers.join(' | '));
  assert.equal(report.noData.length, 0);
});

// A verified result doesn't require the helper's button to remain clickable afterwards.
for (const buttonState of ['absent', 'disabled']) {
  test(`verify revealed: an already-shown lookup with its button ${buttonState} records completion before Continue`, async () => {
    const h = harness();
    decodedPage(h);
    if (buttonState === 'disabled') {
      const lookup = addButton(h, 'Lookup VIN');
      lookup.disabled = true;
      lookup.onclick = () => { throw new Error('a disabled lookup must never be clicked'); };
    }
    const next = addButton(h, 'Continue');
    next.onclick = () => { next._clicks = (next._clicks ?? 0) + 1; };
    const report = await h.kit.fill(shownPlan(VINS[0]), { maxRounds: 8, advance: { text: '^Continue$' } });
    assert.deepEqual(Array.from(report.actions, (a) => [a.id, a.alreadyShown]), [['lookupVin:0', true]], 'kept for the origin unit and later helper prerequisites');
    assert.equal(report.blockers.length, 0, report.blockers.join(' | '));
    assert.equal(report.advanced, 'Continue');
    assert.equal(next._clicks, 1);
  });
}

test('verify revealed: an absent lookup with a shown result still waits for its prerequisites', async () => {
  const h = harness();
  decodedPage(h);
  const plan = shownPlan(VINS[0]);
  plan.at(-1).afterActions = ['required-helper'];
  const next = addButton(h, 'Continue');
  next.onclick = () => { throw new Error('Continue must wait for the prerequisite'); };
  const report = await h.kit.fill(plan, { maxRounds: 8, advance: { text: '^Continue$' } });
  assert.equal(report.actions.length, 0);
  assert.ok(report.blockers.some((b) => /required-helper clicked/.test(b)), report.blockers.join(' | '));
  // The same wait, by kind (what tells a lookup the page did itself at the end of the fill).
  assert.ok(report.blocked.some((b) => JSON.stringify(b.waits) === JSON.stringify([{ action: 'required-helper' }])), JSON.stringify(report.blocked));
  assert.equal(report.advanced, undefined);
});

test('verify revealed: an already-shown decode that is not the intake vehicle is named for the agent', async () => {
  // The agent looked up another VIN, then typed this one without looking it up again: the lookup
  // counts as shown, but the decoded make that isn't the intake's is flagged for the agent.
  const h = harness();
  decodedPage(h, { make: 'VOLVO' });
  addButton(h, 'Lookup VIN');
  const report = await h.kit.fill(shownPlan(VINS[0]), { maxRounds: 8 });
  assert.deepEqual(Array.from(report.actions, (a) => a.id), ['lookupVin:0']);
  assert.deepEqual(Array.from(report.failed, (x) => [x.label, x.reason]), [['Make', 'The looked-up value differs from the intake. Check the VIN.']]);
});

test('verify revealed: a decoded vehicle that is not this VIN\'s, or not decoded yet, is still clicked', async () => {
  // The fill typed the VIN (the box was empty): the year/make/model already on the page are no
  // result for it. The click that redraws them unchanged is no result either.
  let h = harness();
  let els = decodedPage(h, { vin: '' });
  let button = addButton(h, 'Lookup VIN');
  button.onclick = () => { button._clicks = (button._clicks ?? 0) + 1; els.year.value = els.year.value; };
  let report = await h.kit.fill(shownPlan(VINS[0]), { maxRounds: 8 });
  assert.equal(els.vin.value, VINS[0]);
  assert.equal(button._clicks, 3, 'clicked, and tried twice more');
  assert.equal(report.actions.length, 0);
  assert.ok(report.blockers.some((b) => b.startsWith('button: lookupVin:0')), report.blockers.join(' | '));
  assert.deepEqual(Array.from(report.noData, (x) => x.label), ['lookupVin']);
  // Model not decoded yet: clicked, and the decoded model is its result.
  h = harness();
  els = decodedPage(h, { model: '' });
  button = addButton(h, 'Lookup VIN');
  button.onclick = () => { button._clicks = (button._clicks ?? 0) + 1; els.model.value = 'CASCADIA'; };
  report = await h.kit.fill(shownPlan(VINS[0]), { maxRounds: 8 });
  assert.equal(button._clicks, 1);
  assert.deepEqual(Array.from(report.actions, (a) => [a.id, !!a.alreadyShown]), [['lookupVin:0', false]]);
  assert.equal(report.blockers.length, 0, report.blockers.join(' | '));
});

test('verify revealed: a USDOT already verified for the number on the page is done without a click', async () => {
  const dotPlan = [
    { id: 'dot', selector: '#dot', path: 'applicant.dot', kind: 'text', value: '1234567', name: 'USDOT' },
    { id: 'belongs', selector: '#belongs', path: 'progressive.q20F', kind: 'text', value: null, name: 'USDOT belongs to the business' },
    { ...revealAction('revealed'), action: 'verifyDot', baseAction: 'verifyDot', path: 'action.verifyDot', text: '^verify( us)?( ?dot)?( number)?$', after: ['applicant.dot'], shownBy: { all: [], any: ['progressive.q20F'], answered: false } },
  ];
  // The record's question shows: done, unclicked.
  let h = harness();
  h.document.body.append(makeInput({ id: 'dot', ariaLabel: 'USDOT number', value: '1234567' }), makeInput({ id: 'belongs', ariaLabel: 'Does this USDOT Number belong to the business?' }));
  let button = addButton(h, 'Verify');
  button.onclick = () => { button._clicks = (button._clicks ?? 0) + 1; };
  let report = await h.kit.fill(dotPlan, { maxRounds: 8 });
  assert.equal(button._clicks ?? 0, 0);
  assert.deepEqual(Array.from(report.actions, (a) => [a.id, a.alreadyShown]), [['verifyDot', true]]);
  // No record question yet: clicked, and the question it shows is its result.
  h = harness();
  h.document.body.append(makeInput({ id: 'dot', ariaLabel: 'USDOT number', value: '1234567' }));
  button = addButton(h, 'Verify');
  button.onclick = () => { button._clicks = (button._clicks ?? 0) + 1; h.document.body.append(makeInput({ id: 'belongs', ariaLabel: 'Does this USDOT Number belong to the business?' })); };
  report = await h.kit.fill(dotPlan, { maxRounds: 8 });
  assert.equal(button._clicks, 1);
  assert.deepEqual(Array.from(report.actions, (a) => [a.id, !!a.alreadyShown]), [['verifyDot', false]]);
});

test('verify revealed: a click that redraws the result unchanged counts when it shows for this VIN', async () => {
  // Before the click the year showed a stale error (not a result yet); the redraw clears it and
  // shows the same decoded vehicle.
  const h = harness();
  const els = decodedPage(h, { yearAttrs: { 'aria-invalid': 'true' } });
  const button = addButton(h, 'Lookup VIN');
  button.onclick = () => {
    button._clicks = (button._clicks ?? 0) + 1;
    const fresh = makeInput({ id: 'year', ariaLabel: 'Year', value: els.year.value });
    h.document.body.replaceChild(fresh, els.year);
    els.year = fresh;
  };
  const report = await h.kit.fill(shownPlan(VINS[0]), { maxRounds: 8 });
  assert.equal(button._clicks, 1, 'clicked once, and its result accepted');
  assert.deepEqual(Array.from(report.actions, (a) => [a.id, !!a.alreadyShown]), [['lookupVin:0', false]]);
  assert.ok(!report.blockers.includes('button: lookupVin:0'), report.blockers.join(' | '));
});

test('verify { appears }: more matching elements than before the click, or any when there were none', async () => {
  let h = harness();
  let button = addButton(h, 'Lookup VIN');
  button.onclick = () => h.document.body.append(makeInput({ id: 'year', ariaLabel: 'Year', value: '2022', attrs: { 'data-id': 'decoded' } }));
  let report = await h.kit.fill([revealAction({ appears: '[data-id="decoded"]' })], { maxRounds: 4 });
  assert.deepEqual(Array.from(report.actions, (a) => a.id), ['lookupVin:0']);
  h = harness();
  h.document.body.append(makeInput({ id: 'row0', ariaLabel: 'Row', attrs: { 'data-id': 'decoded' } }));
  button = addButton(h, 'Lookup VIN');
  button.onclick = () => { button._clicks = (button._clicks ?? 0) + 1; };
  report = await h.kit.fill([revealAction({ appears: '[data-id="decoded"]' })], { maxRounds: 8 });
  assert.equal(button._clicks, 3);
  assert.equal(report.actions.length, 0);
  assert.ok(report.blockers.includes('button: lookupVin:0'));
  assert.equal(report.noData.length, 1);
});


test('the real USDOT plan recognizes an already shown no-record result', async () => {
  const h = harness({ search: '?pageName=BusinessOwnerInfo' });
  h.document.body.append(makeInput({ id: 'dot', ariaLabel: "USDOT Number associated with the customer's business:", value: '1234567', attrs: { fieldref: 'USDOTInput.NumberCollection' } }));
  const question = 'Did the customer obtain their USDOT Number within the last 60 days?';
  const yes = makeInput({ name: 'sixtyDay', type: 'radio', value: 'Yes', checked: true, attrs: { fieldref: 'USDOTInput.SixtyDayQuestion' } });
  const no = makeInput({ name: 'sixtyDay', type: 'radio', value: 'No', attrs: { fieldref: 'USDOTInput.SixtyDayQuestion' } });
  h.document.body.append(radioGroup(question, yes, no));
  const button = addButton(h, 'Verify DOT');
  let clicks = 0;
  button.onclick = () => clicks++;
  const record = { applicant: { dot: '1234567' }, garaging: {}, operations: {}, drivers: [], vehicles: [], priorInsurance: [], coverage: {}, claims: {} };
  const plan = buildPlan(record, progressive).filter((s) => s.path === 'applicant.dot' || s.q === '21E' || s.action === 'verifyDot');
  assert.equal(plan.length, 3, 'the real plan supplies DOT, its no-record result and helper');
  const report = await h.kit.fill(plan, { maxRounds: 8 });
  assert.equal(clicks, 0, 'matching DOT with an already visible result needs no retry');
  assert.deepEqual(Array.from(report.actions, (a) => [a.id, a.alreadyShown]), [['verifyDot', true]]);
  assert.ok(!report.blockers.some((b) => b.startsWith('button: verifyDot')), 'the completed lookup creates no helper blocker');
  // TNI 2026-10-19: the 60-day answer is its standard Yes, already chosen here.
  assert.equal(report.noData.length, 0, 'the 60-day question has TNI\'s standard answer');
});

test('extra-row acknowledgement survives an unrelated step with no visible witnesses', async () => {
  const h = harness({ pathname: '/application/businessauto' });
  const rows = vehicleRows(h, [...VINS, '1FTBR3X87MKA00099']);
  const elsewhere = makeInput({ id: 'otherStep', ariaLabel: 'Other step answer' });
  elsewhere._visible = false;
  h.document.body.append(elsewhere);
  const plan = [...witnessPlan(), { id: 'other', selector: '#otherStep', path: 'workflow.other', kind: 'text', value: 'done' }];
  const first = await h.kit.fill(plan, { maxRounds: 8 });
  const skip = [first.checks[0].key];
  assert.equal((await h.kit.fill(plan, { maxRounds: 8, skip })).checks.length, 0);
  for (const row of rows) { row.vin._visible = false; row.body._visible = false; }
  elsewhere._visible = true;
  const otherStep = await h.kit.fill(plan, { maxRounds: 8, skip });
  assert.equal(otherStep.checks.length, 0);
  assert.equal(elsewhere.value, 'done');
  for (const row of rows) { row.vin._visible = true; row.body._visible = true; }
  elsewhere._visible = false;
  const returned = await h.kit.fill(plan, { maxRounds: 8, skip });
  assert.equal(returned.checks.length, 0, 'the unchanged extra vehicle remains acknowledged');
  assert.equal(returned.blockers.length, 0, returned.blockers.join(' | '));
  const held = await h.kit.fill(plan, { maxRounds: 8 });
  assert.equal(held.checks[0].key, skip[0], 'the opaque key survives the step change');
});

test('one intake vehicle value targets its VIN behind an extra quote row with the real AmWINS plan', async () => {
  const h = harness({ pathname: '/application/businessauto' });
  const extra = '1FTBR3X87MKA00099';
  const rows = vehicleRows(h, [extra, VINS[0]]);
  const values = rows.map(({ row }, i) => {
    const value = makeInput({ id: i === 0 ? 'marketValue' : 'costNew1', ariaLabel: 'Vehicle value', attrs: { 'data-id': 'costNew' } });
    // This small DOM replay handles simple selectors. Support the real descendant selector
    // here so the expanded carrier plan is exercised unchanged, including its first-row id.
    value.matches = (selector) => selector === '#vehiclesPanel [data-id="costNew"]' || matchesSelector(value, selector);
    row.children[0].append(value);
    return value;
  });
  const record = { applicant: {}, garaging: {}, operations: {}, drivers: [], vehicles: [{ vin: VINS[0], value: 45000 }], priorInsurance: [], coverage: {}, claims: {} };
  const plan = buildPlan(record, amwins).filter((s) => s.path === 'vehicles[0].value' && s.witness);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].witness.value, VINS[0]);
  const report = await h.kit.fill(plan, { maxRounds: 8 });
  assert.equal(values[1].value, '45000', 'the matching later vehicle gets its value');
  assert.equal(values[0].value, '', 'the unmatched first row is untouched');
  assert.equal(rows[0].vin.value, extra);
  assert.equal(report.noData.length, 0, 'the vehicle row was found');
  assert.equal(report.checks.length, 1, 'the extra vehicle still requires review');
});

// Answer provenance (plan.js `source`): a standard answer is reported as such, so the panel can tag
// it; in review mode (a business class the rules weren't written for) it is a check item that holds
// Continue, and an intake answer is neither.
test('the fill report says which answers are TNI standards; review mode makes them check items', async () => {
  const fillBoth = async (businessClass) => {
    const h = harness({ search: '?pageName=AddDriver' });
    const yesNo = (ref, question) => radioGroup(question, ...['Yes', 'No'].map((value) => makeInput({ name: `r_${ref}`, type: 'radio', value, attrs: { fieldref: ref } })));
    h.document.body.append(yesNo('DriverInput.AnyAccidentsViolationsPastExpYears', 'Has this driver had any accidents, claims or violations in the past 3 years?'), yesNo('DriverInput.DefensiveDriverDiscount', 'Defensive Driver Discount'));
    const record = { applicant: {}, garaging: {}, operations: { businessClass }, drivers: [{ first: 'Test', last: 'Driver' }], vehicles: [], trailers: [], priorInsurance: [], coverage: {}, claims: { hasClaims: false } };
    const plan = buildPlan(record, progressive).filter((s) => ['28F5', '299D'].includes(s.q));
    const report = await h.kit.fill(plan, { maxRounds: 4, replaceChoices: true });
    // Report items carry the control's own q (none on these synthetic controls): name them by step.
    const qOf = (x) => plan.find((s) => s.id === x.stepId)?.q;
    for (const x of [...report.filled, ...report.checks]) x.q = qOf(x);
    return report;
  };
  const ok = await fillBoth('Expediter');
  assert.deepEqual([...ok.filled].map((x) => [x.q, x.standard]).sort(), [['28F5', false], ['299D', true]]);
  assert.equal(ok.checks.length, 0);
  const review = await fillBoth('Dump Truck');
  assert.deepEqual([...review.filled].map((x) => [x.q, x.standard]).sort(), [['28F5', false], ['299D', true]], 'still filled');
  assert.deepEqual([...review.checks].map((x) => x.q), ['299D'], 'the standard is a check item; the intake answer is not');
  assert.match(review.checks[0].note, /^Review mode: the business class "Dump Truck" isn't validated for Progressive; confirm this standard answer\.$/);
  assert.ok(review.blockers.some((b) => /^check: /.test(b)), 'Continue waits');
});

// SC live run (2026-10-19): the claims box answered neither Yes nor No and Progressive had No
// selected for every driver; each driver's question went to the agent and to Luna. TNI's standard
// No now keeps the page's No (an automatic fill doesn't replace answers) with nothing left to the
// agent; notes that mention a ticket still leave it to the agent.
test('a blank claims answer is TNI\'s standard No: the page\'s No is kept, not a needs-you item', async () => {
  const fillClaims = async (claims) => {
    const h = harness({ search: '?pageName=AddDriver' });
    const no = makeInput({ name: 'r_claims', type: 'radio', value: 'No', attrs: { fieldref: 'DriverInput.AnyAccidentsViolationsPastExpYears' } });
    no.checked = true;
    h.document.body.append(radioGroup('Has this driver had any accidents, claims or violations in the past 5 years? (since 11/2021)',
      makeInput({ name: 'r_claims', type: 'radio', value: 'Yes', attrs: { fieldref: 'DriverInput.AnyAccidentsViolationsPastExpYears' } }), no));
    const record = { applicant: {}, garaging: {}, operations: { businessClass: 'Expediter' }, drivers: [{ first: 'Test', last: 'Driver' }], vehicles: [], trailers: [], priorInsurance: [], coverage: {}, claims };
    return h.kit.fill(buildPlan(record, progressive).filter((s) => s.q === '28F5'), { maxRounds: 4 });
  };
  const standard = await fillClaims({ hasClaims: null, notes: 'Financed' });
  assert.deepEqual([standard.noData.length, standard.kept.length, standard.kept[0]?.standard], [0, 1, true]);
  assert.ok(!standard.blockers.some((b) => /^needs you/.test(b)), 'nothing for the agent (or Luna)');
  const mentioned = await fillClaims({ hasClaims: null, notes: 'One speeding ticket in 2024' });
  assert.equal(mentioned.noData.length, 1, 'a ticket in the notes: the agent\'s');
  assert.match(mentioned.noData[0].note, /speeding ticket/);
});

// Codex on c31942e: a fact the intake doesn't give reaches the report as the agent's (manualOnly),
// so the AI assistant leaves it (ai/common.js collectItems).
test('AmWINS review mode confirms differing retained standard choices before Continue', async () => {
  const run = async (businessClass) => {
    const h = harness({ pathname: '/application/businessauto' });
    const nonprofit = radioGroup('Is non profit', ...['Yes', 'No'].map((value) => makeInput({ name: 'isNonProfit', type: 'radio', value, checked: value === 'Yes' })));
    const waiver = new SelectNode(['', 'NONE', 'BROAD'], { id: 'waiverType', ariaLabel: 'Waiver type', value: 'BROAD' });
    h.document.body.append(nonprofit, waiver);
    const next = addButton(h, 'Save & Continue');
    next.onclick = () => { next._clicked = true; };
    const record = { applicant: {}, garaging: {}, operations: { businessClass }, drivers: [], vehicles: [], trailers: [], priorInsurance: [], coverage: {}, claims: {} };
    const plan = buildPlan(record, amwins).filter((s) => s.re === '^is non profit$' || s.selector === '#waiverType');
    assert.equal(plan.length, 2, 'the real carrier plan supplies both standard choices');
    const options = { maxRounds: 3, advance: amwins.advance };
    const report = await h.kit.fill(plan, options);
    const retained = () => [nonprofit.children.find((r) => r.checked)?.value, waiver.value];
    assert.deepEqual(retained(), ['Yes', 'BROAD'], 'carrier answers are retained');
    assert.equal(report.filled.length, 0);
    return { h, plan, next, options, report, retained };
  };
  const supported = await run('Expediter');
  assert.equal(supported.report.checks.length, 0, 'supported-class behavior is unchanged');
  assert.ok(supported.next._clicked);
  const review = await run('Dump Truck');
  assert.equal(review.report.checks.length, 2, 'both differing standards need confirmation');
  assert.ok(review.report.checks.every((x) => x.standard && /^Review mode:/.test(x.note) && x.key));
  assert.ok(review.report.blockers.some((b) => /^check:/.test(b)));
  assert.ok(!review.next._clicked, 'Continue waits');
  assert.deepEqual(collectItems([review.report]).items, [], 'confirmation checks are not AI choices');
  const again = await review.h.kit.fill(review.plan, review.options);
  assert.equal(again.checks.length, 2, 'a new fill does not acknowledge them');
  const keys = again.checks.map((x) => x.key);
  const partial = await review.h.kit.fill(review.plan, { ...review.options, skip: [keys[0]] });
  assert.equal(partial.checks.length, 1, 'acknowledging or manually editing one choice protects only it');
  assert.ok(!review.next._clicked);
  await review.h.kit.fill(review.plan, { ...review.options, skip: keys });
  assert.deepEqual(review.retained(), ['Yes', 'BROAD'], 'acknowledgements preserve the retained values');
  assert.ok(review.next._clicked, 'Continue follows explicit acknowledgements');
  const ignored = await run('Dump Truck');
  const ignoredReport = await ignored.h.kit.fill(ignored.plan.map((s) => ({ ...s, ignore: true })), ignored.options);
  assert.equal(ignoredReport.checks.length, 0, 'deliberate ignore rules remain ignored');
  assert.deepEqual(ignored.retained(), ['Yes', 'BROAD']);
});

test('a fact step is reported manualOnly and kept from the AI', async () => {
  const h = harness({ search: '?pageName=MoreAboutBusiness' });
  const yesNo = (ref, question) => radioGroup(question, ...['Yes', 'No'].map((value) => makeInput({ name: `r_${ref}`, type: 'radio', value, attrs: { fieldref: ref } })));
  h.document.body.append(yesNo('MoreBusinessInput.HasContinuousCoverage', 'Has the customer had continuous coverage?'));
  const record = { applicant: {}, garaging: {}, operations: { businessClass: 'Expediter' }, drivers: [], vehicles: [], trailers: [], priorInsurance: [], coverage: {}, claims: {} };
  const plan = buildPlan(record, progressive).filter((s) => s.q === '83');
  assert.equal(plan.length, 1);
  const report = await h.kit.fill(plan, { maxRounds: 2 });
  assert.equal(report.filled.length, 0);
  assert.equal(report.noData.length, 1);
  assert.equal(report.noData[0].manualOnly, true);
  const ai = collectItems([report]);
  assert.deepEqual(ai.items, [], 'never sent to the AI');
  assert.equal(ai.blocked.length, 1);
});

test('an invalid retained client fact stays manual-only across duplicate report rows', async () => {
  const h = harness({ search: '?pageName=MoreAboutBusiness' });
  const question = 'Has the customer had continuous coverage?';
  const yes = makeInput({ name: 'continuous', type: 'radio', value: 'Yes', checked: true,
    attrs: { fieldref: 'MoreBusinessInput.HasContinuousCoverage', 'aria-invalid': 'true' } });
  const no = makeInput({ name: 'continuous', type: 'radio', value: 'No',
    attrs: { fieldref: 'MoreBusinessInput.HasContinuousCoverage' } });
  h.document.body.append(radioGroup(question, yes, no));
  h.document.body.append(new SelectNode(['', 'Yes', 'No'], { id: 'unfamiliar', ariaLabel: 'Synthetic unfamiliar choice' }));
  const record = { applicant: {}, garaging: {}, operations: { businessClass: 'Expediter' }, drivers: [], vehicles: [], trailers: [], priorInsurance: [], coverage: {}, claims: {} };
  const plan = buildPlan(record, progressive).filter((s) => s.q === '83');
  assert.equal(plan.length, 1);
  const report = await h.kit.fill(plan, { maxRounds: 2 });
  assert.equal(report.failed.length, 1, 'the invalid prefill is reported before missing intake data');
  assert.equal(report.noData.length, 1);
  assert.equal(report.failed[0].key, report.noData[0].key);
  assert.equal(report.failed[0].label, report.noData[0].label);
  assert.equal(report.noData[0].manualOnly, true, 'the real carrier plan leaves the fact to the agent');
  assert.equal(yes.checked, true, 'the retained page value is preserved');
  assert.ok(report.blockers.length, 'the agent still must resolve the invalid/missing fact');
  const ai = collectItems([report]);
  assert.deepEqual(ai.items.map((x) => x.label), ['Synthetic unfamiliar choice'], 'only the unrelated choice may reach Luna');
  assert.equal(ai.blocked.length, 1);
  assert.equal(ai.blocked[0].manualOnly, true);
  assert.match(ai.blocked[0].why, /client fact.*agent/);
});

// Codex reproduction (2026-10-08): an agent edit during the wait before Continue halted the fill,
// and Continue was clicked all the same.
test('an agent edit during the wait before Continue stops the Continue and is a blocker', async () => {
  const h = harness({ ext: true, search: '?pageName=Synthetic' });
  const { input } = addExtText(h, 'a', '1234', { ref: 'Test.foo', caption: 'Synthetic question', value: 'wanted' });
  const button = addButton(h, 'Continue');
  let clicks = 0;
  button.onclick = () => { clicks++; };
  // The page settles twice: on arrival, and before Continue. The agent edits during the second.
  let settles = 0;
  h.context.MutationObserver = class {
    constructor() {
      if (++settles === 2) setTimeout(() => {
        input.dispatchEvent({ type: 'pointerdown', target: input, isTrusted: true });
        input.value = 'the agent\'s answer';
        input.dispatchEvent({ type: 'input', target: input, isTrusted: true });
      }, 10);
    }
    observe() {}
    disconnect() {}
  };
  const plan = [{ id: 'field', q: '1234', field: 'Test.foo', path: 'test.answer', name: 'Synthetic question', ask: ['Synthetic question'], kind: 'text', value: 'wanted' }];
  const report = await h.kit.fill(plan, { maxRounds: 3, advance: { text: 'Continue' } });
  assert.equal(settles, 2);
  assert.equal(report.halted, true);
  assert.equal(clicks, 0, 'no Continue after a halt');
  assert.equal(report.advanced, undefined);
  assert.ok(report.blockers.includes(report.reason), `blockers: ${report.blockers.join(' | ')}`);
  assert.deepEqual([...report.protectedKeys], ['ref:Test.foo']);
  assert.equal(input.value, 'the agent\'s answer');
});

// A late server response during the wait before Continue rewrote an answer the fill had given: the
// answer is the agent's to check (no retry), and Continue is not clicked.
test('an answer the carrier rewrites during the wait before Continue fails, and Continue waits', async () => {
  const run = async (rewriteAt) => {
    const h = harness({ ext: true, search: '?pageName=Synthetic' });
    addExtText(h, 'b', '1233', { ref: 'Test.earlier', caption: 'Earlier question', value: 'kept' });
    const { input, cmp } = addExtText(h, 'a', '1234', { ref: 'Test.foo', caption: 'Synthetic question' });
    const button = addButton(h, 'Continue');
    let clicks = 0;
    button.onclick = () => { clicks++; };
    // Every settle builds an observer; the last one is the wait before Continue.
    let settles = 0;
    h.context.MutationObserver = class {
      constructor() { if (++settles === rewriteAt) setTimeout(() => cmp.setValue('carrier value'), 10); }
      observe() {}
      disconnect() {}
    };
    const plan = [
      { id: 'earlier', q: '1233', field: 'Test.earlier', path: 'test.earlier', name: 'Earlier question', ask: ['Earlier question'], kind: 'text', value: 'kept' },
      { id: 'field', q: '1234', field: 'Test.foo', path: 'test.answer', name: 'Synthetic question', ask: ['Synthetic question'], kind: 'text', value: 'wanted' },
    ];
    const report = await h.kit.fill(plan, { maxRounds: 3, advance: { text: 'Continue' } });
    return { report, clicks, settles, input };
  };
  // Nothing changes: the answer stays filled and Continue is clicked.
  const control = await run(0);
  assert.equal(control.clicks, 1);
  assert.equal(control.report.advanced, 'Continue');
  assert.deepEqual(Array.from(control.report.filled, (x) => x.key), ['ref:Test.foo']);
  assert.equal(control.input.value, 'wanted');
  // The carrier rewrites it during that last wait.
  const { report, clicks, settles, input } = await run(control.settles);
  assert.equal(settles, control.settles);
  assert.equal(clicks, 0, 'no Continue over a changed answer');
  assert.equal(report.advanced, undefined);
  assert.equal(report.halted, false);
  assert.equal(input.value, 'carrier value', 'not given again');
  assert.equal(report.filled.length, 0);
  const failed = report.failed.find((x) => x.key === 'ref:Test.foo');
  assert.ok(failed, 'moved to failed');
  assert.equal(failed.reason, 'The carrier changed this answer after it was filled; check it.');
  assert.equal(failed.label, 'Synthetic question');
  assert.equal(failed.order, 1, 'its place on the page, after the earlier question');
  assert.ok(report.blockers.includes('failed: Synthetic question'), `blockers: ${report.blockers.join(' | ')}`);
  assert.equal(input.getAttribute('data-rater-autofill'), 'failed');
});

// Check answers before Continue (the panel's `hold`): a done page is held for the agent; Looks
// right sends the page's receipt as they saw it, and Continue is clicked only while the page still
// matches it. A page changed since is held again, with no click.
test('with hold, Continue waits for the receipt the agent approved, and a changed page is held again', async () => {
  const h = harness({ ext: true, search: '?pageName=Synthetic' });
  addExtText(h, 'a', '1234', { ref: 'Test.foo', caption: 'Synthetic question' });
  // A question the plan has no rule for, already answered on the page (not a blocker).
  const other = addExtText(h, 'b', '1235', { ref: 'Test.other', caption: 'Other question', value: 'carrier' });
  const button = addButton(h, 'Continue');
  let clicks = 0;
  button.onclick = () => { clicks++; };
  const plan = [{ id: 'field', q: '1234', field: 'Test.foo', path: 'test.answer', name: 'Synthetic question', ask: ['Synthetic question'], kind: 'text', value: 'wanted' }];
  const options = { maxRounds: 3, advance: { text: 'Continue' }, hold: true };

  const first = await h.kit.fill(plan, options);
  assert.equal(first.held, 'check', 'done, and waiting for the agent');
  assert.equal(clicks, 0);
  assert.equal(first.advanced, undefined);
  assert.deepEqual(Array.from(first.filled, (x) => x.key), ['ref:Test.foo']);
  assert.ok(!first.blockers.length, 'held is not a blocker: nothing is left for the agent');

  // The agent approved it; the carrier changed an answer before the click.
  const seen = h.kit.receipt();
  assert.match(seen, /^r1-[0-9a-z]+$/);
  assert.equal(h.kit.receipt(), seen, 'the same page, the same receipt');
  other.cmp.setValue('changed by the carrier');
  assert.notEqual(h.kit.receipt(), seen);
  const changed = await h.kit.fill(plan, { ...options, confirmed: seen });
  assert.equal(changed.held, 'changed');
  assert.equal(clicks, 0, 'no Continue for a page the agent did not see');

  // Approved again as it is now: Continue.
  const approved = await h.kit.fill(plan, { ...options, confirmed: h.kit.receipt() });
  assert.equal(approved.held, undefined);
  assert.equal(approved.advanced, 'Continue');
  assert.equal(clicks, 1);
});

// Audit 2026-10-10: a fill also reads collapsed fields it has rules for (`hidden`: AmWINS' prior
// carriers); Looks right's receipt, taken outside a fill, didn't. The receipt is the page as the
// agent sees it either way, so Looks right can continue such a page.
test('the receipt is the same inside a fill and out when a hidden rule\'s field is collapsed', async () => {
  const h = harness({ ext: true, search: '?pageName=Synthetic' });
  addExtText(h, 'a', '1234', { ref: 'Test.foo', caption: 'Synthetic question' });
  const prior = makeInput({ id: 'prior', ariaLabel: 'Prior carrier', value: 'NO PRIOR' });
  prior._visible = false;
  h.document.body.append(prior);
  const button = addButton(h, 'Continue');
  let clicks = 0;
  button.onclick = () => { clicks++; };
  const plan = [
    { id: 'field', q: '1234', field: 'Test.foo', path: 'test.answer', name: 'Synthetic question', ask: ['Synthetic question'], kind: 'text', value: 'wanted' },
    { id: 'prior', selector: '#prior', hidden: true, kind: 'text', value: 'NO PRIOR', name: 'Prior carrier', standard: true, source: 'standard' },
  ];
  const options = { maxRounds: 3, advance: { text: 'Continue' }, hold: true };
  assert.equal((await h.kit.fill(plan, options)).held, 'check');
  const approved = await h.kit.fill(plan, { ...options, confirmed: h.kit.receipt() });
  assert.equal(approved.held, undefined);
  assert.equal(clicks, 1);
});

// Audit 2026-10-10: Stop pressed while the panel still prepared (before fill() began here) was
// lost, and the fill ran to the end and could click Continue. Stop with the fill's run id is kept
// until that fill starts, which then halts at once; another fill isn't affected.
test('a Stop for a fill that hasn\'t begun here halts it as it starts', async () => {
  const h = harness({ ext: true, search: '?pageName=Synthetic' });
  const { input } = addExtText(h, 'a', '1234', { ref: 'Test.foo', caption: 'Synthetic question' });
  const button = addButton(h, 'Continue');
  let clicks = 0;
  button.onclick = () => { clicks++; };
  const plan = [{ id: 'field', q: '1234', field: 'Test.foo', path: 'test.answer', name: 'Synthetic question', ask: ['Synthetic question'], kind: 'text', value: 'wanted' }];
  assert.equal(h.kit.stop('run-1'), false, 'no fill running here yet');
  const stopped = await h.kit.fill(plan, { maxRounds: 3, advance: { text: 'Continue' }, run: 'run-1' });
  assert.equal(stopped.halted, true);
  assert.equal(stopped.reason, 'You stopped the fill. Nothing more was filled or clicked.');
  assert.equal(clicks, 0);
  assert.equal(input.value, '', 'nothing filled');
  const next = await h.kit.fill(plan, { maxRounds: 3, advance: { text: 'Continue' }, run: 'run-2' });
  assert.equal(next.halted, false);
  assert.equal(next.advanced, 'Continue');
  assert.equal(input.value, 'wanted');
});

test('without hold, a done page continues as before; receipt reads only', async () => {
  const h = harness({ ext: true, search: '?pageName=Synthetic' });
  const { input } = addExtText(h, 'a', '1234', { ref: 'Test.foo', caption: 'Synthetic question' });
  const button = addButton(h, 'Continue');
  let clicks = 0;
  button.onclick = () => { clicks++; };
  const plan = [{ id: 'field', q: '1234', field: 'Test.foo', path: 'test.answer', name: 'Synthetic question', ask: ['Synthetic question'], kind: 'text', value: 'wanted' }];
  const before = input.value;
  h.kit.receipt();
  assert.equal(input.value, before, 'receipt changes nothing');
  assert.equal(input.getAttribute('data-rater-autofill'), null);
  const report = await h.kit.fill(plan, { maxRounds: 3, advance: { text: 'Continue' } });
  assert.equal(report.held, undefined);
  assert.equal(report.advanced, 'Continue');
  assert.equal(clicks, 1);
});

test('an agent edit while AI answers go in protects that question and stops the remaining answers', async () => {
  const h = harness();
  const pick = (id, label, options) => new SelectNode([{ text: 'Select one', value: '' }, ...options], { id, ariaLabel: label });
  const commodity = pick('commodity', 'Commodity category', [{ text: 'Consumer Goods', value: 'cg' }, { text: 'Building Materials', value: 'bm' }]);
  const radius = pick('radius', 'Radius', [{ text: 'Local', value: 'l' }, { text: 'Long haul', value: 'lh' }]);
  const notes = makeInput({ id: 'notes', ariaLabel: 'Notes' });
  h.document.body.append(commodity, radius, notes);
  const report = await h.kit.fill([], { maxRounds: 1 });
  const key = (label) => report.unknown.find((x) => x.label === label).key;
  // While the first answer goes in, the agent picks the radius themselves.
  commodity.addEventListener('change', () => {
    if (radius.value) return;
    radius.dispatchEvent({ type: 'pointerdown', target: radius, isTrusted: true });
    radius.value = 'l';
    radius.dispatchEvent({ type: 'change', target: radius, isTrusted: true });
  });
  const results = await h.kit.answer([
    { key: key('Commodity category'), label: 'Commodity category', value: 'Consumer Goods' },
    { key: key('Radius'), label: 'Radius', value: 'Long haul' },
    { key: key('Notes'), label: 'Notes', value: 'from the AI' },
  ]);
  assert.equal(Array.isArray(results), true, 'the panel reads an array');
  assert.deepEqual([...results].map((r) => [r.key, r.ok]), [[key('Commodity category'), true], [key('Radius'), false], [key('Notes'), false]]);
  assert.match(results[1].reason, /agent edit interrupted/);
  assert.match(results[2].reason, /agent edit interrupted/);
  assert.equal(commodity.value, 'cg', 'the answer already in stays in');
  assert.equal(radius.value, 'l', 'the agent\'s pick stays');
  assert.equal(notes.value, '', 'nothing after the edit goes in');
  // Codex review (2026-10-09): the protection rides on the items, which survive the trip to the panel.
  const sent = JSON.parse(JSON.stringify(results));
  assert.deepEqual(sent.map((r) => [r.key, r.protected === true]), [[key('Commodity category'), false], [key('Radius'), true], [key('Notes'), false]]);
  assert.notEqual(radius.getAttribute('data-rater-autofill'), 'failed', 'the agent\'s own answer is not marked as a failed AI answer');
});

test('a question the agent edits while AI answers go in, that was not among them, gets a protected item of its own', async () => {
  const h = harness();
  const pick = (id, label, options) => new SelectNode([{ text: 'Select one', value: '' }, ...options], { id, ariaLabel: label });
  const commodity = pick('commodity', 'Commodity category', [{ text: 'Consumer Goods', value: 'cg' }, { text: 'Building Materials', value: 'bm' }]);
  const radius = pick('radius', 'Radius', [{ text: 'Local', value: 'l' }, { text: 'Long haul', value: 'lh' }]);
  h.document.body.append(commodity, radius);
  const report = await h.kit.fill([], { maxRounds: 1 });
  const key = (label) => report.unknown.find((x) => x.label === label).key;
  commodity.addEventListener('change', () => {
    if (radius.value) return;
    radius.dispatchEvent({ type: 'keydown', target: radius, isTrusted: true });
    radius.value = 'l';
    radius.dispatchEvent({ type: 'change', target: radius, isTrusted: true });
  });
  const results = JSON.parse(JSON.stringify(await h.kit.answer([{ key: key('Commodity category'), label: 'Commodity category', value: 'Consumer Goods' }])));
  assert.deepEqual(results.map((r) => [r.key, r.label, r.ok, r.protected === true]),
    [[key('Commodity category'), 'Commodity category', true, false], [key('Radius'), 'Radius', false, true]]);
  assert.match(results[1].reason, /your answer stays/);
  assert.equal(radius.value, 'l');
});

// Codex reproduction (2026-10-08, AmWINS Underwriting): "Default all answers to No" reset a Yes the
// agent had given, while the report listed that question as skipped.
test('a bulk helper is not clicked while an answer the agent gave is on the page; the other questions still fill one by one', async () => {
  const questions = { subsidiaryToOther: 'subsidiary to other', subsidiary: 'subsidiary', safetyInfo: 'safety info' };
  const build = () => {
    const h = harness();
    const groups = Object.fromEntries(Object.entries(questions).map(([name, label]) => {
      const yes = makeInput({ type: 'radio', name, value: 'Yes' });
      const no = makeInput({ type: 'radio', name, value: 'No' });
      h.document.body.append(radioGroup(label, yes, no));
      return [name, { yes, no }];
    }));
    const button = addButton(h, 'Default all answers to "No"');
    button.onclick = () => { button._clicks = (button._clicks ?? 0) + 1; for (const g of Object.values(groups)) g.no.click(); };
    const plan = [
      ...Object.entries(questions).map(([name, label]) => ({ id: name, path: `amwins.${name}`, re: `^${label}$`, kind: 'bool', value: false, name: label })),
      { id: 'default', kind: 'action', action: 'defaultNo', text: '^default all answers to\\W*no\\W*$', immediate: true, skipIfProtected: true, pages: [], after: [], afterActions: [], afterPages: [], unless: [] },
    ];
    return { h, groups, button, plan };
  };
  // The agent answered Yes to the first question before this fill.
  const guarded = build();
  guarded.groups.subsidiaryToOther.yes.checked = true;
  const report = await guarded.h.kit.fill(guarded.plan, { skip: ['subsidiaryToOther'], batch: true, maxRounds: 6 });
  assert.equal(guarded.button._clicks, undefined, 'the helper would reset the agent\'s answer');
  assert.deepEqual([...report.actions], []);
  assert.equal(guarded.groups.subsidiaryToOther.yes.checked, true);
  assert.deepEqual(['subsidiary', 'safetyInfo'].map((n) => guarded.groups[n].no.checked), [true, true], 'the rules answer the other questions');
  assert.deepEqual([...report.skipped].map((x) => x.key), ['subsidiaryToOther']);
  assert.deepEqual([...report.blockers], [], 'nothing holds Continue: the protected answer is the agent\'s');
  // No answer of the agent's on the page: the helper runs as before.
  const plain = build();
  const run = await plain.h.kit.fill(plain.plan, { batch: true, maxRounds: 6 });
  assert.equal(plain.button._clicks, 1);
  assert.deepEqual([...run.actions].map((a) => a.id), ['defaultNo']);
  assert.deepEqual(Object.keys(questions).map((n) => plain.groups[n].no.checked), [true, true, true]);
});


// A pointer event on an ExtJS option bubbles from a popup outside its combo's DOM subtree.
for (const ownership of ['focused', 'aria-controls', 'aria-owns']) {
  test(`a detached dropdown pick (${ownership}) during AI apply protects the combo and halts later answers`, async () => {
    const h = harness({ ext: true });
    const first = addExtText(h, 'first', '1001', { ref: 'Test.first', caption: 'First' });
    const combo = addExtText(h, 'combo', '1002', { ref: 'Test.combo', caption: 'Combo' });
    const later = addExtText(h, 'later', '1003', { ref: 'Test.later', caption: 'Later' });
    const popup = new FakeNode('div', { id: 'combo-popup', className: 'x-boundlist' });
    const option = new FakeNode('div', { className: 'x-boundlist-item', textContent: 'Agent choice' });
    popup.append(option); h.document.body.append(popup);
    if (ownership === 'focused') h.document.activeElement = combo.input;
    else combo.input.setAttribute(ownership, popup.id);
    first.input.addEventListener('input', () => {
      option.dispatchEvent({ type: 'pointerdown', target: option, isTrusted: true });
      // Focus can move before the input event; ownership must be captured at the gesture.
      h.document.activeElement = later.input;
      combo.cmp.setValue('Agent choice');
      combo.input.dispatchEvent({ type: 'change', target: combo.input, isTrusted: true });
    });
    const results = JSON.parse(JSON.stringify(await h.kit.answer([
      { key: 'ref:Test.first', label: 'First', value: 'AI first' },
      { key: 'ref:Test.combo', label: 'Combo', value: 'AI combo' },
      { key: 'ref:Test.later', label: 'Later', value: 'AI later' },
    ])));
    assert.equal(combo.input.value, 'Agent choice');
    assert.equal(later.input.value, '');
    assert.equal(results.find(r => r.key === 'ref:Test.combo').protected, true);
    assert.match(results.at(-1).reason, /agent edit interrupted/);
  });
}

test('a detached dropdown pick while waiting before Continue stops navigation', async () => {
  const h = harness({ ext: true });
  const combo = addExtText(h, 'combo', '1002', { ref: 'Test.combo', caption: 'Combo', value: 'wanted' });
  const popup = new FakeNode('div', { className: 'x-boundlist' });
  const option = new FakeNode('div', { className: 'x-boundlist-item' });
  popup.append(option); h.document.body.append(popup);
  h.document.activeElement = combo.input;
  const button = addButton(h, 'Continue');
  let clicks = 0, settles = 0;
  button.onclick = () => { clicks++; };
  h.context.MutationObserver = class {
    constructor() {
      if (++settles === 2) setTimeout(() => {
        option.dispatchEvent({ type: 'pointerdown', target: option, isTrusted: true });
        combo.cmp.setValue('Agent choice');
        combo.input.dispatchEvent({ type: 'change', target: combo.input, isTrusted: true });
      }, 10);
    }
    observe() {} disconnect() {}
  };
  const report = await h.kit.fill([{ id: 'combo', field: 'Test.combo', kind: 'text', value: 'wanted', name: 'Combo' }],
    { maxRounds: 2, advance: { text: 'Continue' } });
  assert.equal(clicks, 0);
  assert.equal(report.halted, true);
  assert.ok(report.blockers.includes(report.reason));
  assert.deepEqual([...report.protectedKeys], ['ref:Test.combo']);
  assert.equal(combo.input.value, 'Agent choice');
});

for (const scenario of ['future frame', 'finished frame', 'same frame without edits', 'transport failure', 'transport failure after edit', 'document replacement', 'context invalidation']) {
  test(`AI apply guards across frames: ${scenario}`, async () => {
    const frames = [harness(), harness(), harness()];
    const owners = ['same frame without edits', 'document replacement', 'context invalidation'].includes(scenario) ? [0, 0, 0] : [0, 1, 2];
    const controls = owners.map((owner, i) => {
      const h = frames[owner];
      const select = new SelectNode([{ text: '', value: '' }, { text: 'No', value: 'no' }, { text: 'Yes', value: 'yes' }],
        { id: `choice${i}`, ariaLabel: `Choice ${i}` });
      h.document.body.append(select);
      return select;
    });
    // First apply returns from B and C immediately, while A is waiting for its page to settle.
    // The agent changes B during that wait. C must never receive its planned answer.
    if (scenario === 'future frame' || scenario === 'finished frame' || scenario === 'transport failure after edit') {
      const trigger = scenario === 'finished frame' ? 1 : 0;
      const edited = scenario === 'finished frame' ? 0 : 1;
      controls[trigger].addEventListener('change', () => setTimeout(() => {
        controls[edited].dispatchEvent({ type: 'pointerdown', isTrusted: true });
        controls[edited].value = 'yes';
        controls[edited].dispatchEvent({ type: 'change', isTrusted: true });
      }, 10));
    }
    const pre = frames.map((h, frameId) => ({ frameId, documentId: `doc-${frameId}`, result: h.kit.decisionSnapshot() }));
    const xs = controls.map((el, i) => {
      const field = JSON.parse(pre[owners[i]].result)[1].find(f => f.key === el.id);
      return { ...field, controlKind: field.kind, choice: 'No', autoOk: true };
    });
    const record = {}, intake = { record };
    const state = { filling: false, intake, active: {}, tab: { id: 1, url: 'https://synthetic.example/rater' },
      aiCache: new Map(xs.map((x, i) => [`1\n/rater\n${i}`, x])), agentKeys: new Map(), filled: new Map() };
    const ctx = { tabId: 1, page: '/rater', tabUrl: state.tab.url, intake, carrier: { practice: true },
      contextKey: assistContextKey(record, state.active), snapshots: pre };
    if (scenario === 'context invalidation') controls[0].addEventListener('change', () => setTimeout(() => {
      state.intake = { record: { changed: true } };
    }, 10));
    const documents = frames.map((_, i) => `doc-${i}`);
    let dispatches = 0, replacementControls;
    const sandbox = { state, crypto: { randomUUID }, assistContextKey, aiFingerprint: JSON.stringify, pageOf: url => new URL(url).pathname,
      runKit: async (tabId, carrier, func, args = [], frameIds) => {
        // Navigation after the global read, immediately before dispatch: a frameId alone
        // must not authorize writing into the new document, even with identical fields.
        if (/\.answer\(/.test(String(func)) && ++dispatches === 2 && scenario === 'document replacement') {
          frames[0] = harness();
          documents[0] = 'replacement-document';
          replacementControls = controls.map((_, i) => new SelectNode(
            [{ text: '', value: '' }, { text: 'No', value: 'no' }, { text: 'Yes', value: 'yes' }],
            { id: `choice${i}`, ariaLabel: `Choice ${i}` }));
          frames[0].document.body.append(...replacementControls);
        }
        const results = await Promise.all(frames.map(async (h, frameId) => {
          if (frameIds && !frameIds.includes(frameId)) return null;
          h.context.__testArgs = args;
          const result = await vm.runInNewContext(`(${func.toString()})(...__testArgs)`, h.context);
          return { frameId, documentId: documents[frameId], result: JSON.parse(JSON.stringify(result)) };
        }));
        if (scenario.startsWith('transport failure') && /\.answer\(/.test(String(func))) throw new Error('Transport unavailable after answer');
        return results.filter(Boolean);
      },
      tellRecorder: async () => {}, persistAiPending: async () => {},
      agentKeysQueue: Promise.resolve(), agentKeysStore: { get: async () => [], set: async () => {} },
      usage: { currentSession: () => ({ intakeId: 'scope' }) }, aiSafeText: String, aiRetiredSignatures: new Set() };
    const source = fs.readFileSync(new URL('../sidepanel/sidepanel.js', import.meta.url), 'utf8');
    const functions = ['aiActionCurrent', 'canonicalSnapshotMetadata', 'canonicalSnapshotFrame', 'canonicalSnapshots',
      'snapshotsEqual', 'snapshotFingerprint', 'snapshotHashMatches', 'aiSnapshotFields', 'aiSnapshotFieldMatches',
      'aiQuestionHash', 'aiLiveFieldHash', 'aiOriginRecord', 'aiAnswerOrigin', 'aiCurrentAnswerPresent', 'applyAi', 'persistGuardedEdits', 'agentEdited', 'editScope', 'formScoped', 'stepScope', 'tabStep', 'stopNoteFor'];
    vm.runInNewContext(functions.map(name => {
      const match = source.match(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
      assert.ok(match, name);
      return source.slice(match.index, source.indexOf('\n}', match.index) + 2);
    }).join('\n') + '\nfunction scheduleLayout() {}', sandbox);
    const applied = await sandbox.applyAi(xs, ctx, 'auto');
    assert.equal(applied, !scenario.startsWith('transport failure'), JSON.stringify(xs.map(x => x.error)));
    if (scenario === 'same frame without edits') {
      assert.deepEqual(controls.map(el => el.value), ['no', 'no', 'no']);
      assert.ok(xs.every(x => x.done === 'auto'), 'later answers use per-field validation after the first changes the snapshot');
    } else if (scenario.startsWith('transport failure')) {
      assert.deepEqual(controls.map(el => el.value), ['no', scenario.endsWith('after edit') ? 'yes' : '', '']);
      if (scenario.endsWith('after edit')) assert.deepEqual([...state.agentKeys.get('/rater')], ['choice1'], 'cleanup preserves edits even when answer transport failed');
      assert.ok(xs.every(x => x.done === 'auto'), 'transport failure retains conservative approval holds');
    } else if (scenario === 'document replacement') {
      assert.deepEqual(replacementControls.map(el => el.value), ['', '', ''], 'no remaining answer is written into the replacement document');
      assert.match(xs[1].error, /page or frame changed/);
      assert.match(xs[2].error, /page or frame changed/);
      assert.equal(xs[1].done, null);
    } else if (scenario === 'context invalidation') {
      assert.deepEqual(controls.map(el => el.value), ['no', '', ''], 'changing intake stops all later dispatches');
      assert.match(xs[1].error, /context changed/);
      assert.equal(xs[0].done, 'auto', 'the sent answer retains its original durable review hold');
      assert.equal(xs[1].done, null);
      assert.equal(state.filled.size, 0, 'the replacement intake bookkeeping is untouched');
    } else {
      assert.deepEqual(controls.map(el => el.value), scenario === 'future frame' ? ['no', 'yes', ''] : ['yes', 'no', ''],
        'the correction stays and future frame C is not answered');
      assert.deepEqual([...state.agentKeys.get('/rater')].sort(), ['choice0', 'choice1']);
      assert.match(xs[2].error, /agent edit interrupted/);
      assert.equal(xs[2].done, null);
      if (scenario === 'finished frame') assert.equal(xs[0].done, null, 'a correction to an earlier applied answer replaces its AI hold');
    }
    // A completed or failed operation must not leave listeners behind.
    for (const h of frames) assert.equal((h.document._listeners.get('pointerdown') ?? []).length, 0);
  });
}

// ---------------------------------------------------------------------------------------------
// GEICO (sales.geico.com). Its design system (GDS) draws radios and buttons in open shadow roots,
// names a question Id_<data-model name>_<render number> and renumbers it on every redraw, and gives
// its coverage lists only an Id_<uuid>_<n> id that Recalculate regenerates. The fakes below draw them
// as the saved pages do (layouts/geico, never committed); the GEICO mock checks real shadow DOM.

const shadowOf = (host, ...nodes) => { host.attachShadow({ mode: 'open' }).append(...nodes); return host; };

// A GDS radio question: a <gds-radio-button-group> with the question in its [slot=legend] part, and
// per option a <gds-radio-button> named like the question, holding its own <input type=radio> alone
// in its shadow root and its words in a [slot=label] part. A pick shows on the hosts' `checked` (as
// GDS reflects it). Each input is a native group of its own: one picked earlier stays checked, and a
// click on it then changes nothing and tells the page nothing.
function gdsRadios(stem, n, question, options, { checked = null, tooltip = null } = {}) {
  const name = `Id_${stem}_${n}`;
  const group = new FakeNode('gds-radio-button-group', { id: name });
  if (question != null) {
    const legend = new FakeNode('span', { attrs: { slot: 'legend' } });
    legend.append(new FakeNode('span', { textContent: question }));
    if (tooltip) {
      const tip = new FakeNode('gds-tooltip');
      tip.append(new FakeNode('p', { textContent: tooltip }));
      legend.append(tip);
    }
    group.append(legend);
  }
  const hosts = options.map(([value, words], i) => {
    const host = new FakeNode('gds-radio-button', { id: `${name}${i}`, attrs: { name, value } });
    const input = makeInput({ type: 'radio', name, id: `${name}${i}-shadow`, value });
    shadowOf(host, input);
    host.append(new FakeNode('span', { textContent: words, attrs: { slot: 'label' } }));
    const click = input.click.bind(input);
    input.click = () => { const was = input.checked; click(); if (!was) pick(i); };
    host.input = input;
    return host;
  });
  const pick = (i) => {
    hosts.forEach((h, j) => (j === i ? h.setAttribute('checked', '') : h.removeAttribute('checked')));
    group.setAttribute('active-index', String(i));
  };
  group.append(...hosts);
  if (checked != null) { hosts[checked].input.checked = true; pick(checked); }
  return { group, hosts, inputs: hosts.map((h) => h.input) };
}

// A GDS button: its words in the page, a <button> of <slot>s in its shadow root.
function gdsButton(words, { disabled = false } = {}) {
  const host = new FakeNode('gds-button', { textContent: words, attrs: disabled ? { disabled: '' } : {} });
  const button = new FakeNode('button');
  const label = new FakeNode('span');
  label.append(new FakeSlot());
  button.append(new FakeSlot('left-visual'), label, new FakeSlot('right-visual'));
  shadowOf(host, button);
  return { host, button };
}

// An event as a listener on the document gets it from inside shadow roots: its target the host in
// the page, its composedPath() from the element itself out.
function composedEvent(type, el, { isTrusted = true } = {}) {
  const path = [];
  for (let n = el; n; n = n instanceof FakeShadowRoot ? n.host : n.parentElement ?? n.parentNode ?? null) path.push(n);
  const target = path.find((n) => !(n instanceof FakeShadowRoot) && n.getRootNode() === n.ownerDocument) ?? el;
  return { type, bubbles: true, isTrusted, target, composedPath: () => path };
}

// The kit's arrays come from its own realm (vm): compared as plain data.
const plain = (v) => JSON.parse(JSON.stringify(v));

const geicoRecord = () => ({ applicant: {}, garaging: {}, operations: {}, drivers: [], vehicles: [], priorInsurance: [], coverage: {}, claims: {} });

test('GEICO field keys: the data-model name without its render number, a filing box by its box, coverage lists by name or row', () => {
  const h = harness({ pathname: '/quote' });
  const key = (el) => h.context.__raterFieldKey(el);
  assert.equal(h.context.__raterFieldKey.version, 5);
  const year = new SelectNode(['2024'], { id: 'Id_GiveYear_81515', name: 'Id_GiveYear_81515' });
  // A radio option's input id adds its option digit and -shadow; its name doesn't.
  const radio = makeInput({ type: 'radio', name: 'Id_GiveVehicleOrTrailer_36353', id: 'Id_GiveVehicleOrTrailer_363531-shadow', value: 'No' });
  const vin = makeInput({ id: 'Id_GiveVinPreQuote_25322', name: 'Id_GiveVinPreQuote_25322maskedField' });
  // The boxes of one checkbox group share a name; only the id says which box.
  const boxes = ['FederalLiability', 'MCS90', 'StateFiling'].map((box) => makeInput({ type: 'checkbox', name: 'Id_AddFilings_123', id: `checkbox-Id_AddFilings_123-${box}` }));
  h.document.body.append(year, radio, vin, ...boxes);
  assert.deepEqual([year, radio, vin, ...boxes].map(key), ['ref:GiveYear', 'ref:GiveVehicleOrTrailer', 'ref:GiveVinPreQuote',
    'ref:AddFilings.FederalLiability', 'ref:AddFilings.MCS90', 'ref:AddFilings.StateFiling']);
  assert.equal(h.context.__raterFieldKey.dataName(year), 'GiveYear');
  // A redraw renumbers it: the same key, so an agent's edit stays protected.
  assert.equal(key(makeInput({ type: 'radio', name: 'Id_GiveVehicleOrTrailer_90210', id: 'Id_GiveVehicleOrTrailer_902100-shadow' })), 'ref:GiveVehicleOrTrailer');
  // Not GEICO's shape: its id, as before. Progressive's data-model names and AmWINS' rows unchanged.
  for (const id of ['Id_GiveYear', 'Id_GiveYear_12_extra', 'id_GiveYear_12', 'Id_1Year_12']) assert.equal(key(makeInput({ id })), id);
  assert.equal(key(makeInput({ id: `f_c${'A'.repeat(32)}22F_1_2`, attrs: { fieldref: 'RiskInput.VIN' } })), 'ref:RiskInput.VIN@2');
  assert.equal(key(makeInput({ type: 'checkbox', name: 'medicalPaymentExclude', id: 'medicalPaymentExclude1_0_' })), 'medicalPaymentExclude#2');

  // Quote & Coverages as drawn after each Recalculate: every list a new uuid and number.
  const coverages = () => {
    const box = new FakeNode('div');
    const lists = [];
    for (const coverage of ['Liability Coverage', 'Motor Truck Cargo']) {
      const id = `Id_${randomUUID()}_${10000 + lists.length}`;
      const legend = new FakeNode('gds-label-legend', { attrs: { element: 'label', for: id } });
      const tip = new FakeNode('gds-tooltip');
      tip.append(new FakeNode('p', { textContent: 'What this coverage pays for' }));
      legend.append(new FakeNode('span', { textContent: coverage }), tip);
      const list = new SelectNode(['Please Select'], { id });
      box.append(legend, list);
      lists.push(list);
    }
    // Per-vehicle rows, labelled with the vehicle, its VIN and its premium: never in a key.
    for (const vin of ['1FTBR3X87MKA12345', '1FTBR3X80MKA12399']) {
      for (const coverage of ['COMP', 'COLL']) {
        const list = new SelectNode(['Not Included'], { id: `Id_${randomUUID()}_${20000 + lists.length}_${coverage}`, ariaLabel: `2022 FORD TRANSIT ${vin} $123.00` });
        box.append(list);
        lists.push(list);
      }
    }
    const value = makeInput({ id: `Id_${randomUUID()}_30000_CustomizationValue` });
    value.name = value.id;
    const bare = new SelectNode(['Other'], { id: `Id_${randomUUID()}_40000` });
    box.append(value, bare);
    return { box, lists: [...lists, value], bare };
  };
  const first = coverages();
  h.document.body.append(first.box);
  const keys = first.lists.map(key);
  assert.deepEqual(keys, ['cov:liability coverage', 'cov:motor truck cargo', 'cov:COMP#1', 'cov:COLL#1', 'cov:COMP#2', 'cov:COLL#2', 'cov:CustomizationValue#1']);
  assert.equal(key(first.bare), first.bare.id, 'no coverage name and no label of its own: its id, as before');
  assert.equal(h.context.__raterFieldKey.dataName(first.lists[0]), null);
  // A label of its own that names a vehicle is no coverage's name: never in a key.
  const named = new SelectNode(['Not Included'], { id: `Id_${randomUUID()}_50000` });
  const vehicle = new FakeNode('label', { textContent: '2022 FORD TRANSIT 1FTBR3X87MKA12345', attrs: { for: named.id } });
  first.box.append(vehicle, named);
  assert.equal(key(named), named.id);
  first.box.remove();
  const recalculated = coverages();
  h.document.body.append(recalculated.box);
  assert.deepEqual(recalculated.lists.map(key), keys, 'new ids, the same keys');
});

test('GEICO radios: in page order among the other fields, asked by their legend, each option by its words', () => {
  const h = harness({ pathname: '/quote' });
  const zip = makeInput({ id: 'Id_GiveInitialZipCode_11111', name: 'Id_GiveInitialZipCode_11111', ariaLabel: '5-Digit ZIP Code' });
  const kind = gdsRadios('GiveVehicleOrTrailer', 36353, 'What would the customer like to add?', [['Yes', 'Vehicle'], ['No', 'Trailer']], { tooltip: 'A trailer has no engine of its own.' });
  // Two pay-plan lists share their data-model name and have no legend: two questions, named by it.
  const plans = [52525, 52526].map((n) => gdsRadios('GivePayPlanV2', n, null, [['GEICO_PP_1Pay', 'Pay In Full']], { checked: n === 52525 ? 0 : null }));
  const year = new SelectNode(['2024'], { id: 'Id_GiveYear_81515', name: 'Id_GiveYear_81515', ariaLabel: 'Year' });
  // An amount box whose only words are its "$" sign; a box that isn't GEICO's keeps its "$".
  const amount = makeInput({ id: 'Id_GiveCostNew_22222', name: 'Id_GiveCostNew_22222', ariaLabel: '$' });
  const other = makeInput({ id: 'amount', ariaLabel: '$' });
  const state = new SelectNode(['NE'], { id: 'Id_GiveDriverLicenseState_33333', name: 'Id_GiveDriverLicenseState_33333', ariaLabel: '<span class="name">Driver</span>\'s **License State**' });
  h.document.body.append(zip, kind.group, ...plans.map((p) => p.group), year, amount, other, state);
  const page = h.kit.capture(null, []);
  assert.deepEqual(plain(page.controls.map((c) => [c.ref ?? null, c.kind, c.label])), [
    ['GiveInitialZipCode', 'text', '5-Digit ZIP Code'],
    ['GiveVehicleOrTrailer', 'radio', 'What would the customer like to add?'],
    ['GivePayPlanV2', 'radio', 'give pay plan v2'],
    ['GivePayPlanV2', 'radio', 'give pay plan v2'],
    ['GiveYear', 'select', 'Year'],
    ['GiveCostNew', 'text', 'give cost new'],
    [null, 'text', '$'],
    ['GiveDriverLicenseState', 'select', "Driver's License State"],
  ]);
  assert.deepEqual(plain(page.controls[1].options), ['Vehicle', 'Trailer']);
  assert.deepEqual(plain(page.controls.slice(1, 4).map((c) => c.selected)), ['', 'Pay In Full', '']);
});

// The saved pages show each option's input checked like its host, but each input is a native group
// of its own: after Yes then No, Yes's input may stay checked while its host isn't. The page shows
// the hosts.
test('a GEICO radio is read from its hosts: a stale inner input neither passes for the answer nor blocks the click', async () => {
  const h = harness({ pathname: '/quote' });
  const observed = [];
  h.context.MutationObserver = class { observe(_, options) { observed.push(options); } disconnect() {} };
  const team = gdsRadios('TeamDrivingOrSlipSeatingYesNo', 36353, 'Do any vehicles require team driving or slip seating?', [['Yes', 'Yes'], ['No', 'No']], { checked: 0 });
  team.inputs[1].checked = true;
  h.document.body.append(team.group);
  const step = { id: 'team', field: 'TeamDrivingOrSlipSeatingYesNo', path: 'operations.teamDriving', name: 'Team driving', kind: 'bool', value: false };
  const report = await h.kit.fill([step], { maxRounds: 4, replaceChoices: true });
  assert.deepEqual(team.hosts.map((x) => x.hasAttribute('checked')), [false, true], 'the page shows No');
  assert.deepEqual(plain(report.filled.map((x) => [x.key, x.shown])), [['ref:TeamDrivingOrSlipSeatingYesNo', 'No']]);
  assert.deepEqual(plain([...report.failed, ...report.kept]), []);
  assert.deepEqual(plain(h.kit.readBack([{ key: 'ref:TeamDrivingOrSlipSeatingYesNo' }]).map((x) => x.shown)), ['No']);
  const again = await h.kit.fill([step], { maxRounds: 3, replaceChoices: true });
  assert.deepEqual(plain(again.kept.map((x) => x.key)), ['ref:TeamDrivingOrSlipSeatingYesNo'], 'Yes\'s stale input is not the answer');
  assert.deepEqual(plain(again.filled), []);
  // The wait after an answer sees the hosts change (a pick redraws nothing).
  assert.ok(observed.some((o) => o.attributes && String(o.attributeFilter) === 'checked,active-index'));
});

test('an agent click on a GEICO radio during a fill is the agent\'s edit: protected, and the fill stops', async () => {
  for (const on of ['input', 'words']) {
    const h = harness({ pathname: '/quote' });
    const team = gdsRadios('TeamDrivingOrSlipSeatingYesNo', 36353, 'Do any vehicles require team driving or slip seating?', [['Yes', 'Yes'], ['No', 'No']]);
    const zip = makeInput({ id: 'Id_GiveZip_11111', name: 'Id_GiveZip_11111', ariaLabel: '5-Digit ZIP Code' });
    h.document.body.append(team.group, zip);
    let injected = false;
    h.document._onAddEvent = (type) => {
      if (type !== 'input' || injected) return;
      injected = true;
      // The agent picks No on its input, or on its words (the host's [slot=label] part). At the
      // document both events name the host; composedPath() names the element.
      const gesture = on === 'input' ? team.inputs[1] : team.hosts[1].children.find((c) => c.getAttribute('slot') === 'label');
      h.document._dispatch(composedEvent('pointerdown', gesture));
      team.inputs[1].click();
      h.document._dispatch(composedEvent('input', team.inputs[1]));
    };
    const report = await h.kit.fill([
      { id: 'team', field: 'TeamDrivingOrSlipSeatingYesNo', path: 'operations.teamDriving', name: 'Team driving', kind: 'bool', value: true },
      { id: 'zip', field: 'GiveZip', path: 'garaging.zip', name: 'ZIP', kind: 'text', value: '68102' },
    ], { maxRounds: 4, replaceChoices: true });
    assert.equal(report.halted, true, on);
    assert.deepEqual([...report.protectedKeys], ['ref:TeamDrivingOrSlipSeatingYesNo'], on);
    assert.deepEqual(team.hosts.map((x) => x.hasAttribute('checked')), [false, true], `${on}: the agent's No stays`);
    assert.equal(zip.value, '', `${on}: nothing more is filled`);
  }
});

test('GEICO buttons: a gds-button by its words, not when its host is disabled; progress links never; add icons by token', async () => {
  const h = harness({ pathname: '/quote' });
  const progress = new FakeNode('div', { id: 'progressIndicator' });
  const bar = new FakeNode('gds-progress-bar', { attrs: { value: '100', max: '100' } });
  const stepLink = new FakeNode('a', { textContent: 'Vehicles', role: 'button', attrs: { href: '#', tabindex: '0' } });
  bar.append(stepLink);
  progress.append(bar);
  const recalc = gdsButton('Recalculate');
  const print = gdsButton('Print Quote Proposal', { disabled: true });
  const drivers = new FakeNode('div');
  const icon = new FakeNode('span', { attrs: { 'data-testid': 'addIcon', tabindex: '0' } });
  const unreachable = new FakeNode('span', { attrs: { 'data-testid': 'addIcon', tabindex: '-1' } });
  drivers.append(new FakeNode('p', { textContent: 'Add Driver' }), icon);
  h.document.body.append(progress, recalc.host, print.host, drivers, unreachable);
  const clicks = [];
  for (const [id, el] of [['vehicles', stepLink], ['recalculate', recalc.button], ['print', print.button], ['addDriver', icon], ['other', unreachable]]) el.onclick = () => clicks.push(id);
  const actions = buildPlan(geicoRecord(), { id: 'synthetic', useGenericRules: false, rules: [], actions: [
    { id: 'vehicles', text: '^vehicles$' }, { id: 'recalculate', text: '^recalculate$' }, { id: 'print', text: '^print' },
    { id: 'addDriver', token: 'addIcon', near: 'Add Driver' },
  ] }).filter((s) => s.kind === 'action');
  const report = await h.kit.fill(actions, { maxRounds: 6 });
  assert.deepEqual(clicks.sort(), ['addDriver', 'recalculate']);
  assert.equal(report.actions.find((a) => a.id === 'recalculate')?.text, 'Recalculate');
  assert.deepEqual(plain(h.kit.capture(null, []).buttons), ['Vehicles', 'Recalculate', 'Print Quote Proposal']);
});

test('discarding a form, ordering reports and signing are never clicked, as a helper or as Continue', async () => {
  const words = ['Discard Changes', 'Yes, please discard.', 'Order reports', 'eSignature', 'E-Sign', 'Sign'];
  const h = harness({ pathname: '/quote' });
  const clicks = [];
  for (const [i, text] of words.entries()) {
    const drawn = i % 2 ? gdsButton(text) : null;
    const button = drawn?.button ?? new FakeNode('button', { textContent: text });
    button.onclick = () => clicks.push(text);
    h.document.body.append(drawn?.host ?? button);
  }
  const actions = buildPlan(geicoRecord(), { id: 'synthetic', useGenericRules: false, rules: [], actions: [
    { id: 'discard', text: 'discard' }, { id: 'yes', text: '^yes' }, { id: 'order', text: '^order reports$' },
    { id: 'esign', text: 'e-?sign' }, { id: 'sign', text: '^sign$' },
  ] }).filter((s) => s.kind === 'action');
  const report = await h.kit.fill(actions, { maxRounds: 6, advance: { text: words.map((w) => `^${w.replace(/\./g, '\\.')}$`).join('|') } });
  assert.deepEqual(clicks, []);
  assert.equal(report.advanced, undefined);
  assert.deepEqual(plain(report.actions), []);
});

// GEICO's add rows and the chooser behind Add Vehicle or Trailer (FL live run, 2026-10-21): a helper
// kept to a container (`within`) clicks only there, and with `moveOn` a Next there (it opens a form,
// no step's move) is clicked, never one elsewhere, nor Cancel, Save, Discard in the same container.
test('a helper kept to a container clicks only there; a Next is clicked only with moveOn inside it', async () => {
  const h = harness({ pathname: '/quote' });
  const chooser = new FakeNode('div', { id: 'chooser' });
  const next = gdsButton('Next');
  const cancel = gdsButton('Cancel');
  const save = gdsButton('Save and Continue');
  chooser.append(next.host, cancel.host, save.host);
  const stepNext = gdsButton('Next');
  const drivers = new FakeNode('li', { className: 'add-state', attrs: { 'data-list': 'drivers' } });
  const incidents = new FakeNode('li', { className: 'add-state', attrs: { 'data-list': 'incidents' } });
  const driverIcon = new FakeNode('span', { attrs: { 'data-testid': 'addIcon', tabindex: '0' } });
  const incidentIcon = new FakeNode('span', { attrs: { 'data-testid': 'addIcon', tabindex: '0' } });
  drivers.append(new FakeNode('p', { textContent: 'Add Driver' }), driverIcon);
  incidents.append(new FakeNode('p', { textContent: 'Add Incident' }), incidentIcon);
  h.document.body.append(stepNext.host, incidents, chooser, drivers);
  const clicks = [];
  for (const [id, el] of [['next', next.button], ['cancel', cancel.button], ['save', save.button], ['stepNext', stepNext.button], ['driver', driverIcon], ['incident', incidentIcon]]) el.onclick = () => clicks.push(id);
  const plan = (actions) => buildPlan(geicoRecord(), { id: 'synthetic', useGenericRules: false, rules: [], actions }).filter((s) => s.kind === 'action');
  // Without moveOn, or without a container, Next is never a helper.
  await h.kit.fill(plan([{ id: 'a', text: '^next$', within: '#chooser' }, { id: 'b', text: '^next$', moveOn: true }]), { maxRounds: 4 });
  assert.deepEqual(clicks, []);
  // Cancel and Save in the chooser stay off limits with moveOn.
  await h.kit.fill(plan([{ id: 'c', text: '^cancel$', within: '#chooser', moveOn: true }, { id: 'd', text: '^save', within: '#chooser', moveOn: true }]), { maxRounds: 4 });
  assert.deepEqual(clicks, []);
  // The chooser's Next, and the driver list's "+", not the incidents' (first on the page).
  const report = await h.kit.fill(plan([{ id: 'next', text: '^next$', within: '#chooser', moveOn: true }, { id: 'addDriver', token: 'addIcon', within: 'li.add-state[data-list=drivers]' }]), { maxRounds: 6 });
  assert.deepEqual(clicks.sort(), ['driver', 'next']);
  assert.deepEqual(plain(report.actions.map((a) => a.id)).sort(), ['addDriver', 'next']);
});

test('a one-address unit list: how many units it lists and which of them it shows, within the list only', () => {
  const h = harness({ pathname: '/quote' });
  const list = new FakeNode('ul', { id: 'summaryPage-AddCommercialVehicle' });
  list.append(new FakeNode('li'), new FakeNode('li'), new FakeNode('li', { className: 'add-state' }));
  list.innerText = 'Delivery Van\n1FTBR3X80MKA12345\n2019 RAM 1500\nBox/Straight Truck\n2021 RAM 2500\nAdd Vehicle or Trailer';
  h.document.body.append(list);
  // A VIN elsewhere on the page (the summary panel) isn't the list's.
  h.document.body.innerText = `${list.innerText}\n1FTBR3X80MKA12399`;
  assert.deepEqual(plain(h.kit.unitList('#summaryPage-AddCommercialVehicle', ['1FTBR3X80MKA12345', '1FTBR3X80MKA12399', '', ['Casey', 'Example']])),
    { rows: 2, shown: [true, false, false, false] });
  assert.equal(h.kit.unitList('#summaryPage-AddDriver', []), null, 'not on screen');
  list._visible = false;
  assert.equal(h.kit.unitList('#summaryPage-AddCommercialVehicle', []), null);
});

test('a unit added but never entered is said on its list, not on the unit\'s own form drawn at the same address', async () => {
  const unfinished = 'The "+" was clicked for vehicle 2, but no form was filled for it';
  const actions = buildPlan(geicoRecord(), { id: 'synthetic', useGenericRules: false, rules: [], actions: [
    { id: 'addVehicle', token: 'addIcon', within: 'li.add-state', scope: 'vehicle', doneWhen: (r, a) => [`vehicleEntered:${a.vehicles}`], unfinished },
  ] }, { vehicles: 1 }).filter((s) => s.kind === 'action');
  const run = async ({ list, entered = false, disabled = false }) => {
    const h = harness({ pathname: '/quote' });
    if (list) {
      const row = new FakeNode('li', { className: 'add-state' });
      row.append(new FakeNode('span', { attrs: { 'data-testid': 'addIcon', tabindex: '0', ...(disabled ? { 'aria-disabled': 'true' } : {}) } }));
      h.document.body.append(row);
    }
    const report = await h.kit.fill(actions, { maxRounds: 3, doneActions: ['addVehicle:1', ...(entered ? ['vehicleEntered:1'] : [])] });
    return report.noData.map((x) => x.note);
  };
  assert.deepEqual(plain(await run({ list: true })), [unfinished]);
  assert.deepEqual(plain(await run({ list: false })), [], 'the form, not the list');
  assert.deepEqual(plain(await run({ list: true, entered: true })), []);
  // GEICO greys the "+" out (its unit cap): still the list, still said.
  assert.deepEqual(plain(await run({ list: true, disabled: true })), [unfinished]);
});

test('GEICO spinners keep the page busy while they show', () => {
  for (const id of ['page-load', 'extendedWaiting']) {
    const h = harness({ pathname: '/quote' });
    const loader = new FakeNode('div', { id, className: 'loader-container section-loader--show' });
    h.document.body.append(loader);
    assert.equal(h.kit.busy(), true, id);
    // Idle, GEICO leaves it in the page with display:none.
    loader._visible = false;
    assert.equal(h.kit.busy(), false, id);
  }
});

test("GEICO's premium summary and its stale-rates wording are recognized", async () => {
  const good = premiumHarness({ recalcResult: 'Quote\n\n$1,000.00\n\nDue Today\n\n$1,000.00\n\nTotal' });
  good.h.document.body.innerText = 'Quote\n\n$ --.--\n\nDue Today\n\n$ --.--\n\nTotal';
  await good.h.kit.fill(coverageActionPlan(), { maxRounds: 4 });
  assert.equal(good.recalc._clicked, true, '"$ --.--" in place of the amounts is out of date');
  assert.equal(good.bill._clicked, true, '"Quote $… Due Today $… Total" is a current premium');
  const notice = premiumHarness({ recalcResult: 'Please Recalculate Due To Coverage Change\nQuote\n$1,000.00\nDue Today\n$1,000.00\nTotal' });
  notice.h.document.body.innerText = 'Please Recalculate Due To Coverage Change';
  await notice.h.kit.fill(coverageActionPlan(), { maxRounds: 4 });
  assert.equal(notice.recalc._clicked, true);
  assert.equal(notice.bill._clicked, undefined, 'amounts under the recalculate notice are not current');
});

test('a list taking several choices is never set (the agent picks them), and reads as all its picks', async () => {
  const h = harness({ pathname: '/quote' });
  const goods = new SelectNode(['Sand', 'Gravel', 'Steel'], { id: 'Id_GiveMtcHaulingCommoditiesCollect_44444', name: 'Id_GiveMtcHaulingCommoditiesCollect_44444', ariaLabel: 'Select up to four commodities' });
  goods.multiple = true;
  goods.options[0].picked = goods.options[1].picked = true;
  Object.defineProperty(goods, 'selectedOptions', { get: () => goods.options.filter((o) => o.picked) });
  h.document.body.append(goods);
  const report = await h.kit.fill([{ id: 'goods', field: 'GiveMtcHaulingCommoditiesCollect', path: 'operations.commodities', name: 'Commodities', kind: 'choice', value: 'Steel' }], { maxRounds: 3, replaceChoices: true });
  assert.deepEqual(plain(report.failed.map((x) => [x.key, x.reason, x.current])), [['ref:GiveMtcHaulingCommoditiesCollect', 'this list takes several choices: pick these yourself', 'Sand; Gravel']]);
  assert.deepEqual(goods.options.map((o) => !!o.picked), [true, true, false]);
  assert.equal(goods.value, '');
});

test('a GEICO coverage list\'s hidden stand-in for its current choice is never the option picked', async () => {
  const h = harness({ pathname: '/quote' });
  const comp = new SelectNode([{ text: 'Not Included', value: '' }, { text: 'Not Included', value: 'Not Included' }, { text: '$100 deductible', value: '$100 deductible' }],
    { id: `Id_${randomUUID()}_97546_COMP` });
  comp.options[0].hidden = true;
  h.document.body.append(comp);
  const report = await h.kit.fill([{ id: 'comp', selector: '[id$="_COMP"]', path: 'vehicles[0].comp', name: 'Comprehensive', kind: 'choice', value: 'Not Included' }], { maxRounds: 3, replaceChoices: true });
  assert.equal(comp.value, 'Not Included', 'the real option, not the stand-in');
  assert.deepEqual(plain(report.filled.map((x) => [x.key, x.shown])), [['cov:COMP#1', 'Not Included']]);
});

test('a search box that is an address question is a question; a site search or a list\'s filter box is not', () => {
  const h = harness({ pathname: '/quote' });
  const street = makeInput({ type: 'search', id: 'Id_GiveStreet_12121', name: 'Id_GiveStreet_12121', ariaLabel: 'Street address', attrs: { 'aria-autocomplete': 'list', 'aria-controls': 'address-dropdown-list' } });
  const site = makeInput({ type: 'search', id: 'site-search', ariaLabel: 'Search' });
  const filter = makeInput({ type: 'search', className: 'select2-search__field', ariaLabel: 'Search the list', attrs: { 'aria-autocomplete': 'list', 'aria-controls': 'select2-year-results' } });
  h.document.body.append(street, site, filter);
  assert.deepEqual(plain(h.kit.capture(null, []).controls.map((c) => c.ref)), ['GiveStreet']);
});

test('marks go where the agent looks: a GEICO option on its host, a select2 list on its drawn box', async () => {
  const h = harness({ pathname: '/quote' });
  const kind = gdsRadios('GiveVehicleOrTrailer', 36353, 'What would the customer like to add?', [['Yes', 'Vehicle'], ['No', 'Trailer']]);
  const year = new SelectNode(['2024'], { id: 'Id_GiveYear_81515', name: 'Id_GiveYear_81515', ariaLabel: 'Year', className: 'select2-hidden-accessible' });
  const drawn = new FakeNode('span', { className: 'select2 select2-container' });
  const selection = new FakeNode('span', { className: 'select2-selection select2-selection--single' });
  drawn.append(selection);
  h.document.body.append(kind.group, year, drawn);
  await h.kit.fill([], { maxRounds: 1 });
  const marks = (els) => els.map((x) => x.getAttribute('data-rater-autofill'));
  assert.deepEqual(marks(kind.hosts), ['needs', 'needs']);
  assert.deepEqual(marks(kind.inputs), [null, null]);
  assert.deepEqual(marks([selection, year]), ['needs', 'needs']);
  assert.equal(h.kit.clear(), 4);
});

// GEICO's steps all share /quote. The step on screen is the progress bar's part under way
// (#progressIndicator: a <gds-progress-bar> per step, value 100 done, 50 under way, 0 to come),
// while the title ("GEICO <step>") names it too. `go(step)` moves both, as the agent's Next does.
const GEICO_STEPS = ['Business Class & USDOT', 'Business & Owner Info', 'Vehicles', 'Drivers & Incidents',
  'Additional Business Info', 'Quote & Coverages', 'Final Quote Details', 'MVR & CLUE', 'Payment Information'];
function geicoBar(h, current, { title } = {}) {
  const box = new FakeNode('div', { id: 'progressIndicator' });
  const group = new FakeNode('gds-progress-bar-group');
  const bars = GEICO_STEPS.map((name) => {
    const bar = new FakeNode('gds-progress-bar', { attrs: { max: '100' } });
    bar.append(new FakeNode('span', { textContent: name }));
    return bar;
  });
  group.append(...bars);
  box.append(group);
  h.document.body.append(box);
  const go = (step, { title: shown = `GEICO ${step}` } = {}) => {
    const at = GEICO_STEPS.indexOf(step);
    bars.forEach((bar, i) => bar.setAttribute('value', String(i < at ? 100 : i === at ? 50 : 0)));
    h.document.title = shown;
  };
  go(current, { title });
  return { bars, go };
}

// A GEICO text box or list: named Id_<data-model name>_<render number>.
const geicoBox = (stem, n, ariaLabel, props = {}) => makeInput({ id: `Id_${stem}_${n}`, name: `Id_${stem}_${n}`, ariaLabel, ...props });
const geicoList = (stem, n, ariaLabel, options, props = {}) => new SelectNode(options, { id: `Id_${stem}_${n}`, name: `Id_${stem}_${n}`, ariaLabel, ...props });

test('GEICO\'s step is its progress bar\'s part under way while the title names it too; pages without a bar read their headings', async () => {
  const h = harness({ pathname: '/quote' });
  // GEICO's headings read "Dashboard" on every step: never the step.
  h.document.body.append(new FakeNode('h1', { textContent: 'Dashboard' }));
  const bar = geicoBar(h, 'Vehicles');
  assert.equal(h.kit.step(), 'Vehicles');
  assert.equal(h.kit.capture(null, []).step, 'Vehicles');
  assert.equal((await h.kit.fill([], { maxRounds: 1 })).stepKey, 'Vehicles');
  // Mid-redraw the title and the form were seen to be one step's and the bar another's: no step.
  bar.go('Vehicles', { title: 'GEICO Business & Owner Info' });
  assert.equal(h.kit.step(), '');
  assert.equal((await h.kit.fill([], { maxRounds: 1 })).stepKey, '');
  // Two parts under way, or none: no step either.
  bar.go('Vehicles');
  bar.bars[3].setAttribute('value', '50');
  assert.equal(h.kit.step(), '');
  for (const b of bar.bars) b.setAttribute('value', '100');
  assert.equal(h.kit.step(), '');
  // No bar (AmWINS): the visible headings, as before.
  const plainPage = harness();
  plainPage.document.body.append(new FakeNode('h3', { textContent: 'Vehicles' }), new FakeNode('h3', { textContent: 'Drivers' }));
  assert.equal(plainPage.kit.step(), 'Vehicles / Drivers');
});

test('GEICO steps: a rule kept to a step answers only there, a rule kept to none anywhere, and with no step named nothing kept to one', async () => {
  const plan = [
    { id: 'owner', field: 'GiveFirstName', steps: ['Business & Owner Info'], path: 'applicant.firstName', name: 'Owner first name', kind: 'text', value: 'Pat' },
    { id: 'driver', field: 'GiveFirstName', steps: ['Drivers & Incidents'], path: 'drivers[0].firstName', name: 'Driver first name', kind: 'text', value: 'Sam' },
    { id: 'zip', field: 'GiveZip', path: 'garaging.zip', name: 'ZIP', kind: 'text', value: '68102' },
  ];
  const run = async (step, title) => {
    const h = harness({ pathname: '/quote' });
    geicoBar(h, step, { title });
    const first = geicoBox('GiveFirstName', 40001, 'First Name');
    const zip = geicoBox('GiveZip', 40002, '5-Digit ZIP Code');
    h.document.body.append(first, zip);
    const report = await h.kit.fill(plan, { maxRounds: 6 });
    return { first: first.value, zip: zip.value, report };
  };
  let r = await run('Business & Owner Info');
  assert.deepEqual([r.first, r.zip], ['Pat', '68102']);
  r = await run('Drivers & Incidents');
  assert.deepEqual([r.first, r.zip], ['Sam', '68102']);
  // No rule for it on this step: the first name is unfamiliar here, never the owner's or a driver's.
  r = await run('Vehicles');
  assert.deepEqual([r.first, r.zip], ['', '68102']);
  assert.deepEqual(plain(r.report.unknown.map((x) => x.key)), ['ref:GiveFirstName']);
  // The bar says Drivers & Incidents and the title another step: the step can't be read, and a plan
  // kept to steps does nothing there, not even its rules kept to none (see the unread-step test).
  r = await run('Drivers & Incidents', 'GEICO Vehicles');
  assert.deepEqual([r.first, r.zip, r.report.stepKey, r.report.halted], ['', '', '', true]);
  assert.deepEqual(plain(r.report.filled), []);
});

test('GEICO forms: a vehicle form\'s rules answer beside its own question, a trailer form\'s beside the trailer wording, a form showing neither neither', async () => {
  const carrier = { id: 'synthetic', useGenericRules: false, rules: [
    { field: 'GiveYear', steps: ['Vehicles'], whenShown: { field: 'YesNoPreQuoteHaveFullVinActivity', unit: 'vehicles' }, path: 'vehicles[].year', name: 'Vehicle year', kind: 'choice' },
    { field: 'GiveYear', steps: ['Vehicles'], whenShown: { field: 'GiveOtherVehicleType', label: '\\btrailer\\b', unit: 'trailers' }, path: 'trailers[].year', name: 'Trailer year', kind: 'choice' },
    // The owner's driver form (GEICO draws it) has no relationship question; an added driver's has.
    { field: 'GiveFirstName', steps: ['Drivers & Incidents'], unlessShown: { field: 'GiveDriverRelationshipToBusiness' }, name: 'Owner first name', value: () => 'Pat' },
    { field: 'GiveFirstName', steps: ['Drivers & Incidents'], whenShown: { field: 'GiveDriverRelationshipToBusiness', unit: 'drivers' }, path: 'drivers[].firstName', name: 'Driver first name' },
  ] };
  const record = { ...geicoRecord(), vehicles: [{ year: '2022' }], trailers: [{ year: '2019' }], drivers: [{ firstName: 'Sam' }] };
  const plan = buildPlan(record, carrier, { vehicles: 0, trailers: 0, drivers: 0 });
  const vehicleStep = async (kind) => {
    const h = harness({ pathname: '/quote' });
    geicoBar(h, 'Vehicles');
    if (kind === 'vehicle') h.document.body.append(gdsRadios('YesNoPreQuoteHaveFullVinActivity', 85493, 'Do you have the VIN handy?', [['Yes', 'Yes'], ['No', 'No']]).group);
    if (kind !== 'neither') h.document.body.append(geicoList('GiveOtherVehicleType', 85494, `Which of the following best describes the customer's ${kind}?`, ['Box Truck', 'Flatbed']));
    const year = geicoList('GiveYear', 85495, 'Year', ['2019', '2022']);
    h.document.body.append(year);
    const report = await h.kit.fill(plan, { maxRounds: 6 });
    return { year: year.value, report };
  };
  let r = await vehicleStep('vehicle');
  assert.equal(r.year, '2022');
  assert.deepEqual(plain(r.report.unitForm), { list: 'vehicles', id: 'Id_YesNoPreQuoteHaveFullVinActivity_85493' });
  r = await vehicleStep('trailer');
  assert.equal(r.year, '2019');
  assert.deepEqual(plain(r.report.unitForm), { list: 'trailers', id: 'Id_GiveOtherVehicleType_85494' });
  r = await vehicleStep('neither');
  assert.equal(r.year, '');
  assert.deepEqual(plain(r.report.unknown.map((x) => x.key)), ['ref:GiveYear']);
  assert.equal(r.report.unitForm, null);

  const driverStep = async (added) => {
    const h = harness({ pathname: '/quote' });
    geicoBar(h, 'Drivers & Incidents');
    const first = geicoBox('GiveFirstName', 34001, 'First Name');
    h.document.body.append(first);
    if (added) h.document.body.append(geicoList('GiveDriverRelationshipToBusiness', 34002, 'Relationship to the business', ['Employee', 'Spouse']));
    await h.kit.fill(plan, { maxRounds: 6 });
    return first.value;
  };
  assert.equal(await driverStep(false), 'Pat');
  assert.equal(await driverStep(true), 'Sam');
});

// The forms of GEICO's vehicles share /quote and are drawn one at a time: the panel binds each to
// the vehicle a fill answered on it (report.unitForm, by its first question's element name, whose
// number is new with each form) and passes the bindings back (fill `units`).
const VEHICLE_FORM = { field: 'YesNoPreQuoteHaveFullVinActivity', label: null, unit: 'vehicles' };
const GEICO_VINS = ['1FTBR3X87MKA12345', '1FTBR3X80MKA12399'];
const vehicleFormPlan = (i) => [
  { id: `vin${i}`, field: 'GiveVinPreQuote', steps: ['Vehicles'], whenShown: VEHICLE_FORM, path: `vehicles[${i}].vin`, name: 'VIN', kind: 'text', value: GEICO_VINS[i] },
  { id: `year${i}`, field: 'GiveYear', steps: ['Vehicles'], whenShown: VEHICLE_FORM, path: `vehicles[${i}].year`, name: 'Vehicle year', kind: 'choice', value: '2022' },
];
function geicoVehicleForm(h, n) {
  const marker = gdsRadios('YesNoPreQuoteHaveFullVinActivity', n, 'Do you have the VIN handy?', [['Yes', 'Yes'], ['No', 'No']]);
  const vin = makeInput({ id: `Id_GiveVinPreQuote_${n + 1}`, name: `Id_GiveVinPreQuote_${n + 1}maskedField`, ariaLabel: 'VIN', required: true });
  const year = geicoList('GiveYear', n + 2, 'Year', ['2021', '2022'], { required: true });
  const form = new FakeNode('div');
  form.append(marker.group, vin, year);
  h.document.body.append(form);
  return { form, marker, vin, year, id: `Id_YesNoPreQuoteHaveFullVinActivity_${n}` };
}
const geicoUnits = (active, bound, count = 2) => ({
  active: { vehicles: active, drivers: 0, trailers: 0 }, count: { vehicles: count, drivers: 1, trailers: 0 }, bound: { vehicles: bound, drivers: {}, trailers: {} },
});

test('a GEICO unit form that may be another vehicle\'s is held: nothing typed, one check naming the vehicle by its place, its questions not unfamiliar', async () => {
  const h = harness({ pathname: '/quote' });
  geicoBar(h, 'Vehicles');
  const a = geicoVehicleForm(h, 85493);
  // A new form, nothing bound yet: vehicle 1's, filled, and named for the panel to bind.
  let report = await h.kit.fill(vehicleFormPlan(0), { maxRounds: 6, units: geicoUnits(0, {}) });
  assert.deepEqual([a.vin.value, a.year.value], [GEICO_VINS[0], '2022']);
  assert.deepEqual(plain([report.unitForm, report.unitHeld]), [{ list: 'vehicles', id: a.id }, null]);
  const held = (r) => {
    assert.deepEqual(plain([...r.filled, ...r.unknown, ...r.leftRequired, ...r.noData, ...r.failed]), []);
    assert.equal(r.checks.length, 1);
    assert.equal(r.checks[0].key, 'ref:YesNoPreQuoteHaveFullVinActivity');
    for (const vin of GEICO_VINS) assert.ok(!JSON.stringify(plain(r)).includes(vin), 'never its VIN');
    return r.checks[0].note;
  };

  // The picker moved to vehicle 2 while vehicle 1's form is still on screen: that form is vehicle 1's.
  a.vin.value = ''; a.year.value = '';
  report = await h.kit.fill(vehicleFormPlan(1), { maxRounds: 6, units: geicoUnits(1, { [a.id]: 0 }) });
  assert.deepEqual([a.vin.value, a.year.value], ['', '']);
  assert.deepEqual(plain([report.unitForm, report.unitHeld]), [null, { list: 'vehicles', id: a.id }]);
  // Only the agent can tell whose it is: the note says both ways out.
  assert.match(held(report), /^This form was filled for vehicle 1, and the panel has vehicle 2 picked: if it is vehicle 1's, pick vehicle 1 in the panel, then Fill again; if it is vehicle 2's, correct its answers yourself\.$/);
  assert.equal(a.marker.hosts[0].getAttribute('data-rater-autofill'), 'needs', 'marked on its first question');

  // Vehicle 1 saved, the next form drawn: the follow-up fill for vehicle 1 (the picker unchanged)
  // would put vehicle 1's VIN on what is likely vehicle 2's form.
  a.form.remove();
  const b = geicoVehicleForm(h, 37768);
  report = await h.kit.fill(vehicleFormPlan(0), { maxRounds: 6, units: geicoUnits(0, { [a.id]: 0 }) });
  assert.deepEqual([b.vin.value, b.year.value], ['', '']);
  assert.deepEqual(plain([report.unitForm, report.unitHeld]), [null, { list: 'vehicles', id: b.id }]);
  assert.match(held(report), /^This form may be another vehicle's than vehicle 1, which was filled on an earlier form: pick the vehicle this form is about in the panel/);
  // One vehicle on the intake: no other to pick.
  report = await h.kit.fill(vehicleFormPlan(0), { maxRounds: 6, units: geicoUnits(0, { [a.id]: 0 }, 1) });
  assert.match(held(report), /\. The intake lists one vehicle: answer this form yourself\.$/);
  // Marked done in the panel (its first question the agent's): still held, without the check.
  report = await h.kit.fill(vehicleFormPlan(0), { maxRounds: 6, units: geicoUnits(0, { [a.id]: 0 }, 1), skip: ['ref:YesNoPreQuoteHaveFullVinActivity'] });
  assert.deepEqual([b.vin.value, b.year.value], ['', '']);
  assert.deepEqual(plain([report.unitHeld, report.checks, report.unknown]), [{ list: 'vehicles', id: b.id }, [], []]);
  // The agent picks vehicle 2: the new form is its.
  report = await h.kit.fill(vehicleFormPlan(1), { maxRounds: 6, units: geicoUnits(1, { [a.id]: 0 }) });
  assert.deepEqual([b.vin.value, b.year.value], [GEICO_VINS[1], '2022']);
  assert.deepEqual(plain([report.unitForm, report.unitHeld]), [{ list: 'vehicles', id: b.id }, null]);
  assert.deepEqual(plain(report.checks), []);
});

test('a GEICO unit form drawn during a fill is held for the rest of it: the unit it began on was answered on the earlier one', async () => {
  const h = harness({ pathname: '/quote' });
  geicoBar(h, 'Vehicles');
  const a = geicoVehicleForm(h, 85493);
  let b = null;
  // Its last answer saves the vehicle, and the next form is drawn (in place of a click on Next).
  a.year.addEventListener('change', () => { if (!b) { a.form.remove(); b = geicoVehicleForm(h, 37768); } });
  const report = await h.kit.fill(vehicleFormPlan(0), { maxRounds: 6, units: geicoUnits(0, {}) });
  assert.equal(a.vin.value, GEICO_VINS[0]);
  assert.ok(b);
  assert.deepEqual([b.vin.value, b.year.value], ['', '']);
  assert.deepEqual(plain([report.unitForm, report.unitHeld]), [{ list: 'vehicles', id: a.id }, { list: 'vehicles', id: b.id }]);
});

// GEICO's Add Driver form (its relationship question is only there) and its trailer form.
const ADD_DRIVER_FORM = { field: 'GiveDriverRelationshipToBusiness', label: null, unit: 'drivers' };
const TRAILER_FORM = { field: 'GiveOtherVehicleType', label: '\\btrailer\\b', unit: 'trailers' };
// What the panel passes as `skipBy` for GEICO (sidepanel fillSkipBy): the agent's edits by the step,
// active unit or form they were made on.
const geicoSkipBy = ({ steps = {}, units = {}, forms = {} } = {}) => ({
  steps, units: { vehicles: [], trailers: [], drivers: [], ...units }, forms,
  stepUnits: { Vehicles: 'vehicles', 'Drivers & Incidents': 'drivers' },
});

test('GEICO skipBy: an edit made on a step protects its field there only; the same name on another step still fills', async () => {
  const plan = [
    { id: 'owner', field: 'GiveLastName', steps: ['Business & Owner Info'], path: 'applicant.owner1.last', name: 'Owner last name', kind: 'text', value: 'Lane' },
    { id: 'driver', field: 'GiveLastName', steps: ['Drivers & Incidents'], whenShown: ADD_DRIVER_FORM, path: 'drivers[0].last', name: 'Driver last name', kind: 'text', value: 'Lane' },
    { id: 'zip', field: 'GiveZip', path: 'garaging.zip', name: 'ZIP', kind: 'text', value: '68102' },
  ];
  const run = async (step, options) => {
    const h = harness({ pathname: '/quote' });
    geicoBar(h, step);
    const last = geicoBox('GiveLastName', 40001, 'Last Name');
    const zip = geicoBox('GiveZip', 40002, '5-Digit ZIP Code');
    h.document.body.append(last, zip);
    if (step === 'Drivers & Incidents') h.document.body.append(geicoList('GiveDriverRelationshipToBusiness', 40003, 'What is their relationship to the business?', ['Owner', 'Employee']));
    const report = await h.kit.fill(plan, { maxRounds: 6, units: geicoUnits(0, {}), ...options });
    return { last: last.value, zip: zip.value, report };
  };
  // The agent corrected the owner's last name and the business ZIP on Business & Owner Info.
  const skipBy = geicoSkipBy({ steps: { 'Business & Owner Info': ['ref:GiveLastName', 'ref:GiveZip'] } });
  let r = await run('Business & Owner Info', { skipBy });
  assert.deepEqual([r.last, r.zip], ['', '']);
  assert.deepEqual(plain(r.report.skipped.map((x) => x.key)).sort(), ['ref:GiveLastName', 'ref:GiveZip']);
  // The added driver's last name and another step's ZIP still come from the intake.
  r = await run('Drivers & Incidents', { skipBy });
  assert.deepEqual([r.last, r.zip], ['Lane', '68102']);
  assert.deepEqual(plain(r.report.skipped), []);
  assert.deepEqual(plain(r.report.unitForm), { list: 'drivers', id: 'Id_GiveDriverRelationshipToBusiness_40003' });
  // `skip` (edits made where no step was read) applies on every step, as before.
  r = await run('Drivers & Incidents', { skipBy, skip: ['ref:GiveZip'] });
  assert.deepEqual([r.last, r.zip], ['Lane', '']);
});

test('GEICO skipBy on a unit step: a vehicle form gets the active vehicle\'s edits, a trailer form the active trailer\'s, each form its own', async () => {
  const plan = [
    { id: 'vyear', field: 'GiveYear', steps: ['Vehicles'], whenShown: VEHICLE_FORM, path: 'vehicles[1].year', name: 'Vehicle year', kind: 'choice', value: '2022' },
    { id: 'tyear', field: 'GiveYear', steps: ['Vehicles'], whenShown: TRAILER_FORM, path: 'trailers[0].year', name: 'Trailer year', kind: 'choice', value: '2019' },
  ];
  const run = async (kind, skipBy) => {
    const h = harness({ pathname: '/quote' });
    geicoBar(h, 'Vehicles');
    if (kind === 'vehicle') h.document.body.append(gdsRadios('YesNoPreQuoteHaveFullVinActivity', 85493, 'Do you have the VIN handy?', [['Yes', 'Yes'], ['No', 'No']]).group);
    h.document.body.append(geicoList('GiveOtherVehicleType', 85494, `Which of the following best describes the customer's ${kind}?`, ['Box Truck', 'Flatbed']));
    const year = geicoList('GiveYear', 85495, 'Year', ['2019', '2022']);
    h.document.body.append(year);
    const report = await h.kit.fill(plan, { maxRounds: 6, units: geicoUnits(1, {}), skipBy });
    return year.value;
  };
  // The agent corrected vehicle 2's year (its form, no VIN): the trailer form's year still fills.
  const vehicleEdit = geicoSkipBy({ units: { vehicles: ['ref:GiveYear'] } });
  assert.equal(await run('vehicle', vehicleEdit), '');
  assert.equal(await run('trailer', vehicleEdit), '2019');
  // A trailer's edit protects the trailer form's year, never a vehicle's.
  const trailerEdit = geicoSkipBy({ units: { trailers: ['ref:GiveYear'] } });
  assert.equal(await run('trailer', trailerEdit), '');
  assert.equal(await run('vehicle', trailerEdit), '2022');
  // An edit filed under a form applies on that form only.
  const formEdit = geicoSkipBy({ forms: { Id_GiveOtherVehicleType_85494: ['ref:GiveYear'] } });
  assert.equal(await run('trailer', formEdit), '');
  assert.equal(await run('vehicle', formEdit), '2022');
  // Edits of another step don't apply here.
  assert.equal(await run('vehicle', geicoSkipBy({ steps: { 'Business & Owner Info': ['ref:GiveYear'] } })), '2022');
});

test('GEICO skipBy on a unit step with no unit form on screen: the step\'s own edits, never a unit\'s', async () => {
  const plan = [{ id: 'count', field: 'GiveNumberOfUnits', steps: ['Vehicles', 'Drivers & Incidents'], path: 'operations.units', name: 'Number of units', kind: 'text', value: '2' }];
  const run = async (step, skipBy) => {
    const h = harness({ pathname: '/quote' });
    geicoBar(h, step);
    const box = geicoBox('GiveNumberOfUnits', 1, 'How many?');
    h.document.body.append(box);
    await h.kit.fill(plan, { maxRounds: 6, units: geicoUnits(0, {}), skipBy });
    return box.value;
  };
  // The owner's own driver form asks Add Driver's questions: the picked driver's edits aren't the owner's.
  for (const step of ['Vehicles', 'Drivers & Incidents']) {
    assert.equal(await run(step, geicoSkipBy({ units: { vehicles: ['ref:GiveNumberOfUnits'], drivers: ['ref:GiveNumberOfUnits'] } })), '2', step);
    assert.equal(await run(step, geicoSkipBy({ steps: { [step]: ['ref:GiveNumberOfUnits'] } })), '', step);
  }
});

test('GEICO skipBy on a held form: only an edit filed under that form dismisses its check, never the active unit\'s; its own edits stay once its unit is picked', async () => {
  const h = harness({ pathname: '/quote' });
  geicoBar(h, 'Vehicles');
  // Vehicle 1 was filled on an earlier form; the next form is on screen and the picker is still on vehicle 1.
  const earlier = 'Id_YesNoPreQuoteHaveFullVinActivity_85493';
  const b = geicoVehicleForm(h, 37768);
  const marker = 'ref:YesNoPreQuoteHaveFullVinActivity';
  const fill = (skipBy) => h.kit.fill(vehicleFormPlan(0), { maxRounds: 6, units: geicoUnits(0, { [earlier]: 0 }), skipBy });
  // Vehicle 1's edits (its first question, on its own form and as vehicle 1) never answer this form's check.
  let report = await fill(geicoSkipBy({ units: { vehicles: [marker] }, forms: { [earlier]: [marker] } }));
  assert.deepEqual(plain([report.unitHeld, report.checks.map((x) => x.key)]), [{ list: 'vehicles', id: b.id }, [marker]]);
  assert.deepEqual([b.vin.value, b.year.value], ['', '']);
  assert.equal(b.marker.hosts[0].getAttribute('data-rater-autofill'), 'needs');
  // Dismissed on this form: still held, without the check.
  report = await fill(geicoSkipBy({ forms: { [b.id]: [marker] } }));
  assert.deepEqual(plain([report.unitHeld, report.checks]), [{ list: 'vehicles', id: b.id }, []]);
  assert.deepEqual([b.vin.value, b.year.value], ['', '']);
  // The agent picks a year on the held form, then picks vehicle 2: their choice stays, the rest fills.
  b.year.value = '2021';
  report = await h.kit.fill(vehicleFormPlan(1), { maxRounds: 6, replaceChoices: true, units: geicoUnits(1, { [earlier]: 0 }), skipBy: geicoSkipBy({ forms: { [b.id]: ['ref:GiveYear'] } }) });
  assert.deepEqual([b.vin.value, b.year.value], [GEICO_VINS[1], '2021']);
  assert.deepEqual(plain([report.unitForm, report.unitHeld]), [{ list: 'vehicles', id: b.id }, null]);
});

test('a GEICO unit form is bound only when the plan answers it: the owner-listed Add Driver binds nothing, and the driver picked next fills it', async () => {
  const h = harness({ pathname: '/quote' });
  geicoBar(h, 'Drivers & Incidents');
  const first = geicoBox('GiveFirstName', 34001, 'First Name');
  h.document.body.append(first, geicoList('GiveDriverRelationshipToBusiness', 34002, 'What is their relationship to the business?', ['Owner', 'Employee']));
  const id = 'Id_GiveDriverRelationshipToBusiness_34002';
  const note = 'The panel\'s driver is the owner, whom GEICO already lists: pick the driver this form is for in the panel, then Fill again.';
  const driverPlan = (i, value) => [{ id: `first${i}`, field: 'GiveFirstName', steps: ['Drivers & Incidents'], whenShown: ADD_DRIVER_FORM, path: `drivers[${i}].first`, name: 'Driver first name', kind: 'text', value, note: value == null ? note : null }];
  const units = (active, bound) => ({ active: { vehicles: 0, drivers: active, trailers: 0 }, count: { vehicles: 1, drivers: 2, trailers: 0 }, bound: { vehicles: {}, drivers: bound, trailers: {} } });
  // The picker on the owner: every answer is a note, so the form is nobody's yet.
  let report = await h.kit.fill(driverPlan(0, null), { maxRounds: 6, units: units(0, {}) });
  assert.equal(first.value, '');
  assert.deepEqual(plain([report.unitForm, report.unitHeld, report.checks]), [null, null, []]);
  assert.deepEqual(plain(report.noData.map((x) => x.note)), [note]);
  // The agent picks driver 2: the form is not held, and is now driver 2's.
  report = await h.kit.fill(driverPlan(1, 'Sam'), { maxRounds: 6, units: units(1, {}) });
  assert.equal(first.value, 'Sam');
  assert.deepEqual(plain([report.unitForm, report.unitHeld, report.checks]), [{ list: 'drivers', id }, null, []]);
});

test('a GEICO form filled for one driver while the panel has another picked: the note says both ways out', async () => {
  const h = harness({ pathname: '/quote' });
  geicoBar(h, 'Drivers & Incidents');
  const first = geicoBox('GiveFirstName', 34001, 'First Name');
  h.document.body.append(first, geicoList('GiveDriverRelationshipToBusiness', 34002, 'What is their relationship to the business?', ['Owner', 'Employee']));
  const id = 'Id_GiveDriverRelationshipToBusiness_34002';
  const plan = [{ id: 'first2', field: 'GiveFirstName', steps: ['Drivers & Incidents'], whenShown: ADD_DRIVER_FORM, path: 'drivers[2].first', name: 'Driver first name', kind: 'text', value: 'Sam' }];
  const units = { active: { vehicles: 0, drivers: 2, trailers: 0 }, count: { vehicles: 1, drivers: 3, trailers: 0 }, bound: { vehicles: {}, drivers: { [id]: 1 }, trailers: {} } };
  const report = await h.kit.fill(plan, { maxRounds: 6, units });
  assert.equal(first.value, '');
  assert.deepEqual(plain([report.unitHeld, report.checks.map((x) => [x.name, x.note])]), [{ list: 'drivers', id }, [['driver 3',
    'This form was filled for driver 2, and the panel has driver 3 picked: if it is driver 2\'s, pick driver 2 in the panel, then Fill again; if it is driver 3\'s, correct its answers yourself.']]]);
});

// The questions that start GEICO's forms (fill plan `whenShown.unit`), as the panel's plan gives them.
const TRAILER_YEAR = { id: 'tyear', field: 'GiveYear', steps: ['Vehicles'], whenShown: TRAILER_FORM, path: 'trailers[0].year', name: 'Trailer year', kind: 'choice', value: '2019' };
const trailerForm = (h, n) => {
  const type = geicoList('GiveOtherVehicleType', n, 'Which of the following best describes the customer\'s trailer?', ['Flatbed', 'Dry Van']);
  const year = geicoList('GiveYear', n + 1, 'Year', ['2019', '2022']);
  const form = new FakeNode('div');
  form.append(type, year);
  h.document.body.append(form);
  return { form, type, year, id: `Id_GiveOtherVehicleType_${n}` };
};

test('unitFormsNow names the unit forms on screen between fills, by the markers a fill here was given, element names only', async () => {
  const h = harness({ pathname: '/quote' });
  geicoBar(h, 'Vehicles');
  const zipOnly = [{ id: 'zip', field: 'GiveZip', path: 'garaging.zip', name: 'ZIP', kind: 'text', value: '68102' }];
  // No fill has said which questions start a form: the kit can't tell.
  assert.equal(h.kit.unitFormsNow(), null);
  const a = geicoVehicleForm(h, 85493);
  // A plan with no unit forms (Progressive's, AmWINS') tells it nothing.
  await h.kit.fill(zipOnly, { maxRounds: 2 });
  assert.equal(h.kit.unitFormsNow(), null);
  await h.kit.fill([...vehicleFormPlan(0), TRAILER_YEAR], { maxRounds: 6, units: geicoUnits(0, {}) });
  assert.equal(a.vin.value, GEICO_VINS[0]);
  assert.deepEqual(plain(h.kit.unitFormsNow()), [{ list: 'vehicles', id: a.id, blank: true }]);
  assert.ok(!JSON.stringify(plain(h.kit.unitFormsNow())).includes(GEICO_VINS[0]), 'never a value');
  // Vehicle 1 saved, the agent opens the trailer form: named before any fill has read it, also
  // after a fill whose plan has no unit forms.
  a.form.remove();
  const t = trailerForm(h, 51200);
  await h.kit.fill(zipOnly, { maxRounds: 2 });
  assert.deepEqual(plain(h.kit.unitFormsNow()), [{ list: 'trailers', id: t.id, blank: true }]);
  // A vehicle form's type list reads "…vehicle?": not the trailer form.
  t.type.setAttribute('aria-label', 'Which of the following best describes the customer\'s vehicle?');
  assert.deepEqual(plain(h.kit.unitFormsNow()), []);
  // No form on screen (the owner check under Vehicles): none.
  t.form.remove();
  assert.deepEqual(plain(h.kit.unitFormsNow()), []);
  // It never throws: a page it can't read gives no answer.
  h.document.querySelectorAll = () => { throw new Error('unreadable'); };
  assert.equal(h.kit.unitFormsNow(), null);
});

test('GEICO skipBy is read again each round: a form drawn partway through a fill gets its own edits, never the previous form\'s', async () => {
  const h = harness({ pathname: '/quote' });
  geicoBar(h, 'Vehicles');
  const a = geicoVehicleForm(h, 85493);
  let b = null;
  // Its last answer saves the vehicle, and the next form is drawn (in place of a click on Next).
  a.year.addEventListener('change', () => { if (!b) { a.form.remove(); b = geicoVehicleForm(h, 37768); } });
  // The agent answered vehicle 1's first question (its VIN handy?) themselves.
  const marker = 'ref:YesNoPreQuoteHaveFullVinActivity';
  const report = await h.kit.fill(vehicleFormPlan(0), { maxRounds: 6, units: geicoUnits(0, {}), skipBy: geicoSkipBy({ units: { vehicles: [marker] } }) });
  assert.equal(a.vin.value, GEICO_VINS[0]);
  assert.ok(b);
  assert.deepEqual([b.vin.value, b.year.value], ['', '']);
  // The new form is held: its check and mark are there, vehicle 1's edit doesn't answer them.
  assert.deepEqual(plain([report.unitForm, report.unitHeld]), [{ list: 'vehicles', id: a.id }, { list: 'vehicles', id: b.id }]);
  assert.deepEqual(plain(report.checks.map((x) => [x.key, x.name])), [[marker, 'vehicle 1']]);
  assert.equal(b.marker.hosts[0].getAttribute('data-rater-autofill'), 'needs');
  assert.ok(!report.skipped.some((x) => x.key === marker), 'not skipped on the new form');
});

test('GEICO skipBy on a unit step with no unit form (the owner check under Vehicles): every step\'s edits apply, no unit\'s', async () => {
  const OWNER_CHECK = { field: 'GiveSocialSecurityNumber' };
  const plan = [
    { id: 'owner', field: 'GiveLastName', steps: ['Business & Owner Info'], path: 'applicant.owner1.last', name: 'Owner last name', kind: 'text', value: 'Lane' },
    { id: 'ownerAgain', field: 'GiveLastName', steps: ['Vehicles'], whenShown: OWNER_CHECK, path: 'applicant.owner1.last', name: 'Owner last name', kind: 'text', value: 'Lane' },
    { id: 'zipAgain', field: 'GiveZip', steps: ['Vehicles'], whenShown: OWNER_CHECK, path: 'garaging.zip', name: 'Business ZIP', kind: 'text', value: '68102' },
    { id: 'units', field: 'GiveNumberOfUnits', steps: ['Vehicles'], whenShown: OWNER_CHECK, path: 'operations.units', name: 'Number of units', kind: 'text', value: '2' },
    ...vehicleFormPlan(0),
  ];
  const run = async (skipBy, { form = false } = {}) => {
    const h = harness({ pathname: '/quote' });
    geicoBar(h, 'Vehicles');
    const last = geicoBox('GiveLastName', 61001, 'Business Owner Last Name');
    const zip = geicoBox('GiveZip', 61002, '5-Digit ZIP Code');
    const count = geicoBox('GiveNumberOfUnits', 61003, 'How many?');
    h.document.body.append(last, zip, count, geicoBox('GiveSocialSecurityNumber', 61004, 'Business Owner Social Security Number'));
    if (form) geicoVehicleForm(h, 85493);
    const report = await h.kit.fill(plan, { maxRounds: 6, units: geicoUnits(0, {}), skipBy });
    return { values: [last.value, zip.value, count.value], skipped: plain(report.skipped.map((x) => x.key)).sort() };
  };
  // The owner's last name corrected on Business & Owner Info: not typed over where GEICO asks it again.
  const corrected = geicoSkipBy({ steps: { 'Business & Owner Info': ['ref:GiveLastName'], 'Quote & Coverages': ['ref:GiveZip'] }, units: { vehicles: ['ref:GiveNumberOfUnits'], drivers: ['ref:GiveZip'] } });
  let r = await run(corrected);
  assert.deepEqual(r.values, ['', '', '2']);
  assert.deepEqual(r.skipped, ['ref:GiveLastName', 'ref:GiveZip']);
  // Another unit's edits don't apply here.
  r = await run(geicoSkipBy({ units: { drivers: ['ref:GiveLastName'] } }));
  assert.deepEqual(r.values, ['Lane', '68102', '2']);
  // With a vehicle form on screen, other steps' edits stay theirs (its questions are the form's).
  r = await run(corrected, { form: true });
  assert.ok(!r.skipped.includes('ref:GiveLastName') && !r.skipped.includes('ref:GiveZip'));
});

test('a recorder in the kit\'s world names the unit form an agent change was made on, before any fill has read it', async () => {
  const h = harness({ pathname: '/quote' });
  geicoBar(h, 'Vehicles');
  const a = geicoVehicleForm(h, 85493);
  await h.kit.fill([...vehicleFormPlan(0), TRAILER_YEAR], { maxRounds: 6, units: geicoUnits(0, {}) });
  const recorder = recorderHarness(h.document);
  // GEICO's recorder runs in the kit's (isolated) world.
  recorder.context.__raterKit = h.kit;
  const lastChange = () => recorder.sent.filter((m) => m.event === 'field_changes').at(-1);
  // Vehicle 1 saved; the agent opens the trailer form and picks its year at once.
  a.form.remove();
  const t = trailerForm(h, 51200);
  recorder.tick();
  recorder.trusted(t.year);
  t.year.value = '2022';
  recorder.tick();
  let message = lastChange();
  assert.deepEqual(plain(message.changes.map((c) => [c.key, c.agent])), [['ref:GiveYear', true]]);
  assert.deepEqual(plain(message.forms), [{ list: 'trailers', id: t.id, blank: true }]);
  // The owner check under Vehicles: no unit form.
  t.form.remove();
  const last = geicoBox('GiveLastName', 61001, 'Business Owner Last Name');
  h.document.body.append(last, geicoBox('GiveSocialSecurityNumber', 61004, 'Business Owner Social Security Number'));
  recorder.tick();
  recorder.trusted(last);
  last.value = 'Lane';
  recorder.tick();
  message = lastChange();
  assert.deepEqual(plain([message.changes.map((c) => c.key), message.forms]), [['ref:GiveLastName'], []]);
});

test('a GEICO step that can\'t be read (its bar and title disagree): a plan kept to steps does nothing there and reads nothing for its report', async () => {
  const plan = [
    { id: 'owner', field: 'GiveFirstName', steps: ['Business & Owner Info'], path: 'applicant.firstName', name: 'Owner first name', kind: 'text', value: 'Pat' },
    { id: 'zip', field: 'GiveZip', path: 'garaging.zip', name: 'ZIP', kind: 'text', value: '68102' },
  ];
  const h = harness({ pathname: '/quote' });
  const bar = geicoBar(h, 'Quote & Coverages', { title: 'GEICO Final Quote Details' });
  const zip = geicoBox('GiveZip', 1, '5-Digit ZIP Code', { required: true });
  const payPlan = gdsRadios('GivePayPlanV2', 2, 'How would the customer like to pay?', [['GEICO_PP_1Pay', 'Pay In Full'], ['GEICO_PP_12Pay', 'Monthly']]);
  // Enough unfamiliar questions to read as a changed page, were they read.
  const others = [3, 4, 5, 6, 7].map((n) => geicoBox(`GiveUnmapped${n}`, n, `Question ${n}`, { required: true }));
  h.document.body.append(zip, payPlan.group, ...others);
  const next = addButton(h, 'Next');
  next.onclick = () => { next._clicked = true; };
  const report = await h.kit.fill(plan, { maxRounds: 6, advance: { text: '^next$' } });
  assert.deepEqual(plain([report.halted, report.reason, report.stepKey]), [true, 'The step on screen could not be read (the progress bar and the page title disagree): fill again once the page settles.', '']);
  // Said apart from other halts: the panel tries an automatic fill once more instead of pausing them.
  assert.equal(report.stepUnread, true);
  assert.equal(zip.value, '');
  assert.equal(next._clicked, undefined);
  // Nothing of the page is the report's: no unfamiliar question (none for the AI assistant), no
  // required one, no changed page, no marks.
  assert.deepEqual(plain([...report.filled, ...report.unknown, ...report.leftRequired, ...report.noData, ...report.checks, ...report.labels]), []);
  assert.equal(report.pageChanged, false);
  assert.ok(report.blockers.includes(report.reason));
  assert.deepEqual([zip, ...others].map((x) => x.getAttribute('data-rater-autofill')), [null, null, null, null, null, null]);
  // A plan kept to no step has nothing a step decides: it fills there as before.
  const stepless = await h.kit.fill(plan.filter((s) => !s.steps), { maxRounds: 6 });
  assert.deepEqual([stepless.halted, zip.value], [false, '68102']);
  // Once the bar and the title agree, the plan fills.
  zip.value = '';
  bar.go('Quote & Coverages');
  const settled = await h.kit.fill(plan, { maxRounds: 6 });
  assert.deepEqual([settled.halted, settled.stepKey, zip.value, settled.stepUnread], [false, 'Quote & Coverages', '68102', false]);
  assert.equal(settled.unknown.length, 6);
});

test('on a step that is the agent\'s (stopSteps) nothing is typed or clicked, also when the agent moves there during the fill', async () => {
  const stopSteps = ['Final Quote Details', 'MVR & CLUE', 'Payment Information'];
  const [go] = buildPlan(geicoRecord(), { id: 'synthetic', useGenericRules: false, rules: [], actions: [{ id: 'go', text: '^go$' }] }).filter((s) => s.kind === 'action');
  const plan = [
    { id: 'zip', field: 'GiveZip', path: 'garaging.zip', name: 'ZIP', kind: 'text', value: '68102' },
    { id: 'city', field: 'GiveCity', path: 'garaging.city', name: 'City', kind: 'text', value: 'Omaha' },
    go,
  ];
  const page = (step, title) => {
    const h = harness({ pathname: '/quote' });
    const bar = geicoBar(h, step, { title });
    const zip = geicoBox('GiveZip', 1, '5-Digit ZIP Code');
    const city = geicoBox('GiveCity', 2, 'City');
    const clicks = [];
    for (const text of ['Go', 'Next']) addButton(h, text).onclick = () => clicks.push(text);
    h.document.body.append(zip, city);
    return { h, bar, zip, city, clicks, fill: () => h.kit.fill(plan, { maxRounds: 6, stopSteps, advance: { text: '^next$' } }) };
  };
  const stopped = (p, report, step) => {
    assert.equal(report.halted, true, step);
    assert.equal(report.reason, 'This step is yours: nothing is filled or clicked here.');
    assert.equal(report.stopStep, step);
    assert.equal(report.stepUnread, false, 'a step that is the agent\'s, not one that could not be read');
    assert.deepEqual(p.clicks, [], 'no helper and no Continue');
    assert.equal(p.city.value, '');
  };
  // On it as the fill starts: by the bar and the title, or by the title alone (the bar disagrees).
  for (const [step, title, at] of [['MVR & CLUE', undefined, 'MVR & CLUE'], ['Quote & Coverages', 'GEICO Payment Information', 'Payment Information']]) {
    const p = page(step, title);
    const report = await p.fill();
    stopped(p, report, at);
    assert.equal(p.zip.value, '');
    assert.deepEqual(plain([...report.filled, ...report.actions]), []);
    assert.equal(report.stepKey, title ? '' : step);
    // The AI assistant's answers are not put in there either.
    const answers = await p.h.kit.answer([{ key: 'ref:GiveZip', label: '5-Digit ZIP Code', value: '68102' }]);
    assert.deepEqual(plain(answers.map((x) => [x.ok, x.reason])), [[false, 'This step is yours: nothing is filled or clicked here.']]);
    assert.equal(p.zip.value, '');
  }
  // A kit no fill has told: the panel's stop steps, with the answers.
  const fresh = page('Payment Information');
  const answers = await fresh.h.kit.answer([{ key: 'ref:GiveZip', label: '5-Digit ZIP Code', value: '68102' }], null, null, { stopSteps });
  assert.equal(answers[0].ok, false);
  assert.equal(fresh.zip.value, '');
  // Another step fills and clicks as before.
  const quote = page('Vehicles');
  const report = await quote.fill();
  assert.deepEqual([quote.zip.value, quote.city.value, report.halted], ['68102', 'Omaha', false]);
  assert.deepEqual(quote.clicks, ['Go', 'Next']);
  // The agent clicks Next to MVR & CLUE while the first answer goes in: nothing more there, and
  // nothing of that step is read for the report.
  const moving = page('Quote & Coverages');
  moving.zip.addEventListener('change', () => moving.bar.go('MVR & CLUE'));
  const movedReport = await moving.fill();
  assert.equal(moving.zip.value, '68102');
  stopped(moving, movedReport, 'MVR & CLUE');
  assert.equal(movedReport.stepKey, 'Quote & Coverages', 'the report is the step the fill was on');
  assert.deepEqual(plain(movedReport.labels), []);
});

test('a fill ends when the agent moves to another step: the rest of its plan is not given there, nor is Continue clicked, and that step\'s questions are not its', async () => {
  const plan = [
    { id: 'zip', field: 'GiveZip', path: 'garaging.zip', name: 'ZIP', kind: 'text', value: '68102' },
    { id: 'city', field: 'GiveCity', path: 'garaging.city', name: 'City', kind: 'text', value: 'Omaha' },
  ];
  const h = harness({ pathname: '/quote' });
  const bar = geicoBar(h, 'Vehicles');
  const zip = geicoBox('GiveZip', 1, '5-Digit ZIP Code');
  const city = geicoBox('GiveCity', 2, 'City');
  const next = addButton(h, 'Next');
  next.onclick = () => { next._clicked = true; };
  h.document.body.append(zip, city);
  zip.addEventListener('change', () => {
    bar.go('Drivers & Incidents');
    h.document.body.append(geicoBox('GiveDriverLicenseNumber', 3, 'License number', { required: true }));
  });
  const report = await h.kit.fill(plan, { maxRounds: 6, advance: { text: '^next$' } });
  assert.deepEqual([zip.value, city.value, report.halted], ['68102', '', false]);
  assert.equal(next._clicked, undefined);
  assert.equal(report.stepKey, 'Vehicles');
  assert.deepEqual(plain([...report.unknown, ...report.leftRequired, ...report.noData]), []);
  // The step changes as an answer goes in that the page then drops (a round goes on to its next
  // answer after one not kept): that next answer isn't given on the new step either.
  const dropped = harness({ pathname: '/quote' });
  const droppedBar = geicoBar(dropped, 'Vehicles');
  const zip2 = geicoBox('GiveZip', 1, '5-Digit ZIP Code');
  const city2 = geicoBox('GiveCity', 2, 'City');
  dropped.document.body.append(zip2, city2);
  zip2.addEventListener('change', () => { droppedBar.go('Drivers & Incidents'); zip2.value = ''; });
  await dropped.kit.fill(plan, { maxRounds: 6 });
  assert.equal(city2.value, '');

  // Without a bar (AmWINS' headings change with its dialogs) the fill goes on as before.
  const amwinsLike = harness({ pathname: '/app' });
  const heading = new FakeNode('h3', { textContent: 'Vehicles' });
  const z = geicoBox('GiveZip', 1, 'ZIP');
  const c = geicoBox('GiveCity', 2, 'City');
  amwinsLike.document.body.append(heading, z, c);
  z.addEventListener('change', () => { heading.textContent = 'Drivers'; });
  await amwinsLike.kit.fill(plan, { maxRounds: 6 });
  assert.deepEqual([z.value, c.value], ['68102', 'Omaha']);
});

test('a helper kept to a step (GEICO\'s Recalculate) is clicked, or the agent\'s, only on that step', async () => {
  const actions = buildPlan(geicoRecord(), { id: 'synthetic', useGenericRules: false, rules: [], actions: [
    { id: 'recalculate', text: '^recalculate$', steps: ['Quote & Coverages'], needsRecalculation: true, verify: 'premium' },
    { id: 'addVehicle', text: '^add vehicle$', steps: ['Vehicles'], missing: 'Add each vehicle yourself.' },
  ] }).filter((s) => s.kind === 'action');
  const run = async (step) => {
    const h = harness({ pathname: '/quote' });
    geicoBar(h, step);
    // A later step's text can read like the stale premium too.
    h.document.body.innerText = 'Quote $ --.-- Due Today $ --.-- Total';
    const recalc = gdsButton('Recalculate');
    recalc.button.onclick = () => { recalc.clicked = true; h.document.body.innerText = 'Quote $1,000.00 Due Today $1,000.00 Total'; };
    h.document.body.append(recalc.host);
    const report = await h.kit.fill(actions, { maxRounds: 4 });
    return { clicked: !!recalc.clicked, actions: plain(report.actions.map((a) => a.id)), needs: plain(report.noData.map((x) => x.note)) };
  };
  assert.deepEqual(await run('Quote & Coverages'), { clicked: true, actions: ['recalculate'], needs: [] });
  assert.deepEqual(await run('Final Quote Details'), { clicked: false, actions: [], needs: [] });
  assert.deepEqual(await run('Vehicles'), { clicked: false, actions: [], needs: ['Add each vehicle yourself.'] });
});

// FL live run, 2026-10-21: GEICO drew the owner's date of birth and each VIN with their mask as the
// value, and the fill kept them as page values that differ from the intake.
test('a GEICO box showing only its mask has no answer yet: the intake\'s date of birth and VIN go in', async () => {
  for (const [mask, vinMask] of [['MM/DD/YYYY', '_'.repeat(17)], ['__/__/____', '_________________'], ['MM/DD/YY', '']]) {
    const h = harness({ pathname: '/quote' });
    const dob = geicoBox('GiveDateOfBirth', 99843, 'Date of Birth');
    dob.value = mask;
    const vin = makeInput({ id: 'Id_GiveVinPreQuote_64606', name: 'Id_GiveVinPreQuote_64606maskedField', ariaLabel: 'vin' });
    vin.value = vinMask;
    // A real value is still kept and flagged.
    const first = geicoBox('GiveFirstName', 1, 'Business Owner First Name');
    first.value = 'Pat';
    h.document.body.append(dob, vin, first);
    const report = await h.kit.fill([
      { id: 'dob', field: 'GiveDateOfBirth', path: 'drivers[0].dob', name: 'Owner date of birth', kind: 'date', value: '04/29/1971' },
      { id: 'vin', field: 'GiveVinPreQuote', path: 'vehicles[0].vin', name: 'VIN', kind: 'text', value: GEICO_VINS[0] },
      { id: 'first', field: 'GiveFirstName', path: 'drivers[0].first', name: 'Owner first name', kind: 'text', value: 'Sam' },
    ], { maxRounds: 4 });
    assert.deepEqual([dob.value, vin.value, first.value], ['04/29/1971', GEICO_VINS[0], 'Pat'], mask);
    assert.deepEqual(plain(report.kept.filter((x) => x.differs).map((x) => x.key)), ['ref:GiveFirstName'], mask);
  }
  // A partly typed date is an answer.
  const h = harness({ pathname: '/quote' });
  const dob = geicoBox('GiveDateOfBirth', 99843, 'Date of Birth');
  dob.value = '04/__/____';
  h.document.body.append(dob);
  await h.kit.fill([{ id: 'dob', field: 'GiveDateOfBirth', path: 'drivers[0].dob', name: 'Owner date of birth', kind: 'date', value: '04/29/1971' }], { maxRounds: 3 });
  assert.equal(dob.value, '04/__/____');
});

// FL live run, 2026-10-21: every fill set the liability limit again, GEICO requoted and put its own
// back, and the agent's choices went with it. A choice the page took back is the page's (or the
// agent's, through GEICO's own dialog): kept, flagged, never given again on that step.
test('GEICO Quote & Coverages: a choice an earlier fill gave that the page took back is kept and flagged', async () => {
  const h = harness({ pathname: '/quote' });
  const bar = geicoBar(h, 'Quote & Coverages');
  const comp = new SelectNode(['Not Included', '$500 deductible', '$1,000 deductible'], { id: `Id_${randomUUID()}_20000_COMP`, value: 'Not Included' });
  h.document.body.append(comp);
  const step = { id: 'comp', selector: '[id$="_COMP"]', steps: ['Quote & Coverages'], path: 'geico.qCOMP', name: 'Comprehensive', kind: 'choice', value: '$1,000 deductible' };
  const takenBack = (keys) => ({ steps: ['Quote & Coverages'], keys });
  // The step's first fill: GEICO's pre-selection replaced.
  let report = await h.kit.fill([step], { maxRounds: 3, replaceChoices: true, takenBack: takenBack({}) });
  assert.equal(comp.value, '$1,000 deductible');
  const key = report.filled[0].key;
  assert.equal(key, 'cov:COMP#1');
  // GEICO puts its own back: left as it is, a check for the agent.
  comp.value = 'Not Included';
  report = await h.kit.fill([step], { maxRounds: 3, replaceChoices: true, takenBack: takenBack({ [key]: true }) });
  assert.equal(comp.value, 'Not Included');
  assert.deepEqual(plain(report.filled), []);
  assert.deepEqual(plain(report.checks.map((x) => [x.key, x.note])), [[key, 'The page changed this back after it was filled (Comprehensive): left as it is. Check it.']]);
  // The agent asks to replace answers: given again.
  report = await h.kit.fill([step], { maxRounds: 3, replaceChoices: true, overwrite: true, takenBack: takenBack({ [key]: true }) });
  assert.equal(comp.value, '$1,000 deductible');
  // Another key, or another step: a pre-selection is replaced as before.
  comp.value = 'Not Included';
  await h.kit.fill([step], { maxRounds: 3, replaceChoices: true, takenBack: takenBack({ 'cov:COMP#2': true }) });
  assert.equal(comp.value, '$1,000 deductible');
  comp.value = 'Not Included';
  bar.go('Vehicles');
  await h.kit.fill([{ ...step, steps: ['Vehicles'] }], { maxRounds: 3, replaceChoices: true, takenBack: takenBack({ [key]: true }) });
  assert.equal(comp.value, '$1,000 deductible');
});

// FL live run 3, 2026-10-21: "with Click Continue when its done on, GEICO's should click Next".
// Only on its steps (never Quote & Coverages, whose Next leads to MVR & CLUE), never the chooser's
// Next (the add helpers' own), and per form and button: Vehicles is left by each unit's Next, then
// by Looks Good.
test('a Continue kept to steps, never inside the chooser, and continued per form and button', async () => {
  const advance = { text: '^(next|save and continue)$', steps: ['Business Class & USDOT', 'Vehicles'], notWithin: '[id^="Id_Chooser_"]', byForm: true };
  const plan = [{ id: 'zip', field: 'GiveZip', path: 'garaging.zip', name: 'ZIP', kind: 'text', value: '68102' }];
  const page = (step, { chooser = false } = {}) => {
    const h = harness({ pathname: '/quote' });
    geicoBar(h, step);
    h.document.body.append(geicoBox('GiveZip', 1, '5-Digit ZIP Code'));
    const clicks = [];
    const next = gdsButton('Next');
    next.button.onclick = () => clicks.push('Next');
    if (chooser) {
      const box = new FakeNode('div', { id: 'Id_Chooser_123' });
      box.append(next.host);
      h.document.body.append(box);
    } else h.document.body.append(next.host);
    return { h, clicks };
  };
  let p = page('Business Class & USDOT');
  let report = await p.h.kit.fill(plan, { maxRounds: 4, advance });
  assert.deepEqual(plain([p.clicks, report.advanced, report.advanceKey]), [['Next'], 'Next', 'Business Class & USDOT@next']);
  // Continued there already (the panel's doneSteps hold its key): the agent's now.
  p = page('Business Class & USDOT');
  report = await p.h.kit.fill(plan, { maxRounds: 4, advance, doneSteps: ['Business Class & USDOT@next'] });
  assert.deepEqual(plain([p.clicks, report.advanced ?? null]), [[], null]);
  // Not one of its steps (Quote & Coverages), or a step that can't be read: never.
  p = page('Quote & Coverages');
  await p.h.kit.fill(plan, { maxRounds: 4, advance });
  assert.deepEqual(p.clicks, []);
  // The chooser's Next is never Continue.
  p = page('Vehicles', { chooser: true });
  report = await p.h.kit.fill(plan, { maxRounds: 4, advance });
  assert.deepEqual(plain([p.clicks, report.advanced ?? null]), [[], null]);
  // A unit's form: its key names the form, so the next unit's form is continued too.
  const formPage = (n) => {
    const h = harness({ pathname: '/quote' });
    geicoBar(h, 'Vehicles');
    const f = geicoVehicleForm(h, n);
    const clicks = [];
    const next = gdsButton('Next');
    next.button.onclick = () => clicks.push('Next');
    h.document.body.append(next.host);
    return { h, f, clicks };
  };
  const formPlan = [{ id: 'handy0', field: 'YesNoPreQuoteHaveFullVinActivity', steps: ['Vehicles'], path: 'vehicles[0].vin', name: 'VIN handy', kind: 'radio', value: 'Yes' }, ...vehicleFormPlan(0)];
  const first = formPage(85493);
  report = await first.h.kit.fill(formPlan, { maxRounds: 8, advance, units: geicoUnits(0, {}) });
  assert.equal(report.advanceKey, 'Vehicles@next@Id_YesNoPreQuoteHaveFullVinActivity_85493');
  const second = formPage(37768);
  report = await second.h.kit.fill(formPlan, { maxRounds: 8, advance, units: geicoUnits(0, {}), doneSteps: ['Vehicles@next@Id_YesNoPreQuoteHaveFullVinActivity_85493'] });
  assert.deepEqual(plain([second.clicks, report.advanceKey]), [['Next'], 'Vehicles@next@Id_YesNoPreQuoteHaveFullVinActivity_37768']);
  // Without byForm (AmWINS), a step is continued once, by its name, as before.
  p = page('Business Class & USDOT');
  report = await p.h.kit.fill(plan, { maxRounds: 4, advance: { text: '^next$' } });
  assert.deepEqual(plain([p.clicks, report.advanceKey ?? null]), [['Next'], null]);
});

// GEICO draws a question a moment after an answer (the USDOT record's address check, after the
// USDOT number): with `quietMs`, Continue waits for the page to be quiet, and a question drawn
// meanwhile without an answer holds it (the follow-up fill for that question decides).
test('a Continue with quietMs waits for the page, and a question drawn meanwhile without an answer holds it', async () => {
  const advance = { text: '^next$', steps: ['Business Class & USDOT'], byForm: true, quietMs: 800 };
  const plan = [{ id: 'dot', field: 'GiveDepartmentOfTransportationNumber', path: 'applicant.dot', name: 'USDOT number', kind: 'text', value: '1234567' }];
  const page = (draws) => {
    const h = harness({ pathname: '/quote' });
    geicoBar(h, 'Business Class & USDOT');
    const dot = geicoBox('GiveDepartmentOfTransportationNumber', 11, 'What is the customer\'s USDOT number?');
    const clicks = [];
    const next = gdsButton('Next');
    next.button.onclick = () => clicks.push('Next');
    h.document.body.append(dot, next.host);
    if (draws) dot.addEventListener('change', () => setTimeout(() => h.document.body.append(gdsRadios('GiveExtendUsDotVerifyBusinessAddress', 12, 'Is this the customer\'s business?', [['Yes', 'Yes'], ['No', 'No']]).group), 200));
    return { h, clicks };
  };
  let p = page(true);
  let report = await p.h.kit.fill(plan, { maxRounds: 6, advance });
  assert.deepEqual(plain([p.clicks, report.advanced ?? null, report.filled.length]), [[], null, 1]);
  // Nothing drawn after the answer: Continue.
  p = page(false);
  report = await p.h.kit.fill(plan, { maxRounds: 6, advance });
  assert.deepEqual(plain([p.clicks, report.advanced]), [['Next'], 'Next']);
});

test('unitFormsNow says whether a unit form is new: its first question unanswered', async () => {
  const h = harness({ pathname: '/quote' });
  geicoBar(h, 'Vehicles');
  const a = geicoVehicleForm(h, 85493);
  await h.kit.fill(vehicleFormPlan(0), { maxRounds: 6, units: geicoUnits(0, {}) });
  assert.deepEqual(plain(h.kit.unitFormsNow()), [{ list: 'vehicles', id: a.id, blank: true }]);
  a.marker.hosts[0].input.click();
  assert.deepEqual(plain(h.kit.unitFormsNow()), [{ list: 'vehicles', id: a.id, blank: false }]);
});

// FL live run 2, 2026-10-21: GEICO's VIN decode redrew the vehicle form and cleared the type the
// fill had just picked (the Cascadia's Tractor, three times). With `waitFor`, the type waits for the
// decoded year.
test('a step with waitFor is answered only once that question has its answer; one still waiting when the fill ends is reported', async () => {
  const h = harness({ pathname: '/quote' });
  geicoBar(h, 'Vehicles');
  const year = geicoList('GiveYear', 11, 'Year', ['', '2016']);
  const type = geicoList('GiveOtherVehicleType', 12, 'Which of the following best describes the customer\'s vehicle?', ['', 'Dump Truck', 'Tractor']);
  h.document.body.append(year, type);
  const step = { id: 'type', field: 'GiveOtherVehicleType', path: 'geico.qGiveOtherVehicleType', name: 'Vehicle type', kind: 'choice', value: 'Tractor', waitFor: 'GiveYear' };
  let typeAtDecode = null;
  // The decode answers later, redrawing the form: whatever type was picked before it is cleared.
  setTimeout(() => { typeAtDecode = type.value; year.value = '2016'; type.value = ''; }, 900);
  let report = await h.kit.fill([step], { maxRounds: 30 });
  assert.equal(typeAtDecode, '', 'nothing picked before the decode');
  assert.equal(type.value, 'Tractor');
  assert.deepEqual([report.filled.length, report.failed.length], [1, 0]);

  // The decode never comes before the fill's rounds run out: the type is unanswered, and said so.
  const h2 = harness({ pathname: '/quote' });
  geicoBar(h2, 'Vehicles');
  const type2 = geicoList('GiveOtherVehicleType', 22, 'Which of the following best describes the customer\'s vehicle?', ['', 'Dump Truck', 'Tractor']);
  h2.document.body.append(geicoList('GiveYear', 21, 'Year', ['', '2016']), type2);
  report = await h2.kit.fill([step], { maxRounds: 2 });
  assert.equal(type2.value, '');
  assert.deepEqual(plain(report.failed.map((x) => [x.key, x.reason])), [['ref:GiveOtherVehicleType', 'the page was still working on this question; check it']]);

  // A VIN GEICO doesn't decode: the year stays empty. Answered once the wait runs out, and a later
  // fill of the same form doesn't wait for that year again.
  const h4 = harness({ pathname: '/quote' });
  geicoBar(h4, 'Vehicles');
  const type4 = geicoList('GiveOtherVehicleType', 42, 'Which of the following best describes the customer\'s vehicle?', ['', 'Dump Truck', 'Tractor']);
  h4.document.body.append(geicoList('GiveYear', 41, 'Year', ['', '2016']), type4);
  let started = clock.Date.now();
  report = await h4.kit.fill([step], { maxRounds: 60 });
  assert.equal(type4.value, 'Tractor');
  assert.deepEqual([report.failed.length, clock.Date.now() - started >= 8000], [0, true], 'waited out, then answered');
  type4.value = '';
  started = clock.Date.now();
  report = await h4.kit.fill([step], { maxRounds: 60 });
  assert.equal(type4.value, 'Tractor');
  assert.ok(clock.Date.now() - started < 2000, `the next fill waited ${clock.Date.now() - started} ms`);

  // No such question on the page yet: GEICO draws the decoded year only when its decode comes back
  // (FL live run 3, 2026-10-21), so it is waited for too. One never drawn is waited out, then
  // answered, and not waited for again on that form.
  const h3 = harness({ pathname: '/quote' });
  geicoBar(h3, 'Vehicles');
  const type3 = geicoList('GiveOtherVehicleType', 32, 'Which of the following best describes the customer\'s vehicle?', ['', 'Dump Truck', 'Tractor']);
  h3.document.body.append(type3);
  report = await h3.kit.fill([step], { maxRounds: 3 });
  assert.deepEqual([type3.value, report.failed.length], ['', 1], 'still waiting when its rounds ran out');
  started = clock.Date.now();
  report = await h3.kit.fill([step], { maxRounds: 60 });
  assert.deepEqual([type3.value, report.failed.length, clock.Date.now() - started >= 8000], ['Tractor', 0, true]);
  type3.value = '';
  started = clock.Date.now();
  await h3.kit.fill([step], { maxRounds: 60 });
  assert.equal(type3.value, 'Tractor');
  assert.ok(clock.Date.now() - started < 2000, `the next fill waited ${clock.Date.now() - started} ms`);
});

// FL live run 3, 2026-10-21: the fill typed the VIN and picked Delivery Van at once; GEICO drew the
// decoded year 1.5 s later and cleared the type, distance and personal use. On the semi truck the
// year came in during the fill and the type list was filled again a moment after the fill's last
// look: Tractor was gone, and the agent picked it again.
test('a waitFor question drawn late is waited for; what it redraws a moment later is waited out, and a cleared answer is given again', async () => {
  const typeStep = { id: 'type', field: 'GiveOtherVehicleType', path: 'geico.qGiveOtherVehicleType', name: 'Vehicle type', kind: 'choice', value: 'Tractor', waitFor: 'GiveYear' };
  const distanceStep = { id: 'distance', field: 'GiveFarthestOneWayDistance', path: 'geico.qGiveFarthestOneWayDistance', name: 'Distance', kind: 'choice', value: '101-200', waitFor: 'GiveYear' };
  const TYPES = ['', 'Dump Truck', 'Tractor'];
  // The decode: the year drawn with its value, then (`lag` ms later) the type list drawn anew and
  // the distance emptied.
  const decodingPage = (lag) => {
    const h = harness({ pathname: '/quote' });
    geicoBar(h, 'Vehicles');
    const type = geicoList('GiveOtherVehicleType', 12, 'Which of the following best describes the customer\'s vehicle?', TYPES);
    const distance = geicoList('GiveFarthestOneWayDistance', 13, 'How far?', ['', '0-100', '101-200']);
    h.document.body.append(type, distance);
    const seen = {};
    setTimeout(() => {
      const year = geicoList('GiveYear', 11, 'Year', ['', '2016']);
      year.value = '2016';
      h.document.body.append(year);
      setTimeout(() => { seen.typeAtRedraw = type.value; type.value = ''; distance.value = ''; }, lag);
    }, 1500);
    return { h, type, distance, seen };
  };
  const p = decodingPage(300);
  const report = await p.h.kit.fill([typeStep, distanceStep], { maxRounds: 60 });
  assert.equal(p.seen.typeAtRedraw, '', 'nothing picked before the redraw');
  assert.deepEqual([p.type.value, p.distance.value, report.failed.length], ['Tractor', '101-200', 0]);

  // The year already in, and the type list drawn anew just after the fill's last answer: the fill's
  // last look, once the page has gone quiet, gives it again.
  const h = harness({ pathname: '/quote' });
  geicoBar(h, 'Vehicles');
  const type = geicoList('GiveOtherVehicleType', 22, 'Which of the following best describes the customer\'s vehicle?', TYPES);
  const year = geicoList('GiveYear', 21, 'Year', ['', '2016']);
  year.value = '2016';
  h.document.body.append(year, type);
  let cleared = 0;
  type.addEventListener('change', () => { if (!cleared++) setTimeout(() => { type.value = ''; }, 300); });
  const again = await h.kit.fill([typeStep], { maxRounds: 60 });
  assert.deepEqual([type.value, cleared, again.filled.length, again.failed.length], ['Tractor', 2, 1, 0]);
  // A plan that waits on nothing takes no last look: an answer cleared after the fill stays for the
  // follow-up, as before.
  const plainPage = harness({ pathname: '/quote' });
  geicoBar(plainPage, 'Vehicles');
  const plainType = geicoList('GiveOtherVehicleType', 32, 'Which of the following best describes the customer\'s vehicle?', TYPES);
  plainPage.document.body.append(plainType);
  let plainCleared = 0;
  plainType.addEventListener('change', () => { if (!plainCleared++) setTimeout(() => { plainType.value = ''; }, 300); });
  await plainPage.kit.fill([{ ...typeStep, waitFor: null }], { maxRounds: 60 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual([plainType.value, plainCleared], ['', 1], 'cleared after the fill ended: left to the follow-up');
});

// FL live run 2: a leased vehicle's collision row offers only "Not Included" until its comprehensive
// is chosen, and the fill gave up on rows 1 and 2 before GEICO drew their deductibles.
test('a list whose only option shows twice is still loading: waited for; a full list without the answer fails at once', async () => {
  const h = harness({ pathname: '/quote' });
  geicoBar(h, 'Quote & Coverages');
  const coll = geicoList('GiveCollision', 41, 'Collision', [{ text: 'Not Included', value: '' }, { text: 'Not Included', value: 'NI' }]);
  h.document.body.append(coll);
  setTimeout(() => { for (const text of ['$500 deductible', '$1,000 deductible']) { const o = new OptionNode(text); coll.options.push(o); coll.append(o); } }, 700);
  const step = { id: 'coll', field: 'GiveCollision', path: 'geico.qCOLL', name: 'Collision', kind: 'choice', value: '$1,000 deductible' };
  let report = await h.kit.fill([step], { maxRounds: 30 });
  assert.equal(coll.value, '$1,000 deductible');
  assert.deepEqual([report.filled.length, report.failed.length], [1, 0]);

  const h2 = harness({ pathname: '/quote' });
  geicoBar(h2, 'Quote & Coverages');
  h2.document.body.append(geicoList('GiveCollision', 51, 'Collision', ['Not Included', '$500 deductible']));
  const t0 = Date.now();
  report = await h2.kit.fill([step], { maxRounds: 30 });
  assert.ok(Date.now() - t0 < 2000, 'no wait');
  assert.deepEqual(plain(report.failed.map((x) => x.reason)), ['no option matches "$1,000 deductible"']);
});
