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

// `elements`: the page's other elements (a design-system host with its shadow root), as `*` finds them.
function harness({ reply = () => ({ ok: true }), href = 'https://synthetic.example/quote', pathname = '/quote', elements = [] } = {}) {
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
    querySelectorAll: (selector) => (/input|select|textarea/.test(selector) ? [...controls] : selector === '*' ? [...elements] : []),
    getElementById: () => null,
    createTreeWalker: () => ({ currentNode: null, previousNode: () => false }),
    addEventListener: on('document'),
    removeEventListener: off('document'),
  };
  // The page's own changes and requests, handed to the trace by the test (mutate, resource).
  // `observed`: what the mutation observer was asked to watch, in order.
  const observers = { mutation: null, resource: null, observed: [] };
  const context = {
    document,
    location: { href, pathname, search: '', origin: 'https://synthetic.example' },
    URL,
    URLSearchParams,
    MutationObserver: class { constructor(fn) { this.fn = fn; observers.mutation = this; } observe(target) { observers.observed.push(target); } disconnect() { observers.mutation = null; } },
    // `queued`: entries the browser finished but hasn't handed the callback yet (takeRecords).
    PerformanceObserver: class { constructor(fn) { this.fn = fn; this.queued = []; observers.resource = this; } observe() {} takeRecords() { const q = this.queued; this.queued = []; return q; } disconnect() { this.queued = []; observers.resource = null; } },
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
    observers,
    mutate(records) { observers.mutation?.fn(records); },
    resource(entries) { observers.resource?.fn({ getEntries: () => entries }); },
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

// Review of PR #166: the page was named without its ids (pageKey), but its path kept them.
test('a page path keeps no ids, as its name does not', async () => {
  const h = harness({ pathname: '/applications/123456789012/vehicles' });
  await h.advance(400);
  const page = h.events().find((e) => e.kind === 'page');
  assert.deepEqual([page.page, page.path], ['/applications/:id/vehicles', '/applications/:id/vehicles']);
  // Decoded, so a name in it is redacted as words; a part that isn't valid encoding stays as it is.
  const named = harness({ pathname: '/drivers/Sam%20Smith/%E0%A4%A' });
  await named.advance(400);
  assert.equal(named.events().find((e) => e.kind === 'page').path, '/drivers/Sam Smith/%E0%A4%A');
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

// What the page does on its own and what the extension's fill says, in the same timeline
// (docs/developer-recording.md), so a recording shows where a quote's time went.
const node = (inside, { matches = false, type = '', connected = true } = {}) => ({ nodeType: 1, type, isConnected: connected, matches: () => matches, querySelectorAll: () => inside });

test('the page\'s changes are one burst once quiet for 100 ms: the questions it drew by name, those it took away counted', async () => {
  const h = harness();
  const team = new Control('select', { name: 'team', label: 'Team driving?', options: [{ text: 'No', value: 'N' }] });
  const secret = new Control('input', { name: 'pin', type: 'password' });
  const hidden = new Control('input', { name: 'token', type: 'hidden' });
  h.now = 1000;
  h.mutate([{ addedNodes: [node([team, secret, hidden])], removedNodes: [] }]);
  h.now = 1060;
  h.mutate([{ addedNodes: [node([])], removedNodes: [node([], { matches: true, type: 'text', connected: false })] }]);
  await h.advance(99);
  assert.ok(!h.events().some((e) => e.kind === 'burst'), 'not before the page is quiet');
  await h.advance(400);
  const burst = h.events().find((e) => e.kind === 'burst');
  assert.deepEqual([burst.t, burst.end, burst.records, burst.drawnCount, burst.removed], [ORIGIN + 1000, ORIGIN + 1060, 2, 1, 1]);
  assert.deepEqual(burst.drawn, [{ key: 'field:team', kind: 'select', label: 'Team driving?' }], 'never a password or hidden box');
  // Only changes: no questions, nothing named.
  h.mutate([{ addedNodes: [node([])], removedNodes: [] }]);
  await h.advance(400);
  const plain = h.events().filter((e) => e.kind === 'burst')[1];
  assert.deepEqual([plain.records, 'drawn' in plain, 'removed' in plain], [1, false, false]);
});

test('the page\'s requests to its own origin, as each finishes: the path without query or ids, when it began and ended', async () => {
  const h = harness();
  h.resource([
    { initiatorType: 'fetch', name: 'https://synthetic.example/api/quote/123456/rate?premium=1', startTime: 2000, responseEnd: 2300 },
    { initiatorType: 'xmlhttprequest', name: 'https://cdn.other.example/x.js', startTime: 2000, responseEnd: 2100 },
    { initiatorType: 'img', name: 'https://synthetic.example/logo.png', startTime: 2000, responseEnd: 2050 },
    // A name in a path is kept decoded, so the panel's redactor finds it as words (review of PR #257).
    { initiatorType: 'xmlhttprequest', name: 'https://synthetic.example/drivers/Sam%20Smith/save', startTime: 2400, responseEnd: 2500 },
  ]);
  await h.advance(400);
  const requests = h.events().filter((e) => e.kind === 'request');
  assert.deepEqual(requests.map((e) => [e.path, e.t, e.end, e.ms, e.via]), [['/api/quote/:id/rate', ORIGIN + 2000, ORIGIN + 2300, 300, 'fetch'], ['/drivers/Sam Smith/save', ORIGIN + 2400, ORIGIN + 2500, 100, 'xhr']]);
});

test('what the extension\'s fill says is kept by its own time; anything else on that event is left out', async () => {
  const h = harness();
  const say = (detail) => h.emit('rater-trace', h.context.document, { detail });
  say(JSON.stringify({ what: 'wait', t: ORIGIN + 3000.5, why: 'answer', start: ORIGIN + 2880.5, ms: 120, ended: 'quiet', kind: 'click', seq: 99, frame: 4, filling: false }));
  say(JSON.stringify({ what: 'press', t: ORIGIN + 3200, button: { text: 'Continue' }, how: 'page' }));
  say({ what: 'wait', t: ORIGIN + 3300 });
  say(JSON.stringify({ what: 'navigate', t: ORIGIN + 3400 }));
  say(JSON.stringify({ what: 'wait', t: ORIGIN + 3500, pad: 'x'.repeat(5000) }));
  say('{not json');
  await h.advance(400);
  const kit = h.events().filter((e) => e.kind === 'kit');
  assert.deepEqual(kit.map((e) => [e.what, e.t]), [['wait', ORIGIN + 3000.5], ['press', ORIGIN + 3200]]);
  assert.deepEqual([kit[0].ms, kit[0].why, kit[0].kind, kit[0].seq !== 99, 'frame' in kit[0], 'filling' in kit[0]], [120, 'answer', 'kit', true, false, false]);
  assert.deepEqual(kit[1].button, { text: 'Continue' });
});

// Review of PR #257: the page can dispatch the same event, so what it holds is built afresh from
// the documented fields; free text where a fixed word or a number belongs never reaches the
// recording, where only labels, keys and button words are redacted.
test('an event the page dispatches as the fill\'s keeps only the documented fields, each of its type', async () => {
  const h = harness();
  const say = (detail) => h.emit('rater-trace', h.context.document, { detail: JSON.stringify(detail) });
  say({ what: 'wait', t: ORIGIN + 1000, start: ORIGIN + 900, ms: 100, ended: 'quiet', why: 'Sam Smith', quietMs: '150', requests: 'yes',
    held: { busy: 'Sam Smith', changing: true }, note: 'Sam Smith' });
  say({ what: 'wait', t: ORIGIN + 1100, start: ORIGIN + 1000, ms: 100, ended: 'Sam Smith' });
  say({ what: 'wait', t: ORIGIN + 1150, ms: 50, ended: 'quiet' });
  say({ what: 'answer', t: ORIGIN + 1200, start: ORIGIN + 1150, applyMs: 20, ok: 'yes', field: { key: 'ref:Lic', label: 'License', extra: 'Sam Smith' },
    stepKind: 'Sam Smith', timing: { ms: 50, settleMs: 'Sam Smith', ajax: 1, batch: true, who: 'Sam Smith' } });
  say({ what: 'answer', t: ORIGIN + 1250, start: ORIGIN + 1200, field: { key: 'ref:Zip', label: 'ZIP' }, stepKind: 'address-suggest' });
  // Lowercase and hyphenated, shaped like a kind but none of the plan's (review of PR #258).
  say({ what: 'answer', t: ORIGIN + 1260, start: ORIGIN + 1255, field: { key: 'ref:Own', label: 'Owner' }, stepKind: 'sam-smith' });
  // An answer with no field, or no time it began, says nothing it must: left out.
  say({ what: 'answer', t: ORIGIN + 1270, start: ORIGIN + 1265, stepKind: 'choice' });
  say({ what: 'answer', t: ORIGIN + 1280, start: null, field: { key: 'ref:Bad', label: 'Bad' }, stepKind: 'choice' });
  say({ what: 'press', t: ORIGIN + 1300, button: { text: 'Continue', extra: 'Sam Smith' }, how: 'Sam Smith' });
  say({ what: 'run', t: ORIGIN + 1400, on: false, filled: 3, halted: 'no', who: 'Sam Smith' });
  await h.advance(400);
  const kit = h.events().filter((e) => e.kind === 'kit');
  assert.ok(!JSON.stringify(kit).includes('Sam Smith'), 'none of the page\'s free text');
  assert.deepEqual(kit.map((e) => e.what), ['wait', 'answer', 'answer', 'answer', 'press', 'run'], 'a wait with no start or an unknown end is left out');
  const [wait, answer, zip, owner, press, run] = kit;
  assert.deepEqual([wait.why, 'quietMs' in wait, 'requests' in wait, wait.held, 'note' in wait], [null, false, false, { busy: false, changing: true, requests: false }, false]);
  assert.deepEqual([answer.field, answer.stepKind, 'ok' in answer, answer.applyMs, answer.timing], [{ key: 'ref:Lic', label: 'License' }, null, false, 20, { ms: 50, ajax: 1, batch: true }]);
  assert.deepEqual([zip.stepKind, owner.stepKind], ['address-suggest', null], 'a plan step\'s kind is kept, nothing else shaped like one');
  assert.ok(!JSON.stringify(kit).includes('sam-smith'));
  assert.deepEqual([press.button, 'how' in press], [{ text: 'Continue' }, false]);
  assert.deepEqual([run.on, run.filled, 'halted' in run, 'who' in run], [false, 3, false, false]);
});

test('stop sends a burst still open and a request the browser hadn\'t handed over yet, then watches the page no more', async () => {
  const h = harness();
  h.mutate([{ addedNodes: [node([])], removedNodes: [] }]);
  // Finished just before Stop, still queued: disconnecting would drop it (review of PR #257).
  h.observers.resource.queued.push({ initiatorType: 'fetch', name: 'https://synthetic.example/api/last', startTime: 500, responseEnd: 600 });
  h.message({ ra: 'trace', cmd: 'stop' });
  await h.advance(10);
  assert.equal(h.events().filter((e) => e.kind === 'burst').length, 1);
  assert.deepEqual(h.events().filter((e) => e.kind === 'request').map((e) => e.path), ['/api/last']);
  assert.deepEqual([h.observers.mutation, h.observers.resource], [null, null]);
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

// Progressive's recordings of 2026-11-04 named its hidden status boxes (Current Page Errored, SSID
// Value: drawn with no size) among every page's new questions.
test('a box drawn with no size and no label on screen is not one of the questions drawn', async () => {
  const h = harness();
  const team = new Control('select', { name: 'team', label: 'Team driving?', options: [{ text: 'No', value: 'N' }] });
  const errored = new Control('input', { name: 'errored', type: 'checkbox', label: 'Current Page Errored' });
  errored.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 });
  h.now = 1000;
  h.mutate([{ addedNodes: [node([team, errored])], removedNodes: [] }]);
  await h.advance(400);
  const burst = h.events().find((e) => e.kind === 'burst');
  assert.deepEqual([burst.drawnCount, burst.drawn.map((d) => d.label)], [1, ['Team driving?']]);
  // Taken away again (review of PR #286): the box left out as drawn isn't counted as removed.
  h.mutate([{ addedNodes: [], removedNodes: [node([team, errored], { connected: false })] }]);
  await h.advance(400);
  const gone = h.events().filter((e) => e.kind === 'burst')[1];
  assert.equal(gone.removed, 1);
  // Drawn again where it shows (review of PR #286): a question now, and its removal counted.
  errored.getBoundingClientRect = () => ({ left: 10, top: 300, width: 16, height: 16 });
  h.mutate([{ addedNodes: [node([errored])], removedNodes: [] }]);
  await h.advance(400);
  h.mutate([{ addedNodes: [], removedNodes: [node([errored], { connected: false })] }]);
  await h.advance(400);
  const [back, again] = h.events().filter((e) => e.kind === 'burst').slice(2);
  assert.deepEqual([back.drawnCount, again.removed], [1, 1]);
  // Added and taken away within one burst (review of PR #286): never drawn, so not counted as gone.
  const brief = new Control('input', { name: 'brief', type: 'checkbox', label: 'Brief box' });
  brief.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 });
  const added = node([brief], { connected: false });
  h.mutate([{ addedNodes: [added], removedNodes: [added] }]);
  await h.advance(400);
  const passing = h.events().filter((e) => e.kind === 'burst')[4];
  assert.deepEqual(['drawn' in passing, 'removed' in passing], [false, false]);
});

// Review of PR #286: a control moved within the page is taken away and added again in one burst.
// Moved and left there, it's still on the page; moved and then taken away, it's gone.
test('a question moved within the page isn\'t taken away; moved and then taken away, it is', async () => {
  const h = harness();
  const team = new Control('select', { name: 'team', label: 'Team driving?', options: [{ text: 'No', value: 'N' }] });
  const moved = node([team]);
  h.now = 1000;
  h.mutate([{ addedNodes: [], removedNodes: [moved] }, { addedNodes: [moved], removedNodes: [] }]);
  await h.advance(400);
  const stayed = h.events().find((e) => e.kind === 'burst');
  assert.equal('removed' in stayed, false, 'still on the page');
  moved.isConnected = false;
  h.mutate([{ addedNodes: [], removedNodes: [moved] }, { addedNodes: [moved], removedNodes: [] }, { addedNodes: [], removedNodes: [moved] }]);
  await h.advance(400);
  const gone = h.events().filter((e) => e.kind === 'burst')[1];
  assert.equal(gone.removed, 1, 'it was on the page before the burst');
});

// Review of PR #286: a radio or checkbox drawn with no size and shown by its label keeps the label's
// place on the page, so the report still tells its order; a box with no size and no label has none.
test('a question with no size is placed where its label is on screen', async () => {
  const h = harness();
  const styled = new Control('input', { name: 'styled', type: 'checkbox', label: 'Styled box', top: 0 });
  styled.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 });
  styled.labels = [{ getClientRects: () => [{}], getBoundingClientRect: () => ({ left: 20, top: 420, width: 90, height: 18 }) }];
  const status = new Control('input', { name: 'errored', type: 'checkbox', label: 'Current Page Errored', top: 0 });
  status.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 });
  h.controls.push(styled, status);
  h.now = 1000;
  h.emit('change', styled);
  h.emit('change', status);
  await h.advance(400);
  const [a, b] = h.events().filter((e) => e.kind === 'change');
  assert.deepEqual([a.field.rect.w, a.field.rect.docY], [90, 470], 'the label\'s box plus the scroll');
  assert.deepEqual([b.field.rect.w, b.field.rect.h], [0, 0]);
});

// Recording of 2026-11-04 (1143-fdc8): two waits the fill engine had just been given names for were
// traced unnamed, as the trace keeps only the names it knows. Every wait the engine names is known to
// the trace and has words in the report.
test('every wait the fill engine names is kept by the trace and said by the report', async () => {
  const dir = new URL('../src/kit/', import.meta.url);
  const named = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    for (const m of fs.readFileSync(new URL(f, dir), 'utf8').matchAll(/why: '([a-z-]+)'/g)) named.add(m[1]);
  }
  const kept = new Set([...TRACE.match(/WAITS_FOR = new Set\(\[([^\]]*)\]\)/)[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]));
  const report = fs.readFileSync(new URL('../scripts/lib/recording.mjs', import.meta.url), 'utf8');
  const said = new Set([...report.match(/const WAITS = \{([^}]*)\}/)[1].matchAll(/(?:'([a-z-]+)'|([a-z]+)): '/g)].map((m) => m[1] ?? m[2]));
  assert.ok(named.size >= 8, [...named].join(', '));
  for (const why of named) {
    assert.ok(kept.has(why), `the trace keeps "${why}"`);
    assert.ok(said.has(why), `the report says "${why}"`);
  }
});

// REC-19 (audit 2026-11-07): GEICO draws its controls inside open shadow roots (gds-*), and the
// trace watched only the light DOM: a control redrawn there left no change in the recording.
test('open shadow roots are watched too: those on the page as it starts, and those a change brings, once each', async () => {
  const shadowHost = (name) => {
    const root = { nodeType: 11, querySelectorAll: () => [] };
    return { tagName: 'GDS-RADIO-BUTTON', nodeType: 1, name, shadowRoot: root, querySelectorAll: () => [], matches: () => false };
  };
  const first = shadowHost('first');
  const h = harness({ elements: [first] });
  assert.equal(h.observers.observed.includes(first.shadowRoot), true, 'one on the page as the trace starts');
  // A component drawn later, inside a new section.
  const later = shadowHost('later');
  const section = { tagName: 'DIV', nodeType: 1, querySelectorAll: (sel) => (sel === '*' ? [later] : []), matches: () => false };
  h.mutate([{ addedNodes: [section], removedNodes: [] }]);
  h.mutate([{ addedNodes: [section], removedNodes: [] }]);
  assert.equal(h.observers.observed.filter((x) => x === later.shadowRoot).length, 1, 'one a change brings, once');
  assert.equal(h.observers.observed.filter((x) => x === first.shadowRoot).length, 1);
  // A change inside a shadow root is a burst as any other.
  h.mutate([{ target: later.shadowRoot, addedNodes: [], removedNodes: [] }]);
  await h.advance(1000);
  assert.equal(h.events().filter((e) => e.kind === 'burst').length, 1);
});
