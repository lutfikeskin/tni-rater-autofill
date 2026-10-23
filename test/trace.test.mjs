import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The developer recording's trace (src/content/trace.js), run with the recorder whose readers it
// uses, on a small page of controls and a virtual clock (docs/developer-recording.md).
const RECORDER = fs.readFileSync(new URL('../src/content/recorder.js', import.meta.url), 'utf8');
const TRACE = fs.readFileSync(new URL('../src/content/trace.js', import.meta.url), 'utf8');
const ORIGIN = 1_790_000_000_000;

class Control {
  constructor(tagName, { name = '', type = '', value = '', options = [], label = '', top = 100 } = {}) {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.id = name;
    this.name = name;
    this.type = type || (this.tagName === 'INPUT' ? 'text' : '');
    this.disabled = false;
    this.labels = [];
    this.options = options;
    this._value = String(value);
    this.attrs = new Map([['name', name], ['aria-label', label]]);
    this.top = top;
  }

  get value() { return this._value; }
  set value(v) { this._value = String(v ?? ''); }
  get selectedOptions() { return this.options.filter((o) => String(o.value) === this._value); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  matches() { return false; }
  closest() { return null; }
  getClientRects() { return [{}]; }
  getBoundingClientRect() { return { left: 10, top: this.top, width: 200, height: 24 }; }
}

class Button {
  constructor(text) { this.tagName = 'BUTTON'; this.nodeType = 1; this.textContent = text; this.value = ''; }
  matches(selector) { return /button/.test(selector); }
  closest() { return null; }
  getBoundingClientRect() { return { left: 10, top: 700, width: 80, height: 30 }; }
}

function harness({ reply = () => ({ ok: true }), href = 'https://synthetic.example/quote' } = {}) {
  const controls = [];
  const listeners = new Map();
  const on = (target) => (type, fn) => { const key = `${target}:${type}`; (listeners.get(key) ?? (listeners.set(key, new Set()), listeners.get(key))).add(fn); };
  const off = (target) => (type, fn) => listeners.get(`${target}:${type}`)?.delete(fn);
  const messageListeners = new Set();
  const sent = [];
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const document = {
    title: 'Synthetic quote',
    visibilityState: 'visible',
    documentElement: { scrollHeight: 2400 },
    querySelectorAll: (selector) => (/input|select|textarea/.test(selector) ? [...controls] : []),
    getElementById: () => null,
    createTreeWalker: () => ({ currentNode: null, previousNode: () => false }),
    addEventListener: on('document'),
    removeEventListener: off('document'),
  };
  const context = {
    document,
    location: { href, pathname: '/quote', search: '' },
    URLSearchParams,
    NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: () => ({ visibility: 'visible' }),
    performance: { timeOrigin: ORIGIN, now: () => now },
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    scrollX: 0,
    scrollY: 50,
    setTimeout: (fn, ms = 0) => { const id = nextId++; timers.set(id, { due: now + ms, fn }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => { const id = nextId++; timers.set(id, { due: now + ms, fn, every: ms }); return id; },
    clearInterval: (id) => timers.delete(id),
    addEventListener: on('window'),
    removeEventListener: off('window'),
    chrome: {
      runtime: {
        id: 'synthetic-extension',
        sendMessage(message) { sent.push(structuredClone(message)); return Promise.resolve(reply(message)); },
        onMessage: { addListener: (fn) => messageListeners.add(fn), removeListener: (fn) => messageListeners.delete(fn) },
      },
    },
    // The production key helper's contract, kept explicit (as test/recorder.test.mjs does).
    __raterFieldKey: (el) => `field:${el.name || el.id}`,
  };
  context.window = context;
  context.top = context;
  vm.runInNewContext(RECORDER, context, { filename: 'src/content/recorder.js' });
  vm.runInNewContext(TRACE, context, { filename: 'src/content/trace.js' });
  const flushed = () => new Promise((resolve) => setImmediate(resolve));
  return {
    context,
    controls,
    sent,
    trace: () => sent.filter((m) => m.ra === 'trace'),
    events: () => sent.filter((m) => m.ra === 'trace').flatMap((m) => m.events),
    emit(type, target, extra = {}) {
      const event = { type, target, isTrusted: true, timeStamp: now, composedPath: () => [target], ...extra };
      for (const fn of [...(listeners.get(`window:${type}`) ?? [])]) fn(event);
      for (const fn of [...(listeners.get(`document:${type}`) ?? [])]) fn(event);
    },
    message(message) { for (const fn of [...messageListeners]) fn(message); },
    // Runs every timer due within `ms`, in order, letting promises settle after each.
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const [id, t] = [...timers].filter(([, x]) => x.due <= end).sort((a, b) => a[1].due - b[1].due)[0] ?? [];
        if (!t) break;
        now = t.due;
        if (t.every) t.due += t.every; else timers.delete(id);
        t.fn();
        await flushed();
      }
      now = end;
      await flushed();
    },
    set now(ms) { now = ms; },
  };
}

test('a change is stamped with the page clock, its question named as the recorder names it, a choice by its words', async () => {
  const h = harness();
  const hazmat = new Control('select', { name: 'hazmat', label: 'Hauls hazmat', options: [{ text: 'Select', value: '' }, { text: 'No', value: 'N' }], top: 300 });
  h.controls.push(hazmat);
  h.now = 1000;
  h.emit('pointerdown', hazmat, { clientX: 40, clientY: 310 });
  h.now = 1250;
  hazmat.value = 'N';
  h.emit('change', hazmat);
  await h.advance(400);
  const events = h.events();
  assert.deepEqual(events.map((e) => e.kind), ['page', 'pointer', 'change']);
  const change = events[2];
  assert.equal(change.t, ORIGIN + 1250, 'when it happened, not when it was sent');
  assert.deepEqual([change.field.key, change.field.label, change.field.kind, change.value, change.trusted, change.gestureMs], ['field:hazmat', 'Hauls hazmat', 'select', 'No', true, 250]);
  assert.equal(change.field.rect.docY, 350, 'its height on the page: its box plus the scroll');
  assert.deepEqual([events[0].page, events[0].title, events[0].top], ['/quote', 'Synthetic quote', true]);
});

test('typed text is never kept: keys by name or as printable, a text box by its length, a password box not at all', async () => {
  const h = harness();
  const name = new Control('input', { name: 'business', label: 'Business name' });
  const password = new Control('input', { name: 'pw', type: 'password', label: 'Password' });
  h.controls.push(name, password);
  h.now = 10;
  h.emit('keydown', name, { key: 'S' });
  h.now = 20;
  name.value = 'Sam Trucking';
  h.emit('input', name);
  h.now = 25;
  h.emit('keydown', name, { key: ' ' });
  h.now = 30;
  h.emit('keydown', name, { key: 'Tab' });
  h.emit('keydown', name, { key: 'Shift' });
  h.emit('keydown', password, { key: 'x' });
  password.value = 'secret';
  h.emit('input', password);
  h.emit('pointerdown', password);
  await h.advance(400);
  // In the order they happened (a choice's or a length's reading comes a moment later: by time).
  const events = h.events().filter((e) => e.kind !== 'page').sort((a, b) => a.t - b.t);
  assert.deepEqual(events.map((e) => [e.kind, e.key ?? null, e.printable ?? null, e.len ?? null]), [
    ['key', null, true, null], ['input', null, null, 12], ['key', null, true, null], ['key', 'Tab', null, null],
  ], 'a space in a text box is typing, not a named key');
  const text = JSON.stringify(h.sent);
  for (const typed of ['Sam', 'secret', '"key":"S"', '"key":"x"', 'Password']) assert.ok(!text.includes(typed), `${typed} was kept`);
});

test('a batch the panel doesn\'t take is kept and sent again; with no panel for a minute the trace stops', async () => {
  let taken = false;
  const h = harness({ reply: () => (taken ? { ok: true } : undefined) });
  const button = new Button('Next');
  h.emit('click', button, { clientX: 20, clientY: 710 });
  await h.advance(400);
  await h.advance(2100);
  const resent = h.trace();
  assert.equal(resent.length, 2, 'sent, not taken, sent again');
  assert.deepEqual(resent[1].events.map((e) => e.seq), resent[0].events.map((e) => e.seq), 'the same events, once each');
  taken = true;
  await h.advance(2100);
  assert.equal(h.trace().length, 3);
  await h.advance(5000);
  assert.equal(h.trace().length, 3, 'nothing more once taken');
  // Never taken again: the trace stops within a minute or so.
  taken = false;
  h.emit('click', button);
  await h.advance(70_000);
  assert.equal(h.context.__raterTrace, undefined, 'stopped');
});

test('stop sends what is held and ends the trace; a button is named by its words', async () => {
  const h = harness();
  h.emit('click', new Button('Recalculate'));
  h.message({ ra: 'trace', cmd: 'stop' });
  await h.advance(10);
  const click = h.events().find((e) => e.kind === 'click');
  assert.deepEqual([click.button.text, click.trusted], ['Recalculate', true]);
  assert.equal(h.context.__raterTrace, undefined);
  const before = h.trace().length;
  h.emit('click', new Button('Next'));
  await h.advance(1000);
  assert.equal(h.trace().length, before, 'nothing after stop');
});

// Live recording, 2026-10-23 (Progressive's agents' site): its Select Product(s) and Add Products to
// Quote are input buttons, logged as unnamed text boxes; its two about:blank frames each sent events.
test('an input that is a button is named by its words, and an empty frame records nothing', async () => {
  const h = harness();
  const add = new Control('input', { name: 'quoteActionSelectButton', type: 'button', value: 'Add Products to Quote', label: 'EPLI, NPDO, Cyber and More' });
  h.controls.push(add);
  h.emit('click', add);
  await h.advance(400);
  const click = h.events().find((e) => e.kind === 'click');
  assert.deepEqual([click.button?.text, click.field], ['Add Products to Quote', undefined]);
  const blank = harness({ href: 'about:blank' });
  blank.emit('click', new Button('Next'));
  await blank.advance(400);
  assert.deepEqual([blank.trace().length, blank.context.__raterTrace], [0, undefined]);
});

test('the trace only watches: nothing in it clicks, types, scrolls or dispatches', () => {
  const code = TRACE.replace(/\/\/.*$/gm, '');
  for (const act of [/\.click\(/, /\.value\s*=[^=]/, /dispatchEvent\(/, /\.focus\(/, /\.submit\(/, /scroll(To|By|IntoView)\(/, /\.checked\s*=[^=]/, /setAttribute\(/]) {
    assert.ok(!act.test(code), `trace.js must not ${act}`);
  }
});
