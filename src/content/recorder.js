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
//
// GEICO (sales.geico.com) draws its radios and buttons inside open shadow roots: the snapshot
// reads through them, and every event is taken at the element it happened on (composedPath), not
// at the shadow host it reaches the window as.

(() => {
  const VERSION = 12;
  const previous = globalThis.__raterRecorder;
  // A recorder left by an extension that was reloaded or updated can no longer reach the panel.
  const orphaned = previous?.alive?.() === false;
  if (previous) {
    // Report what changed since the recorder's last poll before reusing or replacing it, so an
    // edit that landed immediately before reinjection doesn't disappear into a new baseline: the
    // panel reinjects on every tab update, and an ExtJS combo pick fires no input/change event
    // (2026-10-20: a General Liability limit picked just before "Done with this coverage" was never
    // logged). A version-8 recorder has no poll: it flushes its trusted edits and rebaselines.
    if (!orphaned) (previous.poll ?? previous.rebaseline)?.();
    // Reusing the current recorder avoids resetting its listeners on every fill. Older versions
    // have no dispose hook, so rebaseline and leave the sole installed recorder in place rather
    // than starting a second timer that would duplicate usage events.
    if ((previous.version === VERSION && !orphaned) || typeof previous.dispose !== 'function') return;
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
  // A search box that is an address question is recorded, as pagekit collects it: GEICO's street
  // box (type=search with its suggestion list). A site search or a select2 list's filter box is not.
  const ADDRESS_SEARCH = 'input[type=search][aria-autocomplete=list][aria-controls]:not(.select2-search__field)';
  const TICK_MS = 1500;
  const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  // As pagekit's squash and humanize.
  const squash = (s) => String(s ?? '').toLowerCase().replace(/['’*]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const humanize = (s) => squash(String(s ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-.[\]$:]+/g, ' '));

  // Every match under root in page order, open shadow roots included: a shadow root's matches at
  // its host's place, as pagekit's deepQueryAll. A page with no shadow root (Progressive, AmWINS)
  // is read with one query, as before.
  function deepAll(root, selector) {
    const all = [...(root.querySelectorAll?.('*') ?? [])];
    if (!all.some((el) => el.shadowRoot)) return [...(root.querySelectorAll?.(selector) ?? [])];
    const out = [];
    for (const el of all) {
      if (el.matches?.(selector)) out.push(el);
      if (el.shadowRoot) out.push(...deepAll(el.shadowRoot, selector));
    }
    return out;
  }

  // The element an event happened on. An event from inside a shadow root reaches the window
  // retargeted to the host (GEICO's <gds-radio-button>, <gds-button>), which is no control.
  const eventTarget = (e) => e.composedPath?.()[0] ?? e.target;

  // A design-system radio option (GEICO's <gds-radio-button>): its radio input is alone in the
  // option's own shadow root, named like the option. Another tree's radios don't uncheck it, so the
  // pick is the host's [checked] (as pagekit's optionOn reads it), and the option's words are its
  // [slot=label] child. Null for any other radio.
  const radioHost = (el) => {
    const root = el?.getRootNode?.();
    const host = root?.host;
    if (!host || el.type?.toLowerCase() !== 'radio' || host.getAttribute?.('name') !== el.name) return null;
    return (root.querySelectorAll?.('input[type=radio]') ?? []).length === 1 ? host : null;
  };
  const radioOn = (el) => {
    const host = radioHost(el);
    return host ? host.hasAttribute?.('checked') === true : !!el.checked;
  };
  // The words of a host's direct child in slot `name`, without a tooltip in it (GEICO's legend holds
  // a <gds-tooltip> whose body is ordinary text).
  const slotText = (host, name) => {
    const part = [...(host?.children ?? [])].find((n) => n.getAttribute?.('slot') === name);
    if (!part) return '';
    let text = part.textContent ?? '';
    for (const tip of part.querySelectorAll?.('gds-tooltip, [role=tooltip]') ?? []) text = text.replace(tip.textContent, ' ');
    return oneLine(text);
  };
  // The radio of the option a gesture is on: its card, its slotted words, anything in its shadow root.
  const optionRadio = (target) => {
    for (let n = target, i = 0; n && i < 12; n = n.parentElement ?? n.getRootNode?.()?.host ?? null, i++) {
      const radio = n.shadowRoot?.querySelector?.('input[type=radio]');
      if (radio && radioHost(radio) === n) return radio;
    }
    return null;
  };

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
    const option = optionRadio(target);
    if (option) return option;
    const wrapper = target?.closest?.('.x-form-trigger-wrap');
    const nested = wrapper?.querySelector?.('input, select, textarea');
    if (isControl(nested)) return nested;
    const listOption = target?.closest?.('[role=option], .x-boundlist-item');
    const popup = listOption?.closest?.('[role=listbox], .x-boundlist');
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
    // A label names a control of its own tree (a shadow root's label, one of its own radios).
    const id = target?.htmlFor || target?.getAttribute?.('for');
    const linked = id ? (target.getRootNode?.()?.getElementById?.(id) ?? document.getElementById?.(id)) : null;
    return isControl(linked) ? linked : null;
  };

  // The last trusted gesture, kept apart from lastTrusted (which a value event resets). While
  // paused it decides whose a trusted input/change is: the extension's own .click() on a radio or
  // checkbox fires trusted input/change too, with no gesture before it.
  // It must also be on that control: an agent edit on one field starts a follow-up fill, and the
  // fill's click on another radio within the 2 s is not the agent's.
  let lastGesture = -Infinity;
  let lastGestureTarget = null;
  let lastGestureControl = null;
  const GESTURE_TYPES = new Set(['pointerdown', 'keydown', 'paste', 'drop']);
  for (const type of ['pointerdown', 'mousedown', 'keydown', 'paste', 'drop']) {
    listen(type, (e) => {
      if (!e.isTrusted) return;
      const target = eventTarget(e);
      lastTrusted = Date.now();
      lastTrustedControl = controlForEvent(target);
      if (GESTURE_TYPES.has(type)) {
        lastGesture = lastTrusted;
        lastGestureTarget = target ?? null;
        // Mapped now: an ExtJS option pick resolves through the focused combo, valid only now.
        lastGestureControl = lastTrustedControl;
      }
    });
  }

  // Is the last gesture on this control? Its target is the control, a radio of its group (arrow
  // keys move the pick), its label (label[for] or a wrapping label; for a radio, the label of any
  // radio in its group), or an element holding no other control than it (or its radio group).
  const sameGroup = (a, b) => a === b || (!!a && !!b && a.type === 'radio' && b.type === 'radio'
    && !!a.name && a.name === b.name && (a.form ?? null) === (b.form ?? null));
  const gestureOn = (el) => {
    const target = lastGestureTarget;
    if (!target) return false;
    if (sameGroup(target, el) || sameGroup(lastGestureControl, el)) return true;
    const label = target.closest?.('label');
    if (label) {
      const forId = label.htmlFor || label.getAttribute?.('for');
      const linked = label.control ?? (forId ? document.getElementById?.(forId) : null)
        ?? label.querySelector?.('input, select, textarea');
      if (sameGroup(linked, el)) return true;
    }
    if (target === document.body || target === document.documentElement || !target.contains?.(el)) return false;
    return [...(target.querySelectorAll?.('input, select, textarea') ?? [])].every((x) => sameGroup(x, el));
  };

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
  // GEICO's radio input sits in a shadow root: its input event (composed) reaches the window as the
  // option host's, and its change event (not composed) doesn't reach it at all.
  const trustedValue = (e) => {
    const el = eventTarget(e);
    if (!isCurrent() || !e.isTrusted || !isControl(el)) return;
    // While the kit puts answers in, a value event counts as the agent's only within 2 s of a
    // trusted gesture on that control (the rule of pagekit's guardEdits); otherwise it is the
    // fill's own click.
    if (paused && (Date.now() - lastGesture > 2000 || !gestureOn(el))) return;
    trustedPending.set(el, oneControlState(el));
    const discrete = isDiscreteControl(el);
    if (discrete) trustedImmediate.add(el);
    // Once an explicit value event exists, the broad gesture fallback must not classify another
    // control changed in the same polling window as manual.
    lastTrusted = 0;
    lastTrustedControl = null;
    if (!discrete) return;
    const flush = () => flushTrusted({ immediateOnly: true });
    // A design-system option shows the pick on its host only once the page has handled the event,
    // after this capture listener: flushed in a later task, or the snapshot reads the old pick and
    // the agent's change is lost.
    if (radioHost(el)) setTimeout(flush, 0);
    else Promise.resolve().then(flush);
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

  // A Duck Creek question's caption (Progressive): its own label c_<id> for the field f_<id>, drawn
  // above the answers, without the smaller note under it (.lowerLabelText). pagekit names the field
  // by the same caption (ExtJS dctCaption, which this isolated world can't read). textBefore skips
  // labels, so a radio group took the text of the row above it (2026-10-20: "Does the customer earn
  // 100% of his or her income from for hire trucking operations?" logged as a cargo commodity).
  function dctCaption(el) {
    const id = el.id?.match(/^f_([a-z][0-9a-f]{32}[0-9a-f]+_\d+_\d+)/i)?.[1];
    const caption = id ? document.getElementById?.(`c_${id}`) : null;
    if (!caption) return '';
    return oneLine([...(caption.childNodes ?? [])]
      .filter((n) => !n.classList?.contains?.('lowerLabelText')).map((n) => n.textContent).join(' ')).slice(0, 160);
  }

  // A design-system radio group's question (GEICO), as pagekit's radioGroupLabel reads it: the
  // [slot=legend] child of the nearest element around the option. The option's own shadow root has
  // no text before its radio, so textBefore finds nothing there.
  function legendFor(control) {
    for (let n = radioHost(control), i = 0; n && i < 4; n = n.parentElement ?? n.getRootNode?.()?.host ?? null, i++) {
      const text = slotText(n, 'legend');
      if (text) return text;
    }
    return '';
  }

  // GEICO's data-model name (field-key.js), without the render number its name and id carry.
  const dataName = (el) => {
    try { return globalThis.__raterFieldKey?.dataName?.(el) ?? null; } catch { return null; }
  };

  const labels = new Map();
  // el: the field, or a radio's group; control: the field's own control (a radio of the group).
  function labelFor(key, el, control = el) {
    if (!labels.has(key)) {
      const own = oneLine([...(el.labels ?? [])].map((l) => l.textContent).join(' ') || el.getAttribute('aria-label') || '');
      const name = dataName(control);
      labels.set(key, dctCaption(control) || legendFor(control) || (el.type === 'radio' ? '' : own) || textBefore(el) || own
        || el.placeholder || (name ? humanize(name) : el.name) || '');
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
    for (const el of deepAll(document, 'input, select, textarea')) {
      const type = (el.type || el.tagName).toLowerCase();
      if ((SKIP_TYPES.has(type) && !(type === 'search' && el.matches?.(ADDRESS_SEARCH))) || el.disabled || !isVisible(el)) continue;
      const q = questionId(el);
      if (type === 'radio') {
        const key = fieldKey(el, q, true);
        const entry = out.get(key) ?? { key, q, kind: 'radio', label: labelFor(key, el.closest('[role=radiogroup], fieldset') ?? el, el), v: '', controls: [] };
        if (!entry.controls.includes(el)) entry.controls.push(el);
        if (radioOn(el)) entry.v = oneLine([...(el.labels ?? [])].map((l) => l.textContent).join(' ')) || slotText(radioHost(el), 'label') || el.value;
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
  // The step of a one-address application (AmWINS), as pagekit's stepKey reads it: the visible
  // h1-h3 headings. Sent with each batch of changes, new questions and page arrival, so the panel
  // can name the step a change was on and see the agent move to the next step (its steps share the
  // page's address); the panel keeps it only as one of such a carrier's step names.
  // A page with a step progress bar (GEICO: every step is /quote, and its visible headings read
  // "Dashboard" on every step) names the step by the one part under way (0 < value < 100), as
  // pagekit's stepKey reads it, only while the page title names it too: mid-redraw, the bar and the
  // form can be different steps', and then no step is named.
  const stepKey = () => {
    const bars = [...(document.querySelectorAll?.('gds-progress-bar[value]') ?? [])].filter((el) => el.tagName === 'GDS-PROGRESS-BAR');
    if (bars.length) {
      const current = bars.filter((el) => { const v = Number(el.getAttribute?.('value')); return v > 0 && v < 100; });
      const step = current.length === 1 ? oneLine(current[0].textContent) : '';
      return squash(step) && squash(document.title).includes(squash(step)) ? step : undefined;
    }
    const headings = [...(document.querySelectorAll?.('h1, h2, h3') ?? [])].filter((el) => /^H[1-3]$/.test(el.tagName ?? '')
      && el.getClientRects?.().length && globalThis.getComputedStyle?.(el)?.visibility !== 'hidden');
    return headings.map((el) => oneLine(el.textContent)).filter(Boolean).slice(0, 4).join(' / ') || undefined;
  };

  // Error and validation messages on screen, as pagekit's capture reads them. When one appears that
  // wasn't there (a Continue the carrier refused: "This field is required"), the panel records the
  // page's layout again, which carries the messages. Only that one appeared is sent, never its text.
  const MESSAGES = '[role=alert], .x-form-error-msg, .x-form-invalid-under, [class*="error-message"], [class*="validation-message"], [class*="help-block"]';
  const messages = () => new Set([...(document.querySelectorAll?.(MESSAGES) ?? [])]
    .filter((el) => el.getClientRects?.().length).map((el) => oneLine(el.textContent)).filter(Boolean));

  // The unit forms on screen as the kit reads them (pagekit unitFormsNow): GEICO draws every
  // vehicle's, trailer's and driver's form at one address, one at a time. [{ list, id }], the id the
  // form's first question's element name; [] when none is; null when no fill has told the kit which
  // questions start a form, or the kit runs in another world (Progressive's, in the page's own). Sent
  // with each batch of changes, so the panel files an agent edit under the form it was made on, also
  // one no fill has read yet. Element names only, never a value.
  const unitForms = () => {
    try { return globalThis.__raterKit?.unitFormsNow?.() ?? null; } catch { return null; }
  };

  // The unit lists on screen as the kit reads them (pagekit unitListsNow), with their rows: GEICO
  // draws a vehicle or driver list with no question on it, seconds after the form it saves went
  // away. '' when none is, or the kit isn't in this world. Selectors and counts only.
  const unitLists = () => {
    try { return globalThis.__raterKit?.unitListsNow?.() ?? ''; } catch { return ''; }
  };

  let paused = false;
  let page = pageKey();
  let prev = snapshot();
  let prevMessages = messages();
  // The unit lists last seen. Not taken again on rebaseline: a list a fill's own Next drew while
  // the recorder was paused is news to the panel, which adds the next unit to it.
  let shownLists = unitLists();
  // The step headings last seen, so a move to another step is sent even when no answer changes and
  // no question appears with it (a step whose questions are still loading or in a closed section).
  let shownStep = isTop ? stepKey() : undefined;

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
    if (changes.length) send({ event: 'field_changes', page, step: stepKey(), forms: unitForms(), changes });
    if (appeared.length) send({ event: 'new_fields', page, step: stepKey(), keys: appeared });
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
    const removed = [...prev.keys()].filter((k) => !cur.has(k));
    prev = cur;
    const shown = messages();
    const newMessages = [...shown].some((m) => !prevMessages.has(m));
    prevMessages = shown;
    if (changes.length) send({ event: 'field_changes', page, step: stepKey(), forms: unitForms(), changes });
    // A trusted value event is valid for one snapshot only. This also drops controls that were
    // replaced by a redraw before the poll, keeping an old element from authorizing later edits.
    trustedPending.clear();
    trustedImmediate.clear();
    // New questions (follow-ups revealed by an answer, or a panel that opened): the side panel
    // may fill them automatically.
    if (appeared.length) send({ event: 'new_fields', page, step: stepKey(), keys: appeared });
    // Questions that went away (hidden, disabled or removed by an answer): the panel records the
    // page's layout again, so both sides of a follow-up question are seen.
    if (removed.length) send({ event: 'removed_fields', page, keys: removed });
    if (newMessages) send({ event: 'new_messages', page });
    // A unit list drawn, or its rows changed: the panel may add the next intake unit to it.
    const lists = unitLists();
    if (lists !== shownLists) {
      shownLists = lists;
      if (lists) send({ event: 'list_shown', page, step: stepKey() });
    }
    // The agent moved to another step of a one-address application (AmWINS' Drivers and Vehicles
    // tabs): the panel shows that step's report (live run 2026-10-19).
    if (isTop) {
      const step = stepKey();
      if (step !== shownStep) {
        shownStep = step;
        if (step) send({ event: 'step_shown', page, step });
      }
    }
  }

  // Only the top frame reports page switches; embedded frames (ads, trackers) would be noise.
  function pageChanged(nowPage, cur) {
    trustedPending.clear();
    trustedImmediate.clear();
    if (isTop) send({ event: 'page_view', page: nowPage, from: page, step: stepKey(), fields: cur.size, title: document.title });
    page = nowPage;
    prevMessages = messages();
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
    prevMessages = messages();
    trustedPending.clear();
    trustedImmediate.clear();
  }

  // The pause ends (the fill or AI answer is done). What the agent changed themselves meanwhile is
  // reported first, as theirs: a trusted value still on its control (a question the pause revealed
  // included; a value a page script replaced since is the page's). The extension's own answers
  // were logged by the panel as it gave them, so the rest becomes the new baseline unreported,
  // and the questions they revealed are not announced as new (the fill answered them).
  // Told to resume while not paused (the panel attaching, after reinjecting it): nothing on the page
  // is the extension's, so what changed since the last poll is reported as a poll would, and the
  // step on screen is sent again: a reused recorder had sent it to the panel before, and a panel
  // that was closed and opened again doesn't know it (GEICO's steps all share /quote).
  function resume() {
    if (!isCurrent()) return;
    if (!paused) {
      shownStep = undefined;
      tick();
      return;
    }
    paused = false;
    if (trustedPending.size && pageKey() === page) {
      const changes = [];
      for (const [key, c] of snapshot()) {
        if (!c.controls.some((el) => trustedPending.get(el) === oneControlState(el))) continue;
        const before = prev.get(key)?.v ?? '';
        if (before !== c.v) changes.push({ key, q: c.q, label: c.label, kind: c.kind, combo: c.combo, before, after: c.v, agent: true });
      }
      if (changes.length) send({ event: 'field_changes', page, forms: unitForms(), changes });
    }
    trustedPending.clear();
    trustedImmediate.clear();
    rebaseline();
  }

  // Buttons and links the agent clicks themselves (Continue, Recalculate, Print, a lookup): the
  // review sees a helper the extension didn't click and a Continue the agent pressed. The
  // extension's own clicks are untrusted and never reported. Only the button's text (60
  // characters) and the step on screen.
  const BUTTONS = 'a, button, [role=button], input[type=button], input[type=submit], .x-btn';
  // A button's words: its own, else the words slotted into it. GEICO's <gds-button> draws a
  // <button> in its shadow root around a <slot>: "Next" is the host's text, shown through the slot.
  // Not the host's whole text: a tooltip's icon button (<gds-tooltip>) would be logged with the help
  // paragraph its host holds.
  const buttonText = (el) => oneLine(el.value || el.textContent)
    || oneLine([...(el.querySelectorAll?.('slot') ?? [])].flatMap((s) => [...(s.assignedNodes?.({ flatten: true }) ?? [])])
      .map((n) => n.textContent).join(' '));
  listen('click', (e) => {
    if (!isCurrent() || !e.isTrusted) return;
    // The button on the click's path, also inside a shadow root: the click reaches the window as the
    // <gds-button> host's, which is no button, and was never reported (2026-10-20 GEICO captures).
    const el = (e.composedPath?.() ?? []).find((n) => n.matches?.(BUTTONS)) ?? e.target?.closest?.(BUTTONS);
    if (!el) return;
    const text = buttonText(el).slice(0, 60);
    if (text) send({ event: 'agent_click', page, step: stepKey(), text });
  });

  const timer = setInterval(tick, TICK_MS);

  const onMessage = (msg) => {
    if (!isCurrent() || msg?.ra !== 'recorder') return;
    if (msg.cmd === 'pause') paused = true;
    if (msg.cmd === 'resume') resume();
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

  // A control as the snapshot names it (its key, question id, kind and label), and the words of the
  // choice it shows (null for a text box): for the developer recording's trace (trace.js), so a
  // recording names a question exactly as this recorder and the usage log do.
  const describe = (el) => {
    const type = (el.type || el.tagName).toLowerCase();
    const q = questionId(el);
    if (type === 'radio') {
      const key = fieldKey(el, q, true);
      return { key, q, kind: 'radio', label: labelFor(key, el.closest?.('[role=radiogroup], fieldset') ?? el, el) };
    }
    const key = fieldKey(el, q, false);
    const kind = el.tagName === 'SELECT' || isCombo(el) ? 'select' : type === 'checkbox' ? 'checkbox' : 'text';
    return { key, q, kind, label: labelFor(key, el) };
  };
  const choiceText = (el) => {
    const type = (el.type || el.tagName).toLowerCase();
    if (type === 'radio') return radioOn(el) ? oneLine([...(el.labels ?? [])].map((l) => l.textContent).join(' ')) || slotText(radioHost(el), 'label') || el.value : null;
    if (type === 'checkbox') return el.checked ? 'checked' : 'unchecked';
    if (el.tagName === 'SELECT') { const o = el.selectedOptions?.[0]; return o && o.value !== '' ? oneLine(o.text) : ''; }
    return null;
  };

  api = {
    version: VERSION,
    rebaseline,
    // A poll now, as the timer's (nothing while paused: resume reports the agent's edits then).
    poll: tick,
    dispose,
    alive: () => !!chrome.runtime?.id,
    // Reading only (docs/developer-recording.md).
    read: { controlForEvent, describe, choiceText, stepKey, pageKey, buttonText, BUTTONS },
  };
  globalThis.__raterRecorder = api;

  if (isTop) send({ event: 'page_view', page, from: null, step: stepKey(), fields: prev.size, title: document.title });
})();
