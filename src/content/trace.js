// @ts-nocheck -- not type-checked yet (audit 2026-11-07, QA-08): fix its errors and take this line out
// The developer recording's trace (docs/developer-recording.md): injected by the side panel next to
// the recorder, in its isolated world and every frame, only while a recording runs (unpacked
// builds). It watches and never acts: it clicks nothing, sets no value and dispatches no event.
//
// Each event is stamped with the page's own clock at the moment it happened (an input event's
// timeStamp), in milliseconds, and sent to the panel in small batches; the panel redacts and stores
// them. It names a question as the recorder does (the recorder's readers, `__raterRecorder.read`),
// so a recording's keys and labels are the usage log's. Typed characters are never kept: a text
// box's change keeps its length, a key its name (Enter, Tab…) or only that it was a printable one;
// nothing at all is kept for a password box.
//
// Alongside what the person does: what the page did (its DOM changes as bursts, the questions they
// drew or took away, its own requests) and what the extension's fill said it did (pagekit.js
// `kitTrace`: its waits, answers and presses), so a recording shows where a quote's time went.

(() => {
  const VERSION = 2;
  const previous = globalThis.__raterTrace;
  if (previous?.version === VERSION && previous.alive?.()) return;
  previous?.dispose?.();
  // The recorder (version 12 on) is injected with this file, before it, in the same world.
  const read = globalThis.__raterRecorder?.read;
  // An empty frame (about:blank, as the agents' site has two of) has nothing to record.
  if (!read || /^about:/.test(location.href ?? '')) return;

  const isTop = window === window.top;
  const round = (n) => Math.round(n * 10) / 10;
  // When an event happened, on the page's clock (wall-clock ms), not when this saw it (`at`: a
  // moment given as wall-clock ms, as a document's navigation start).
  const when = (e) => round(typeof e?.at === 'number' ? e.at : performance.timeOrigin + (typeof e?.timeStamp === 'number' && e.timeStamp > 0 ? e.timeStamp : performance.now()));
  const BATCH_MS = 250;
  // Kept while no panel takes them (closed, reloading); past this the oldest go, and the next batch
  // says how many (`dropped`). With no panel taking them for a minute, the trace stops: a panel opened
  // again doesn't take up the recording, and offers to save what it had written.
  const MAX_BUFFER = 2000;
  const ORPHAN_MS = 60_000;
  let failingSince = 0;
  const NAMED_KEYS = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
  const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph']);

  let disposed = false;
  let seq = 0;
  let buffer = [];
  let dropped = 0;
  let timer = null;
  const listeners = [];
  const listen = (target, type, fn) => { target.addEventListener(type, fn, true); listeners.push([target, type, fn]); };

  function push(kind, fields, e) {
    if (disposed) return;
    buffer.push({ kind, t: when(e), seq: ++seq, ...fields });
    if (buffer.length > MAX_BUFFER) { buffer.shift(); dropped++; }
    if (!timer) timer = setTimeout(flush, BATCH_MS);
  }

  function flush() {
    timer = null;
    if (!buffer.length || !chrome.runtime?.id) return;
    const events = buffer;
    const lost = dropped;
    buffer = [];
    dropped = 0;
    // The panel answers a batch it took; none (no panel, or one not recording this tab) keeps it.
    // `v`, `recorder`: which trace and recorder wrote them, for the recording's manifest.
    chrome.runtime.sendMessage({ ra: 'trace', events, dropped: lost, v: VERSION, recorder: globalThis.__raterRecorder?.version ?? null }).then((reply) => {
      if (!reply?.ok) throw new Error('not taken');
      failingSince = 0;
    }).catch(() => {
      failingSince ||= performance.now();
      if (performance.now() - failingSince > ORPHAN_MS) { dispose(); return; }
      const all = [...events, ...buffer];
      dropped += lost + Math.max(0, all.length - MAX_BUFFER);
      buffer = all.slice(-MAX_BUFFER);
      if (!timer && !disposed) timer = setTimeout(flush, 2000);
    });
  }

  const num = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : null);
  const viewport = () => ({ w: num(window.innerWidth), h: num(window.innerHeight), dpr: window.devicePixelRatio ?? null });
  const scroll = () => ({ x: num(window.scrollX), y: num(window.scrollY) });
  // Where an element is: its box in the viewport, and its height on the page (`docY`), by which the
  // report tells whether answers went down the page.
  const box = (el) => {
    try {
      const r = el.getBoundingClientRect();
      return { x: num(r.left), y: num(r.top), w: num(r.width), h: num(r.height), docY: num(r.top + (window.scrollY ?? 0)) };
    } catch { return null; }
  };
  // Where a question is: its own box, or, for one drawn with no size and a label on screen (a radio
  // or checkbox shown by its label), the label's, so the report can tell its order down the page.
  const fieldBox = (el) => {
    const own = box(el);
    if (!own || own.w || own.h) return own;
    const label = [...(el.labels ?? [])].find((l) => l.getClientRects?.().length);
    return label ? box(label) ?? own : own;
  };
  const isPassword = (el) => String(el?.type ?? '').toLowerCase() === 'password';

  // What an event was on: the question, as the recorder names it, else the button (its words, as the
  // recorder's agent_click reads them), else the element's tag.
  function targetOf(e) {
    const path = e.composedPath?.() ?? [e.target];
    const el = path[0];
    let control = null;
    try { control = read.controlForEvent(el); } catch { /* not a control */ }
    // An input that is a button (Progressive's Select Product(s), Add Products to Quote) is named
    // by its words, as a button.
    if (control && /^(button|submit|reset|image)$/i.test(control.type ?? '')) {
      return { button: { text: String(control.value || control.alt || control.getAttribute?.('aria-label') || '').trim().slice(0, 60), rect: box(control) } };
    }
    if (control) {
      if (isPassword(control)) return { password: true };
      let field;
      try { field = read.describe(control); } catch { field = { key: null, q: null, kind: null, label: '' }; }
      return { control, field: { key: field.key, q: field.q, kind: field.kind, label: field.label, rect: fieldBox(control) } };
    }
    const selector = read.buttons();
    const button = path.find((n) => n?.matches?.(selector));
    if (button) return { button: { text: read.buttonText(button).slice(0, 60), rect: box(button) } };
    return { other: { tag: String(el?.tagName ?? '').toLowerCase() || null } };
  }
  const about = ({ field, button, other }) => (field ? { field } : button ? { button } : { other });

  // The last trusted gesture on each control: a value event long after it (or with none) is the
  // page's or the extension's (the recorder's rule; the report judges, from `trusted` and this).
  const gestures = new WeakMap();

  for (const type of ['pointerdown', 'click']) {
    listen(window, type, (e) => {
      const target = targetOf(e);
      if (target.password) return;
      if (e.isTrusted && target.control) gestures.set(target.control, when(e));
      push(type === 'click' ? 'click' : 'pointer', { trusted: !!e.isTrusted, x: num(e.clientX), y: num(e.clientY), ...about(target) }, e);
    });
  }

  listen(window, 'keydown', (e) => {
    if (!e.isTrusted || MODIFIERS.has(e.key)) return;
    const target = targetOf(e);
    if (target.password) return;
    if (target.control) gestures.set(target.control, when(e));
    // Space types a character in a text box (printable); on a radio, a box or a button it picks.
    const key = e.key === ' ' ? (target.field?.kind === 'text' ? null : 'Space') : NAMED_KEYS.has(e.key) ? e.key : null;
    const mods = ['ctrlKey', 'altKey', 'metaKey', 'shiftKey'].filter((m) => e[m]).map((m) => m.replace('Key', ''));
    push('key', { ...(key ? { key } : { printable: String(e.key ?? '').length === 1 }), ...(mods.length ? { mods } : {}), ...about(target) }, e);
  });

  for (const type of ['input', 'change']) {
    listen(window, type, (e) => {
      const target = targetOf(e);
      if (!target.control || target.password) return;
      const g = gestures.get(target.control);
      const base = { trusted: !!e.isTrusted, gestureMs: g == null ? null : round(when(e) - g), ...about(target) };
      // A choice's words once the page has shown it: a GEICO option shows its pick on its host only
      // after the page has handled the event (as the recorder reads it, a task later).
      setTimeout(() => {
        let value = null;
        try { value = read.choiceText(target.control); } catch { /* unreadable */ }
        push(type, value == null ? { ...base, len: String(target.control.value ?? '').length } : { ...base, value }, e);
      }, 0);
    });
  }

  for (const [type, kind] of [['focusin', 'focus'], ['focusout', 'blur']]) {
    listen(window, type, (e) => {
      const target = targetOf(e);
      if (!target.control || target.password) return;
      push(kind, about(target), e);
    });
  }

  // Scrolling, at most one event per 100 ms per scrolled thing: the window's position and the page's
  // height, or a scrolled element's own offset. A text box scrolling its own text as it's typed into
  // isn't the page moving.
  const scrolling = new Map();
  listen(window, 'scroll', (e) => {
    const el = e.target && e.target !== document && e.target !== window && e.target.nodeType === 1 ? e.target : null;
    if (/^(INPUT|TEXTAREA)$/.test(el?.tagName ?? '')) return;
    const which = el ?? window;
    if (scrolling.has(which)) return;
    scrolling.set(which, setTimeout(() => {
      scrolling.delete(which);
      push('scroll', el
        ? { el: { tag: el.tagName.toLowerCase(), id: el.id || null }, top: num(el.scrollTop), left: num(el.scrollLeft) }
        : { ...scroll(), height: num(document.documentElement?.scrollHeight) });
    }, 100));
  });

  // The tab shown or hidden: once, from its top frame (every frame of it sees the same).
  if (isTop) listen(document, 'visibilitychange', (e) => push('visible', { state: document.visibilityState }, e));
  for (const type of ['pageshow', 'pagehide']) {
    listen(window, type, (e) => {
      if (isTop) push('visible', { state: type === 'pagehide' ? 'hidden' : document.visibilityState, why: type }, e);
      if (type === 'pagehide') flush();
    });
  }
  // Pasting or dropping into a box is the person's too (as the recorder counts gestures).
  for (const type of ['paste', 'drop']) {
    listen(window, type, (e) => {
      const target = targetOf(e);
      if (e.isTrusted && target.control && !target.password) gestures.set(target.control, when(e));
    });
  }
  let resizing = null;
  listen(window, 'resize', () => {
    if (resizing) return;
    resizing = setTimeout(() => { resizing = null; push('resize', viewport()); }, 200);
  });

  // The page and, in the top frame, the step on screen (GEICO's progress bar, AmWINS' headings; null
  // while they can't be read, as mid-redraw), looked at twice a second.
  const stepNow = () => { try { return isTop ? read.stepKey() ?? null : null; } catch { return null; } };
  // The path without its ids, as the page key has none (an application's number), each part decoded:
  // the panel redacts a client's name as words, which `Sam%20Smith` isn't (review of PR #257).
  const decoded = (p) => String(p ?? '').split('/').map((part) => { try { return decodeURIComponent(part); } catch { return part; } }).join('/');
  const idless = (p) => decoded(p).replace(/\/(?:[0-9a-f]{8}-[0-9a-f-]{27,}|\d{3,})(?=\/|$)/gi, '/:id');
  const pathOf = () => idless(location.pathname);
  let page = read.pageKey();
  let step = stepNow();
  // A document the trace is in from its load (`fresh`: put in within LOAD_MS of its navigation,
  // as the panel does on each load, and the first trace in it): its first `page` is stamped at its
  // navigation start (`injectedAt`: when the trace was put in), a `load` says how it loaded, and
  // the requests it made before the trace are read from the browser's buffer (REC-03, 2026-11-07:
  // a full page load's time and its first requests, often the slow part, were charged to the step
  // before or lost). Once per document: a trace put in again doesn't read them twice.
  const LOAD_MS = 30_000;
  let nav = null;
  try { nav = performance.getEntriesByType?.('navigation')?.[0] ?? null; } catch { /* no timing */ }
  const fresh = !!nav && performance.now() < LOAD_MS && !globalThis.__raterTraceLoaded;
  globalThis.__raterTraceLoaded = true;
  const navAt = (ms) => (typeof ms === 'number' && ms > 0 ? round(performance.timeOrigin + ms) : null);
  push('page', { page, path: pathOf(), title: document.title, step, top: isTop, viewport: viewport(), scroll: scroll(), ...(fresh ? { injectedAt: round(performance.timeOrigin + performance.now()) } : {}) },
    fresh ? { at: performance.timeOrigin } : undefined);
  // `how`: navigate, reload or back_forward; when the server's answer ended (`response`), the
  // document was ready (DOMContentLoaded) and loaded (load), each null while not yet.
  if (fresh) {
    push('load', { how: /^(navigate|reload|back_forward|prerender)$/.test(String(nav.type)) ? nav.type : null, response: navAt(nav.responseEnd),
      ready: navAt(nav.domContentLoadedEventEnd), loaded: navAt(nav.loadEventEnd) }, { at: performance.timeOrigin });
  }
  const watch = setInterval(() => {
    if (!chrome.runtime?.id) { dispose(); return; }
    const nowPage = read.pageKey();
    if (nowPage !== page) {
      push('page', { page: nowPage, from: page, path: pathOf(), title: document.title, step: stepNow(), top: isTop });
      page = nowPage;
    }
    const nowStep = stepNow();
    if (isTop && nowStep !== step) {
      push('step', { step: nowStep, from: step });
      step = nowStep;
    }
    // A component that has its shadow root only now (below).
    lateRoots();
  }, 500);

  // What the page does on its own. A run of DOM changes ends BURST_QUIET_MS after the last one, as
  // one `burst` (stamped when it began): its end, how many records, and the questions it drew
  // (named as the recorder names them, at most MAX_DRAWN) or took away (counted). Open shadow roots
  // are watched too (GEICO's gds-* components draw their controls in them): each one on the page as
  // the trace starts, and each one a change brings, once (REC-19, 2026-11-07: a control redrawn in
  // its shadow root left no change, and a busy GEICO page read as quiet).
  const BURST_QUIET_MS = 100;
  const MAX_DRAWN = 12;
  const MAX_NODES = 500;
  const CONTROLS = 'input, select, textarea';
  let burst = null;
  let burstTimer = null;
  // In an element, or in a shadow root a change brought (11).
  const controlsIn = (node) => {
    if (node?.nodeType !== 1 && node?.nodeType !== 11) return [];
    let inside = [];
    try { inside = [...(node.querySelectorAll?.(CONTROLS) ?? [])]; } catch { /* not queryable */ }
    return node.matches?.(CONTROLS) ? [node, ...inside] : inside;
  };
  const asQuestion = (el) => !isPassword(el) && !/^(hidden|button|submit|reset|image)$/i.test(String(el.type ?? ''));
  // A box drawn with no size and no label on screen is the page's own bookkeeping, not a question
  // (Progressive's Current Page Errored and SSID values, named among every page's new questions in
  // the recordings of 2026-11-04).
  // The boxes left out as they were drawn (`shown`), so their removal isn't counted either.
  const unseen = new WeakSet();
  const shown = (el) => {
    let r = null;
    try { r = el.getBoundingClientRect?.() ?? null; } catch { /* not laid out */ }
    return !r || r.width > 0 || r.height > 0 || [...(el.labels ?? [])].some((l) => l.getClientRects?.().length);
  };
  function endBurst() {
    clearTimeout(burstTimer);
    burstTimer = null;
    const b = burst;
    burst = null;
    if (!b) return;
    // Counted before this burst's own draws change what was left out: a box left out as it was
    // drawn is left out as it goes too (it has no size to measure by then). Only what is off the page as the burst ends
    // counts (a control moved stays on it), and not one this burst made: added and taken away again,
    // it was never drawn in the trace.
    let removed = 0;
    for (const node of b.removed) {
      if (node.isConnected === true || b.created.has(node)) continue;
      removed += controlsIn(node).filter((el) => asQuestion(el) && !unseen.has(el)).length;
    }
    const drawn = [];
    let drawnCount = 0;
    const seen = new Set();
    for (const node of b.added) {
      if (node.isConnected === false) continue;
      for (const el of controlsIn(node)) {
        if (seen.has(el) || !asQuestion(el)) continue;
        if (!shown(el)) { unseen.add(el); continue; }
        // Drawn again where it shows: a question now, and its removal counted.
        unseen.delete(el);
        seen.add(el);
        drawnCount++;
        if (drawn.length >= MAX_DRAWN) continue;
        try { const f = read.describe(el); drawn.push({ key: f.key, kind: f.kind, label: f.label }); } catch { /* unreadable */ }
      }
    }
    push('burst', { end: b.end, records: b.records, ...(drawnCount ? { drawn, drawnCount } : {}), ...(removed ? { removed } : {}) }, { timeStamp: b.start });
  }
  let mutations = null;
  // A change now (`records` of them): the burst it is part of, begun or carried on.
  const changeNow = (records) => {
    const now = performance.now();
    burst ??= { start: now, records: 0, added: new Set(), removed: new Set(), created: new Set() };
    burst.end = round(performance.timeOrigin + now);
    burst.records += records;
    clearTimeout(burstTimer);
    burstTimer = setTimeout(endBurst, BURST_QUIET_MS);
  };
  // The open shadow roots in and under the page as the trace starts and each node a change adds
  // (theirs too), each observed once. Looked through in turns of at most SHADOW_SCAN elements, the
  // rest on the next tick, so a large page or redraw never stalls the page and none is left unlooked
  // (review of PR #377). A node added under one still waiting its turn waits on that one's look.
  // A root a change brought is part of that change: its controls, drawn before it was watched,
  // count as drawn (`drawn`). A component whose root came after it was looked at (one defined
  // later: its upgrade attaches the root, and no change says so) is looked at again each half
  // second while it has none, at most MAX_BARE of them (`bare`).
  const watchedRoots = new WeakSet();
  const SHADOW_SCAN = 5000;
  const MAX_BARE = 1000;
  const shadowWork = [];
  const waiting = new Set();
  const bare = new Set();
  let looking = null;
  let shadowTimer = null;
  const toLook = (node, drawn) => { shadowWork.push({ node, drawn }); waiting.add(node); };
  const waitsAbove = (node) => {
    for (let p = node.parentNode ?? node.host; p; p = p.parentNode ?? p.host) if (waiting.has(p)) return true;
    return false;
  };
  // The elements under a node one at a time (a tree walker, so a turn's look stops where its budget
  // does, never listing a large subtree first); a list of them where there is no walker.
  const SHOW_ELEMENT = (typeof NodeFilter === 'object' && NodeFilter?.SHOW_ELEMENT) || 1;
  const elementsIn = (node) => {
    try {
      const walker = document.createTreeWalker?.(node, SHOW_ELEMENT);
      if (typeof walker?.nextNode === 'function') return () => walker.nextNode();
    } catch { /* not walkable */ }
    let list = [];
    try { list = node.querySelectorAll?.('*') ?? []; } catch { /* not queryable */ }
    let i = 0;
    return () => (i < list.length ? list[i++] : null);
  };
  const rootOf = (el, drawn) => {
    const root = el?.shadowRoot;
    if (!root) {
      if (String(el?.localName ?? '').includes('-') && bare.size < MAX_BARE) bare.add(el);
      return;
    }
    bare.delete(el);
    if (watchedRoots.has(root)) return;
    watchedRoots.add(root);
    try { mutations.observe(root, { childList: true, subtree: true }); } catch { return; }
    if (drawn) {
      changeNow(0);
      if (burst.added.size < MAX_NODES) { burst.added.add(root); burst.created.add(root); }
    }
    toLook(root, drawn);
  };
  const lookForShadows = () => {
    shadowTimer = null;
    if (!mutations || disposed) return;
    let budget = SHADOW_SCAN;
    while (budget > 0) {
      if (!looking) {
        const next = shadowWork.shift();
        if (!next) break;
        waiting.delete(next.node);
        looking = { next: elementsIn(next.node), drawn: next.drawn };
        if (next.node.nodeType === 1) { rootOf(next.node, next.drawn); budget--; }
      }
      while (budget > 0) {
        const el = looking.next();
        if (!el) { looking = null; break; }
        rootOf(el, looking.drawn);
        budget--;
      }
    }
    if (looking || shadowWork.length) shadowTimer = setTimeout(lookForShadows, 0);
  };
  // The components seen with no root, again: one that has one now is a change that drew it.
  const lateRoots = () => {
    if (!mutations || disposed) return;
    for (const el of bare) {
      if (el.shadowRoot) rootOf(el, true);
      else if (el.isConnected === false) bare.delete(el);
    }
    if (shadowWork.length && !shadowTimer) lookForShadows();
  };
  if (typeof MutationObserver === 'function') {
    mutations = new MutationObserver((records) => {
      changeNow(records.length);
      for (const r of records) {
        // Added before this burst took it away: made in this burst, not moved (`created`).
        for (const n of r.addedNodes ?? []) if (burst.added.size < MAX_NODES) { burst.added.add(n); if (!burst.removed.has(n)) burst.created.add(n); }
        for (const n of r.removedNodes ?? []) if (burst.removed.size < MAX_NODES) burst.removed.add(n);
        // A component drawn in this change attaches its shadow root as it is put in the page.
        for (const n of r.addedNodes ?? []) if (n?.nodeType === 1 && !waiting.has(n) && !waitsAbove(n)) toLook(n, true);
      }
      if (!shadowTimer) lookForShadows();
    });
    try { mutations.observe(document.documentElement ?? document, { childList: true, subtree: true }); } catch { mutations = null; }
    if (mutations) { toLook(document, false); lookForShadows(); }
  }

  // The page's own requests (fetch or XHR to its origin), each as it finishes: its path without the
  // query or ids, when it started (the event's time) and ended, and the HTTP status the server
  // answered (`status`; 0 when the browser doesn't say, as for an opaque response), so a carrier's
  // own error shows (REC-20, 2026-11-07). One still running isn't seen.
  const recordRequests = (entries) => {
    for (const r of entries) {
      if (!/^(fetch|xmlhttprequest)$/.test(r.initiatorType) || !String(r.name).startsWith(`${location.origin}/`)) continue;
      let p = '';
      try { p = new URL(r.name).pathname; } catch { continue; }
      const status = Number.isInteger(r.responseStatus) ? { status: r.responseStatus } : {};
      push('request', { path: idless(p), end: round(performance.timeOrigin + r.responseEnd), ms: round(r.responseEnd - r.startTime), via: r.initiatorType === 'fetch' ? 'fetch' : 'xhr', ...status }, { timeStamp: r.startTime });
    }
  };
  let requests = null;
  try {
    requests = new PerformanceObserver((list) => recordRequests(list.getEntries()));
    requests.observe({ type: 'resource', buffered: fresh });
  } catch { requests = null; }

  // What the extension's fill says (pagekit.js `kitTrace`), by its own time: a JSON string from
  // whichever world the kit runs in. The page could dispatch the same event, so each is built
  // afresh from its documented fields: a number or a yes/no only as one, a fixed word only as one
  // of its words, a step's kind only as one of the plan's (the carriers' rules and the kit's; a
  // kind not listed here is shown as none, never kept as text: a shape let `sam-smith` through,
  // review of PR #258). Nothing the page gave is passed on as it is; a long one, or one missing
  // what it must say, is left out (review of PR #257).
  const WAITS_FOR = new Set(['answer', 'round', 'load', 'before-load', 'rated', 'continue', 'drawn', 'start', 'helper', 'continued']);
  const STEP_KINDS = new Set(['action', 'address-suggest', 'bool', 'choice', 'date', 'first-option', 'int', 'money', 'phone', 'pick-not', 'radio',
    'search-select', 'selected-option', 'state', 'text']);
  const TIMING = ['ms', 'settleMs', 'ajax', 'revealed', 'removed', 'changed'];
  const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
  const words = (s, max) => (typeof s === 'string' ? s.slice(0, max) : null);
  function kitSaid(said) {
    const nums = (from, keys) => Object.fromEntries(keys.filter((k) => isNum(from[k])).map((k) => [k, from[k]]));
    const yesNo = (from, keys) => Object.fromEntries(keys.filter((k) => typeof from[k] === 'boolean').map((k) => [k, from[k]]));
    const has = (x) => !!x && typeof x === 'object';
    if (said.what === 'run') return { what: 'run', ...yesNo(said, ['on', 'halted']), ...nums(said, ['steps', 'filled']) };
    if (said.what === 'press') return { what: 'press', button: { text: words(said.button?.text, 60) ?? '' }, ...(said.how === 'page' || said.how === 'kit' ? { how: said.how } : {}) };
    if (said.what === 'wait') {
      if (!isNum(said.start) || !isNum(said.ms) || (said.ended !== 'quiet' && said.ended !== 'limit')) return null;
      const held = has(said.held) ? { held: { busy: said.held.busy === true, changing: said.held.changing === true, requests: said.held.requests === true } } : {};
      return { what: 'wait', why: WAITS_FOR.has(said.why) ? said.why : null, start: said.start, ms: said.ms, ended: said.ended,
        ...nums(said, ['quietMs', 'maxMs', 'lastChange', 'lastHeld']), ...yesNo(said, ['requests', 'settled']), ...held };
    }
    if (said.what === 'answer') {
      if (!has(said.field) || !isNum(said.start)) return null;
      const timing = has(said.timing) ? { timing: { ...nums(said.timing, TIMING), ...yesNo(said.timing, ['batch']) } } : {};
      return { what: 'answer', field: { key: words(said.field.key, 200), label: words(said.field.label, 200) ?? '' },
        stepKind: STEP_KINDS.has(said.stepKind) ? said.stepKind : null, start: said.start,
        ...yesNo(said, ['ok']), ...nums(said, ['applyMs']), ...timing };
    }
    return null;
  }
  listen(document, 'rater-trace', (e) => {
    const text = typeof e.detail === 'string' ? e.detail : '';
    if (!text || text.length > 4000) return;
    let said;
    try { said = JSON.parse(text); } catch { return; }
    if (!said || typeof said !== 'object' || !isNum(said.t)) return;
    const fields = kitSaid(said);
    if (fields) push('kit', fields, { timeStamp: said.t - performance.timeOrigin });
  });

  // Stop: what is buffered goes, then nothing more. Requests the browser finished but hasn't
  // handed the observer yet are taken first: disconnecting drops them (review of PR #257).
  const onMessage = (msg) => {
    if (msg?.ra !== 'trace' || msg.cmd !== 'stop') return;
    endBurst();
    try { recordRequests(requests?.takeRecords?.() ?? []); } catch { /* none to take */ }
    flush();
    dispose();
  };
  chrome.runtime.onMessage.addListener(onMessage);

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearInterval(watch);
    clearTimeout(timer);
    clearTimeout(resizing);
    clearTimeout(burstTimer);
    clearTimeout(shadowTimer);
    mutations?.disconnect();
    requests?.disconnect();
    for (const t of scrolling.values()) clearTimeout(t);
    for (const [target, type, fn] of listeners) target.removeEventListener(type, fn, true);
    chrome.runtime.onMessage.removeListener?.(onMessage);
    if (globalThis.__raterTrace === api) delete globalThis.__raterTrace;
  }

  const api = { version: VERSION, alive: () => !disposed && !!chrome.runtime?.id, dispose, flush };
  globalThis.__raterTrace = api;
})();
