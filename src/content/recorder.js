// Usage recorder, injected by the side panel into supported rater pages while an
// intake is loaded. Runs in the extension's isolated world, so the rater page's own scripts
// can't see it.
//
// Every 1.5 s it snapshots the visible form fields and reports what changed, plus page switches,
// to the side panel. The side panel decides what gets logged: typed text is compared with the
// intake there and thrown away. Nothing is stored here and nothing leaves the computer.
//
// A trusted input/change event identifies the exact control the agent changed. A gesture on that
// control remains a compatibility fallback for widgets which do not emit those events.

(() => {
  const VERSION = 4;
  const previous = globalThis.__raterRecorder;
  if (previous) {
    // Flush any trusted edit before rebaseline or replacing an older recorder. This keeps a
    // native change that landed immediately before reinjection from disappearing.
    previous.rebaseline?.();
    // Reusing the current recorder avoids resetting its listeners on every fill. Older versions
    // have no dispose hook, so rebaseline and leave the sole installed recorder in place rather
    // than starting a second timer that would duplicate usage events.
    if (previous.version === VERSION || typeof previous.dispose !== 'function') return;
    previous.dispose();
  }

  const generation = Number(globalThis.__raterRecorderGeneration ?? 0) + 1;
  globalThis.__raterRecorderGeneration = generation;
  let api;
  let disposed = false;
  const isCurrent = () => !disposed
    && globalThis.__raterRecorderGeneration === generation
    && globalThis.__raterRecorder === api;

  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file', 'password', 'search']);
  const TICK_MS = 1500;
  const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

  let lastTrusted = 0;
  let lastTrustedControl = null;
  const trustedPending = new Map();
  const trustedImmediate = new Set();
  const eventListeners = [];
  const listen = (type, listener) => {
    addEventListener(type, listener, true);
    eventListeners.push([type, listener]);
  };
  const isControl = (el) => {
    const tag = el?.tagName?.toUpperCase();
    return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  };

  const controlForEvent = (target) => {
    if (isControl(target)) return target;
    const direct = target?.closest?.('input, select, textarea');
    if (isControl(direct)) return direct;
    const wrapper = target?.closest?.('.x-form-trigger-wrap');
    const nested = wrapper?.querySelector?.('input, select, textarea');
    if (isControl(nested)) return nested;
    const option = target?.closest?.('[role=option], .x-boundlist-item');
    const popup = option?.closest?.('[role=listbox], .x-boundlist');
    if (popup) {
      const popupId = popup.id || popup.getAttribute?.('id');
      if (popupId) {
        const owners = document.querySelectorAll?.('input, select, textarea, [role=combobox]') ?? [];
        for (const owner of owners) {
          const refs = `${owner.getAttribute?.('aria-owns') ?? ''} ${owner.getAttribute?.('aria-controls') ?? ''}`.split(/\s+/).filter(Boolean);
          if (!refs.includes(popupId)) continue;
          const ownerControl = isControl(owner) ? owner : owner.querySelector?.('input, select, textarea');
          if (isControl(ownerControl)) return ownerControl;
        }
      }
      // ExtJS often leaves the combo input focused while the option popup receives the click.
      const focused = document.activeElement;
      if (isControl(focused)) return focused;
      const focusedControl = focused?.closest?.('input, select, textarea');
      if (isControl(focusedControl)) return focusedControl;
    }
    const id = target?.htmlFor || target?.getAttribute?.('for');
    const linked = id ? document.getElementById?.(id) : null;
    return isControl(linked) ? linked : null;
  };

  for (const type of ['pointerdown', 'mousedown', 'keydown', 'paste', 'drop']) {
    listen(type, (e) => {
      if (!e.isTrusted) return;
      lastTrusted = Date.now();
      lastTrustedControl = controlForEvent(e.target);
    });
  }

  const oneControlState = (el) => {
    if (!isControl(el)) return null;
    const type = (el.type || el.tagName).toLowerCase();
    if (type === 'radio' || type === 'checkbox') return `${type}:${el.checked ? '1' : '0'}:${String(el.value ?? '')}`;
    if (el.tagName?.toUpperCase() === 'SELECT') {
      const option = el.selectedOptions?.[0];
      return `select:${String(el.value ?? '')}:${oneLine(option?.text ?? '')}`;
    }
    return `text:${String(el.value ?? '')}`;
  };

  const isDiscreteControl = (el) => {
    if (!isControl(el)) return false;
    const type = (el.type || el.tagName).toLowerCase();
    if (type === 'radio' || type === 'checkbox' || el.tagName?.toUpperCase() === 'SELECT') return true;
    // ExtJS combos are text inputs with a discrete option selection.
    const trigger = el.closest?.('.x-form-trigger-wrap')?.querySelector?.('.x-form-trigger');
    return !!trigger && /arrow|combo/.test(trigger.className) && !/date|time|picker-date/.test(trigger.className);
  };

  // input/change fires after the native control has its new value. Store that value so a page
  // script which immediately changes the same control is not mistaken for the agent's answer.
  // Ordinary text waits for the existing poll, coalescing a typing sequence into one event;
  // discrete controls still flush immediately so follow-up questions can be detected promptly.
  const trustedValue = (e) => {
    if (!isCurrent() || !e.isTrusted || !isControl(e.target)) return;
    trustedPending.set(e.target, oneControlState(e.target));
    const discrete = isDiscreteControl(e.target);
    if (discrete) trustedImmediate.add(e.target);
    // Once an explicit value event exists, the broad gesture fallback must not classify another
    // control changed in the same polling window as manual.
    lastTrusted = 0;
    lastTrustedControl = null;
    if (discrete) Promise.resolve().then(() => flushTrusted({ immediateOnly: true }));
  };
  listen('input', trustedValue);
  listen('change', trustedValue);

  // Duck Creek question id from an element id (f_<letter><32 hex><q>_<page>_<row>) or field name.
  const questionId = (el) => el.id?.match(/^f_[a-z]([0-9A-F]{32})([0-9A-F]+)_\d+_\d+/i)?.[2]?.toUpperCase()
    ?? el.name?.match(/^[a-z]+_([0-9A-F]+)(\||$)/i)?.[1]?.toUpperCase() ?? null;

  const fieldKey = (el, q, radio) => {
    try {
      if (typeof globalThis.__raterFieldKey === 'function') {
        return globalThis.__raterFieldKey(el, { q, radio });
      }
    } catch { /* fall through to the stable legacy key */ }
    return q ?? ((radio ? el.name : el.name || el.id) || '');
  };

  const isVisible = (el) => el.getClientRects().length > 0 || [...(el.labels ?? [])].some((l) => l.getClientRects().length);

  // Nearest text before the field (Duck Creek puts the question text just above its answers).
  function textBefore(el) {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    w.currentNode = el;
    for (let i = 0; i < 12 && w.previousNode(); i++) {
      const p = w.currentNode.parentElement;
      // Skip other fields' answers, validation messages and bare numbers (ZIPs, dates).
      if (!p || p.closest('script, style, option, label, button, [role=alert], [class*="error"], [class*="invalid"], [class*="boxLabel"], [class*="cb-label"]')) continue;
      const t = oneLine(w.currentNode.nodeValue);
      if (t.length > 2 && !/^[\d\s/().,$-]+$/.test(t) && !/^(mm\/dd\/yyyy|continue|back|next)$/i.test(t)) return t.slice(0, 160);
    }
    return '';
  }

  const labels = new Map();
  function labelFor(key, el) {
    if (!labels.has(key)) {
      const own = oneLine([...(el.labels ?? [])].map((l) => l.textContent).join(' ') || el.getAttribute('aria-label') || '');
      labels.set(key, (el.type === 'radio' ? '' : own) || textBefore(el) || own || el.placeholder || el.name || '');
    }
    return labels.get(key);
  }

  // ExtJS dropdowns have an arrow trigger. Date pickers also have a trigger (and ARIA role
  // combobox), but what's in them is typed text, so they must stay 'text'.
  const isCombo = (el) => {
    const trigger = el.closest('.x-form-trigger-wrap')?.querySelector('.x-form-trigger');
    return !!trigger && /arrow|combo/.test(trigger.className) && !/date|time|picker-date/.test(trigger.className);
  };

  function snapshot() {
    const out = new Map();
    for (const el of document.querySelectorAll('input, select, textarea')) {
      const type = (el.type || el.tagName).toLowerCase();
      if (SKIP_TYPES.has(type) || el.disabled || !isVisible(el)) continue;
      const q = questionId(el);
      if (type === 'radio') {
        const key = fieldKey(el, q, true);
        const entry = out.get(key) ?? { key, q, kind: 'radio', label: labelFor(key, el.closest('[role=radiogroup], fieldset') ?? el), v: '', controls: [] };
        if (!entry.controls.includes(el)) entry.controls.push(el);
        if (el.checked) entry.v = oneLine([...(el.labels ?? [])].map((l) => l.textContent).join(' ')) || el.value;
        out.set(key, entry);
        continue;
      }
      const key = fieldKey(el, q, false);
      let kind = 'text';
      let combo;
      let v = el.value;
      if (el.tagName === 'SELECT') {
        kind = 'select';
        const o = el.selectedOptions[0];
        v = o && o.value !== '' ? oneLine(o.text) : '';
      } else if (type === 'checkbox') {
        kind = 'checkbox';
        v = el.checked ? 'checked' : 'unchecked';
      } else if (isCombo(el)) {
        // The box text, which can be a search typed into it, not a pick. Flagged so the side panel
        // logs it as a choice only when it's one of the combo's options.
        kind = 'select';
        combo = true;
      }
      out.set(key, { key, q, kind, combo, label: labelFor(key, el), v: String(v ?? ''), controls: [el] });
    }
    return out;
  }

  // Progressive reloads a page as "<Page>-Reload" after some answers; it's the same page.
  // Progressive names its pages in ?pageName=; other sites by path or #/route (ids normalised).
  const pageKey = () => (new URLSearchParams(location.search).get('pageName') || (location.pathname + ((location.hash ?? '').startsWith('#/') ? location.hash.slice(1).split('?')[0] : '')).replace(/\/(?:[0-9a-f]{8}-[0-9a-f-]{27,}|\d{3,})(?=\/|$)/gi, '/:id')).replace(/-Reload$/, '');
  const isTop = window === window.top;

  let paused = false;
  let page = pageKey();
  let prev = snapshot();

  function send(msg) {
    if (!isCurrent()) return;
    if (!chrome.runtime?.id) { clearInterval(timer); return; } // extension was reloaded
    chrome.runtime.sendMessage({ ra: 'usage', ...msg }).catch(() => {});
  }

  function changedFields(cur, explicitControls = null, skipControls = null) {
    const agent = Date.now() - lastTrusted < 3000 + TICK_MS;
    const changes = [];
    for (const [key, c] of cur) {
      if (skipControls && c.controls.some((el) => skipControls.has(el))) continue;
      const before = prev.get(key);
      // A field that just appeared (a follow-up question) isn't a change until it's answered.
      if (!before && !c.v) continue;
      // One that appears already answered (a step shown again, a lookup adding a row) was filled
      // by the page, never by the agent, even right after the agent clicked.
      if ((before?.v ?? '') !== c.v) {
        const manual = before && c.controls.some((el) => trustedPending.get(el) === oneControlState(el));
        changes.push({ key, q: c.q, label: c.label, kind: c.kind, combo: c.combo, before: before?.v ?? '', after: c.v,
          agent: before ? (explicitControls ? manual : agent && c.controls.includes(lastTrustedControl)) : false });
      }
    }
    return changes;
  }

  function flushTrusted({ immediateOnly = false } = {}) {
    if (!isCurrent() || paused || !trustedPending.size) return;
    const pending = new Set([...trustedPending.keys()].filter((el) => !immediateOnly || trustedImmediate.has(el)));
    if (!pending.size) return;
    const nowPage = pageKey();
    const cur = snapshot();
    if (nowPage !== page) {
      pageChanged(nowPage, cur);
      prev = cur;
      return;
    }
    // Keep the old baseline for deferred text controls when a discrete choice flushes first.
    // Otherwise the later poll would see no difference and lose the coalesced text event.
    const deferred = immediateOnly
      ? new Set([...trustedPending.keys()].filter((el) => !pending.has(el))) : new Set();
    const changes = changedFields(cur, pending, deferred);
    const appeared = [...cur.entries()]
      .filter(([key, c]) => !prev.has(key) && (!immediateOnly || !c.controls.some((el) => deferred.has(el))))
      .map(([key]) => key);
    for (const [key, c] of cur) if (!c.controls.some((el) => deferred.has(el))) prev.set(key, c);
    if (changes.length) send({ event: 'field_changes', page, changes });
    if (appeared.length) send({ event: 'new_fields', page, keys: appeared });
    for (const el of pending) {
      trustedPending.delete(el);
      trustedImmediate.delete(el);
    }
  }

  function tick() {
    if (!isCurrent() || paused) return;
    const nowPage = pageKey();
    const cur = snapshot();
    if (nowPage !== page) {
      pageChanged(nowPage, cur);
      prev = cur;
      return;
    }
    const pending = trustedPending.size ? new Set(trustedPending.keys()) : null;
    const changes = changedFields(cur, pending);
    const appeared = [...cur.keys()].filter((k) => !prev.has(k));
    prev = cur;
    if (changes.length) send({ event: 'field_changes', page, changes });
    // A trusted value event is valid for one snapshot only. This also drops controls that were
    // replaced by a redraw before the poll, keeping an old element from authorizing later edits.
    trustedPending.clear();
    trustedImmediate.clear();
    // New questions (follow-ups revealed by an answer, or a panel that opened): the side panel
    // may fill them automatically.
    if (appeared.length) send({ event: 'new_fields', page, keys: appeared });
  }

  // Only the top frame reports page switches; embedded frames (ads, trackers) would be noise.
  function pageChanged(nowPage, cur) {
    trustedPending.clear();
    trustedImmediate.clear();
    if (isTop) send({ event: 'page_view', page: nowPage, from: page, fields: cur.size, title: document.title });
    page = nowPage;
  }

  // After a pause (autofill running) the page may have moved on; report that, then start fresh.
  function rebaseline() {
    if (!isCurrent()) return;
    // ensureRecorder() can reinject this script immediately after a native change, before the
    // microtask flush runs. Emit that trusted change before replacing the baseline.
    flushTrusted();
    const cur = snapshot();
    if (pageKey() !== page) pageChanged(pageKey(), cur);
    prev = cur;
    trustedPending.clear();
    trustedImmediate.clear();
  }

  const timer = setInterval(tick, TICK_MS);

  const onMessage = (msg) => {
    if (!isCurrent() || msg?.ra !== 'recorder') return;
    if (msg.cmd === 'pause') paused = true;
    if (msg.cmd === 'resume') { rebaseline(); paused = false; }
  };
  chrome.runtime.onMessage.addListener(onMessage);

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    trustedPending.clear();
    trustedImmediate.clear();
    eventListeners.forEach(([type, listener]) => removeEventListener?.(type, listener, true));
    chrome.runtime.onMessage.removeListener?.(onMessage);
  }

  api = {
    version: VERSION,
    rebaseline,
    dispose,
  };
  globalThis.__raterRecorder = api;

  if (isTop) send({ event: 'page_view', page, from: null, fields: prev.size, title: document.title });
})();
