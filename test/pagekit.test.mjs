import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { buildPlan } from '../src/plan.js';
import { progressive } from '../src/carriers/progressive.js';

// This is a deliberately small DOM/ExtJS replay.  It exercises the injected MAIN-world
// script itself, without a browser session, real quote data, or customer identifiers.
const PAGEKIT = fs.readFileSync(new URL('../src/content/pagekit.js', import.meta.url), 'utf8');
const RECORDER = fs.readFileSync(new URL('../src/content/recorder.js', import.meta.url), 'utf8');

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

  getRootNode() { return this.ownerDocument ?? this; }

  append(...nodes) {
    for (const node of nodes) {
      if (!node) continue;
      node.parentElement = this;
      node.ownerDocument = this.ownerDocument;
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

  matches(selector) { return matchesSelector(this, selector); }

  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }

  contains(node) {
    for (let p = node; p; p = p.parentElement) if (p === this) return true;
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
    setTimeout,
    clearTimeout,
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
  vm.runInNewContext(PAGEKIT, context, { filename: 'src/content/pagekit.js' });
  return { context, document, kit: context.__raterKit };
}

function recorderHarness() {
  const document = new FakeDocument();
  const sent = [];
  let tick;
  const context = {
    document,
    location: { origin: 'https://synthetic.example', pathname: '/rater', search: '?pageName=AddVehicle' },
    window: null,
    NodeFilter: { SHOW_TEXT: 4 },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    URLSearchParams,
    addEventListener() {},
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
  vm.runInNewContext(RECORDER, context, { filename: 'src/content/recorder.js' });
  return { context, document, sent, tick: () => tick?.() };
}

function addExtText(h, prefix, question, options = {}) {
  const group = 'A'.repeat(32);
  const id = `f_${prefix}${group}${question}_1_1`;
  const input = makeInput({ id, ariaLabel: options.caption ?? `Question ${question}`, value: options.value ?? '' });
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

test('Freight Hauler searches the remote business dropdown and verifies a collapsed General Freight summary', async () => {
  for (const offered of ['General Freight Hauler', 'General Freight Trucking']) {
    const h = harness({ ext: true, search: '?pageName=BusinessOwnerInfo' });
    const structure = new SelectNode([{ text: 'Individual / Sole Proprietor', value: 'individual' }], { id: `f_c${'A'.repeat(32)}22D_1_1`, ariaLabel: 'Business structure' });
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
    const report = await h.kit.fill([{ id: 'value', q: '2CE8', path: 'vehicles[0].value', kind: 'money', value: 25000 }]);
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
    { id: 'u', q: '1A01', path: 'synthetic.u', name: 'U', kind: 'text', value: 'one' },
    { id: 'p', q: '1A02', path: 'synthetic.p', name: 'P', kind: 'text', value: 'two' },
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
    const replacement = makeInput({ id: field.id, ariaLabel: 'Redrawn field', value: String(value) });
    this.el.dom.parentElement.replaceChild(replacement, this.el.dom);
    this.el.dom = replacement;
  };
  const report = await h.kit.fill([{ id: 'redraw', q: '2B01', path: 'redraw.value', kind: 'text', value: 'accepted' }], { maxRounds: 2 });
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
    const replacement = makeInput({ id: field.id, ariaLabel: 'Rejected field', value: 'server value' });
    this.el.dom.parentElement.replaceChild(replacement, this.el.dom);
    this.el.dom = replacement;
  };
  const helper = addButton(h, 'Lookup VIN');
  const report = await h.kit.fill([
    { id: 'reject', q: '2B02', path: 'rejected.value', kind: 'text', value: 'intake value' },
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

test('repeated question ids without a vehicle hint stay yellow, and a hint picks the right row', async () => {
  const h = harness({ ext: true });
  const first = addExtText(h, 'U', '3C01', { caption: 'Vehicle one value' });
  const second = addExtText(h, 'P', '3C01', { caption: 'Vehicle two value' });
  const report = await h.kit.fill([
    { id: 'duplicate-step', q: '3C01', path: 'vehicles[0].value', kind: 'text', value: '45000' },
  ], { maxRounds: 2 });
  assert.equal(report.halted, false);
  assert.equal(first.input.value, '');
  assert.equal(second.input.value, '');
  assert.ok(report.unknown.length >= 2);
  // With the active vehicle's year/make/model, the matching row is filled.
  const hinted = await h.kit.fill([
    { id: 'hinted-step', q: '3C01', path: 'vehicles[1].value', kind: 'text', value: '45000', vehicleHint: ['vehicle two'] },
  ], { maxRounds: 2 });
  assert.equal(second.input.value, '45000');
  assert.equal(first.input.value, '');
  assert.equal(hinted.filled.length, 1);
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
    { id: 'duplicate-step', q: '3C01', path: 'vehicle.value', kind: 'text', value: '45000' },
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

test('Print/Send works from the current Print page without remembered navigation, preserving fax cover', async () => {
  const h = harness({ search: '?pageName=PrintEmailFax' });
  const quote = makeInput({ id: `f_c${'A'.repeat(32)}32B0_1_1`, name: 'docs_32B0', type: 'radio', value: 'Insurance Quote (with all bill plans)', checked: true });
  const docs = makeInput({ id: 'doc-set', name: 'docs_32B0', type: 'radio', value: 'Document Set' });
  const print = makeInput({ id: `f_c${'A'.repeat(32)}32CC_1_1`, ariaLabel: 'Print', type: 'checkbox', checked: true });
  const cover = makeInput({ id: `f_c${'A'.repeat(32)}32CE_1_1`, ariaLabel: 'Agent Fax Cover Page', type: 'checkbox', checked: true });
  const email = makeInput({ id: `f_c${'A'.repeat(32)}32D0_1_1`, ariaLabel: 'Email', type: 'checkbox' });
  const fax = makeInput({ id: `f_c${'A'.repeat(32)}32DD_1_1`, ariaLabel: 'Fax', type: 'checkbox' });
  h.document.body.append(quote, docs, print, cover, email, fax);
  const button = addButton(h, 'Print/Send');
  let clicks = 0;
  button.onclick = () => clicks++;
  const record = { applicant: {}, garaging: {}, operations: {}, drivers: [], vehicles: [], priorInsurance: [], coverage: {}, claims: {} };
  const report = await h.kit.fill(buildPlan(record, progressive), { doneActions: [] });
  assert.equal(clicks, 1);
  assert.equal(cover.checked, true);
  assert.equal(email.checked, false);
  assert.equal(fax.checked, false);
  assert.equal(report.unknown.length, 0);
  assert.equal(report.documentPending, true);
  assert.ok(report.actions.some((action) => action.id === 'printSend'));
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
    { id: 'cargo-value', q: '216F', path: 'progressive.q216F', kind: 'text', value: '$100000/$1000' },
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
    { id: 'commodity', q: '216A', path: 'progressive.q216A', kind: 'text', value: null, ignore: true },
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
  const controls = [
    addExtText(h, 'U', '2AE', { caption: 'Zip Code', required: true }),
    addExtText(h, 'U', '2B0', { caption: 'City', required: true }),
    addExtText(h, 'P', '284', { caption: 'Zip Code', required: true }),
    addExtText(h, 'P', '286', { caption: 'City', required: true }),
  ];
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
  assert.equal(report.filled.length, 4);
  assert.deepEqual(controls.map(({ input }) => input.value), ['21000', 'Example City', '21000', 'Example City']);
});

test('blank optional address detail and blank DOT do not stop standard business-page filling', async () => {
  for (const unit of [null, 'Suite 4']) {
    const h = harness({ search: '?pageName=BusinessOwnerInfo' });
    const detail = makeInput({ id: 'address-detail', ariaLabel: 'Apt, Building, Floor, Suite, etc.' });
    const street = makeInput({ id: `f_U${'A'.repeat(32)}27E_1_1`, ariaLabel: 'Street address' });
    const name = makeInput({ id: `f_U${'A'.repeat(32)}230_1_1`, ariaLabel: 'Business name' });
    const dotNumber = makeInput({ id: `f_U${'A'.repeat(32)}1F3_1_1`, ariaLabel: 'USDOT Number' });
    const dot = new SelectNode([
      { text: 'Yes - the customer has a USDOT number', value: 'yes' },
      { text: 'Not Yet - but the customer has applied/will apply for a USDOT number within 60 days', value: 'pending' },
      { text: 'No - and the customer will not have a USDOT number', value: 'no' },
    ], { id: `f_U${'A'.repeat(32)}1ED_1_1`, ariaLabel: 'Has a USDOT number' });
    h.document.body.append(detail, street, dot, name, dotNumber);
    const record = {
      applicant: { name: 'Example LLC', dot: null, mcDotWithin60Days: null, owner1: 'Test Owner' },
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
    ], { id: `f_U${'A'.repeat(32)}267_1_1`, ariaLabel: 'Type of Trucker' });
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
    const manual = makeInput({ id: 'manual-home', name: 'home_2A5', type: 'radio', value: 'Enter a different address', checked: true });
    const primary = makeInput({ id: `f_U${'A'.repeat(32)}2A5_1_1`, name: 'home_2A5', type: 'radio', value: '10 Test Road Example City MD 21000 (Primary Business Address)' });
    const usdot = makeInput({ id: 'usdot-home', name: 'home_2A5', type: 'radio', value: '20 Registered Road Example City MD 21000 (USDOT address)' });
    const street = makeInput({ id: `f_U${'A'.repeat(32)}2AA_1_1`, ariaLabel: 'Street Address' });
    const zip = makeInput({ id: `f_U${'A'.repeat(32)}2AE_1_1`, ariaLabel: 'Zip Code' });
    const city = makeInput({ id: `f_U${'A'.repeat(32)}2B0_1_1`, ariaLabel: 'City' });
    if (hasDot) h.document.body.append(usdot);
    h.document.body.append(primary, manual, street, zip, city);
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
  const manual = makeInput({ id: `f_U${'A'.repeat(32)}2A5_1_1`, name: 'home_2A5', type: 'radio', value: 'Enter a different address', checked: true });
  h.document.body.append(manual);
  const record = { applicant: {}, garaging: {}, operations: {}, drivers: [], vehicles: [], priorInsurance: [], coverage: {}, claims: {} };
  const report = await h.kit.fill(buildPlan(record, progressive), { replaceChoices: true });
  assert.equal(report.halted, false);
  assert.equal(manual.checked, true);
  assert.equal(report.filled.length, 0);
});

test('home address uses offered USDOT address when Primary Business Address is absent', async () => {
  const h = harness({ search: '?pageName=BusinessOwnerInfo' });
  const offered = makeInput({ id: `f_U${'A'.repeat(32)}2A5_1_1`, name: 'home_2A5', type: 'radio', value: '10 Test Road Example City MD 21000 (USDOT address)' });
  const manual = makeInput({ id: 'manual-home', name: 'home_2A5', type: 'radio', value: 'Enter a different address', checked: true });
  h.document.body.append(offered, manual);
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
    h.document.body.append(...radios);
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
  const street = makeInput({ id: `f_U${'A'.repeat(32)}27E_1_1`, ariaLabel: 'Street Address' });
  const zip = makeInput({ id: `f_U${'A'.repeat(32)}284_1_1`, ariaLabel: 'Zip Code' });
  const city = makeInput({ id: `f_U${'A'.repeat(32)}286_1_1`, ariaLabel: 'City' });
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
