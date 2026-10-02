import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const PAGEKIT = fs.readFileSync(new URL('../src/content/pagekit.js', import.meta.url), 'utf8');

// A deliberately small DOM. These tests exercise the extension's injected script directly,
// without requiring a browser or adding a DOM package to the extension's dependencies.
const DOCUMENT_POSITION_FOLLOWING = 4;

class FakeAttributes extends Map {
  *[Symbol.iterator]() {
    for (const [name, value] of super.entries()) yield { name, value };
  }
}

class FakeText {
  constructor(value, parent = null) {
    this.nodeType = 3;
    this.nodeValue = String(value);
    this.parentElement = parent;
  }

  get textContent() { return this.nodeValue; }
}

class FakeElement {
  constructor(tagName, attrs = {}) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.attributes = new FakeAttributes();
    this.children = [];
    this.parentElement = null;
    this.ownerDocument = null;
    this.style = {};
    this.dataset = {};
    this.listeners = new Map();
    this.className = '';
    this._text = '';
    this._value = '';
    this.checked = false;
    this.disabled = false;
    this.readOnly = false;
    this.required = false;
    this.maxLength = 0;
    this.type = this.tagName === 'INPUT' ? 'text' : undefined;
    for (const [key, value] of Object.entries(attrs)) this.setAttribute(key, value);
  }

  append(...nodes) {
    for (const node of nodes) {
      const child = node instanceof FakeText || node instanceof FakeElement ? node : new FakeText(node);
      child.parentElement = this;
      if (child instanceof FakeElement) child.ownerDocument = this.ownerDocument;
      this.children.push(child);
    }
    return nodes.at(-1);
  }

  appendChild(node) { return this.append(node); }

  removeChild(node) {
    const i = this.children.indexOf(node);
    if (i >= 0) this.children.splice(i, 1);
    node.parentElement = null;
    return node;
  }

  replaceChild(next, previous) {
    const i = this.children.indexOf(previous);
    if (i < 0) throw new Error('child not found');
    next.parentElement = this;
    next.ownerDocument = this.ownerDocument;
    this.children[i] = next;
    return previous;
  }

  get textContent() {
    if (this.children.length) return this.children.map((child) => child.textContent).join('');
    return this._text;
  }

  set textContent(value) {
    this.children = [];
    this._text = String(value ?? '');
  }

  setAttribute(name, value) {
    const key = String(name).toLowerCase();
    const text = String(value);
    this.attributes.set(key, text);
    if (key === 'id') this.id = text;
    if (key === 'name') this.name = text;
    if (key === 'type') this.type = text.toLowerCase();
    if (key === 'value') this._value = text;
    if (key === 'class') this.className = text;
    if (key === 'required') this.required = true;
    if (key === 'disabled') this.disabled = true;
    if (key === 'readonly') this.readOnly = true;
  }

  getAttribute(name) { return this.attributes.get(String(name).toLowerCase()) ?? null; }
  hasAttribute(name) { return this.attributes.has(String(name).toLowerCase()); }
  removeAttribute(name) {
    const key = String(name).toLowerCase();
    this.attributes.delete(key);
    if (key === 'required') this.required = false;
    if (key === 'disabled') this.disabled = false;
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatchEvent(event) {
    event.target ??= this;
    for (const listener of this.listeners.get(event.type) ?? []) listener.call(this, event);
    return true;
  }

  focus() {}
  blur() { this.dispatchEvent({ type: 'blur', target: this }); }

  click() {
    if (this.tagName === 'INPUT' && this.type === 'checkbox') {
      this.checked = !this.checked;
      this.dispatchEvent({ type: 'change', target: this });
    } else if (this.tagName === 'INPUT' && this.type === 'radio') {
      const group = this.parentElement?.querySelectorAll(`input[type="radio"][name="${this.name}"]`) ?? [];
      for (const radio of group) radio.checked = false;
      this.checked = true;
      this.dispatchEvent({ type: 'change', target: this });
    }
    this.dispatchEvent({ type: 'click', target: this });
    this.clicks = (this.clicks ?? 0) + 1;
  }

  get labels() {
    if (!this.ownerDocument?.body || !this.id) return [];
    return this.ownerDocument.body.querySelectorAll('label').filter((label) => label.getAttribute('for') === this.id);
  }

  closest(selector) {
    for (let el = this; el; el = el.parentElement) if (el.matches(selector)) return el;
    return null;
  }

  contains(other) {
    for (let el = other; el; el = el.parentElement) if (el === this) return true;
    return false;
  }

  compareDocumentPosition() { return DOCUMENT_POSITION_FOLLOWING; }

  getClientRects() {
    return this.hidden || this.getAttribute('aria-hidden') === 'true' ? [] : [{}];
  }

  querySelectorAll(selector) {
    const out = [];
    const visit = (node) => {
      for (const child of node.children ?? []) {
        if (child.matches?.(selector)) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }

  matches(selector) {
    return selector.split(',').some((part) => this.matchesOne(part.trim()));
  }

  matchesOne(selector) {
    if (!selector) return false;
    const nots = [...selector.matchAll(/:not\(([^)]+)\)/g)].map((m) => m[1]);
    if (nots.some((part) => this.matchesOne(part))) return false;
    selector = selector.replace(/:not\(([^)]+)\)/g, '');
    selector = selector.replace(/:nth-of-type\([^)]*\)/g, '');
    const attrs = [...selector.matchAll(/\[([^\]]+)\]/g)];
    for (const [, body] of attrs) {
      const match = body.match(/^\s*([\w:-]+)\s*(?:(\*=|\^=|\$=|=)\s*["']?([^"']*)["']?)?\s*$/);
      if (!match) return false;
      const [, name, op, expected] = match;
      const actual = this.getAttribute(name);
      if (actual == null) return false;
      if (op === '=' && actual !== expected) return false;
      if (op === '*=' && !actual.includes(expected)) return false;
      if (op === '^=' && !actual.startsWith(expected)) return false;
      if (op === '$=' && !actual.endsWith(expected)) return false;
    }
    selector = selector.replace(/\[[^\]]+\]/g, '');
    const ids = [...selector.matchAll(/#([\w-]+)/g)];
    if (ids.some(([, id]) => this.id !== id)) return false;
    selector = selector.replace(/#[\w-]+/g, '');
    const classes = [...selector.matchAll(/\.([\w-]+)/g)];
    const ownClasses = this.className.split(/\s+/).filter(Boolean);
    if (classes.some(([, cls]) => !ownClasses.includes(cls))) return false;
    selector = selector.replace(/\.[\w-]+/g, '').trim();
    return !selector || selector === '*' || selector.toLowerCase() === this.tagName.toLowerCase();
  }
}

class FakeInput extends FakeElement {
  constructor(attrs = {}) {
    super('input', attrs);
    this.type = this.type || 'text';
  }
}

Object.defineProperty(FakeInput.prototype, 'value', {
  get() { return this._value; },
  set(value) { this._value = String(value ?? ''); },
});

class FakeTextArea extends FakeElement {
  constructor(attrs = {}) { super('textarea', attrs); }
}
Object.defineProperty(FakeTextArea.prototype, 'value', {
  get() { return this._value; },
  set(value) { this._value = String(value ?? ''); },
});

class FakeOption extends FakeElement {
  constructor(text, value = text) {
    super('option', { value });
    this._text = text;
    this.selected = false;
  }
  get text() { return this._text; }
  set text(value) { this._text = String(value); }
}

class FakeSelect extends FakeElement {
  constructor(options, attrs = {}) {
    super('select', attrs);
    for (const option of options) this.append(option instanceof FakeOption ? option : new FakeOption(option));
  }
  get options() { return this.children; }
  get selectedOptions() { return this.options.filter((option) => option.selected); }
  get value() { return this.selectedOptions[0]?.value ?? ''; }
  set value(value) {
    for (const option of this.options) option.selected = option.value === String(value);
    this._value = String(value ?? '');
  }
}
Object.defineProperty(FakeSelect.prototype, 'value', {
  get() { return this.selectedOptions[0]?.value ?? ''; },
  set(value) {
    for (const option of this.options) option.selected = option.value === String(value);
    this._value = String(value ?? '');
  },
});

class FakeDocument {
  constructor() {
    this.body = new FakeElement('body');
    this.body.ownerDocument = this;
    this.title = 'Synthetic rater';
  }

  createElement(tagName) {
    const tag = tagName.toLowerCase();
    const Ctor = tag === 'input' ? FakeInput : tag === 'select' ? FakeSelect : tag === 'textarea' ? FakeTextArea : FakeElement;
    const el = new Ctor();
    el.ownerDocument = this;
    return el;
  }

  getElementById(id) { return this.body.querySelectorAll('*').find((el) => el.id === id) ?? null; }
  querySelectorAll(selector) { return this.body.querySelectorAll(selector); }
  createTreeWalker(root, _whatToShow, filter) {
    const nodes = [];
    const visit = (node) => {
      if (node._text && !node.children?.length) nodes.push(new FakeText(node._text, node));
      for (const child of node.children ?? []) {
        if (child.nodeType === 3) nodes.push(child);
        else visit(child);
      }
    };
    visit(root);
    let index = -1;
    return {
      currentNode: null,
      nextNode() {
        while (++index < nodes.length) {
          const node = nodes[index];
          if (!filter || filter.acceptNode(node) !== 2) {
            this.currentNode = node;
            return true;
          }
        }
        return false;
      },
    };
  }
}

function event(type, init = {}) { return { type, ...init }; }

function field(document, { tag = 'input', label, attrs = {}, value = '', required = false } = {}) {
  const normalizedAttrs = { ...attrs };
  normalizedAttrs.id ??= normalizedAttrs.name ?? `field-${document.body.children.length}`;
  const labelEl = new FakeElement('label', { for: normalizedAttrs.id });
  labelEl.ownerDocument = document;
  labelEl.textContent = label;
  const control = tag === 'select' ? new FakeSelect(normalizedAttrs.options ?? [], normalizedAttrs) : tag === 'textarea' ? new FakeTextArea(normalizedAttrs) : new FakeInput(normalizedAttrs);
  control.ownerDocument = document;
  control.value = value;
  control.required = required;
  document.body.append(labelEl, control);
  return control;
}

function button(document, text) {
  const el = new FakeElement('button');
  el.ownerDocument = document;
  el.textContent = text;
  document.body.append(el);
  return el;
}

function harness({ Ext } = {}) {
  const document = new FakeDocument();
  const context = {
    document,
    window: null,
    location: { origin: 'https://synthetic.test', pathname: '/quote', search: '' },
    Node: { DOCUMENT_POSITION_FOLLOWING },
    NodeFilter: { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 },
    HTMLInputElement: FakeInput,
    HTMLSelectElement: FakeSelect,
    HTMLTextAreaElement: FakeTextArea,
    Event: class Event { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } },
    FocusEvent: class FocusEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } },
    MutationObserver: class MutationObserver {
      constructor(callback) { this.callback = callback; }
      observe() {}
      disconnect() {}
    },
    getComputedStyle: () => ({ visibility: 'visible' }),
    CSS: { escape: (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&') },
    URLSearchParams,
    URL,
    setTimeout,
    clearTimeout,
    console,
  };
  if (Ext) context.Ext = Ext;
  context.window = context;
  context.top = context;
  vm.runInNewContext(PAGEKIT, context, { filename: 'src/content/pagekit.js' });
  return { context, document, kit: context.__raterKit };
}

function haltText(report) {
  return `${JSON.stringify(report.halted ?? '')} ${JSON.stringify(report.blockers ?? '')}`;
}

const commonStep = (path = 'applicant.name') => ({
  id: 'known', path, name: 'Known field', re: '^known field$', value: 'Alice', kind: 'text',
});

const action = (text, id = 'action') => ({
  id, action: id, kind: 'action', text, pages: [], after: ['applicant.name'], afterActions: [], afterPages: [], unless: [],
});

const printPlan = () => [
  { id: 'email', path: 'print.email', name: 'Email channel', re: '^email$', kind: 'bool', value: false, ignore: true },
  { id: 'fax', path: 'print.fax', name: 'Fax channel', re: '^fax$', kind: 'bool', value: false, ignore: true },
  {
    id: 'printSend', action: 'printSend', kind: 'action', text: '^print ?/ ?send$', pages: [], after: [],
    afterActions: [], afterPages: [], unless: [], readiness: 'document',
  },
];

test('strict review halts before writing when a required relevant question is unfamiliar', async () => {
  const { document, kit } = harness();
  const known = field(document, { label: 'Known field', attrs: { name: 'known' }, required: true });
  field(document, { label: 'Unfamiliar underwriting question *', attrs: { name: 'unknown' }, required: true });
  const continueButton = button(document, 'Continue');

  const report = await kit.fill([commonStep(), action('^Continue$', 'continue')], { strictReview: true });

  assert.equal(known.value, '', 'strict review must preflight before any value is written');
  assert.equal(continueButton.clicks ?? 0, 0, 'Continue is always agent-controlled');
  assert.ok(report.halted, 'strict review should expose a halted report');
  assert.match(haltText(report), /unfamiliar underwriting question/i);
});

test('strict review accepts known optional question ids, including uppercase DCT components', async () => {
  const { document, kit } = harness();
  const known = field(document, { label: 'Known field', attrs: { name: 'known' }, required: true });
  const guid = 'A'.repeat(32);
  field(document, {
    label: 'Optional portal suffix',
    attrs: { id: `f_D${guid}ABC_1_2-inputEl`, name: 'optional' },
    required: true,
  });

  const report = await kit.fill([commonStep()], { strictReview: true, optional: ['ABC'] });

  assert.equal(known.value, 'Alice');
  assert.ok(!report.halted, 'an explicitly ignored optional id must not halt the run');
  assert.equal(report.leftRequired.length, 0);
});

test('a redraw that clears an applied answer is reported and prevents downstream actions', async () => {
  const { document, kit } = harness();
  const known = field(document, { label: 'Known field', attrs: { name: 'known' }, required: true });
  const verify = button(document, 'Verify DOT');
  known.addEventListener('input', () => {
    const replacement = field(document, { label: 'Known field', attrs: { name: 'known' }, required: true });
    const replacementLabel = replacement.labels[0];
    document.body.removeChild(replacementLabel);
    document.body.removeChild(replacement);
    document.body.replaceChild(replacement, known);
  });

  const report = await kit.fill([commonStep(), action('^Verify DOT$', 'verify')], { strictReview: true });

  assert.equal(document.body.querySelectorAll('input[name="known"]')[0].value, '');
  assert.equal(verify.clicks ?? 0, 0, 'an action must wait for the applied value to survive redraw');
  assert.ok(report.halted, 'failed post-settle verification should halt strict review');
  assert.match(`${JSON.stringify(report.failed)} ${haltText(report)}`, /redraw|accept|survive|cleared|verify/i);
});

test('a required question that appears after a redraw halts before the next helper action', async () => {
  const { document, kit } = harness();
  const known = field(document, { label: 'Known field', attrs: { name: 'known' }, required: true });
  const verify = button(document, 'Verify DOT');
  known.addEventListener('input', () => {
    const replacement = field(document, { label: 'Known field', attrs: { name: 'known' }, value: 'Alice', required: true });
    const replacementLabel = replacement.labels[0];
    document.body.removeChild(replacementLabel);
    document.body.removeChild(replacement);
    document.body.replaceChild(replacement, known);
    field(document, { label: 'New required portal question *', attrs: { name: 'new-question' }, required: true });
  });

  const report = await kit.fill([commonStep(), action('^Verify DOT$', 'verify')], { strictReview: true });

  assert.equal(document.body.querySelectorAll('input[name="known"]')[0].value, 'Alice');
  assert.equal(verify.clicks ?? 0, 0);
  assert.ok(report.halted);
  assert.match(haltText(report), /new required portal question/i);
});

test('a helper stays blocked when one of its required choices is absent', async () => {
  const { document, kit } = harness();
  const known = field(document, { label: 'Known field', attrs: { name: 'known' }, required: true });
  const billPlan = button(document, 'View bill plan options');
  const helper = {
    id: 'billPlan', action: 'billPlan', kind: 'action', text: '^(view )?bill plan options?$', pages: [],
    after: [], afterAll: ['applicant.name', 'coverage.autoLiabLimit'], afterActions: [], afterPages: [], unless: [],
  };

  const report = await kit.fill([commonStep(), helper], { strictReview: true });

  assert.equal(known.value, 'Alice');
  assert.equal(billPlan.clicks ?? 0, 0, 'a bill-plan helper cannot run without every coverage choice');
  assert.equal(report.halted, false);
});

test('a bill-plan helper waits for a refreshed premium before clicking', async () => {
  const { document, kit } = harness();
  document.body.innerText = 'Premium $1,234.00';
  const billPlan = button(document, 'View bill plan options');
  assert.equal(document.body.innerText, 'Premium $1,234.00');
  assert.equal(billPlan.matches('a, button, [role=button], [role=link], input[type=button], input[type=submit], .x-btn, [onclick]'), true);
  assert.equal(document.querySelectorAll('button').length, 1);
  assert.equal(billPlan.textContent, 'View bill plan options');
  const report = await kit.fill([{
    id: 'billPlan', action: 'billPlan', kind: 'action', text: '^(view )?bill plan options?$', pages: [], after: [],
    afterActions: [], afterPages: [], unless: [], readiness: 'premium',
  }], { strictReview: true });

  assert.equal(billPlan.clicks, 1, JSON.stringify(report));
  assert.equal(report.actions[0].id, 'billPlan');
  assert.equal(report.halted, false);
});

test('stale masked premium blocks the bill-plan helper', async () => {
  const { document, kit } = harness();
  document.body.innerText = '**** Premium is out of date; please recalculate';
  const billPlan = button(document, 'View bill plan options');
  const report = await kit.fill([{
    id: 'billPlan', action: 'billPlan', kind: 'action', text: '^(view )?bill plan options?$', pages: [], after: [],
    afterActions: [], afterPages: [], unless: [], readiness: 'premium',
  }], { strictReview: true });

  assert.equal(billPlan.clicks ?? 0, 0);
  assert.ok(report.halted);
  assert.match(haltText(report), /premium|recalculate/i);
});

test('duplicate DCT question ids block unattended multi-vehicle filling', async () => {
  const { document, kit } = harness();
  const guid = 'C'.repeat(32);
  const id = `f_D${guid}ABC_8_1-inputEl`;
  field(document, { label: 'Vehicle one VIN', attrs: { id, name: 'vin-1' }, required: true });
  field(document, { label: 'Vehicle two VIN', attrs: { id, name: 'vin-2' }, required: true });

  const report = await kit.fill([], { strictReview: true });

  assert.ok(report.halted);
  assert.match(haltText(report), /repeated|vehicle|driver/i);
});

test('print helper blocks when Email is checked even when the field is skipped', async () => {
  const { document, kit } = harness();
  const email = field(document, { label: 'Email', attrs: { name: 'email', type: 'checkbox' } });
  field(document, { label: 'Fax', attrs: { name: 'fax', type: 'checkbox' } });
  email.checked = true;
  const printSend = button(document, 'Print / Send');

  const report = await kit.fill(printPlan(), { strictReview: true, skip: ['email'] });

  assert.equal(printSend.clicks ?? 0, 0);
  assert.ok(report.halted);
  assert.match(haltText(report), /email|fax|unchecked|print/i);
});

test('print helper blocks when Fax is checked even when the field is skipped', async () => {
  const { document, kit } = harness();
  field(document, { label: 'Email', attrs: { name: 'email', type: 'checkbox' } });
  const fax = field(document, { label: 'Fax', attrs: { name: 'fax', type: 'checkbox' } });
  fax.checked = true;
  const printSend = button(document, 'Print / Send');

  const report = await kit.fill(printPlan(), { strictReview: true, skip: ['fax'] });

  assert.equal(printSend.clicks ?? 0, 0);
  assert.ok(report.halted);
  assert.match(haltText(report), /email|fax|unchecked|print/i);
});

test('print helper clicks with both channels unchecked but leaves PDF generation unverified', async () => {
  const { document, kit } = harness();
  field(document, { label: 'Email', attrs: { name: 'email', type: 'checkbox' } });
  field(document, { label: 'Fax', attrs: { name: 'fax', type: 'checkbox' } });
  const printSend = button(document, 'Print / Send');

  const report = await kit.fill(printPlan(), { strictReview: true });

  assert.equal(printSend.clicks, 1, JSON.stringify(report));
  assert.equal(report.documentStatus, 'requested-unverified');
  assert.equal(report.halted, false);
});

test('print helper reports a PDF link when the page exposes one after printing', async () => {
  const { document, kit } = harness();
  field(document, { label: 'Email', attrs: { name: 'email', type: 'checkbox' } });
  field(document, { label: 'Fax', attrs: { name: 'fax', type: 'checkbox' } });
  const printSend = button(document, 'Print / Send');
  const pdf = new FakeElement('a', { href: '/generated-quote.pdf' });
  pdf.ownerDocument = document;
  pdf.textContent = 'Download quote PDF';
  printSend.addEventListener('click', () => document.body.append(pdf));

  const report = await kit.fill(printPlan(), { strictReview: true });

  assert.equal(printSend.clicks, 1, JSON.stringify(report));
  assert.equal(report.documentStatus, 'document-link-available');
});

test('preexisting PDF links do not establish new document generation', async () => {
  const { document, kit } = harness();
  field(document, { label: 'Email', attrs: { name: 'email', type: 'checkbox' } });
  field(document, { label: 'Fax', attrs: { name: 'fax', type: 'checkbox' } });
  const printSend = button(document, 'Print / Send');
  const pdf = new FakeElement('a', { href: '/generated-quote.pdf' });
  pdf.ownerDocument = document;
  pdf.textContent = 'Download quote PDF';
  document.body.append(pdf);

  const report = await kit.fill(printPlan(), { strictReview: true });

  assert.equal(printSend.clicks, 1, JSON.stringify(report));
  assert.equal(report.documentStatus, 'requested-unverified');
});

test('a helper under a disabled ExtJS ancestor is left for the agent', async () => {
  const { document, kit } = harness();
  const wrapper = new FakeElement('div', { class: 'x-item-disabled' });
  wrapper.ownerDocument = document;
  const verify = new FakeElement('button');
  verify.ownerDocument = document;
  verify.textContent = 'Verify DOT';
  wrapper.append(verify);
  document.body.append(wrapper);

  const report = await kit.fill([{
    id: 'verify', action: 'verify', kind: 'action', text: '^Verify DOT$', pages: [], after: [], afterActions: [], afterPages: [], unless: [],
  }], { strictReview: true });

  assert.equal(verify.clicks ?? 0, 0);
  assert.equal(report.actions.length, 0);
  assert.equal(report.halted, false);
});

test('ExtJS redraw rejection is verified against the newly collected component', async () => {
  const guid = 'E'.repeat(32);
  const componentId = `f_D${guid}ABC_8_1`;
  const inputId = `${componentId}-inputEl`;
  const components = new Map();
  const Ext = { Ajax: { isLoading: () => false }, getCmp: (id) => components.get(id) ?? null };
  const { document, kit } = harness({ Ext });
  let current = field(document, { label: 'Known Ext field', attrs: { id: inputId, name: 'known-ext' }, required: true });

  const makeComponent = (el) => {
    const cmp = {
      id: componentId,
      xtype: 'textfield',
      dctCaption: 'Known Ext field',
      dctRequired: true,
      value: '',
      el,
      on(type, listener) { if (type === 'blur') this.blurListener = listener; },
      setValue(value) { this.value = String(value); this.el.value = value; },
      getValue() { return this.value; },
      fireEvent(type) { if (type === 'blur') this.blurListener?.(); },
    };
    return cmp;
  };
  components.set(componentId, makeComponent(current));
  current.addEventListener('input', () => {
    const replacement = field(document, { label: 'Known Ext field', attrs: { id: inputId, name: 'known-ext' }, required: true });
    const replacementLabel = replacement.labels[0];
    document.body.removeChild(replacementLabel);
    document.body.removeChild(replacement);
    document.body.replaceChild(replacement, current);
    current = replacement;
    components.set(componentId, makeComponent(current));
  });

  const report = await kit.fill([
    { id: 'known-ext', path: 'applicant.name', name: 'Known Ext field', re: '^known ext field$', value: 'Alice', kind: 'text' },
    action('^Verify DOT$', 'verify'),
  ], { strictReview: true });

  assert.equal(current.value, '');
  assert.equal(report.actions.length, 0);
  assert.ok(report.halted);
  assert.match(`${JSON.stringify(report.failed)} ${haltText(report)}`, /survive|redraw|verify|update/i);
});

test('uppercase DCT component prefixes still produce the question id used by mappings', () => {
  const { document, kit } = harness();
  const guid = 'B'.repeat(32);
  field(document, {
    label: 'Uppercase DCT question',
    attrs: { id: `f_D${guid}ABC_8_1-inputEl`, name: 'string_ABC' },
  });

  const captured = kit.capture([]);
  assert.equal(captured.controls[0].q, 'ABC');
});


test('a known ID with different question wording stops before applying its value', async () => {
  const { document, kit } = harness();
  const input = field(document, { label: 'Different underwriting question', attrs: { id: `f_U${'A'.repeat(32)}ABC_8_1-inputEl` } });
  const report = await kit.fill([{ ...commonStep(), q: 'ABC' }], { strictReview: true });
  assert.equal(input.value, '');
  assert.ok(report.halted);
  assert.match(haltText(report), /wording differs/);
});

test('reviewed unchecked channels satisfy print prerequisites', async () => {
  const { document, kit } = harness();
  field(document, { label: 'Email', attrs: { name: 'email', type: 'checkbox' } });
  field(document, { label: 'Fax', attrs: { name: 'fax', type: 'checkbox' } });
  const printSend = button(document, 'Print / Send');
  const plan = printPlan();
  plan.at(-1).afterAll = ['print.email', 'print.fax'];
  const report = await kit.fill(plan, { strictReview: true, skip: ['email', 'fax'] });
  assert.equal(report.halted, false);
  assert.equal(printSend.clicks, 1);
});

test('page-level underwriting review blocks helpers until explicitly acknowledged', async () => {
  const { document, kit } = harness();
  const helper = button(document, 'Recalculate');
  const plan = [
    { kind: 'review', key: 'review.gl', pages: ['/quote'], note: 'Review requested General Liability on the quote.' },
    { ...action('^Recalculate$', 'recalculate'), after: [] },
  ];
  const first = await kit.fill(plan, { strictReview: true });
  assert.ok(first.halted);
  assert.equal(helper.clicks ?? 0, 0);
  const reviewed = await kit.fill(plan, { strictReview: true, skip: ['review.gl'] });
  assert.equal(reviewed.halted, false);
  assert.equal(helper.clicks, 1);
});
