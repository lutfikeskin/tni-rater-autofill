import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { buildPlan } from '../src/plan.js';
import { progressive } from '../src/carriers/progressive.js';
import { fieldChangeEvent, redactor } from '../src/usage.js';

// This is a deliberately small DOM/ExtJS replay.  It exercises the injected MAIN-world
// script itself, without a browser session, real quote data, or customer identifiers.
const PAGEKIT = fs.readFileSync(new URL('../src/content/pagekit.js', import.meta.url), 'utf8');
const FIELD_KEY = fs.readFileSync(new URL('../src/content/field-key.js', import.meta.url), 'utf8');
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

  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }

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

function addExtText(h, prefix, question, options = {}) {
  const group = 'A'.repeat(32);
  const id = `f_${prefix}${group}${question}_${options.row ?? '1_1'}`;
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
    h.document.body.append(...radios);
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
  const first = addExtText(h, 'U', '3C01', { caption: '2021 FORD TRANSIT 350', row: '8_1' });
  const second = addExtText(h, 'P', '3C01', { caption: '2019 ISUZU NPR HD', row: '8_2' });
  const report = await h.kit.fill([
    { id: 'duplicate-step', q: '3C01', path: 'vehicles[0].value', kind: 'text', value: '45000' },
  ], { maxRounds: 2 });
  assert.equal(report.halted, false);
  assert.equal(first.input.value, '');
  assert.equal(second.input.value, '');
  assert.ok(report.unknown.length >= 2);
  // With the step's vehicle's year/make/model, the matching row is filled.
  const hinted = await h.kit.fill([
    { id: 'hinted-step', q: '3C01', path: 'vehicles[1].value', kind: 'text', value: '45000', vehicleHint: ['2019', 'isuzu', 'npr hd'], activeVehicle: false },
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
    { id: `rental-${i}`, q: '1FF2', path: 'progressive.q1FF2', kind: 'text', value: `rental ${i}`, vehicleHint: v.hint, activeVehicle: i === 2 },
    { id: `worth-${i}`, q: '2091', path: `vehicles[${i}].value`, kind: 'text', value: v.value, vehicleHint: v.hint, activeVehicle: i === 2 },
  ]);
  // A label fallback for the active (last) vehicle must not take the first row's box.
  plan.push({ id: 'fallback', q: '2CE8', path: 'vehicles[2].value', kind: 'text', value: '22000', re: 'sold today' });
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
    { id: 'ram', q: '1FF2', path: 'progressive.q1FF2', kind: 'text', value: 'ram rental', vehicleHint: ['2025', 'ram', 'promaster 2500'], activeVehicle: false },
    { id: 'sprinter', q: '1FF2', path: 'progressive.q1FF2', kind: 'text', value: 'sprinter rental', vehicleHint: ['2019', 'mercedes benz', 'sprinter'], activeVehicle: true },
  ], { maxRounds: 4, skip: ['1FF2@2'] });
  assert.equal(sprinter.input.value, '', 'the edited row is left alone');
  assert.equal(ram.input.value, 'ram rental', 'the other vehicle still fills');
  assert.deepEqual(Array.from(report.filled, (x) => x.key), ['1FF2'], 'the first row keeps the plain id');
});

test('two vehicles that read the same leave their rows to the agent', async () => {
  const h = harness({ ext: true });
  const first = addExtText(h, 'c', '1FF2', { caption: '2025 RAM PROMASTER 2500', row: '8_1' });
  const second = addExtText(h, 'c', '1FF2', { caption: '2025 RAM PROMASTER 2500', row: '8_2' });
  const hint = ['2025', 'ram', 'promaster 2500'];
  const report = await h.kit.fill([
    { id: 'a', q: '1FF2', path: 'progressive.q1FF2', kind: 'text', value: 'A', vehicleHint: hint, activeVehicle: true },
    { id: 'b', q: '1FF2', path: 'progressive.q1FF2', kind: 'text', value: 'B', vehicleHint: hint, activeVehicle: false },
  ], { maxRounds: 3 });
  assert.equal(first.input.value, '');
  assert.equal(second.input.value, '');
  assert.equal(report.filled.length, 0);
  // A year alone isn't enough to name a row.
  const h2 = harness({ ext: true });
  const ford = addExtText(h2, 'c', '1FF2', { caption: '2025 FORD TRANSIT', row: '8_1' });
  await h2.kit.fill([{ id: 'c', q: '1FF2', path: 'progressive.q1FF2', kind: 'text', value: 'C', vehicleHint: hint, activeVehicle: true }], { maxRounds: 2 });
  assert.equal(ford.input.value, '');
  // Codex on PR #21: an intake vehicle with one identifier can't name a row, even a unique match.
  const h3 = harness({ ext: true });
  const sprinter = addExtText(h3, 'c', '1FF2', { caption: '2019 MERCEDES-BENZ SPRINTER', row: '8_1' });
  addExtText(h3, 'c', '1FF2', { caption: '2016 FREIGHTLINER CASCADIA 125', row: '8_2' });
  await h3.kit.fill([{ id: 'd', q: '1FF2', path: 'progressive.q1FF2', kind: 'text', value: 'D', vehicleHint: ['sprinter'], activeVehicle: true }], { maxRounds: 2 });
  assert.equal(sprinter.input.value, '');
});

test('a page showing one vehicle at a time is answered by the active vehicle only', async () => {
  const h = harness({ ext: true });
  const worth = addExtText(h, 'r', '2091', { caption: 'If this vehicle was sold today, how much would it be worth?', row: '4_1' });
  const report = await h.kit.fill([
    { id: 'first', q: '2091', path: 'vehicles[0].value', kind: 'text', value: '31000', vehicleHint: ['2025', 'ram', 'promaster 2500'], activeVehicle: false },
    { id: 'second', q: '2091', path: 'vehicles[1].value', kind: 'text', value: '17000', vehicleHint: ['2019', 'mercedes benz', 'sprinter'], activeVehicle: true },
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
    { id: 'undescribed', q: '2091', path: 'vehicles[0].value', kind: 'text', value: '31000', vehicleHint: null, activeVehicle: false },
    { id: 'active', q: '2091', path: 'vehicles[1].value', kind: 'text', value: '17000', vehicleHint: ['2019', 'mercedes benz', 'sprinter'], activeVehicle: true },
  ], { maxRounds: 3 });
  assert.equal(worth.input.value, '17000');
  // On Rates (rows named by their vehicle) it can't pick a row, even its own.
  h = harness({ ext: true });
  const row = addExtText(h, 'c', '1FF2', { caption: '2025 RAM PROMASTER 2500', row: '8_1' });
  const report = await h.kit.fill([
    { id: 'undescribed-rates', q: '1FF2', path: 'progressive.q1FF2', kind: 'text', value: 'rental', vehicleHint: null, activeVehicle: true },
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
    { id: `rental-${v}`, q: '1FF2', path: 'progressive.q1FF2', kind: 'text', value: 'rental', vehicleHint: hint(v), activeVehicle: v === 1 },
    { id: `loan-${v}`, q: '2007', path: 'progressive.q2007', kind: 'text', value: 'loan', vehicleHint: hint(v), activeVehicle: v === 1 },
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
  h.context.Ext._components.set('boundlist-2', { pickerField: { dctCaption: 'Vehicle type' } });
  h.document.body.append(vin, phone, orphan, owned,
    new FakeNode('div', { role: 'alert', textContent: 'VIN 1HGBH41JXMN109186 not found; call 555 201 0199' }));
  const page = h.kit.capture(null, []);
  assert.deepEqual([...page.messages], ['VIN [typed] not found; call [typed]']);
  assert.deepEqual(JSON.parse(JSON.stringify(page.openLists.map((l) => [l.label, l.options]))), [[null, []], ['Vehicle type', ['Cargo Van']]]);
});
