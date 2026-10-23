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

(() => {
  const VERSION = 1;
  const previous = globalThis.__raterTrace;
  if (previous?.version === VERSION && previous.alive?.()) return;
  previous?.dispose?.();
  // The recorder (version 12 on) is injected with this file, before it, in the same world.
  const read = globalThis.__raterRecorder?.read;
  if (!read) return;

  const isTop = window === window.top;
  const round = (n) => Math.round(n * 10) / 10;
  // When an event happened, on the page's clock (wall-clock ms), not when this saw it.
  const when = (e) => round(performance.timeOrigin + (typeof e?.timeStamp === 'number' && e.timeStamp > 0 ? e.timeStamp : performance.now()));
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
    chrome.runtime.sendMessage({ ra: 'trace', events, dropped: lost }).then((reply) => {
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
  const isPassword = (el) => String(el?.type ?? '').toLowerCase() === 'password';

  // What an event was on: the question, as the recorder names it, else the button (its words, as the
  // recorder's agent_click reads them), else the element's tag.
  function targetOf(e) {
    const path = e.composedPath?.() ?? [e.target];
    const el = path[0];
    let control = null;
    try { control = read.controlForEvent(el); } catch { /* not a control */ }
    if (control) {
      if (isPassword(control)) return { password: true };
      let field;
      try { field = read.describe(control); } catch { field = { key: null, q: null, kind: null, label: '' }; }
      return { control, field: { key: field.key, q: field.q, kind: field.kind, label: field.label, rect: box(control) } };
    }
    const button = path.find((n) => n?.matches?.(read.BUTTONS));
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

  listen(document, 'visibilitychange', (e) => push('visible', { state: document.visibilityState }, e));
  for (const type of ['pageshow', 'pagehide']) {
    listen(window, type, (e) => {
      push('visible', { state: type === 'pagehide' ? 'hidden' : document.visibilityState, why: type }, e);
      if (type === 'pagehide') flush();
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
  let page = read.pageKey();
  let step = stepNow();
  push('page', { page, path: location.pathname, title: document.title, step, top: isTop, viewport: viewport(), scroll: scroll() });
  const watch = setInterval(() => {
    if (!chrome.runtime?.id) { dispose(); return; }
    const nowPage = read.pageKey();
    if (nowPage !== page) {
      push('page', { page: nowPage, from: page, path: location.pathname, title: document.title, step: stepNow(), top: isTop });
      page = nowPage;
    }
    const nowStep = stepNow();
    if (isTop && nowStep !== step) {
      push('step', { step: nowStep, from: step });
      step = nowStep;
    }
  }, 500);

  // Stop: what is buffered goes, then nothing more.
  const onMessage = (msg) => {
    if (msg?.ra !== 'trace' || msg.cmd !== 'stop') return;
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
    for (const t of scrolling.values()) clearTimeout(t);
    for (const [target, type, fn] of listeners) target.removeEventListener(type, fn, true);
    chrome.runtime.onMessage.removeListener?.(onMessage);
    if (globalThis.__raterTrace === api) delete globalThis.__raterTrace;
  }

  const api = { version: VERSION, alive: () => !disposed && !!chrome.runtime?.id, dispose, flush };
  globalThis.__raterTrace = api;
})();
