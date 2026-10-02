// Usage recorder, injected by the side panel into rater pages (Progressive/GEICO only) while an
// intake is loaded. Runs in the extension's isolated world, so the rater page's own scripts
// can't see it.
//
// Every 1.5 s it snapshots the visible form fields and reports what changed, plus page switches,
// to the side panel. The side panel decides what gets logged: typed text is compared with the
// intake there and thrown away. Nothing is stored here and nothing leaves the computer.
//
// A change counts as the agent's if a real (trusted) click, key press or paste happened in the
// last 3 seconds; otherwise it was the page itself (e.g. a USDOT lookup filling the address).

(() => {
  if (globalThis.__raterRecorder) {
    globalThis.__raterRecorder.rebaseline();
    return;
  }

  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file', 'password', 'search']);
  const TICK_MS = 1500;
  const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

  let lastTrusted = 0;
  for (const type of ['pointerdown', 'mousedown', 'keydown', 'paste', 'drop']) {
    addEventListener(type, (e) => { if (e.isTrusted) lastTrusted = Date.now(); }, true);
  }

  // Duck Creek question id from an element id (f_<letter><32 hex><q>_<page>_<row>) or field name.
  const questionId = (el) => el.id?.match(/^f_[a-z]([0-9A-F]{32})([0-9A-F]+)_\d+_\d+/i)?.[2]?.toUpperCase()
    ?? el.name?.match(/^[a-z]+_([0-9A-F]+)(\||$)/i)?.[1]?.toUpperCase() ?? null;

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
        const key = q ?? (el.name || el.id);
        const entry = out.get(key) ?? { key, q, kind: 'radio', label: labelFor(key, el.closest('[role=radiogroup], fieldset') ?? el), v: '' };
        if (el.checked) entry.v = oneLine([...(el.labels ?? [])].map((l) => l.textContent).join(' ')) || el.value;
        out.set(key, entry);
        continue;
      }
      const key = q ?? ((el.name || el.id) || labelFor(el, el));
      let kind = 'text';
      let v = el.value;
      if (el.tagName === 'SELECT') {
        kind = 'select';
        const o = el.selectedOptions[0];
        v = o && o.value !== '' ? oneLine(o.text) : '';
      } else if (type === 'checkbox') {
        kind = 'checkbox';
        v = el.checked ? 'checked' : 'unchecked';
      } else if (isCombo(el)) {
        kind = 'select';
      }
      out.set(key, { key, q, kind, label: labelFor(key, el), v: String(v ?? '') });
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
    if (!chrome.runtime?.id) { clearInterval(timer); return; } // extension was reloaded
    chrome.runtime.sendMessage({ ra: 'usage', ...msg }).catch(() => {});
  }

  function tick() {
    if (paused) return;
    const nowPage = pageKey();
    const cur = snapshot();
    if (nowPage !== page) {
      pageChanged(nowPage, cur);
      prev = cur;
      return;
    }
    const agent = Date.now() - lastTrusted < 3000 + TICK_MS;
    const changes = [];
    for (const [key, c] of cur) {
      const before = prev.get(key);
      // A field that just appeared (a follow-up question) isn't a change until it's answered.
      if (!before && !c.v) continue;
      if ((before?.v ?? '') !== c.v) changes.push({ key, q: c.q, label: c.label, kind: c.kind, before: before?.v ?? '', after: c.v, agent });
    }
    const appeared = [...cur.keys()].filter((k) => !prev.has(k));
    prev = cur;
    if (changes.length) send({ event: 'field_changes', page, changes });
    // New questions (follow-ups revealed by an answer, or a panel that opened): the side panel
    // may fill them automatically.
    if (appeared.length) send({ event: 'new_fields', page, keys: appeared });
  }

  // Only the top frame reports page switches; embedded frames (ads, trackers) would be noise.
  function pageChanged(nowPage, cur) {
    if (isTop) send({ event: 'page_view', page: nowPage, from: page, fields: cur.size, title: document.title });
    page = nowPage;
  }

  // After a pause (autofill running) the page may have moved on; report that, then start fresh.
  function rebaseline() {
    const cur = snapshot();
    if (pageKey() !== page) pageChanged(pageKey(), cur);
    prev = cur;
  }

  const timer = setInterval(tick, TICK_MS);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.ra !== 'recorder') return;
    if (msg.cmd === 'pause') paused = true;
    if (msg.cmd === 'resume') { rebaseline(); paused = false; }
  });

  globalThis.__raterRecorder = {
    rebaseline,
  };

  if (isTop) send({ event: 'page_view', page, from: null, fields: prev.size, title: document.title });
})();
