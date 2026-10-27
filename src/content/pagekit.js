// Injected into rater pages (every frame) by the side panel. Classic script, no imports.
// Exposes globalThis.__raterKit = { fill, progress, stop, answer, markKey, reveal, readBack, receipt, aiBanner, capture, clear, … }.
//
// It never clicks Next/Submit, never touches password fields, and by default leaves fields the
// page already filled alone.
//
// Two kinds of pages are handled:
//  - plain HTML / React / Angular forms: values are set on the DOM elements;
//  - ExtJS pages (Progressive's Duck Creek "DCT" app): values are set through the ExtJS
//    components, and the page talks to its server after each answer, so filling goes one field
//    at a time and waits for the page to settle. Needs the page's own JS world (world: 'MAIN').
//
// Not type-checked yet; the plan it takes, the fill's options and the report it returns are typed
// in types.js, at the repository's root.
/** @import { FillOptions, FillReport, PlanStep } from '../../types.js' */

(() => {
  // This build of the kit (stamped by scripts/package.mjs): one left in the page by another build,
  // from before an extension reload or update, is replaced rather than reused.
  const BUILD = 'source';
  if (globalThis.__raterKit?.version === 90 && globalThis.__raterKit.build === BUILD) return;

  // Private to this document: no VIN or reversible VIN-derived token leaves the page.
  // A carrier redraw keeps the acknowledgement; a new document requires another decision.
  const extraRowKeys = new Map();
  const MARK = 'data-rater-autofill';
  const SKIP_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file', 'password', 'search']);
  // A search box that is an address question is one (GEICO's street box, with its own suggestion
  // list), never a portal search or a list's filter box (select2's own box is aria-autocomplete=list
  // too). The recorder (recorder.js) keeps the same exception.
  const ADDRESS_SEARCH = 'input[type=search][aria-autocomplete=list][aria-controls]:not(.select2-search__field)';
  // filled: an intake answer (or one worked out from it); standard: a TNI standard answer (plan
  // step `standard`: an assumption such as gender MALE, not a fact from the intake); ai: an answer
  // the AI assistant chose (accepted by the agent or auto-selected); check it; agent: a choice the
  // agent picked in the side panel (answer `by: 'agent'`). The side panel's key uses the same colors
  // (sidepanel.css --mark-*).
  const COLORS = { filled: '#16a34a', standard: '#2f6fd6', needs: '#d97706', failed: '#dc2626', ai: '#7c3aed', agent: '#475569' };
  const SOLID_MARKS = new Set(['filled', 'standard', 'ai', 'agent']);
  const STATE_NAMES = {
    AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut',
    DE: 'delaware', DC: 'district of columbia', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois',
    IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland',
    MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana',
    NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico', NY: 'new york',
    NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania',
    RI: 'rhode island', SC: 'south carolina', SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah',
    VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------------------------------------
  // Text helpers

  const squash = (s) => String(s ?? '').toLowerCase().replace(/['’*]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const humanize = (s) => squash(String(s ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-.[\]$:]+/g, ' '));
  const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

  // In page order: what a shadow root holds comes where its host is. GEICO draws its radios in
  // shadow roots between plain fields; listed after everything else, they came last in the report,
  // the panel and an `askAfter` anchor's "the next one".
  // Up the page as it is drawn: a slotted element to its slot, a shadow root's top to its host.
  const drawnParent = (n) => n.assignedSlot ?? n.parentElement ?? n.getRootNode?.()?.host ?? null;

  function deepQueryAll(root, selector, out = []) {
    for (const el of root.querySelectorAll('*')) {
      if (el.matches(selector)) out.push(el);
      if (el.shadowRoot) deepQueryAll(el.shadowRoot, selector, out);
    }
    return out;
  }

  // GEICO's data-model name of a field (field-key.js): Id_GiveYear_81515 is GiveYear, whatever its
  // render number.
  const dataName = (el) => globalThis.__raterFieldKey.dataName?.(el) ?? null;

  // A design-system radio (GEICO's <gds-radio-button>) keeps its <input type=radio> alone in its own
  // shadow root, under a host named like the input: the host is the option the page shows, and its
  // `checked` attribute the pick (each input is a native group of its own there, so an option picked
  // earlier stays checked inside). Null for any other radio.
  function radioHost(r) {
    const root = r?.getRootNode?.();
    const host = root && root !== document ? root.host : null;
    if (!host || host.getAttribute?.('name') !== r.name) return null;
    return root.querySelectorAll('input[type=radio]').length === 1 ? host : null;
  }

  // The words of a host's light-DOM part for one of its slots ([slot=label], [slot=legend]), without
  // its tooltip's (GEICO's legend holds a <gds-tooltip> whose body is in the page too).
  function slotText(host, name) {
    const part = [...(host?.children ?? [])].find((n) => n.getAttribute?.('slot') === name);
    if (!part) return '';
    let text = part.textContent ?? '';
    for (const tip of part.querySelectorAll('gds-tooltip, [role=tooltip]')) if (tip.textContent) text = text.replace(tip.textContent, ' ');
    return oneLine(text);
  }

  // A button's words as drawn: its own text; else what its slots show (a design-system button,
  // GEICO's <gds-button>, keeps its words in the page and only <slot>s in its shadow <button>); else,
  // inside a shadow root whose host is itself a button (a tag ending in -button, or role=button),
  // its host's. Not any host's: a tooltip's trigger would read as the tooltip's whole body.
  function buttonText(el) {
    const own = oneLine(el.value || el.textContent);
    if (own) return own;
    const slotted = oneLine([...(el.querySelectorAll?.('slot') ?? [])].flatMap((s) => s.assignedNodes?.({ flatten: true }) ?? []).map((n) => n.textContent).join(' '));
    if (slotted) return slotted;
    const root = el.getRootNode?.();
    const host = root && root !== document ? root.host : null;
    return host && (/(^|-)button$/i.test(host.tagName ?? '') || host.getAttribute?.('role') === 'button') ? oneLine(host.textContent) : '';
  }

  // Disabled on its shadow host as well (<gds-button disabled>). GEICO also disables the inner
  // <button>; this is in case a page doesn't.
  const hostDisabled = (el) => {
    const root = el.getRootNode?.();
    const host = root && root !== document ? root.host : null;
    return !!host && (host.hasAttribute?.('disabled') || host.getAttribute?.('aria-disabled') === 'true');
  };

  function isVisible(el) {
    if (el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden') return true;
    // Styled radios/checkboxes often hide the real input and show the <label> instead.
    return [...(el.labels ?? [])].some((l) => l.getClientRects().length);
  }

  // Text inside `root`, skipping the contents of form controls (so option lists don't leak in).
  function textOutsideControls(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p || p.closest('select, option, textarea, button, script, style, noscript, [hidden], [aria-hidden="true"]')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let t = '';
    while (walker.nextNode()) t += ` ${walker.currentNode.nodeValue}`;
    return oneLine(t);
  }

  const CONTROL_SELECTOR = 'input:not([type=hidden]), select, textarea';
  const countControls = (el) => el.querySelectorAll(CONTROL_SELECTOR).length;

  function byId(el, id) {
    const root = el.getRootNode();
    return root.getElementById?.(id) ?? document.getElementById(id);
  }

  function labelFor(el) {
    const parts = [];
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) for (const id of labelledBy.split(/\s+/)) { const n = byId(el, id); if (n) parts.push(n.textContent); }
    for (const l of el.labels ?? []) parts.push(textOutsideControls(l));
    // Without markup: GEICO writes some as HTML (<span …>Name</span>'s Driver License State) or
    // with **…** marks.
    if (el.getAttribute('aria-label')) parts.push(el.getAttribute('aria-label').replace(/<[^>]*>/g, '').replace(/\*\*/g, ''));
    // No explicit label: the smallest wrapper that holds only this field, preferring its label
    // element; a date picker's calendar (Su Mo Tu …, month names) is not part of the question.
    if (!oneLine(parts.join(''))) {
      let p = el.parentElement;
      for (let i = 0; i < 5 && p && p !== document.body; i++, p = p.parentElement) {
        if (countControls(p) > 1) break;
        const own = p.querySelector?.('label, .control-label, .form-label');
        const t = withoutCalendar(own ? textOutsideControls(own) : textOutsideControls(p));
        if (t) { parts.push(t); break; }
      }
    }
    if (!oneLine(parts.join('')) && el.placeholder) parts.push(el.placeholder);
    // The tooltip our own marks put on a field is never its question.
    const title = el.dataset?.raPrevTitle ?? (/^Rater Autofill:/.test(el.title ?? '') ? '' : el.title);
    if (!oneLine(parts.join('')) && title) parts.push(title);
    const text = oneLine(parts.join(' ')).slice(0, 160);
    // No label of its own: its name, GEICO's without the render number (Id_GiveYear_81515: "give
    // year"). Nor one with no words (GEICO's amount boxes show only their "$" sign beside them).
    const name = dataName(el);
    if (name && !/[a-z]/i.test(text)) return oneLine(humanize(name));
    return text || oneLine(humanize(el.name || el.id));
  }

  function withoutCalendar(text) {
    const t = oneLine(text);
    const cut = t.search(/\b(su mo tu we th fr sa|mo tu we th fr sa su)\b|[«»]/i);
    return (cut >= 0 ? t.slice(0, cut) : t).trim();
  }

  // A design-system group (GEICO's <gds-radio-button-group>): the nearest element above the option
  // hosts that holds them all and has words in its [slot=legend] part. Each option's shadow root
  // holds only its own input, so a fieldset or container reading never reaches the question.
  function legendHolder(radios) {
    const hosts = (radios ?? []).map(radioHost);
    if (!hosts.length || !hosts.every(Boolean)) return null;
    for (let n = hosts[0].parentElement ?? null, i = 0; n && i < 3; n = n.parentElement ?? n.getRootNode?.()?.host ?? null, i++) {
      if (hosts.every((h) => n.contains(h)) && slotText(n, 'legend')) return n;
    }
    return null;
  }

  // The legend's words with each line apart. GEICO draws its USDOT record as one element per line
  // with nothing between them, so textContent runs the business name into the house number
  // (W43-46): here each text node, or each element in a page without them, is its own words.
  // Tooltips are left out, as in slotText.
  function legendWords(radios) {
    const part = [...(legendHolder(radios)?.children ?? [])].find((n) => n.getAttribute?.('slot') === 'legend');
    const words = (n) => {
      if (n.nodeType === 3) return n.nodeValue ?? n.textContent ?? '';
      if (n.matches?.('gds-tooltip, [role=tooltip]') || /^GDS-TOOLTIP$/i.test(n.tagName ?? '') || n.getAttribute?.('role') === 'tooltip') return '';
      const nodes = n.childNodes ? [...n.childNodes] : null;
      if (nodes) return nodes.map(words).join(' ');
      return n.children?.length ? [...n.children].map(words).join(' ') : (n.textContent ?? '');
    };
    return part ? oneLine(words(part)) : '';
  }

  function radioGroupLabel(radios, optionTexts) {
    const first = radios[0];
    const holder = legendHolder(radios);
    if (holder) return slotText(holder, 'legend').slice(0, 160);
    const group = first.closest('[role=radiogroup]');
    if (group && (group.getAttribute('aria-label') || group.getAttribute('aria-labelledby'))) return labelFor(group);
    const fieldset = first.closest('fieldset');
    if (fieldset && radios.every((r) => fieldset.contains(r))) {
      const legend = fieldset.querySelector('legend');
      if (legend) return oneLine(legend.textContent);
    }
    // Smallest container holding the whole group; its text minus the option labels.
    let c = first.parentElement;
    while (c && !radios.every((r) => c.contains(r))) c = c.parentElement;
    for (let i = 0; c && i < 3; i++, c = c.parentElement) {
      let t = textOutsideControls(c);
      for (const o of optionTexts) if (o) t = t.replace(o, ' ');
      t = oneLine(t);
      if (t) return t.slice(0, 160);
      if (c.querySelectorAll(CONTROL_SELECTOR).length > radios.length) break;
    }
    // GEICO's two pay-plan lists have no legend: "give pay plan v2", not its render number.
    return oneLine(humanize(dataName(first) || first.name));
  }

  function isRequired(el, label) {
    // app-valid-rq: AmWINS marks its required fields this way.
    return el.required || el.getAttribute('aria-required') === 'true' || el.getAttribute('app-valid-rq') === '1' || !!el.closest?.('table[app-valid-rq="1"]') || /\*/.test(label);
  }

  function sectionOf(el) {
    for (let p = el.parentElement, i = 0; p && i < 8; p = p.parentElement, i++) {
      const heads = [...p.querySelectorAll('h1, h2, h3, h4, legend, [role=heading]')]
        .filter((h) => h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (heads.length) return oneLine(heads.at(-1).textContent).slice(0, 100);
    }
    return '';
  }

  // ---------------------------------------------------------------------------------------------
  // ExtJS / Duck Creek helpers (only work in the page's own JS world)

  const ext = () => (typeof globalThis.Ext?.getCmp === 'function' ? globalThis.Ext : null);
  const extCmp = (el) => (el?.id && ext() ? ext().getCmp(el.id.replace(/-inputEl$/, '')) ?? null : null);

  function dctCaption(cmp) {
    for (let c = cmp, i = 0; c && i < 6; c = c.ownerCt, i++) {
      if (c.dctCaption) return oneLine(String(c.dctCaption).replace(/<[^>]+>/g, ' '));
    }
    return null;
  }

  // Only the field itself (or its radio group) says whether it's required; outer containers
  // carrying dctRequired made optional fields like Suffix and DBA look required.
  function dctRequired(cmp) {
    return !!cmp?.dctRequired;
  }

  // The field's name in the carrier's data model: Duck Creek puts it on every input
  // (fieldref="RiskInput.VIN", "ComprehensiveInput.Deductible"). It names what the field holds,
  // where the question id below is only a number, which Progressive renumbers (2026-10-07). GEICO
  // has it in its names instead (dataName: Id_GiveYear_81515 is GiveYear).
  const fieldRef = (el) => el?.getAttribute?.('fieldref') || dataName(el) || null;

  // Duck Creek element ids look like f_<letter><32 hex group id><question id>_<page>_<row>. The
  // question id is a number Progressive reassigns: it keeps a page's rows of one question
  // together, and is logged, but never says which question a field is (see assign).
  function dctQuestionId(id) {
    return String(id ?? '').match(/^f_[a-z]([0-9a-f]{32})([0-9a-f]+)_\d+_\d+/i)?.[2]?.toUpperCase() ?? null;
  }

  // Its <page>_<row>: on Progressive's Rates every question of one vehicle shares the row, and
  // one of them is labelled with the vehicle ("2025 RAM PROMASTER 2500").
  const VEHICLE_LABEL = /^(?:19|20)\d{2}\s+\S/;
  function dctRow(id) {
    return String(id ?? '').match(/^f_[a-z][0-9a-f]{32}[0-9a-f]+_(\d+_\d+)/i)?.[1] ?? null;
  }

  // The page is waiting on its server or re-drawing after an answer.
  function pageBusy() {
    const X = ext();
    if (X?.Ajax?.isLoading?.()) return true;
    // #loadingDefault: AmWINS' overlay while it saves or reloads the application (it redraws every
    // step when the reload lands, so nothing may be filled before that).
    // #page-load / #extendedWaiting: GEICO's spinners while a step loads and while Recalculate rates
    // (both stay in the page, display:none, when idle).
    return [...document.querySelectorAll('.x-mask-msg, .x-mask-loading, [class*="loading-mask"], [class*="LoadingMessage"], #loadingDefault, #page-load.loader-container, #extendedWaiting.loader-container')]
      .some((m) => m.getClientRects().length && getComputedStyle(m).visibility !== 'hidden');
  }

  // The carrier's own components the page hasn't defined yet (`components`, a fill option: GEICO's
  // gds-* while their script loads): no control of theirs is drawn, and defining one draws its
  // shadow root without a mutation record. In the page only: a part inside a component's shadow root
  // exists once that component is defined, by the same script (the GEICO mock's are copies that
  // are never defined, and each render waited for them). Only the carrier's: another element never
  // defined (a widget, another extension's) holds nothing. Each is waited for up to UNDEFINED_MS
  // from when a wait first saw it, and never past a wait's own limit (settle).
  const UNDEFINED_MS = 3000;
  const undefinedSince = new WeakMap();
  let componentPrefix = null;
  function partsUndefined() {
    if (!componentPrefix) return false;
    let parts;
    try { parts = [...document.querySelectorAll(':not(:defined)')].filter((el) => el.localName.startsWith(componentPrefix)); } catch { return false; }
    const now = Date.now();
    // Every one is noted as it is first seen, so they are waited for together, not one after another.
    let waiting = false;
    for (const el of parts) {
      if (!undefinedSince.has(el)) undefinedSince.set(el, now);
      if (now - undefinedSince.get(el) < UNDEFINED_MS) waiting = true;
    }
    return waiting;
  }

  // The page's own requests (fetch or XHR to its origin), each as it finishes. A request still
  // running can't be seen. GEICO sends its server a coverage change half a second after it is
  // picked, with nothing drawn (its widget actions' callServiceForOutcomes). A Recalculate the fill
  // clicked 2 s after its last answer was rated 13 to 19 s later, with GEICO's own liability, UM,
  // road service and cargo (2026-10-22, 5 fills of 5). The agent's own clicks were rated in about
  // 2 s and kept every answer (13 of 13 since 2026-10-21). That was the script's click itself, not a
  // request still running: GEICO's button sent its request without its own part (W43-44, pressButton).
  // Watched from a fill's start in the top frame.
  let requestWatch = null;
  // The last of them (start and end, performance time; `poll`: a beat, below); the last one's end,
  // beats left out, is when the page's own requests last finished.
  const recentRequests = [];
  const lastRequestEnd = () => recentRequests.reduce((m, r) => (r.poll ? m : Math.max(m, r.end)), -Infinity);
  // A request the page sends on a steady beat is no sign of it working: GEICO asks its server every
  // 2.0 s (about 0.3 s each) the whole time a quote is open (2026-10-23, every Recalculate trace), so
  // Recalculate's 2 s without one finishing came only when a beat ran a few ms late (18 s after the
  // last answer on the live recording), or at REQUESTS_MS. An address (its query left out) whose
  // requests started three times running at the same interval, 1.5 s or more give or take
  // POLL_SLACK_MS, beats at that interval; a later request there at least three quarters of an
  // interval after the one before it is a beat. Another one there (a save between two beats) still
  // counts.
  const POLL_SLACK_MS = 40;
  const beats = new Map();
  function isBeat(address, start) {
    const b = beats.get(address) ?? { starts: [], period: null };
    beats.set(address, b);
    const prev = b.starts.at(-1);
    b.starts = [...b.starts, start].slice(-4);
    if (b.period != null) return prev != null && start - prev >= b.period * 0.75;
    const gaps = b.starts.slice(1).map((s, i) => s - b.starts[i]);
    if (gaps.length < 3 || gaps[0] < 1500 || gaps.some((g) => Math.abs(g - gaps[0]) > POLL_SLACK_MS)) return false;
    b.period = (gaps[0] + gaps[1] + gaps[2]) / 3;
    return true;
  }
  // The time the page's requests are timed in (Date.now where a page has no performance clock).
  const perfNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  function watchRequests() {
    if (requestWatch !== null) return;
    try {
      requestWatch = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if ((e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest') && String(e.name).startsWith(`${location.origin}/`)) {
            const start = e.startTime ?? e.responseEnd;
            recentRequests.push({ start, end: e.responseEnd, poll: isBeat(String(e.name).split(/[?#]/)[0], start) });
            if (recentRequests.length > 200) recentRequests.shift();
          }
        }
      });
      requestWatch.observe({ type: 'resource', buffered: true });
    } catch {
      requestWatch = false;
    }
  }
  // How long a wait for the page's requests (settle's `requests`) lasts at most. After that, a page
  // that keeps sending them (a session check) counts as quiet once its controls are.
  const REQUESTS_MS = 30000;

  // Wait until the page stops changing: not busy, every component it draws defined, and no new
  // nodes for `quietMs`. With `requests`, a check that holds while they are waited for (the fill
  // not stopped), also none of its own requests finished for `quietMs`. The quiet time counts from
  // when the wait begins: a page can change in ways no observer is told of (a spinner shown by its
  // style, a shadow root drawn, a value a script sets), so the quiet it had before isn't counted
  // (PR 178 tried that for a fill's first wait, and dropped it).
  // The wait wakes when its quiet time would be over (60 ms apart while something else holds it:
  // the page busy, a component undefined, a request), not every 60 ms: a 150 ms wait took 195 ms on
  // average in the GEICO mock, a 400 ms one 444 ms.
  async function settle({ quietMs = 250, maxMs = 15000, requests = null } = {}) {
    let last = Date.now();
    const mo = new MutationObserver(() => { last = Date.now(); });
    // A pick on a design-system radio redraws nothing: its host's `checked` and its group's
    // `active-index` change (GEICO). Only these two attributes, so a page's own animations don't
    // keep the wait going.
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['checked', 'active-index'] });
    const start = Date.now();
    try {
      const requested = () => !!requestWatch && !!requests?.() && Date.now() - start < REQUESTS_MS && perfNow() - lastRequestEnd() < quietMs;
      for (let now = Date.now(); now - start < maxMs; now = Date.now()) {
        if (mo.takeRecords?.().length) last = now;
        const quietFor = now - last;
        if (quietFor >= quietMs && !pageBusy() && !partsUndefined() && !requested()) return true;
        await sleep(Math.max(1, Math.min(quietFor < quietMs ? quietMs - quietFor : 60, maxMs - (now - start))));
      }
      // Only components still not defined at the limit: the page itself is settled.
      return !pageBusy() && Date.now() - last >= quietMs;
    } finally {
      mo.disconnect();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Finding the fields on the page

  // Selectors of rules allowed to fill a field that isn't on screen (set while a fill runs): a
  // question the page adds to an earlier step of a one-address application after it was left.
  let hiddenOk = [];
  // The units a fill is for (fill `units`, set while a fill runs): which vehicle, driver and
  // trailer the plan answers for, and which unit forms are already theirs (see assign).
  let fillUnits = null;
  // In a step section that isn't the one on screen (AmWINS' .form-tab, hidden).
  const otherStep = (el) => { const tab = el?.closest?.('.form-tab'); return !!tab && !isVisible(tab); };

  function collectControls() {
    const out = [];
    const groups = new Map();
    for (const el of deepQueryAll(document, CONTROL_SELECTOR)) {
      const type = el.tagName === 'INPUT' ? (el.type || 'text').toLowerCase() : el.tagName.toLowerCase();
      if (el.tagName === 'INPUT' && SKIP_INPUT_TYPES.has(type) && !(type === 'search' && safeMatches(el, ADDRESS_SEARCH))) continue;
      if (el.disabled || (!isVisible(el) && !hiddenOk.some((sel) => safeMatches(el, sel)))) continue;
      const cmp = extCmp(el);
      if (type === 'radio') {
        const extGroup = cmp?.up?.('radiogroup') ?? null;
        // By its name too: two groups with one data-model name (GEICO's two pay-plan lists, both
        // ref:GivePayPlanV2) are two questions. Nameless radios group as before.
        const key = extGroup ? `x:${extGroup.id}` : `${el.form ? 'f' : ''}:${globalThis.__raterFieldKey(el)}|${el.name ?? ''}`;
        let g = groups.get(key);
        if (!g) {
          g = { kind: 'radio', el, type, radios: [], cmp: extGroup };
          groups.set(key, g);
          out.push(g);
        }
        g.radios.push(el);
        continue;
      }
      const c = { kind: el.tagName === 'SELECT' ? 'select' : type === 'checkbox' ? 'checkbox' : 'text', el, type, cmp };
      if (cmp?.store && cmp.displayField) {
        // ExtJS combo box: a text input backed by a list of records.
        c.kind = 'select';
        c.options = cmp.store.getRange().map((rec) => ({ rec, text: oneLine(rec.get(cmp.displayField)), value: rec.get(cmp.valueField ?? cmp.displayField) }));
      }
      // A checkbox in a group ("Filings: [ ] Federal [ ] MCS-90") is named by its own box label.
      c.label = (c.kind === 'checkbox' && cmp?.boxLabel ? oneLine(String(cmp.boxLabel).replace(/<[^>]+>/g, ' ')) : null) ?? dctCaption(cmp) ?? labelFor(el);
      // No caption or label of its own: its "label" is its name, which says nothing of its wording
      // (assign's `reworded`). Progressive draws TX's PIP limit so (live recording, 2026-10-23).
      c.nameOnly = !!c.label && (c.label === oneLine(humanize(el.name || el.id)) || (!!dataName(el) && c.label === oneLine(humanize(dataName(el)))));
      c.q = dctQuestionId(cmp?.id ?? el.id);
      c.ref = fieldRef(el);
      out.push(c);
    }
    for (const g of groups.values()) {
      g.options = g.radios.map((r) => {
        const item = extCmp(r);
        // A design-system option's words are its host's [slot=label] part (GEICO: "Vehicle" for
        // the value Yes, "Pay In Full" for GEICO_PP_1Pay); its shadow <label> holds only a <slot>.
        const host = radioHost(r);
        return { el: r, cmp: item, host, text: oneLine(String(item?.boxLabel ?? '').replace(/<[^>]+>/g, ' ')) || oneLine([...(r.labels ?? [])].map(textOutsideControls).join(' ')) || slotText(host, 'label') || r.value, value: r.value };
      });
      g.label = dctCaption(g.cmp) ?? radioGroupLabel(g.radios, g.options.map((o) => o.text));
      g.q = dctQuestionId(g.cmp?.id ?? g.el.id) ?? (String(g.el.name).match(/^[a-z]+_([0-9A-F]+)/)?.[1] ?? null);
      g.ref = g.radios.map(fieldRef).find(Boolean) ?? null;
    }
    for (const c of out) {
      c.text = squash(c.label);
      c.hint = humanize(dataName(c.el) || c.el.name || c.el.id || '');
      c.required = dctRequired(c.cmp) || isRequired(c.el, c.label);
    }
    // The vehicle a per-vehicle row belongs to: a question labelled with it ("2025 RAM PROMASTER
    // 2500") names its row, and the row's unlabelled questions (vehicle value, equipment) are its
    // too. A row naming two vehicles names none.
    const rowVehicle = new Map();
    for (const c of out) {
      c.row = dctRow(c.cmp?.id ?? c.el.id);
      if (!c.row || !VEHICLE_LABEL.test(c.label ?? '')) continue;
      rowVehicle.set(c.row, rowVehicle.has(c.row) && rowVehicle.get(c.row) !== c.text ? null : c.text);
    }
    for (const c of out) c.vehicle = VEHICLE_LABEL.test(c.label ?? '') ? c.text : (c.row && rowVehicle.get(c.row)) || null;
    return out;
  }

  // A several-choice answer's option texts ("a; b": W43-23). Parts joined by "; " that make one
  // offered option's text are that option (its own text has "; " in it).
  const multiValue = (v, options = []) => {
    const parts = String(v ?? '').split(/;\s*/).map(oneLine).filter(Boolean);
    const offered = new Set(options.map((o) => oneLine(o.text).toLowerCase()));
    const out = [];
    for (let i = 0; i < parts.length;) {
      let j = parts.length;
      while (j > i + 1 && !offered.has(parts.slice(i, j).join('; ').toLowerCase())) j--;
      out.push(parts.slice(i, j).join('; '));
      i = j;
    }
    return out;
  };

  function optionsOf(c) {
    if (c.options) return c.options;
    if (c.kind === 'select') return [...c.el.options].map((o) => ({ el: o, text: oneLine(o.text), value: o.value }));
    return [];
  }

  const isPlaceholderOption = (text) => /^(-+|select\b|choose\b|please\b|\s*$)/i.test(oneLine(text));

  // What the AI assistant needs to know about a field left for the agent: its choices (never
  // agency staff lists), the heading it sits under, and what the page shows now.
  function describe(c) {
    const options = /agent|producer/i.test(c.label ?? '') ? []
      : [...new Set(optionsOf(c).map((o) => o.text).filter((t) => t && !isPlaceholderOption(t)))];
    return { options, section: sectionOf(c.el), current: c.kind === 'text' ? (textValue(c.el) ? 'has a value' : null) : selectedText(c) };
  }

  // An ExtJS field's value. A combo whose list was never loaded (or was torn down by a redraw)
  // throws from getValue(); its box text is then the best answer there is.
  function cmpValue(cmp, el) {
    try { return cmp.getValue(); } catch { return el?.value || null; }
  }

  // Whether a radio option is the pick: its ExtJS component's value; a design-system option's host
  // `checked` (radioHost: its own input may still be checked from an earlier pick); else the input.
  const optionOn = (o) => (o.cmp ? !!cmpValue(o.cmp, o.el) : o.host ? o.host.hasAttribute('checked') : o.el.checked);

  // A masked box that shows only its mask ("__/__/____", "MM/DD/YYYY", a VIN's seventeen "_") holds
  // no answer yet: GEICO's owner date of birth and VIN were kept as page values that differ from
  // the intake (FL live run, 2026-10-21).
  const MASK_ONLY = /^(?:[\s_\-/.()#*]|MM|DD|YYYY|YY)*$/i;
  const textValue = (el) => (MASK_ONLY.test(el.value ?? '') ? '' : el.value ?? '');

  function hasValue(c) {
    if (c.kind === 'radio') return c.options.some(optionOn);
    if (c.cmp && c.kind === 'select') {
      const v = cmpValue(c.cmp, c.el);
      return v != null && v !== '' && !isPlaceholderOption(c.cmp.getRawValue?.() ?? '');
    }
    if (c.kind === 'text') return textValue(c.el).trim() !== '';
    if (c.kind === 'checkbox') return c.el.checked;
    const o = c.el.selectedOptions?.[0];
    return !!o && o.value !== '' && !isPlaceholderOption(o.text);
  }

  function selectedText(c) {
    if (c.kind === 'checkbox') return c.el.checked ? 'checked' : 'unchecked';
    if (c.kind === 'radio') return c.options.find(optionOn)?.text ?? null;
    if (c.cmp) return oneLine(c.cmp.getRawValue?.() ?? '') || null;
    // A list taking several choices (GEICO's commodities): all of them.
    if (c.kind === 'select' && c.el.multiple) return [...(c.el.selectedOptions ?? [])].map((x) => oneLine(x.text)).filter((t) => t && !isPlaceholderOption(t)).join('; ') || null;
    const o = c.el.selectedOptions?.[0];
    return o && !isPlaceholderOption(o.text) ? oneLine(o.text) : null;
  }

  // ExtJS keeps a stale "you must select one item" error on a group until it re-validates, so
  // ask the component to validate now rather than reading the old message.
  function invalidControl(c) {
    if (c.el.getAttribute('aria-invalid') === 'true' || c.el.validity?.valid === false) return true;
    const cmp = c.cmp ?? c.options?.[0]?.cmp?.up?.('radiogroup');
    if (typeof cmp?.isValid === 'function') { try { return !cmp.isValid(); } catch { return false; } }
    return typeof cmp?.getActiveError === 'function' && !!cmp.getActiveError();
  }

  // Same answer, different formatting: 45000 / "45,000" / "$45,000", 02/03/1988 / 1988-02-03.
  function loose(v) {
    const s = String(v ?? '').trim();
    const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/) ?? s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    // 1/5/1980, 01/05/1980 and 1980-01-05 are the same date.
    if (m) return m[0].startsWith(m[3]) ? `d${m[3]}${m[1].padStart(2, '0')}${m[2].padStart(2, '0')}` : `d${m[1].padStart(2, '0')}${m[2].padStart(2, '0')}${m[3]}`;
    return s.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  // Some known answers become a summary plus a dependent question after the server redraw.
  // Require both witnesses so disappearing controls alone never count as accepted answers.
  function summaryAccepted(step, controls) {
    if (!step.summaryAfter || !controls.some((c) => c.text === squash(step.summaryAfter))) return false;
    return (document.body.innerText ?? '').split(/\r?\n/).some((line) => {
      const text = squash(line).replace(/^business(?: type)? /, '').replace(/ edit$/, '');
      return [step.value, ...(step.choiceAliases ?? [])].some((value) => text === squash(value));
    });
  }

  // Same key the usage recorder (recorder.js) uses, so its changes can be tied to our fills.
  function fieldKey(c) {
    return globalThis.__raterFieldKey(c.el, { q: c.q });
  }

  function safeMatches(el, selector) {
    try { return el.matches(selector); } catch { return false; }
  }

  // Kinds of step that answer a text box, and kinds that pick a choice: which of two questions
  // reading the same ("Business Name" as a registered-name choice, or a box) is a step's.
  const TEXT_STEPS = new Set(['text', 'date', 'address-suggest']);
  const TYPED_STEPS = new Set(['date', 'address-suggest']);
  // Yes / No too (Codex on PR #43): a question that became a text box is never typed "Yes" into.
  const CHOICE_STEPS = new Set(['choice', 'pick-not', 'first-option', 'selected-option', 'bool']);

  // Pairs plan steps with page fields. A carrier's known question is found by what it is, never
  // by its question id: Progressive renumbered every question on 2026-10-07, and an id kept from
  // before then named another question (Business Name got the trucker type). So, by
  // - the field's data-model name (`field`, Duck Creek's fieldref: "ComprehensiveInput.Deductible"),
  //   on whatever page it is; its expected wording (`ask`/`re`) is a check: other words on the field
  //   fill it, flagged for the agent (`reworded`);
  // - else its question on its page (`ask`, the exact text, or `re` on `pages`), never a field
  //   another rule knows by its data-model name; the first one after an anchor question when the
  //   text repeats (`askAfter`: the business "City" comes after "Street Address", the owner's after
  //   "Home Address"; with no anchor on screen, none);
  // - else the list offering a given answer (`withOption`), or a selector.
  // A known question not found stays with the agent: it never falls back to a looser label rule.
  // A data-model name not on the page while its expected wording is (a renamed field) is reported
  // (`pairs.renamed`) and left with the agent. Then label rules, then a pass on the field's name/id.
  // Each pair says how it was found (`how`).
  // On a one-address application whose steps share their field names (GEICO's GiveFirstName is the
  // owner on one step and a driver on another), a rule kept to steps (`steps`) or to a form
  // (`whenShown` / `unlessShown`: a question only that form asks) is live only there; one that
  // isn't live neither answers nor claims a field. A unit's form that may be another unit's is held
  // (`pairs.units`, `pairs.held`; see unitFormsOf).
  function assign(controls, plan) {
    const used = new Set();
    const donePaths = new Set();
    const pairs = [];
    // Steps with a witness whose unit's row isn't among the rows on the page (none or several
    // read as the unit): left for the agent, named by unit (pairs.unwitnessed).
    const unwitnessed = [];
    // The rows a witness step chooses among: known questions, never unfamiliar ones, also while
    // no unit's row is among them yet (the rows before an import) (pairs.witnessed).
    const witnessed = new Set();
    // Rows showing a witness (a VIN) no intake unit has: a vehicle on the quote the intake doesn't
    // list. Never answered or changed; each row is a check for the agent (pairs.extraRows).
    const extraRows = new Map();
    const page = currentPage();
    // The step on screen, read only for a plan kept to steps ('' when no step is named: then no
    // stepped rule is live, and GEICO's fields stay the agent's).
    const stepNow = plan.some((s) => s.steps?.length) ? stepKey() : '';
    const live = (s) => (!s.steps?.length || stepIs(s.steps, stepNow))
      && (!s.whenShown || !!shownControl(controls, s.whenShown)) && (!s.unlessShown || !shownControl(controls, s.unlessShown));
    const steps = plan.filter(live).map((s) => ({ ...s, reC: s.re ? new RegExp(s.re, 'i') : null, exC: s.ex ? new RegExp(s.ex, 'i') : null }));
    const units = unitFormsOf(controls, steps);
    // Steps of a held form: they keep their fields (no other rule takes them, and they aren't
    // unfamiliar), but answer nothing.
    const isHeld = (s) => !!s.whenShown?.unit && !!units.find((u) => u.list === s.whenShown.unit)?.held;
    // Every witness value an intake unit claims (its VIN): a row reading as none of them isn't ours.
    const wanted = new Set(steps.filter((s) => s.witness).map((s) => idText(s.witness.value)).filter(Boolean));
    const take = (s, c, how, reworded = false) => { used.add(c); donePaths.add(s.path); pairs.push({ step: s, control: c, how, reworded }); };
    const fits = (s, c) => !(c.kind === 'checkbox' && s.kind !== 'bool');
    // A label pattern kept to pages or steps is a known question there, as a data-model name is.
    const known = (s) => !!(s.field || s.ask?.length || (s.reC && (s.pages?.length || s.steps?.length)));
    // A question's own pages (`notPages`: never there, whatever finds it).
    const onPage = (s) => (!s.pages?.length || s.pages.includes(page)) && !s.notPages?.includes(page);
    // A data-model name is found on any page, except where the step is fenced off: a trailer's
    // questions carry the vehicle's names (RiskInput.VIN), so each is kept to its own pages.
    const nameHere = (s) => (s.pageOnly ? onPage(s) : !s.notPages?.includes(page));
    const worded = (s) => !!s.ask?.length || !!s.reC;
    const textIs = (s, x) => !!x.text && ((s.ask ?? []).some((a) => squash(a) === x.text) || (!!s.reC && s.reC.test(x.text) && !(s.exC && s.exC.test(x.text))));
    // Data-model names some rule knows here: those fields are that rule's, never a text rule's. A
    // name fenced off this page (a trailer's RiskInput.PAValue on Add Vehicle) claims nothing here.
    const claimed = new Set(steps.filter((s) => s.field && nameHere(s)).map((s) => s.field));
    const isIt = (s, x) => (s.field ? x.ref === s.field && nameHere(s) : onPage(s) && worded(s) && !claimed.has(x.ref) && textIs(s, x));
    // A choice is never typed into a box, nor a typed address or date put in a choice; a plain
    // text step only gives way to a box when its text names a box and a choice.
    const definite = (s, x) => !(CHOICE_STEPS.has(s.kind) && x.kind === 'text') && !(TYPED_STEPS.has(s.kind) && x.kind !== 'text');
    const kindFits = (s, x) => !(TEXT_STEPS.has(s.kind) && x.kind !== 'text');
    const afterAnchor = (same, anchor) => {
      const at = controls.findIndex((x) => x.text === squash(anchor));
      const next = at < 0 ? null : same.find((x) => controls.indexOf(x) > at);
      return next ? [next] : [];
    };
    // The fields a known question is on this page (several: one per vehicle, or one per group).
    const fieldsOf = (s) => {
      if (!known(s)) return [];
      // `control`: the kind of field the question is, when its text is shared with another kind.
      let same = controls.filter((x) => isIt(s, x) && definite(s, x) && (!s.control || x.kind === s.control));
      if (same.length > 1 && same.some((x) => kindFits(s, x))) same = same.filter((x) => kindFits(s, x));
      // The anchor tells repeated texts apart; a data-model name is already the one field.
      return s.askAfter && !s.field ? afterAnchor(same, s.askAfter) : same;
    };
    const found = new Map(steps.map((s) => [s, fieldsOf(s)]));
    // A label fallback can't tell rows of one question apart, nor a vehicle's question from
    // another vehicle's: those are only answered by a known question and its vehicle. (Rows of one
    // question share a question id on the page: that compares the page with itself.)
    const repeated = new Set(controls.map((x) => x.q).filter((q, i, all) => q && all.indexOf(q) !== i));
    // Fields of a per-vehicle question: its steps come one per vehicle (activeVehicle true or
    // false), with or without a year/make/model to name its row.
    const perVehicle = new Set(steps.filter((s) => s.activeVehicle != null).flatMap((s) => found.get(s)));
    // A page about one vehicle (Add Vehicle): no question names a vehicle and the per-vehicle
    // questions sit in one row. Rows of several vehicles without their names stay with the agent.
    const oneVehicle = !controls.some((x) => x.vehicle) && new Set([...perVehicle].map((x) => x.row)).size <= 1;

    // Distinct known questions may share intake data (business and home ZIP/City).
    // Match every known question; path deduplication applies only to label fallbacks.
    for (const s of steps) {
      if (isHeld(s)) continue;
      let c = null;
      let how = s.field ? 'field' : 'text';
      const same = found.get(s);
      if (known(s) && s.activeVehicle != null) {
        // One step per vehicle (several in the quote): on a page showing one vehicle at a time, the
        // active vehicle's; otherwise the row labelled with this vehicle's year/make/model. A
        // vehicle the intake doesn't describe can't name a row: left to the agent.
        c = oneVehicle ? (s.activeVehicle && same.length === 1 ? same[0] : null) : s.vehicleHint ? vehicleRow(same, s.vehicleHint) : null;
        if (c && used.has(c)) c = null;
      } else if (known(s)) {
        // Without a vehicle, several fields for one question are ambiguous: they stay yellow.
        // `each`: a question repeated in several groups, one step per group.
        const free = same.filter((x) => !used.has(x));
        c = s.each ? free[0] ?? null : free.length > 1 ? null : free[0] ?? null;
      } else if (onPage(s)) {
        how = 'selector';
        if (s.selector) {
          const all = controls.filter((x) => safeMatches(x.el, s.selector) || x.radios?.some((r) => safeMatches(r, s.selector)));
          const matching = all.filter((x) => !used.has(x));
          // A repeated question's rows (AmWINS' vehicle rows): the step's unit's row is the one
          // whose witness (its VIN) reads as the unit's, never the row at the unit's position.
          // No such row, or two, while rows are there: the unit is the agent's (unwitnessed).
          if (s.witness) {
            c = witnessRow(matching, s.witness);
            if (!c && all.length) unwitnessed.push(s);
            for (const x of all) {
              witnessed.add(x);
              const w = rowWitnessOf(x, s.witness);
              if (w?.value && !wanted.has(w.value) && !extraRows.has(w.el)) extraRows.set(w.el, s.witness);
            }
          } else c = matching[0] ?? null;
          // An ignored step for every match (`every`: the gateway's other product boxes, however many).
          if (s.ignore && s.every) for (const x of matching.slice(1)) take(s, x, how);
        }
        // A dropdown with no usable label, known by one of its options ("NO PRIOR").
        if (!c && s.withOption) { how = 'option'; c = controls.find((x) => !used.has(x) && optionsOf(x).some((o) => squash(o.text) === squash(s.withOption))); }
      }
      // Reworded: found by its data-model name, its wording isn't the rule's. A field with no wording
      // of its own (nameOnly) can't say so: it was taken for reworded, a check that held Progressive's
      // Rates helpers on TX's caption-less PIP limit (live recording, 2026-10-23).
      if (c) take(s, c, how, !!s.field && worded(s) && !c.nameOnly && !textIs(s, c));
    }
    // A held form's fields (its steps' and its marker question) that no live step took: nobody
    // else's, and not unfamiliar either. The form is one check for the agent (fill).
    const held = new Set();
    for (const s of steps.filter(isHeld)) {
      const mine = known(s) ? found.get(s) : s.selector ? controls.filter((x) => safeMatches(x.el, s.selector) || x.radios?.some((r) => safeMatches(r, s.selector))) : [];
      for (const x of mine) if (!used.has(x)) held.add(x);
    }
    for (const u of units) if (u.held && !used.has(u.marker)) held.add(u.marker);
    for (const x of held) used.add(x);
    // A data-model name not on the page, while its expected wording is: the field was probably renamed.
    pairs.renamed = steps.filter((s) => s.field && worded(s) && onPage(s) && nameHere(s) && !found.get(s).length)
      .flatMap((s) => { const x = controls.find((y) => !used.has(y) && y.ref !== s.field && !claimed.has(y.ref) && textIs(s, y)); return x ? [{ step: s, control: x }] : []; });
    // A label rule kept out of a carrier's row sections (`notWithin`): its rows are answered by
    // their own rules, or stay the agent's.
    const fenced = (s, x) => !!s.notWithin?.some((sel) => { try { return !!x.el?.closest(sel); } catch { return false; } });
    for (const field of ['text', 'hint']) {
      for (const s of steps) {
        if (!s.reC || known(s) || isHeld(s) || donePaths.has(s.path) || !onPage(s)) continue;
        const c = controls.find((x) => !used.has(x) && !repeated.has(x.q) && !perVehicle.has(x) && !fenced(s, x) && x[field] && fits(s, x) && s.reC.test(x[field]) && !(s.exC && s.exC.test(x[field])));
        if (c) take(s, c, field === 'text' ? 'label' : 'name');
      }
    }
    pairs.unwitnessed = unwitnessed;
    pairs.witnessed = witnessed;
    pairs.held = held;
    pairs.units = units;
    // Numbered by their place among the page's rows (by their witness controls), never by value.
    const witnesses = steps.filter((s) => s.witness).map((s) => s.witness);
    const rowWitnesses = [...new Set(controls.flatMap((x) => witnesses.some((w) => safeMatches(x.el, w.selector)) ? [x.el] : []))];
    const identities = [...extraRows].map(([el, witness]) => JSON.stringify([
      witness.selector, String(witness.path ?? '').replace(/\[\d+\]/g, '[]'), idText(el.value),
    ]));
    // A removed identity loses its acknowledgement, including a later re-addition of the same VIN.
    // Without visible witness rows (another application step), absence proves no removal.
    if (rowWitnesses.length) {
      for (const identity of extraRowKeys.keys()) if (!identities.includes(identity)) extraRowKeys.delete(identity);
    }
    pairs.extraRows = [...extraRows].map(([el, witness], i) => {
      const identity = identities[i];
      const count = identities.filter((id) => id === identity).length;
      // A duplicate's VIN cannot identify which row was reviewed. Keep its key on that DOM
      // control through reordering; after a redraw each duplicate requires fresh confirmation.
      if (extraRowKeys.get(identity)?.count !== count) {
        extraRowKeys.set(identity, { count, key: `extra-row:${crypto.randomUUID()}`, rows: new WeakMap() });
      }
      const entry = extraRowKeys.get(identity);
      if (count > 1 && !entry.rows.has(el)) entry.rows.set(el, `extra-row:${crypto.randomUUID()}`);
      return { witness, position: rowWitnesses.indexOf(el) + 1, key: count === 1 ? entry.key : entry.rows.get(el) };
    });
    return pairs;
  }

  // The field a presence condition (`whenShown` / `unlessShown`: { field, label? }) names: one on
  // the page with that data-model name and, with `label` (a pattern, tested like a rule's label),
  // a question reading like it (GEICO's trailer form asks GiveOtherVehicleType about "the
  // customer's trailer", its vehicle form about "the customer's vehicle"). Null when none is.
  function shownControl(controls, cond) {
    const re = cond.label ? new RegExp(cond.label, 'i') : null;
    return controls.find((x) => x.ref === cond.field && (!re || re.test(x.text ?? ''))) ?? null;
  }

  // The unit forms on screen, one per list (vehicles, drivers, trailers): GEICO draws each vehicle's,
  // trailer's and driver's form at the same address, one at a time, and the live steps kept to a
  // unit's form (`whenShown.unit`) answer it for the panel's active unit of that list. A form is
  // told by its marker question's element name, whose number is new with each form GEICO draws
  // (Id_YesNoPreQuoteHaveFullVinActivity_85493, then _37768 for the next vehicle). Against the forms
  // fills have answered each unit on (fill `units.bound`: the panel's, plus this fill's own), a form
  // is held when it was answered for another unit, or is new while the active unit was answered on
  // another form: the picker still names the last unit, and the automatic fill of the next form
  // would type that unit's VIN into it. { list, id, marker, active, count, held, boundTo } each.
  function unitFormsOf(controls, steps) {
    const out = [];
    for (const s of steps) {
      const list = s.whenShown?.unit;
      if (!list || out.some((u) => u.list === list)) continue;
      const marker = shownControl(controls, s.whenShown);
      const id = marker ? String(marker.el.name || marker.el.id || '') : '';
      if (!id) continue;
      const bound = fillUnits?.bound?.[list] ?? {};
      const active = fillUnits?.active?.[list] ?? 0;
      const boundTo = Object.hasOwn(bound, id) ? bound[id] : null;
      const activeForm = Object.keys(bound).find((k) => bound[k] === active) ?? null;
      const held = (boundTo != null && boundTo !== active) || (boundTo == null && activeForm != null && activeForm !== id);
      out.push({ list, id, marker, active, count: fillUnits?.count?.[list] ?? 0, held, boundTo });
    }
    return out;
  }

  // The unit forms on screen now, [{ list, id }] as unitFormsOf tells them (by their marker
  // question's element name), between fills: the recorder sends them with the agent's changes, so
  // the panel files an edit under the form it was made on, also one no fill has read yet (a trailer
  // form just opened). [] when the markers fills in this document were given show no form (GEICO's
  // owner check under Vehicles); null when no fill here gave any. Element names only, no values:
  // `blank` says whether the marker question is still unanswered (a new form, not a saved unit's).
  function unitFormsNow() {
    if (!knownUnitMarkers) return null;
    try {
      const controls = collectControls();
      const out = [];
      for (const m of knownUnitMarkers) {
        if (out.some((u) => u.list === m.unit)) continue;
        const marker = shownControl(controls, m);
        const id = marker ? String(marker.el.name || marker.el.id || '') : '';
        if (id) out.push({ list: m.unit, id, blank: !hasValue(marker) });
      }
      return out;
    } catch {
      return null;
    }
  }

  const unitNoun = (list) => ({ vehicles: 'vehicle', drivers: 'driver', trailers: 'trailer' }[list] ?? 'unit');

  // What the agent is told about a held unit form: the unit by its place in the intake's list,
  // never by its VIN or name.
  function heldFormNote(u) {
    const noun = unitNoun(u.list);
    const which = u.boundTo != null
      ? `This form was filled for ${noun} ${Number(u.boundTo) + 1}, and the panel has ${noun} ${Number(u.active) + 1} picked`
      : `This form may be another ${noun}'s than ${noun} ${Number(u.active) + 1}, which was filled on an earlier form`;
    if (u.count <= 1) return `${which}. The intake lists ${u.count === 1 ? `one ${noun}` : `no ${noun}s`}: answer this form yourself.`;
    // A form filled for one unit stays held once the agent picks the unit it is really about: the
    // note says both ways out, as only the agent can tell whose it is.
    if (u.boundTo == null) return `${which}: pick the ${noun} this form is about in the panel, then Fill again.`;
    const filledFor = `${noun} ${Number(u.boundTo) + 1}`;
    return `${which}: if it is ${filledFor}'s, pick ${filledFor} in the panel, then Fill again; if it is ${noun} ${Number(u.active) + 1}'s, correct its answers yourself.`;
  }

  // Letters and digits only, uppercase: how a witness value (a VIN) compares with the page's.
  const idText = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  // The unit a witness path names ("vehicles[1].vin": vehicle 2), and what the witness is (VIN).
  const unitName = (path) => { const m = String(path ?? '').match(/^(\w+?)s?\[(\d+)\]/); return m ? `${m[1]} ${Number(m[2]) + 1}` : 'this unit'; };
  const witnessName = (w) => { const k = String(w.path ?? '').split('.').pop() ?? ''; return k.length <= 3 ? k.toUpperCase() : humanize(k); };

  // Of the rows of a repeated question (one control each), the one whose row holds the step's
  // witness: a control matching `witness.selector` (AmWINS' [data-id="vin"]) reading as
  // `witness.value`. A control's row is its nearest ancestor holding a witness control, which
  // must be the only one there (higher up is the whole panel). No row reading as the unit (the
  // import hasn't landed, or rejected its VIN; the intake has no VIN for it), or two (two rows
  // with one VIN), is no row: the unit stays the agent's.
  function witnessRow(candidates, witness) {
    const want = idText(witness.value);
    if (!want) return null;
    const rows = candidates.filter((x) => rowWitnessOf(x, witness)?.value === want);
    return rows.length === 1 ? rows[0] : null;
  }

  // A control's row's witness control and what it reads (letters and digits), or null when the
  // nearest ancestor holding a witness control holds two (the whole panel) or there is none.
  function rowWitnessOf(x, witness) {
    for (let p = x.el; p && p !== document; p = p.parentElement) {
      let found;
      try { found = [...p.querySelectorAll(witness.selector)]; } catch { return null; }
      if (!found.length) continue;
      return found.length === 1 ? { el: found[0], value: idText(found[0].value) } : null;
    }
    return null;
  }

  // The one row naming this vehicle best: at least two of its year, make and model as whole
  // words, also when the intake gives only one of them. Two rows that fit equally well (two
  // identical vans) are the agent's.
  function vehicleRow(rows, hint) {
    const score = (x) => hint.filter((h) => ` ${x.vehicle ?? ''} `.includes(` ${h} `)).length;
    const best = Math.max(0, ...rows.map(score));
    const top = rows.filter((x) => score(x) === best);
    return best >= 2 && top.length === 1 ? top[0] : null;
  }

  // ---------------------------------------------------------------------------------------------
  // Choosing dropdown / radio options

  function moneyTokens(s) {
    const out = [];
    for (const m of String(s).matchAll(/\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|m|mm|million|thousand)?\b/gi)) {
      let n = parseFloat(m[1].replace(/,/g, ''));
      const unit = (m[2] ?? '').toLowerCase();
      if (unit === 'k' || unit === 'thousand') n *= 1e3;
      else if (unit) n *= 1e6;
      out.push(Math.round(n));
    }
    return out;
  }

  function candidates(step) {
    const v = step.value;
    if (step.kind === 'bool') return v ? ['yes', 'y', 'true'] : ['no', 'n', 'false'];
    if (step.kind === 'state') return [squash(v), STATE_NAMES[String(v).toUpperCase()]].filter(Boolean);
    return [v, ...(step.choiceAliases ?? [])].map(squash);
  }

  const businessNameKey = (text) => squash(String(text).replace(/\((?:US)?DOT[^)]*\)/ig, ''));

  // Registered business names that read the same once normalised count once (the lookup can
  // list one name twice).
  function uniqueBusinessNames(options) {
    const seen = new Set();
    return options.filter((o) => {
      const k = businessNameKey(o.text);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // A list's stand-in for what is picked: GEICO starts every coverage list with an
  // <option value="" hidden> repeating the current choice ("Not Included"). Picking it picks nothing.
  const standIn = (o) => o.el?.tagName === 'OPTION' && (!!o.el.hidden || !!o.el.disabled || o.value === '');

  // A list's choices: options that read the same are the same choice (pages sometimes list one
  // twice), and the real one of them is the choice, never a stand-in reading like it. Placeholders
  // are no choice.
  function usableOptions(options) {
    const seenText = new Set();
    const real = new Set(options.filter((o) => !standIn(o)).map((o) => squash(o.text)));
    return options.filter((o) => {
      const k = squash(o.text);
      if (!k || isPlaceholderOption(o.text) || seenText.has(k) || (standIn(o) && real.has(k))) return false;
      seenText.add(k);
      return true;
    });
  }

  function matchOption(options, step) {
    const usable = usableOptions(options);
    // "Any option except …" (e.g. the registered USDOT address instead of "Enter a different
    // address"), preferring one that matches `prefer` when there are several.
    if (step.kind === 'pick-not') {
      const allowed = usable.filter((o) => !new RegExp(step.value.not, 'i').test(o.text));
      if (step.registeredName && step.businessNames?.length) {
        // One registered name listed twice ("ACME LLC", "Acme, LLC") is still one match.
        const matches = uniqueBusinessNames(allowed.filter((o) => step.businessNames.some((name) => businessNameKey(o.text) === businessNameKey(name))));
        return matches.length === 1 ? matches[0] : null;
      }
      return (step.value.prefer && allowed.find((o) => new RegExp(step.value.prefer, 'i').test(o.text))) || allowed[0]
        || (step.value.fallback && usable.find((o) => new RegExp(step.value.fallback, 'i').test(o.text))) || null;
    }
    if (step.kind === 'selected-option') return usable.find((o) => /^selected\b/i.test(o.text)) ?? null;
    // Always the page's first choice (e.g. the first offered home address).
    if (step.kind === 'first-option') return usable[0] ?? null;
    const cands = candidates(step);
    for (const c of cands) {
      const hit = usable.find((o) => squash(o.text) === c || squash(o.value) === c);
      if (hit) return hit;
    }
    // Dollar amounts: "$1M CSL" matches "$1 million CSL"; "$100000/$1000" matches
    // "$100k with a $1,000 Deductible".
    if (step.kind !== 'bool' && step.kind !== 'state') {
      const want = typeof step.value === 'number' ? [step.value] : moneyTokens(step.value);
      if (want.length) {
        const hits = usable.filter((o) => { const t = moneyTokens(o.text); return t.length === want.length && t.every((n, i) => n === want[i]); });
        if (hits.length === 1) return hits[0];
        if (hits.length > 1) {
          const csl = /csl|combined/.test(squash(step.value));
          return hits.find((o) => /csl|combined/.test(squash(o.text)) === csl) ?? null;
        }
      }
    }
    // Numeric bands: 350 matches "201-500"; 800 matches "500+" / "More than 500 miles";
    // otherwise the smallest single-number option that covers the value (150 -> "200 miles").
    const n = typeof step.value === 'number' ? step.value : /^\d+$/.test(String(step.value)) ? Number(step.value) : null;
    if (n != null && step.kind === 'int') {
      for (const o of usable) {
        const t = o.text.replace(/,/g, '');
        const range = t.match(/(\d+)\s*(?:-|–|to)\s*(\d+)/);
        if (range && n >= Number(range[1]) && n <= Number(range[2])) return o;
        const open = t.match(/(\d+)\s*\+|(?:over|more than|greater than)\s*(\d+)/i);
        if (open && n > Number(open[1] ?? open[2]) - (open[1] ? 1 : 0)) return o;
      }
      const single = usable
        .map((o) => ({ o, t: moneyTokens(o.text) }))
        .filter(({ o, t }) => t.length === 1 && !/(\d+)\s*\+|over|more than|greater than|-|–|\bto\b/i.test(o.text) && t[0] >= n)
        .sort((a, b) => a.t[0] - b.t[0]);
      if (single.length) return single[0].o;
    }
    // A requested amount must match exactly; never turn $1,000 into $10,000 by substring.
    if (step.kind !== 'bool' && moneyTokens(step.value).length) return null;
    for (const c of cands.filter((x) => x.length >= 2)) {
      const starts = usable.filter((o) => squash(o.text).startsWith(c));
      if (starts.length === 1) return starts[0];
    }
    for (const c of cands.filter((x) => x.length >= 3)) {
      const has = usable.filter((o) => squash(o.text).includes(c));
      if (has.length === 1) return has[0];
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------
  // Setting values

  // Plain pages: set the value in a way React / Angular / Vue notice.
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    el.focus({ preventScroll: true });
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    // Date boxes with a vanillajs-datepicker (AmWINS): the page reads the picker's date, not the
    // box, and the picker only takes typed text on Tab / Enter / leaving the box. Tab is handled
    // the same whether its calendar is open or not.
    if (el.classList?.contains('datepicker-input')) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true }));
    el.blur();
  }

  function textFor(step, c) {
    const v = step.value;
    switch (step.kind) {
      case 'bool': return v ? 'Yes' : 'No';
      case 'date': {
        const m = String(v).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        return m && c.type === 'date' ? `${m[3]}-${m[1]}-${m[2]}` : String(v);
      }
      case 'phone': return c.el.maxLength > 0 && c.el.maxLength <= 10 ? String(v).replace(/\D/g, '') : String(v);
      default: return String(v);
    }
  }

  // Waiting for the page (fill: `waitFor`).
  const WAIT_MS = 8000;
  const WAIT_ROUND_MS = 400;
  // The questions a fill waited the whole WAIT_MS for in this document: the page isn't working on
  // them (a VIN GEICO doesn't decode leaves its year for the agent), so no later fill waits again.
  const waitedOut = new WeakSet();
  // Address boxes a fill left without a suggestion (`checkNumber`: GEICO's street), with what it
  // left in them: still the agent's on a later fill while the box holds that.
  const unpicked = new WeakMap();
  // The same for a question that was never drawn, by the unit form it would be on (its marker
  // question's element; the page's body without one): step ids per form.
  const waitedOutUndrawn = new WeakMap();
  // Once the question waited for comes in, the page goes on redrawing for a moment (GEICO fills its
  // vehicle type list again after the decoded year): this long without a change before the answer.
  const AFTER_WAIT_QUIET_MS = 800;
  // A helper that draws a new view (`loads`: GEICO's add icons, the chooser's Next): how long its
  // page may stay loading, and how long its view may take to show once the page is quiet, before
  // the click counts as lost. Clicked once either way: a second "+" queues a second add.
  const LOAD_MS = 60000;
  const LOAD_RESULT_MS = 20000;
  // How long the page is quiet before such a helper is clicked.
  const LOAD_QUIET_MS = 1000;
  const LOAD_HALT = 'The page was still loading after a minute: wait for it, then fill again.';
  // A helper clicked once a quote (`once`: GEICO's Recalculate, W43-31) whose result didn't show.
  // How long after a helper that redraws answers (`keepAnswers`: GEICO's Recalculate) they are
  // watched before the fill goes on (View More Payment Plans, Print): GEICO drew its own values 9 to
  // 14 s after the fill's click (FL run 6, 2026-10-21).
  const KEPT_WATCH_MS = 15000;
  const ONCE_UNVERIFIED = 'it was clicked, but the page showed no current premium afterwards. Check the page and click Recalculate yourself: the fill clicks it once a quote.';
  // What a `whenClear` helper waits for (its `why`).
  const NOTHING_LEFT = 'nothing left for you on the page';
  // What holds Continue after the agent's own button during a fill (`notePress`).
  const AGENT_PRESSED = 'you clicked a button during the fill: Continue is yours';
  // How long the page is quiet before an answer it reset is given again (`filledBefore`).
  const RESET_QUIET_MS = 1000;

  const noMatch = (step, options) => ({
    ok: false,
    reason: `no option matches "${step.value}"`,
    options: options.filter((o) => !isPlaceholderOption(o.text)).map((o) => o.text).slice(0, 25),
  });

  // Address boxes with the carrier's own address suggestions: type the whole one-line address,
  // wait for the suggestion list, pick its first entry for that address (which fills street, city
  // and ZIP): one with its house number and, when both show one, its ZIP. No such suggestion means
  // the address needs the agent; the ZIP/city rules then check the rest. GEICO's are
  // <gds-dropdown-list-item type="address">, in its address wrapper's shadow root, read as list items
  // (its script; FL live run 3, 2026-10-21).
  // What the agent may click to move a page on (`notePress` in fill): a button or an add icon, also
  // ExtJS's (`.x-btn`: Progressive's Continue, whose press during a fill went unseen, live recording,
  // 2026-10-23). A toggle (aria-expanded: GEICO's section headings, a menu) or a link moves nothing.
  const AGENT_PRESS = 'button, gds-button, input[type=submit], input[type=button], [data-testid=addIcon], .x-btn';
  const SUGGESTION_SELECTOR = '[role=option], .x-boundlist-item, .pac-item, [class*="suggest"] li, [class*="Suggest"] li, [class*="autocomplete"] li, [class*="Autocomplete"] li, gds-dropdown-list-item[type=address]';
  // An address's house number (its leading number) and ZIP (after a state's two letters).
  const houseNumberOf = (text) => String(text ?? '').match(/^\s*(\d+)\b/)?.[1] ?? null;
  const zipOf = (text) => String(text ?? '').match(/\b[A-Z]{2}\s+(\d{5})(?:-\d{4})?\b/i)?.[1] ?? null;
  const shownSuggestions = () => deepQueryAll(document, SUGGESTION_SELECTOR).filter((el) => el.getClientRects().length && oneLine(el.textContent));
  async function applyAddress(step, c) {
    const text = String(step.value);
    const { el, cmp } = c;
    const before = new Set(shownSuggestions());
    // Google's address autocomplete (Progressive uses it): its list (.pac-item) is only shown
    // while the box has focus, which it doesn't while the agent works in the side panel. The
    // suggestions are still there, hidden; they're picked the way the keyboard does (↓, Enter).
    const pacBefore = new Map(deepQueryAll(document, '.pac-item').map((x) => [x, x.textContent]));
    const houseNumber = text.match(/^\s*(\d+)/)?.[1] ?? null;
    const freshPac = () => deepQueryAll(document, '.pac-item').find((x) => pacBefore.get(x) !== x.textContent && oneLine(x.textContent) && (!houseNumber || x.textContent.includes(houseNumber))) ?? null;
    el.focus?.({ preventScroll: true });
    el.dispatchEvent(new Event('focus'));
    if (cmp) cmp.setValue(text);
    else Object.getOwnPropertyDescriptor(c.el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(el, text);
    // Suggestion lists listen for typing: send the events typing would.
    for (const type of ['input', 'keydown', 'keyup']) el.dispatchEvent(new Event(type, { bubbles: true }));
    try { cmp?.fireEvent?.('change', cmp, text); } catch { /* page handler expected a real event */ }
    // What the page adds while it thinks: when no known list shows up, the reason names the new
    // elements (tag.class), so the carrier's suggestion list can be recognised next time.
    const added = [];
    const mo = typeof MutationObserver === 'function' ? new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1 && added.length < 40) added.push(n);
    }) : null;
    mo?.observe(document.body, { subtree: true, childList: true });
    // A suggestion for this address: the same house number, and the same ZIP when both show one
    // (another town's same street is not it).
    const wantZip = zipOf(text);
    const fits = (x) => {
      const shown = oneLine(x.textContent);
      return (!houseNumber || houseNumberOf(shown) === houseNumber) && (!wantZip || !zipOf(shown) || zipOf(shown) === wantZip);
    };
    let first = null;
    let offered = false;
    try {
      for (const start = Date.now(); !first && Date.now() - start < 4000;) {
        await sleep(200);
        const fresh = shownSuggestions().filter((x) => !before.has(x));
        offered ||= fresh.length > 0;
        first = freshPac() ?? fresh.find(fits) ?? null;
      }
    } finally {
      mo?.disconnect();
    }
    if (!first) {
      // A box with its own city/ZIP boxes gets back just the street.
      if (step.fallback) {
        if (cmp) cmp.setValue(step.fallback);
        else Object.getOwnPropertyDescriptor(c.el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(el, step.fallback);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      el.blur?.();
      if (step.checkNumber) unpicked.set(el, el.value);
      if (offered) return { ok: false, reason: `none of the page's address suggestions has the intake's house number${wantZip ? ' and ZIP' : ''}: pick the address yourself` };
      const seen = [...new Set(added.filter((n) => n.getClientRects?.().length).map((n) => `${n.tagName.toLowerCase()}${n.id ? `#${String(n.id).replace(/\d{3,}/g, '#')}` : ''}${typeof n.className === 'string' && n.className.trim() ? `.${n.className.trim().split(/\s+/).slice(0, 3).join('.')}` : ''}${n.getAttribute?.('role') ? `[role=${n.getAttribute('role')}]` : ''}`))].slice(0, 8);
      return { ok: false, reason: `the page offered no address suggestion; check the address, city and ZIP${seen.length ? ` (new on the page: ${seen.join(', ')})` : ''}` };
    }
    const shown = oneLine(first.textContent).slice(0, 120);
    if (first.classList?.contains('pac-item') || / pac-item /.test(` ${first.className} `)) {
      for (const [key, code] of [['ArrowDown', 40], ['Enter', 13]]) el.dispatchEvent(keyEvent('keydown', key, code));
      await settle({ quietMs: 300, maxMs: 5000 });
      // Still the typed text: Google didn't take the keys; click the suggestion instead.
      if (el.value !== text) return { ok: true, shown };
    }
    for (const type of ['mousedown', 'mouseup']) first.dispatchEvent(new Event(type, { bubbles: true }));
    first.click?.();
    await settle({ quietMs: 300, maxMs: 5000 });
    return { ok: true, shown };
  }

  // A key press as page scripts read it (Google's autocomplete looks at keyCode).
  function keyEvent(type, key, code) {
    const e = typeof KeyboardEvent === 'function' ? new KeyboardEvent(type, { key, bubbles: true, cancelable: true }) : new Event(type, { bubbles: true });
    for (const prop of ['keyCode', 'which']) { try { Object.defineProperty(e, prop, { get: () => code }); } catch { /* read-only */ } }
    if (!('key' in e)) e.key = key;
    return e;
  }

  // Type-ahead dropdowns (select2: a hidden <select> with the box select2 draws after it, and a
  // search box that lists what matches the typed text). select2 opens on a left-button mousedown
  // (it checks the event's button), so a plain Event isn't enough.
  const Mouse = () => (typeof MouseEvent === 'function' ? MouseEvent : Event);
  const press = (el) => { for (const type of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new (Mouse())(type, { bubbles: true, cancelable: true, button: 0 })); };
  const select2Box = (select) => [select.nextElementSibling, ...(select.parentElement?.children ?? [])]
    .find((n) => n && n !== select && /\bselect2\b/.test(String(n.className))) ?? null;
  // A list select2 draws (its own <select> hidden by select2), not one it only searches for.
  const isSelect2 = (c) => c.kind === 'select' && !c.cmp && !!c.el.classList?.contains('select2-hidden-accessible') && !!select2Box(c.el);

  // Opens a select2 list and types `text` in its search box: { box, results } as the list then
  // shows them, or { reason } when it can't. A list taking several choices types in its own box,
  // drawn in the list's box; another in the box its open dropdown draws (none on a short list:
  // its results are read as listed). The results are the list's own (select2 names them after the
  // <select>: select2-<id>-results), else those on screen.
  async function select2Search(select, text) {
    const container = select2Box(select);
    const opener = container?.querySelectorAll?.('.select2-selection')?.[0] ?? container;
    if (!opener) return { reason: 'the search box for this list was not found; pick it yourself' };
    if (!/\bselect2-container--open\b/.test(String(container.className))) press(opener);
    const inline = () => (select.multiple ? container.querySelectorAll?.('.select2-search__field')?.[0] ?? null : null);
    // Never another list's own box (a list taking several choices always shows its box).
    const dropdownBox = () => deepQueryAll(document, '.select2-search__field').find((n) => n.getClientRects().length && !n.closest?.('.select2-selection')) ?? null;
    const own = () => (select.id ? document.getElementById?.(`select2-${select.id}-results`) : null);
    const listed = () => (own() ? [...own().querySelectorAll('.select2-results__option')] : deepQueryAll(document, '.select2-results__option'))
      .filter((n) => n.getClientRects().length && !/loading|message/.test(String(n.className)));
    let box = null;
    for (const start = Date.now(); !box && Date.now() - start < 3000;) {
      await sleep(100);
      box = inline() ?? dropdownBox();
      if (!box && !select.multiple && own() && listed().length && Date.now() - start >= 1000) break;
    }
    if (!box && !(own() && listed().length)) return { reason: "the list's search box didn't open; pick it yourself" };
    if (box) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(box, String(text));
      for (const type of ['input', 'keyup']) box.dispatchEvent(new Event(type, { bubbles: true }));
    }
    let results = [];
    for (const start = Date.now(); Date.now() - start < 6000;) {
      await sleep(200);
      results = listed();
      if (results.length) break;
    }
    return { box, results };
  }

  // Closes an open select2 list without a pick (its box takes a key, the page a click elsewhere).
  function closeSelect2(box) {
    box?.dispatchEvent(new Event('keydown', { bubbles: true }));
    document.body.dispatchEvent(new (Mouse())('mousedown', { bubbles: true, button: 0 }));
  }

  // Type-ahead dropdowns the page fills from its server (AmWINS' classification): type
  // `step.search`, and pick the one result containing `step.value`; no such result (or several)
  // means no confident match, and the agent picks.
  async function applySearchSelect(step, c) {
    const found = await select2Search(c.el, step.search ?? step.value);
    if (found.reason) return { ok: false, reason: found.reason };
    const want = squash(step.value);
    // The result that is exactly the wanted text wins over others that only contain it.
    const exact = found.results.filter((n) => squash(n.textContent) === want);
    const hits = exact.length ? exact : found.results.filter((n) => squash(n.textContent).includes(want));
    if (hits.length !== 1) {
      closeSelect2(found.box);
      return { ok: false, reason: hits.length ? `${hits.length} results match "${step.value}"; pick the right one` : `no confident match for "${step.value}"; pick it yourself` };
    }
    press(hits[0]);
    await settle({ quietMs: 250, maxMs: 4000 });
    return squash(selectedText(c) ?? '').includes(want) ? { ok: true, shown: oneLine(hits[0].textContent) } : { ok: false, reason: 'the page did not keep the choice; pick it yourself' };
  }

  // One option of a select2 list picked as the agent picks it: its text typed in the list's search
  // box, and the one result reading exactly that clicked (one not picked yet, on a list taking
  // several: clicking a picked one takes it off).
  async function pickSelect2(select, text) {
    const found = await select2Search(select, text);
    if (found.reason) return { ok: false, reason: found.reason };
    const want = oneLine(text).toLowerCase();
    const hits = found.results.filter((n) => oneLine(n.textContent).toLowerCase() === want && n.getAttribute?.('aria-selected') !== 'true');
    if (hits.length !== 1) {
      closeSelect2(found.box);
      return { ok: false, reason: hits.length ? `the list showed "${text}" ${hits.length} times; pick it yourself` : `the list didn't show "${text}" when it was typed; pick it yourself` };
    }
    press(hits[0]);
    await settle({ quietMs: 250, maxMs: 4000 });
    return { ok: true };
  }

  // A pick taken off a select2 list taking several choices: its own × in the list's box.
  async function unpickSelect2(select, text) {
    const want = oneLine(text).toLowerCase();
    const chip = [...(select2Box(select)?.querySelectorAll?.('.select2-selection__choice') ?? [])]
      .find((n) => oneLine(n.getAttribute?.('title') ?? n.textContent.replace(/^×/, '')).toLowerCase() === want);
    const remove = chip?.querySelectorAll?.('.select2-selection__choice__remove')?.[0] ?? null;
    if (!remove) return { ok: false, reason: `"${text}" is picked but has no × to take it off; take it off yourself` };
    press(remove);
    await settle({ quietMs: 250, maxMs: 4000 });
    return { ok: true };
  }

  // GEICO's select2 lists (business description, cargo commodities, a driver's suffix, a vehicle's
  // year, make and model) take a pick only from select2 itself: the page reads its select2:select
  // and select2:unselect, never a change of the hidden <select> (FL live run 6, 2026-10-21: the
  // commodity set on the <select> showed, but GEICO took none and never asked for the cargo limit;
  // the business description set so was refused at Next). Each pick is made in the list (typed,
  // then clicked: pickSelect2), and on a list taking several a pick the answer doesn't name is
  // taken off first (GEICO takes at most four).
  async function applySelect2(step, c) {
    let options = optionsOf(c);
    if (c.el.multiple) {
      const wanted = multiValue(step.value, options);
      const picks = wanted.map((w) => options.find((o) => !o.el.disabled && o.text.toLowerCase() === w.toLowerCase()));
      if (!wanted.length || picks.some((o) => !o)) return noMatch({ ...step, value: wanted.filter((w, i) => !picks[i]).join('; ') || step.value }, options);
      for (const o of options.filter((x) => x.el.selected && !picks.includes(x))) {
        const off = await unpickSelect2(c.el, o.text);
        if (!off.ok) return off;
      }
      for (const o of picks.filter((x) => !x.el.selected)) {
        const on = await pickSelect2(c.el, o.text);
        if (!on.ok) return on;
      }
      if (!options.every((o) => !!o.el.selected === picks.includes(o))) return { ok: false, reason: 'the page did not keep these picks' };
      return { ok: true, shown: picks.map((o) => o.text).join('; ') };
    }
    let opt = matchOption(options, step);
    for (const start = Date.now(); !opt && new Set(options.map((o) => oneLine(o.text)).filter(Boolean)).size <= 1 && Date.now() - start < 6000;) {
      await sleep(250);
      options = optionsOf(c);
      opt = matchOption(options, step);
    }
    if (!opt) return noMatch(step, options);
    const on = await pickSelect2(c.el, opt.text);
    if (!on.ok) return on;
    return selectedText(c) === opt.text ? { ok: true, shown: opt.text } : { ok: false, reason: 'the page did not keep the choice; pick it yourself' };
  }

  // Returns { ok: true, shown } or { ok: false, reason, options? }.
  async function apply(step, c) {
    if (step.kind === 'address-suggest' && c.kind === 'text') return applyAddress(step, c);
    if (step.kind === 'search-select') return applySearchSelect(step, c);
    if (c.cmp || c.options?.some((o) => o.cmp)) return applyExt(step, c);
    if (c.el.readOnly) return { ok: false, reason: 'the field is read-only (usually a date picker or lookup) — set it by hand' };
    if (isSelect2(c)) return applySelect2(step, c);
    // A list taking several choices (GEICO's commodities: W43-23): exactly the answer's options,
    // named by their texts joined by "; " (as selectedText reads them back), each of them offered.
    if (c.kind === 'select' && c.el.multiple) {
      const options = optionsOf(c);
      const wanted = multiValue(step.value, options);
      // A disabled option (a limit reached, or not for this class) isn't offered.
      const picks = wanted.map((w) => options.find((o) => !o.el.disabled && o.text.toLowerCase() === w.toLowerCase()));
      if (!wanted.length || picks.some((o) => !o)) return noMatch({ ...step, value: wanted.filter((w, i) => !picks[i]).join('; ') || step.value }, options);
      for (const o of options) o.el.selected = picks.includes(o);
      c.el.dispatchEvent(new Event('input', { bubbles: true }));
      c.el.dispatchEvent(new Event('change', { bubbles: true }));
      if (!options.every((o) => o.el.selected === picks.includes(o))) return { ok: false, reason: 'the page did not keep these picks' };
      return { ok: true, shown: picks.map((o) => o.text).join('; ') };
    }
    if (c.kind === 'text') {
      const text = textFor(step, c);
      if (c.el.maxLength > 0 && text.length > c.el.maxLength) return { ok: false, reason: `value is longer than the field allows (${c.el.maxLength})` };
      setNativeValue(c.el, text);
      if (c.el.value === '') return { ok: false, reason: 'the page cleared the value (it may need a different format)' };
      return { ok: true, shown: c.el.value };
    }
    if (c.kind === 'checkbox') {
      if (typeof step.value !== 'boolean') return { ok: false, reason: 'checkbox needs a yes/no answer' };
      if (c.el.checked !== step.value) c.el.click();
      return { ok: true, shown: step.value ? 'checked' : 'unchecked' };
    }
    let options = optionsOf(c);
    let opt = matchOption(options, step);
    // A list still waiting for its options (loaded after the page shows): give it a few seconds.
    // Counted by distinct text: GEICO's collision row lists "Not Included" twice until its
    // comprehensive is chosen (FL live run 2, 2026-10-21).
    const loading = () => new Set(options.map((o) => oneLine(o.text)).filter(Boolean)).size <= 1;
    for (const start = Date.now(); !opt && c.kind === 'select' && loading() && Date.now() - start < 6000;) {
      await sleep(250);
      options = optionsOf(c);
      opt = matchOption(options, step);
    }
    if (!opt) return noMatch(step, options);
    if (c.kind === 'select') setNativeValue(c.el, opt.value);
    else if (!optionOn(opt)) {
      // A design-system option whose own input is still checked from an earlier pick while its host
      // isn't (the page shows another option): a click on a checked radio changes nothing and tells
      // the page nothing, so it is unchecked first.
      if (opt.host && opt.el.checked) opt.el.checked = false;
      opt.el.click();
    }
    return { ok: true, shown: opt.text };
  }

  // Runs ExtJS's own "field lost focus" handling, which is when Duck Creek sends an answer to
  // its server. A real focus/blur doesn't fire while the agent is clicking in the side panel
  // (the page window isn't focused), so fall back to calling Ext's handler directly.
  function extFocusAndBlur(cmp, el, set) {
    let blurred = false;
    cmp.on('blur', () => { blurred = true; }, null, { single: true });
    el.focus();
    set();
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.blur();
    if (!blurred && typeof cmp.onFocusLeave === 'function') {
      cmp.onFocusLeave({ type: 'focusleave', event: new FocusEvent('blur'), target: el, relatedTarget: document.body, fromComponent: cmp, toComponent: null });
    }
    if (!blurred) cmp.fireEvent('blur', cmp, new FocusEvent('blur'));
  }

  // ExtJS pages: go through the components so the page's own change/blur handlers run (Duck
  // Creek sends each answer to the server when the field loses focus).
  // Type-ahead lists (e.g. Progressive's business type list) only hold what matches the typed
  // text: type the value, wait for the list to load, then pick.
  async function queryCombo(cmp, text) {
    if (typeof cmp.doQuery !== 'function') return null;
    cmp.doQuery(text, false, true);
    const start = Date.now();
    await sleep(200);
    if (!cmp.store) return null;
    while (cmp.store?.isLoading?.() && Date.now() - start < 6000) await sleep(100);
    return storeOptions(cmp);
  }

  // A list redrawn while it's answered may have lost its store (TX 2026-10-07): no options.
  const storeOptions = (cmp) => (cmp.store?.getRange?.() ?? []).map((rec) => ({ rec, text: oneLine(rec.get(cmp.displayField)), value: rec.get(cmp.valueField ?? cmp.displayField) }));
  const hasOptions = (options) => options.some((o) => !isPlaceholderOption(o.text));

  async function applyExt(step, c) {
    const { cmp, el } = c;
    if (c.kind === 'radio') {
      const opt = matchOption(c.options, step);
      if (!opt) return noMatch(step, c.options);
      const isOn = () => (opt.cmp ? !!opt.cmp.getValue() : opt.el.checked);
      if (!isOn()) opt.el.click();
      if (!isOn() && opt.cmp) opt.cmp.setValue(true);
      return isOn() ? { ok: true, shown: opt.text } : { ok: false, reason: "the page didn't accept the choice" };
    }
    if (cmp?.readOnly) return { ok: false, reason: 'the field is read-only — set it by hand' };
    if (c.kind === 'select') {
      let opt = matchOption(c.options, step);
      if (!opt && step.kind !== 'bool') {
        for (const q of [String(step.value), String(step.value).split(/\s+/).slice(0, 2).join(' ')]) {
          const loaded = await queryCombo(cmp, q);
          opt = loaded && matchOption(loaded, step);
          if (opt) break;
        }
      }
      // A list that fills in only after another answer (Progressive's cargo commodities, once
      // their category is picked) may still be empty: give it a few seconds to load.
      for (const start = Date.now(); !opt && !hasOptions(storeOptions(cmp)) && Date.now() - start < 6000;) {
        await sleep(250);
        opt = matchOption(storeOptions(cmp), step);
      }
      if (!opt) return noMatch(step, hasOptions(c.options) ? c.options : storeOptions(cmp));
      extFocusAndBlur(cmp, el, () => {
        cmp.setValue(opt.value);
        cmp.fireEvent('select', cmp, opt.rec);
      });
      return { ok: true, shown: cmp.getRawValue?.() || opt.text };
    }
    if (c.kind === 'checkbox') {
      if (typeof step.value !== 'boolean') return { ok: false, reason: 'checkbox needs a yes/no answer' };
      if (!!cmp.getValue() !== step.value) cmp.setValue(step.value);
      return { ok: true, shown: step.value ? 'checked' : 'unchecked' };
    }
    const text = textFor(step, c);
    if (c.el.maxLength > 0 && text.length > c.el.maxLength) return { ok: false, reason: `value is longer than the field allows (${c.el.maxLength})` };
    extFocusAndBlur(cmp, el, () => cmp.setValue(text));
    if (!el.value && !cmp.getValue()) return { ok: false, reason: 'the page cleared the value (it may need a different format)' };
    return { ok: true, shown: el.value || String(cmp.getValue()) };
  }

  // ---------------------------------------------------------------------------------------------
  // Highlighting

  function highlightTargets(c) {
    if (c.kind !== 'radio') {
      // A select2 list's own <select> is a 1-px box: the box drawn after it is what the agent sees.
      const drawn = c.el.classList?.contains('select2-hidden-accessible') ? c.el.nextElementSibling?.querySelector?.('.select2-selection') ?? null : null;
      return drawn ? [drawn, c.el] : [c.cmp?.el?.dom?.querySelector?.('.x-form-trigger-wrap') ?? c.el];
    }
    // A design-system option is drawn by its host (its own input may be drawn invisibly).
    return c.radios.map((r) => {
      const host = radioHost(r);
      if (host?.getClientRects().length) return host;
      return isVisible(r) && r.getClientRects().length ? r : r.labels?.[0] ?? r;
    });
  }

  function mark(c, status, note) {
    for (const el of highlightTargets(c)) {
      if (!el.hasAttribute(MARK)) {
        el.dataset.raPrevOutline = el.style.outline;
        el.dataset.raPrevOffset = el.style.outlineOffset;
        el.dataset.raPrevTitle = el.getAttribute('title') ?? '';
      }
      el.setAttribute(MARK, status);
      el.style.outline = `2px ${SOLID_MARKS.has(status) ? 'solid' : 'dashed'} ${COLORS[status]}`;
      el.style.outlineOffset = '1px';
      if (note) el.setAttribute('title', `Rater Autofill: ${note}`);
    }
  }

  function clear() {
    aiBanner([]);
    let n = 0;
    for (const el of deepQueryAll(document, `[${MARK}]`)) {
      el.style.outline = el.dataset.raPrevOutline ?? '';
      el.style.outlineOffset = el.dataset.raPrevOffset ?? '';
      if (el.dataset.raPrevTitle) el.setAttribute('title', el.dataset.raPrevTitle); else el.removeAttribute('title');
      for (const k of ['raPrevOutline', 'raPrevOffset', 'raPrevTitle']) delete el.dataset[k];
      el.removeAttribute(MARK);
      n++;
    }
    return n;
  }

  // Does the field already hold the answer we'd give?
  function agreesWith(step, c) {
    // The chosen suggestion rewrites the typed address in the page's own format. `checkNumber`: an
    // address the page put there itself (GEICO's, from its USDOT record) agrees only with the
    // intake's house number.
    if (step.kind === 'address-suggest') return c.kind === 'text' && hasValue(c) && (!step.checkNumber || houseNumberOf(c.el.value) === houseNumberOf(step.value));
    if (step.kind === 'search-select') return squash(selectedText(c) ?? '').includes(squash(step.value));
    if (c.kind === 'checkbox') return typeof step.value === 'boolean' && (c.cmp ? !!cmpValue(c.cmp, c.el) : c.el.checked) === step.value;
    if (step.kind === 'selected-option') return /^selected\b/i.test(selectedText(c) ?? '');
    if (c.kind === 'text') {
      if (loose(c.el.value) === loose(textFor(step, c))) return true;
      // Carriers standardize addresses to ZIP+4 (and intakes sometimes have it): 17101-1234 is
      // 17101, whichever side has the +4.
      if (/zip/i.test(step.path ?? '') && /^\d{5}(?:-?\d{4})?$/.test(String(step.value).trim())) {
        const five = (v) => String(v ?? '').replace(/\D/g, '').slice(0, 5);
        return five(c.el.value).length === 5 && five(c.el.value) === five(step.value);
      }
      if (step.kind === 'money') {
        const amount = (v) => /^\$?\s*\d[\d,]*(?:\.\d{1,2})?\s*$/.test(String(v)) ? Number(String(v).replace(/[$,\s]/g, '')) : null;
        const actual = amount(c.el.value), wanted = amount(step.value);
        return actual != null && wanted != null && actual === wanted;
      }
      return oneLine(c.el.value) === oneLine(textFor(step, c));
    }
    // A list taking several choices: the same options, in any order (read from the options picked,
    // so a text with "; " in it stays one).
    if (c.kind === 'select' && c.el.multiple) {
      const options = optionsOf(c);
      const set = (texts) => texts.map((t) => t.toLowerCase()).sort().join('\n');
      const picked = set(options.filter((o) => o.el.selected).map((o) => o.text));
      return picked !== '' && picked === set(multiValue(step.value, options));
    }
    const current = selectedText(c);
    const opt = matchOption(optionsOf(c), step);
    return !!opt && oneLine(opt.text) === oneLine(current ?? '');
  }

  // ---------------------------------------------------------------------------------------------
  // Clicking buttons (carrier "actions": Verify DOT, Lookup VIN, Add a Commodity, …)

  // Never clicked, whatever a rule says: moving on or committing is always the agent's call. So is
  // throwing away a form (GEICO's Discard Changes and its "Yes, please discard."), ordering reports
  // (MVR & CLUE) and signing (eSignature). The words are literal: \bsign\b misses "signature".
  const NEVER_CLICK = /\b(continue|next|start quote|finish|buy|bind|purchase|submit|save|delete|remove|cancel|discard|order|sign|signature|esign|esignature|e-sign|e-signature|logout|log out|sign out)\b/i;
  // Links of a step progress bar (GEICO's #progressIndicator): each opens its step, so none is a
  // helper or a Continue.
  const STEP_LINKS = '#progressIndicator';

  // Progressive names its pages in ?pageName=; other sites by path or #/route (ids normalised).
  const pageAt = (loc) => (new URLSearchParams(loc.search).get('pageName') || (loc.pathname + ((loc.hash ?? '').startsWith('#/') ? loc.hash.slice(1).split('?')[0] : '')).replace(/\/(?:[0-9a-f]{8}-[0-9a-f-]{27,}|\d{3,})(?=\/|$)/gi, '/:id')).replace(/-Reload$/, '');
  const currentPage = () => pageAt(location);

  // src/premium.js keeps a copy of this test (STALE): change both together.
  function ratesStale() {
    const text = document.body.innerText ?? '';
    // "The coverages have changed, please "recalculate" to see your rate." / "Recalculate to see
    // coverage cost" (Progressive), or a premium of ****. GEICO: "Please Recalculate Due To Coverage
    // Change", and "$ --.--" in place of the amounts.
    return /\*{4}|\$\s*--\.--|(?:must|please|need to)\W+recalculate|recalculate to see|premium.*(?:out of date|not current)|chang\w*.*recalculate/i.test(text);
  }

  function premiumReady() {
    if (pageBusy() || ratesStale()) return false;
    const text = document.body.innerText ?? '';
    // "Total premium amount $12,815.00 per year" (Progressive), "Total premium: $12,345.67". GEICO's
    // summary names each amount after it: "Quote $1,000.00 Due Today $1,000.00 Total".
    return /(?:total|annual|policy|estimated)\s+premium(?:\s+amount)?\s*:?\s*\$\s*[1-9][\d,]*(?:\.\d{2})?/i.test(text)
      || /\bquote\s+\$\s*[1-9][\d,]*\.\d{2}\s+due today\s+\$\s*[\d,]+\.\d{2}\s+total\b/i.test(text);
  }

  // A helper that rates the quote (`verify: 'premium'`) is rated once a current premium shows and,
  // with `ratedBy`, that is drawn too. GEICO's pay plans (2026-10-26, NTL, TX): after the fill's
  // Recalculate the stale-rates notice went and a total showed, but GEICO drew no coverage premiums
  // and no pay plans until the agent clicked Recalculate again; the fill took it as rated, and
  // View More Payment Plans and Print, not on the page, were never said.
  function rated(a) {
    return premiumReady() && (!a?.ratedBy || deepQueryAll(document, a.ratedBy).some((el) => el.getClientRects().length));
  }

  // The page's own "move on" button, only ever used when nothing is left for the agent. Buttons
  // that commit anything stay off limits whatever the pattern says, and so do discarding a form and
  // signing (scripts/lib/signals.mjs RESTRICTED keeps every word of this list).
  const NEVER_ADVANCE = /\b(finish|buy|bind|purchase|submit|save|delete|remove|cancel|discard|sign|signature|esign|esignature|e-sign|e-signature|logout|log out|sign out|order)\b/i;
  // What is over `el` where a click on it lands, its centre: a dialog, a message or a mask open on
  // the page, through which a script's click would still reach it. Null when a click there reaches
  // it (the element, a part of it, the words its slots show, or what it is drawn in: its shadow
  // host), or when that can't be told (no size, no layout, no point to look at). A centre off the
  // screen or under something is looked at again with the element scrolled to the middle (a button
  // below the fold, a sticky header).
  function coveredBy(el) {
    const drawnIn = (node, outer) => {
      for (let n = node; n; n = drawnParent(n)) if (n === outer) return true;
      return false;
    };
    const look = () => {
      const r = el.getBoundingClientRect?.();
      if (!r?.width || !r.height) return null;
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return 'off';
      // Inside a shadow root, that root's own view of the point (the page's is retargeted to the host).
      const root = el.getRootNode?.();
      const top = (root?.elementFromPoint ? root : document).elementFromPoint?.(x, y);
      // The kit's own AI banner is not the page's.
      return !top || drawnIn(top, el) || drawnIn(el, top) || top.closest?.(`#${BANNER_ID}`) ? null : top;
    };
    if (!look()) return null;
    // At once: a page that scrolls smoothly (Bootstrap's) would still show the place it left.
    el.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' });
    const cover = look();
    return cover === 'off' ? null : cover;
  }
  const COVERED = 'something on the page is open over Continue: close it, then fill again';
  const COVERED_HELPER = 'something on the page is open over it';

  // A button the fill presses (a helper, its menu, Continue). GEICO's submit buttons set their own
  // part of the request after an await, which its React applies in time only while an event is
  // still being dispatched: a script's click sent Recalculate without it, rated with GEICO's own
  // liability, UM, road service and cargo (W43-44, FL, 2026-10-22: 171 entries, the agent's 172).
  // Where the page's own world has src/content/page-press.js (`pressInPage`: GEICO), the press is
  // asked of it with a `rater-press` event on the button, and it clicks a moment later, inside an
  // event the browser dispatches; elsewhere, clicked here. Returns how: 'page' or 'kit'. `late`:
  // called if the page's world clicked only once its wait for that event ran out (a script's click).
  // `kit`: clicked here all the same (a helper's `kitClick`: GEICO's Print Quote Proposal, which
  // opened nothing pressed from the page's world, 2026-10-23).
  function pressButton(el, { late = null, kit = false } = {}) {
    let taken = false;
    if (!kit) {
      try { taken = !el.dispatchEvent(new CustomEvent('rater-press', { bubbles: true, composed: true, cancelable: true })); } catch { /* no CustomEvent */ }
    }
    if (!taken) {
      el.click();
      return 'kit';
    }
    if (late) el.addEventListener('rater-pressed-late', late, { once: true });
    return 'page';
  }

  // `notWithin`: never a button inside this (GEICO's chooser behind Add Vehicle or Trailer, whose
  // Next opens a unit's form: the add helpers' own, after their "+").
  function findAdvanceButton(pattern, { notWithin = null } = {}) {
    const re = new RegExp(pattern, 'i');
    let best = null;
    for (const el of deepQueryAll(document, 'a, button, [role=button], input[type=button], input[type=submit], .x-btn')) {
      if (!el.getClientRects().length || el.disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('.x-item-disabled, .x-btn-disabled, [aria-disabled="true"]') || hostDisabled(el) || el.closest(STEP_LINKS)) continue;
      if (notWithin && insideOf(el, notWithin)) continue;
      const text = buttonText(el);
      // "Save & Continue" (AmWINS) only saves the draft and opens the next step.
      const committing = NEVER_ADVANCE.test(text.replace(/^save\s*(?:&|and)\s*continue$/i, 'continue'));
      if (text.length > 40 || committing || !re.test(text)) continue;
      if (!best || best.contains(el)) best = el;
    }
    return best;
  }

  // The element itself, or the shadow host it is drawn in (a gds-button's inner <button>), inside
  // `selector`.
  const insideOf = (el, selector) => {
    for (let n = el; n; n = drawnParent(n)) if (n.matches?.(selector)) return true;
    return false;
  };

  // `disabledToo`: also a visible button the page has disabled (a link that must be gone).
  // `within`: only a button inside an element matching this selector (GEICO's add icon of one
  // list, not the incidents' below it). `moveOn` with `within`: a Next there opens a form and is no
  // step's move (GEICO's chooser behind Add Vehicle or Trailer): it may be clicked, and is checked
  // against NEVER_ADVANCE instead (never Save, Submit, Cancel, Discard…). Nowhere else.
  function findButton(step, { disabledToo = false } = {}) {
    const re = step.text ? new RegExp(step.text, 'i') : null;
    let best = null;
    // `unique`: two separate matches (two reefer tiles) leave the choice to the agent.
    const separate = [];
    // [data-testid][tabindex]: an icon the keyboard reaches that has no role (GEICO's add icons:
    // Add Driver's +). Never a Continue (findAdvanceButton).
    for (const el of deepQueryAll(document, 'a, button, [role=button], [role=link], input[type=button], input[type=submit], .x-btn, [onclick], [data-testid][tabindex]:not([tabindex="-1"])')) {
      if (!el.getClientRects().length || el.closest(STEP_LINKS)) continue;
      if (step.within && !insideOf(el, step.within)) continue;
      if (!disabledToo && (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('.x-item-disabled, .x-btn-disabled, [aria-disabled="true"]') || hostDisabled(el))) continue;
      const text = buttonText(el);
      if (step.moveOn && step.within ? NEVER_ADVANCE.test(text) : NEVER_CLICK.test(text)) continue;
      const attrs = [el.id, el.getAttribute('name'), el.getAttribute('href'), el.getAttribute('onclick'),
        ...[...el.attributes].filter((a) => a.name.startsWith('data-')).map((a) => a.value)].join(' ');
      const hit = (re && text.length <= 80 && re.test(text)) || (step.token && attrs.includes(step.token));
      if (!hit || (step.near && !isNear(el, step.near, re))) continue;
      // Prefer the innermost match (the link itself, not the table cell around it).
      if (!best || best.contains(el)) best = el;
      if (!separate.some((s) => s.contains(el) || el.contains(s))) separate.push(el);
    }
    return step.unique && separate.length > 1 ? null : best;
  }

  // For look-alike buttons ("+" next to every coverage): the button's section must mention
  // `near`, and the smallest block around it that does must hold no other such button.
  function isNear(el, near, re) {
    const want = near.toLowerCase();
    for (let p = el.parentElement, i = 0; p && i < 10; p = p.parentElement, i++) {
      if (!p.textContent.toLowerCase().includes(want)) continue;
      const alike = [...p.querySelectorAll('a, button, [role=button], .x-btn, [onclick]')].filter((b) => re && re.test(buttonText(b)));
      return alike.filter((b) => !b.contains(el) && !el.contains(b)).length === 0;
    }
    return false;
  }

  // ---------------------------------------------------------------------------------------------
  // Agent edits while answers go in

  // Why a fill stops when the agent edits the page meanwhile (the panel shows it as a blocker).
  const EDIT_HALT = 'An agent edit interrupted filling. Review before resuming.';
  // Why the AI answers after such an edit are not put in.
  const EDIT_HALT_ANSWERS = 'an agent edit interrupted applying the answers; review the page, then request fresh suggestions';
  // Why a fill stops when the agent clicks Stop in the side panel.
  const STOP_HALT = 'You stopped the fill. Nothing more was filled or clicked.';
  // Why a fill does nothing on a step that is the agent's (fill `stopSteps`: GEICO's MVR & CLUE).
  const STOP_STEP_HALT = 'This step is yours: nothing is filled or clicked here.';
  // Why a fill kept to steps does nothing on a step it can't read (stepKey ''): no rule kept to a
  // step would be live there, so every question would read as unfamiliar and the page as changed.
  const STEP_UNREAD_HALT = 'The step on screen could not be read (the progress bar and the page title disagree): fill again once the page settles.';
  // The stop steps fills in this document were given: answer() refuses on them too, even when
  // the panel's word on the step lags.
  let knownStopSteps = [];
  // The unit-form markers (`whenShown` with a `unit`: GEICO's vehicle, trailer and driver forms) of
  // the last fill in this document whose plan had any: unitFormsNow reads the forms on screen by
  // them between fills. Null until a fill gives some.
  let knownUnitMarkers = null;
  // The unit lists the panel read in this document (unitList's selectors): unitListsNow tells the
  // recorder when one is drawn.
  const knownUnitLists = [];

  // The fill running in this frame (its report and how to halt it): the side panel reads the
  // answers in so far, each as a row of its list while the fill runs, and its Stop halts it the
  // way an agent edit does (no Continue after).
  let running = null;
  // Fills the agent stopped before they began here (`run`: the panel's id for the fill; Stop can
  // come while the panel still prepares, before fill() starts): such a fill halts as it starts.
  const stoppedRuns = new Set();
  // This frame's kit and the filled lists it has sent rows of (progress).
  const FRAME = Math.random().toString(36).slice(2);
  const listIds = new WeakMap();
  let lastListId = 0;
  // `seen`: how many rows the panel has, by list (`list`: this frame's id and the filled list's
  // own, which a rewrite of the list, an answer given again, changes). Only the rows after those
  // are sent (`since`); a list the panel hasn't seen, whole.
  function progress(seen = null) {
    if (!running) return null;
    const all = running.report.filled;
    if (!listIds.has(all)) listIds.set(all, ++lastListId);
    const list = `${FRAME}:${listIds.get(all)}`;
    const had = Number(seen?.[list]) || 0;
    const since = had > 0 && had <= all.length ? had : 0;
    const rows = all.slice(since).map((x) => ({ key: x.key ?? null, label: x.label || x.name || '', shown: x.shown ?? '', standard: !!x.standard,
      stepId: x.stepId ?? null, path: x.path ?? null, otherStep: !!x.otherStep }));
    return { frame: FRAME, list, filled: all.length, since, rows, phase: running.phase ?? null };
  }
  function stop(run = null) {
    if (run != null && (!running || running.run !== run)) stoppedRuns.add(run);
    if (!running) return false;
    running.halt(STOP_HALT);
    return true;
  }

  // The recorder is paused while the kit puts answers in (a fill, an AI apply), so a real edit by
  // the agent has to be caught here: a trusted input/change within 2 s of a trusted gesture (a
  // click, a key, a paste, a drop) on that same control, on a question of the page, gives that
  // question's key and control to `onEdit`. The gesture must be on the control because the kit's
  // own click on a radio or checkbox fires trusted input/change too: an agent click elsewhere
  // just before it is not an edit of that question. On the control means its target is the
  // control, a radio of its group (arrow keys move the pick), its label (label[for] or a wrapping
  // label; for a radio, the label of any radio in its group), inside its ExtJS trigger wrap, or an
  // element holding no other control than it (or its radio group). Returns the function that
  // takes the listeners off again.
  function guardEdits(onEdit) {
    let lastGesture = -Infinity;
    let gestureTarget = null;
    let gestureControl = null;
    // ExtJS draws its options outside the combo. Resolve ownership at pointerdown, while the
    // combo still owns focus; the carrier can move focus before its input/change event.
    const popupControl = (target) => {
      const option = target?.closest?.('[role=option], .x-boundlist-item');
      const popup = option?.closest?.('[role=listbox], .x-boundlist');
      if (!popup) return null;
      const isControl = (el) => /^(INPUT|SELECT|TEXTAREA)$/.test(el?.tagName ?? '');
      if (popup.id) {
        for (const owner of deepQueryAll(document, 'input, select, textarea, [role=combobox]')) {
          const refs = `${owner.getAttribute('aria-owns') ?? ''} ${owner.getAttribute('aria-controls') ?? ''}`.split(/\s+/);
          if (!refs.includes(popup.id)) continue;
          const control = isControl(owner) ? owner : owner.querySelector('input, select, textarea');
          if (isControl(control)) return control;
        }
      }
      return isControl(document.activeElement) ? document.activeElement : null;
    };
    const gestureTypes = ['pointerdown', 'keydown', 'paste', 'drop'];
    // The element itself, not its shadow host: at the document, an event from inside a shadow root
    // names the host (a GEICO radio's <gds-radio-button>, not its input).
    const realTarget = (event) => event.composedPath?.()[0] ?? event.target ?? null;
    const trackGesture = (event) => {
      if (!event.isTrusted) return;
      lastGesture = Date.now();
      gestureTarget = realTarget(event);
      gestureControl = popupControl(gestureTarget);
    };
    const sameGroup = (a, b) => a === b || (!!a && !!b && a.type === 'radio' && b.type === 'radio'
      && !!a.name && a.name === b.name && (a.form ?? null) === (b.form ?? null));
    const gestureOn = (el) => {
      const target = gestureTarget;
      if (!target || !el) return false;
      if (sameGroup(target, el) || sameGroup(gestureControl, el)) return true;
      // On a design-system option (radioHost): its host, its [slot=label] words, or anything in its
      // shadow root, is on that option's radio and its group.
      for (let n = target, i = 0; n && i < 8; n = n.parentElement ?? n.getRootNode?.()?.host ?? null, i++) {
        const input = n.shadowRoot?.querySelector?.('input[type=radio]');
        if (input && radioHost(input) === n) return sameGroup(input, el);
      }
      const label = target.closest?.('label');
      if (label) {
        const forId = label.htmlFor || label.getAttribute?.('for');
        const linked = label.control ?? (forId ? document.getElementById(forId) : null)
          ?? label.querySelector?.('input, select, textarea');
        if (sameGroup(linked, el)) return true;
      }
      if (target.closest?.('.x-form-trigger-wrap')?.contains?.(el)) return true;
      if (target === document.body || target === document.documentElement || !target.contains?.(el)) return false;
      return [...(target.querySelectorAll?.('input, select, textarea') ?? [])].every((x) => sameGroup(x, el));
    };
    const protectEdit = (event) => {
      const target = realTarget(event);
      if (!event.isTrusted || Date.now() - lastGesture > 2000 || !gestureOn(target)) return;
      const c = collectControls().find((x) => x.el === target || x.radios?.includes(target));
      if (c) onEdit(fieldKey(c), c);
    };
    for (const type of gestureTypes) document.addEventListener(type, trackGesture, true);
    document.addEventListener('input', protectEdit, true);
    document.addEventListener('change', protectEdit, true);
    return () => {
      for (const type of gestureTypes) document.removeEventListener(type, trackGesture, true);
      document.removeEventListener('input', protectEdit, true);
      document.removeEventListener('change', protectEdit, true);
    };
  }

  // The panel installs this guard in every frame for the whole AI apply, including frames
  // whose answers are still to come or have already finished. Short answer() calls must not
  // remove another frame's protection while the active frame is waiting for its server.
  let answerEditSession = null;
  function answerEdits(command = 'read', token) {
    if (command === 'begin') {
      answerEditSession?.release();
      const questions = new Map();
      const release = guardEdits((key, c) => questions.set(key, c.label ?? null));
      answerEditSession = { questions, release, token };
    }
    if (!answerEditSession || answerEditSession.token !== token) return null;
    const results = [...(answerEditSession?.questions ?? [])].map(([key, label]) => ({ key, label,
      ok: false, protected: true, reason: 'you changed this question yourself while the AI answers went in; your answer stays' }));
    if (command === 'end') {
      answerEditSession?.release();
      answerEditSession = null;
    }
    return results;
  }

  // ---------------------------------------------------------------------------------------------
  // Public API

  // Fills in rounds: each round re-reads the page, handles every step that now has a field, and
  // on pages that talk to their server after each answer (ExtJS/Duck Creek) stops after one
  // answer and waits. New questions that appear because of an answer get picked up next round.
  // `skip`: field keys to leave alone (ones the agent changed; used by automatic follow-up fills).
  // `doneActions`: button actions already clicked earlier in this quote.
  // `replaceChoices`: a dropdown/radio/checkbox answer the page pre-selected (not the agent) is
  // replaced when it differs from ours; agent changes are protected by `skip`.
  // `visitedPages`: pages already seen in this quote (for actions that wait on a page).
  // `advance`: { text, exceptPages, steps, notWithin, byForm, quietMs } — when the page ends with nothing for
  // the agent to look at (no unfamiliar required fields, nothing missing, nothing failed), click its
  // Continue button. `steps`: on a one-address application, only on these steps (GEICO's, up to
  // Additional Business Info). `notWithin`: no button inside this. `byForm`: a step that shows
  // several forms and lists in turn (GEICO's Vehicles: each unit's form, then the list) is continued
  // per form and button, not once a step: `report.advanceKey` is the step, the button's words and the
  // unit form on screen ("Vehicles@next@Id_YesNoPreQuoteHaveFullVinActivity_63452"), which
  // `doneSteps` then holds. `quietMs`: on a page that isn't ExtJS, the page is quiet this long
  // before Continue: a fill that gave answers waits for that before it ends (on `steps`) and answers
  // what the page drew meanwhile, and a question drawn after that without an answer holds Continue.
  // `batch`: for pages whose answers never wait on a server (AmWINS): every answer the round can
  // see is given in one pass and checked on the spot, with one wait for the page per round
  // instead of one per answer. What an answer reveals or redraws is picked up next round, and
  // anything the page changes later is given again (see `refill`).
  // `doneSteps`: steps of a one-address application (stepKey) already continued from: a step the
  // agent goes back to is theirs, never continued again.
  // `stopPages`: pages where the carrier has stopped the quote: nothing is filled or clicked there.
  // `stopSteps`: steps of a one-address application that are the agent's (GEICO's MVR & CLUE), by
  // name: the same, read from the page as the fill starts and again every round (the agent's Next
  // changes the step without a new address).
  // `units`: { active, count, bound } per list (vehicles, drivers, trailers): the unit the plan is
  // for, how many the intake lists, and the unit forms earlier fills answered each unit on (form id
  // -> index). A form that may be another unit's is held (report.unitHeld); one the plan gives an
  // answer for is report.unitForm, for the panel to bind to the active unit.
  // `skipBy` (form-scoped carriers: GEICO): the agent's edits by where they were made, { steps:
  // { step: keys }, units: { list: keys } (the active units'), forms: { form id: keys }, stepUnits:
  // { step: list } }. Each round skips, besides `skip`, those of the step and forms on screen
  // (skipWhere).
  // A plan kept to steps on a page whose step bar can't be read (stepKey '') does nothing there and
  // reads nothing for its report (STEP_UNREAD_HALT, report.stepUnread).
  // `takenBack` ({ steps, keys }: GEICO's Quote & Coverages): on those steps, a choice whose field
  // key an earlier fill on this tab answered (keys) and that the page now shows otherwise was taken
  // back by the page (GEICO puts its own coverage back when the agent backs out of a requote): kept
  // and flagged, never given again, unless the agent asks to replace answers (`overwrite`).
  // `hold` (the panel's "Check answers before Continue"): Continue is clicked only when `confirmed`
  // is the page's `receipt()` as the agent approved it (Looks right) and still is; otherwise the
  // report says `held`: 'check' (not approved yet) or 'changed' (the page changed since).
  // A step with `waitFor` (a data-model name: GEICO's decoded year on a vehicle with a VIN) isn't
  // answered while that question isn't drawn yet or is on the page without an answer: the page is
  // still working it out, and its answer redraws the form (FL live run 2, 2026-10-21: the VIN decode
  // cleared the vehicle type, distance and personal use the fill had just given; FL live run 3: GEICO
  // draws the year only when its decode comes back, after them). It waits at most WAIT_MS, a round
  // every WAIT_ROUND_MS, then is answered as before; a question waited out so is not waited for
  // again. One that came in while the step waited is followed by AFTER_WAIT_QUIET_MS without a change
  // on the page, then read again. A fill such a step was on the page for takes one more look at the
  // end, once the page has gone quiet: an answer it gave that the page has cleared since is given
  // again.
  // A fill on a page with a step progress bar ends when the step on screen changes (stepKey): the
  // rest of its plan is that step's, and the new step gets a fill of its own.
  /**
   * @param {PlanStep[]} plan
   * @param {FillOptions} [options]
   * @returns {Promise<FillReport>}
   */
  async function fill(plan, { overwrite = false, maxRounds = 60, skip = [], keepMarks = false, doneActions = [], replaceChoices = false, visitedPages = [], advance = null, batch = false, doneSteps = [], stopPages = [], stopSteps = [], units = null, skipBy = null, takenBack = null, hold = false, confirmed = null, run = null, loadResultMs = LOAD_RESULT_MS, filledBefore = [], expectPage = null, components = null, formUnit = null, givenBefore = {} } = {}) {
    // The agent's edits: `skipKeys` apply everywhere (`skip`, and those this fill protected itself),
    // `scopedKeys` are those of `skipBy` that apply where the kit is now, read again every round
    // (skipWhere).
    const skipKeys = new Set(skip);
    const scopedKeys = new Set();
    const skipped = (key) => skipKeys.has(key) || scopedKeys.has(key);
    // An agent edit protects its field. A plain name saved by an older build (field-key v2)
    // protects every row key made from it (name#<row>): it could have been any row's edit.
    const skippedKey = (key) => skipped(key) || skipped(globalThis.__raterFieldKey.rowKeyBase?.(key));
    // A field the agent edited, by its key, or by the question id an older build kept it under
    // (version 3) in a quote begun before this one: left alone rather than overwritten.
    const skippedField = (c) => skippedKey(fieldKey(c)) || skipped(globalThis.__raterFieldKey.legacyKey?.(c.el, { q: c.q }));
    // Such a question id can't be tied to its question for certain: saved before a renumbering,
    // it now belongs to another question, and the corrected one has a new number. While one is
    // kept, no answer already on a Duck Creek field is replaced, so whichever field the agent
    // corrected keeps their answer (Codex on PR #43).
    const legacyEdits = skip.some((k) => /^[0-9A-F]+(?:@\d+)?$/.test(String(k)));
    const mayHoldLegacyEdit = (c) => legacyEdits && c.q != null && hasValue(c);
    // The edits (`skipBy`) that apply where the kit is now: `scopedKeys`, set anew each round and for
    // the final reads, so a form drawn partway through the fill has its own, never the previous
    // form's. GEICO asks one data-model name on several steps and forms (the owner's GiveLastName
    // and each driver's; a vehicle's GiveYear and a trailer's), so an edit protects its field only
    // on its own step, unit or form. On a unit step: the active unit's edits on a form that isn't
    // held, and every form's own; a held form gets only its own, so its check is gone only once the
    // agent dismissed or answered that form's. No form on screen (GEICO's owner check under Vehicles
    // asks Business & Owner Info's questions again, and little else): every step's edits, never a
    // unit's (the owner's own driver form asks Add Driver's license state, CDL and SR-22).
    const skipNames = skipBy ? [...Object.keys(skipBy.stepUnits ?? {}), ...Object.keys(skipBy.steps ?? {})] : [];
    const skipWhere = (units) => {
      scopedKeys.clear();
      const key = stepKey();
      const name = skipNames.find((n) => stepIs([n], key));
      if (!name) return;
      const add = (keys) => { for (const k of [].concat(keys ?? [])) scopedKeys.add(k); };
      const list = Object.hasOwn(skipBy.stepUnits ?? {}, name) ? skipBy.stepUnits[name] : null;
      if (!list) return add(skipBy.steps?.[name]);
      if (!units?.length) {
        for (const keys of Object.values(skipBy.steps ?? {})) add(keys);
        return;
      }
      for (const u of units) {
        if (!u.held) add(skipBy.units?.[u.list]);
        add(skipBy.forms?.[u.id]);
      }
    };
    const actions = plan.filter((s) => s.kind === 'action');
    plan = plan.filter((s) => s.kind !== 'action');
    const clicked = new Set(doneActions);
    const openersTried = new Set();
    const nudged = new Set();
    // Answers the page changed or cleared after we gave them (a lookup redrawing its boxes, a
    // panel re-rendering), or didn't keep the first time: given again, at most twice each.
    const retries = new Map();
    const refill = new Set();
    // Helpers whose result never showed after their tries this fill: the agent's, not clicked again.
    const exhausted = new Set();
    // A lookup box its helper has already used (the VIN list Import Data empties) isn't given again.
    const immediateAfter = new Set(actions.filter((a) => a.immediate).flatMap((a) => a.after));
    hiddenOk = plan.filter((s) => s.hidden && s.selector).map((s) => s.selector);
    const consumedPaths = () => new Set(actions.filter((a) => clicked.has(a.action)).flatMap((a) => a.after));
    // Choices whose option isn't offered yet (`whenOffered`), by step id.
    const unoffered = new Map();
    // Options picked in place of one never offered (`orMost`), by step id: what the report says.
    const substituted = new Map();
    const retryOnce = (id) => { const n = retries.get(id) ?? 0; if (n >= 2) return false; retries.set(id, n + 1); return true; };
    // Steps waiting for the page (`waitFor`): since when, by step id.
    const waitingSince = new Map();
    const mayWait = (id) => {
      if (!waitingSince.has(id)) waitingSince.set(id, Date.now());
      return Date.now() - waitingSince.get(id) < WAIT_MS;
    };
    // Steps done waiting this fill (what they waited for came in, or the wait ran out).
    const waitOver = new Set();
    // A step that waits on the page (`waitFor`) was on it this fill, and the last look (see `waitFor`
    // above) once taken.
    let waitShown = false;
    let lastLook = false;
    // Where Continue waits for a quiet page (`advance.quietMs`: GEICO), a fill that gave answers waits
    // for it before it ends and answers what the page drew meanwhile (the end of a round): `quietDue`,
    // an answer was given since the last such wait; `quietSig`, the questions on screen once the page
    // was quiet then.
    let quietDue = false;
    let quietSig = null;
    // Server requests the page sends (ExtJS pages), counted for the per-answer timing.
    let ajaxCount = 0;
    const countAjax = () => { ajaxCount++; };
    try { ext()?.Ajax?.on?.('beforerequest', countAjax); } catch { /* no ExtJS events */ }
    const visited = new Set(visitedPages);
    const startPage = currentPage();
    // The plan has questions for this page (a field rule for it, not only helpers): while it shows no
    // field it is still drawing, and its helpers wait for one (W44-03), except a tile pick
    // (`onBlankPage`: Most Common Vehicles, which may draw only its tiles).
    const expectsQuestions = plan.some((s) => s.kind !== 'action' && s.pages?.includes(startPage));
    const handled = new Map(); // step id -> { status, note }
    /** @type {FillReport} */
    const report = { frame: location.origin + location.pathname, fields: 0, filled: [], noData: [], kept: [], failed: [], leftRequired: [], actions: [], unknown: [], blocked: [], protectedKeys: [], invalidatedActions: [], checks: [], reworded: [], renamed: [], halted: false, rounds: 0, unitForm: null, unitHeld: null, stepUnread: false };
    // The page the panel asked to fill (`expectPage`, as it reads the tab's address): the top frame
    // shows another one now (the agent or the carrier moved on while the panel prepared), so nothing
    // is filled, marked or clicked here (`pageMoved`, the page found). A frame inside the page reads
    // the top's address when it may (the same origin); one that can't (another origin's: a chat
    // window) goes on, as the panel checked just before.
    let topPage = null;
    try { topPage = window === window.top ? startPage : pageAt(window.top.location); } catch { /* another origin */ }
    if (expectPage != null && topPage != null && topPage !== expectPage) {
      try { ext()?.Ajax?.un?.('beforerequest', countAjax); } catch { /* no ExtJS events */ }
      report.pageMoved = topPage;
      return report;
    }
    componentPrefix = components;
    if (window === window.top) watchRequests();
    if (!keepMarks) clear();
    stopSteps = [].concat(stopSteps ?? []);
    if (stopSteps.length) knownStopSteps = [...new Set([...knownStopSteps, ...stopSteps])];
    // Its unit forms' markers, by which unitFormsNow tells the forms on screen between fills.
    const markers = [...new Map(plan.filter((s) => s.whenShown?.unit).map((s) => [JSON.stringify(s.whenShown), s.whenShown])).values()];
    if (markers.length) knownUnitMarkers = markers;
    if (stopPages.includes(startPage)) {
      report.halted = true;
      report.reason = 'The carrier stopped this quote on this page: nothing is filled or clicked here.';
      report.stepKey = stepKey();
      return report;
    }
    // A step that is the agent's, as the fill starts (also at every round, below).
    const stopAt = stopStepOn(stopSteps);
    if (stopAt) {
      report.halted = true;
      report.reason = STOP_STEP_HALT;
      report.stopStep = stopAt;
      report.stepKey = stepKey();
      return report;
    }
    const serverBacked = !!ext();
    let pendingAction = null;
    // A helper that loads a view, due but not clicked until the page has been quiet (`loadDue`), and
    // the page it was quiet on (`quiet`: its action and signature).
    let loadDue = null;
    let quiet = null;
    let progressed = false; // did the last round fill or click anything, or wait for what an answer draws?
    // The questions the last round read (in document order): where the items are on the page
    // when a helper has opened the next page by the end of the fill.
    let roundControls = [];
    const halt = (reason) => { report.halted = true; report.reason = reason; };
    // Answers this fill gave that their field no longer shows (a later server response rewrote or
    // cleared them), each with its question as `pairs` read it. A field the agent edited, and a
    // lookup box its helper has used, don't count.
    // Field keys this tab's fills answered before (`filledBefore`), and whether this fill has waited
    // for a quiet page before giving one the page reset again.
    const filledKeys = new Set(filledBefore);
    let resetWaited = false;
    const changedSinceFilled = (pairs) => {
      const consumed = consumedPaths();
      return report.filled.flatMap((previous) => {
        const pair = pairs.find(({ step }) => step.id === previous.stepId);
        return !pair || skippedField(pair.control) || agreesWith(pair.step, pair.control) || consumed.has(pair.step.path) ? [] : [{ previous, pair }];
      });
    };
    // `phase`: what the fill is doing between answers, for the panel's live list and dock (progress):
    // null while it answers, else { name, what }: 'reading' the page as it begins, 'waiting' for the
    // page after an answer, a 'helper' it clicked (`what`: the button), the 'premium' it rates, or
    // 'continue'. Said so a fill waiting on GEICO's Recalculate doesn't read as stuck (2026-10-23).
    const thisFill = { report, halt, run, phase: null };
    const phase = (name, what = null) => { thisFill.phase = name ? { name, what } : null; };
    running = thisFill;
    // Stopped by the agent before it began (the panel was still preparing): nothing is done.
    if (run != null && stoppedRuns.delete(run)) halt(STOP_HALT);
    phase('reading');
    const settled = await settle({ quietMs: 400, maxMs: 15000 });
    phase(null);
    // Stopped while the page settled: nothing was done.
    if (!settled || report.halted) {
      if (!settled) halt('The page is still waiting on its server. Review and retry.');
      report.stepKey = stepKey();
      if (running === thisFill) running = null;
      return report;
    }
    // The step on screen as the fill begins, on a page with a step progress bar (null elsewhere:
    // AmWINS' headings change with its dialogs). Read once the page has settled.
    const startStep = stepBars().length ? stepKey() : null;
    const stepChanged = () => startStep !== null && stepKey() !== startStep;
    // A stop step the fill found on screen after it started: it does nothing more, and reads nothing
    // there for its report.
    let stoppedAt = '';
    // A plan kept to steps on a page whose step bar can't be read (STEP_UNREAD_HALT): the same.
    const steppedPlan = plan.some((s) => s.steps?.length);
    let unreadStep = false;
    // A real user edit during a fill must survive even while the recorder is paused: its field is
    // protected (also from this fill's later rounds) and the fill stops. The guard stays on until
    // the fill returns, so an edit during the wait before Continue stops that too.
    const releaseEditGuard = guardEdits((key) => {
      skipKeys.add(key);
      if (!report.protectedKeys.includes(key)) report.protectedKeys.push(key);
      halt(EDIT_HALT);
    });
    // A button the agent clicks during the fill (Next, "+", Looks Good) moves the page on their
    // click: this fill clicks no Continue and no helper after it (FL live run 4, 2026-10-21: the
    // agent's Next, then a fill's, while GEICO still worked on the first).
    let agentPressed = false;
    const notePress = (event) => {
      if (!event.isTrusted) return;
      const path = event.composedPath?.() ?? [event.target];
      if (path.some((n) => n?.nodeType === 1 && safeMatches(n, AGENT_PRESS) && !n.hasAttribute('aria-expanded'))) agentPressed = true;
    };
    document.addEventListener('click', notePress, true);
    // Whether the registered names a USDOT lookup offers (Progressive's Business Name choice) are
    // on the page and none, or several, is the intake's: the identity is then the agent's.
    const IDENTITY_NOTE = 'The DOT lookup business name differs from the intake. Verify the identity before accepting it.';
    const identityDiffers = (step, controls) => {
      if (!step.businessNames?.length) return false;
      const registered = assign(controls, plan).find((p) => p.step.registeredName)?.control;
      const names = uniqueBusinessNames(registered ? optionsOf(registered).filter((o) => o.text.trim() && !/^enter a different/i.test(o.text)) : []);
      const matches = names.filter((o) => step.businessNames.some((name) => businessNameKey(o.text) === businessNameKey(name)));
      return names.length > 0 && matches.length !== 1;
    };
    // A registered name shown only after this fill answered (Progressive shows it right after
    // "belongs to the business" Yes): that answer is the agent's to verify too, as if the name had
    // been there first. It stays on the page, and Continue waits. A field the agent edited since is
    // theirs already. Returns the items it moved, each with its field.
    const identityAfterAnswer = (pairs, controls) => {
      const moved = [];
      for (const { step, control } of pairs) {
        const previous = report.filled.find((x) => x.stepId === step.id);
        if (!previous || step.registeredName || skippedField(control) || !identityDiffers(step, controls)) continue;
        report.filled = report.filled.filter((x) => x !== previous);
        report.checks = report.checks.filter((x) => x.stepId !== step.id);
        const item = { ...previous, note: IDENTITY_NOTE, reviewOnly: true, ...describe(control) };
        report.noData.push(item);
        handled.set(step.id, { status: 'needs', note: IDENTITY_NOTE });
        moved.push({ item, control });
      }
      return moved;
    };
    try {
    // This fill's units (see unitFormsOf); a form it answers a unit on is that unit's for the rest
    // of the fill too.
    fillUnits = {
      active: { ...units?.active }, count: { ...units?.count },
      bound: Object.fromEntries(Object.entries(units?.bound ?? {}).map(([list, forms]) => [list, { ...forms }])),
    };
    // The lists whose forms the plan gives an answer: only such a form is bound to the active unit.
    // GEICO's Add Driver while the panel's driver is the owner (whom GEICO already lists) is all
    // notes: bound to the owner, it would be held as the owner's once the agent picks its driver.
    const answeredLists = new Set(plan.filter((s) => s.whenShown?.unit && s.value != null && s.value !== '').map((s) => s.whenShown.unit));

    for (let round = 0; round < maxRounds; round++) {
      report.rounds = round + 1;
      phase(null);
      // The agent's Next changes the step without a new address: on a step that is the agent's the
      // fill does nothing more, and another step is left to a fill of its own.
      stoppedAt = stopStepOn(stopSteps);
      if (stoppedAt) { report.stopStep = stoppedAt; if (!report.halted) halt(STOP_STEP_HALT); break; }
      if (stepChanged()) break;
      // The page moved on under the fill (the agent's Continue: Progressive draws the next page at
      // the same document): this fill's page is gone, and the next page gets a fill of its own. The
      // fill had read Rates as its next round and clicked Print, Email, Fax as the agent did (live
      // recording, 2026-10-23).
      if (currentPage() !== startPage) { report.navigatedTo = currentPage(); break; }
      // The step can't be read, and the fill began there (a step it began on that turns unreadable
      // is the agent's Next mid-redraw: the step changed, above). Nothing is done or read here.
      if (steppedPlan && stepBars().length && stepKey() === '') {
        unreadStep = true;
        // Only this halt: the panel tries an automatic fill once more rather than pausing them all.
        if (!report.halted) { halt(STEP_UNREAD_HALT); report.stepUnread = true; }
        break;
      }
      // A form that names its unit for another one than the plan's: nothing is filled (W43-37).
      if (formUnit) {
        const named = unitNamedNow();
        if (named) report.unitNamed = { list: formUnit.list, index: named.index };
        if (named && named.index !== formUnit.active) {
          halt(`This form is for ${named.name || 'someone else'}, not ${formUnit.label}: nothing was filled. ${named.index == null
            ? 'The intake has no driver by that name: fill the form yourself.' : `Pick ${named.name} in the panel, then fill again.`}`);
          report.unitMismatch = true;
          break;
        }
      }
      const controls = collectControls();
      roundControls = controls;
      report.fields = Math.max(report.fields, controls.length);
      if (report.halted) break;
      const allPairs = assign(controls, plan);
      // The agent's edits made where the kit is now, before anything asks whether a field is theirs.
      if (skipBy) skipWhere(allPairs.units);
      // Review items are flagged in yellow and the rest of the page still fills. Only a stuck
      // page or an agent edit stops the fill.
      const mapped = new Set(allPairs.map((p) => p.control));
      // Rows of one repeated question share a key; their labels (the vehicle) tell them apart.
      const flag = (list, item) => { if (!list.some((x) => x.key === item.key && x.label === item.label)) list.push(item); };
      // The unit forms on screen (assign): one the plan answers for the active unit is that unit's,
      // for the panel (report.unitForm) and for the rest of this fill; one that may be another unit's
      // is held, as one check for the agent, named by its place in the intake's list. Marked done in
      // the panel (its first question is then the agent's), the form stays held, without the check;
      // with `skipBy` only an edit filed under that form counts, never one of the active unit's.
      for (const u of allPairs.units) {
        if (u.held) {
          report.unitHeld = { list: u.list, id: u.id };
          if (!skippedField(u.marker)) flag(report.checks, { label: u.marker.label, path: null, name: `${unitNoun(u.list)} ${Number(u.active) + 1}`, key: fieldKey(u.marker), q: null, controlKind: null, note: heldFormNote(u) });
        } else if (answeredLists.has(u.list)) {
          report.unitForm = { list: u.list, id: u.id };
          (fillUnits.bound[u.list] ??= {})[u.id] = u.active;
        }
      }
      // Known questions whose wording changed (answered, and flagged when answered), and fields that
      // read like a known question whose data-model name isn't on the page (left for the agent).
      for (const p of allPairs.filter((x) => x.reworded)) flag(report.reworded, { label: p.control.label, key: fieldKey(p.control), name: p.step.name, field: p.step.field });
      const renamed = new Map(allPairs.renamed.map((r) => [r.control, r.step]));
      for (const [c, step] of renamed) flag(report.renamed, { label: c.label, key: fieldKey(c), name: step.name, field: step.field, now: c.ref ?? null });
      for (const c of controls) {
        // A row a witness step chooses among is a known question (its unit is named instead), and
        // so is a held unit form's (the form is named instead).
        if (mapped.has(c) || skippedField(c) || allPairs.witnessed.has(c) || allPairs.held.has(c)) continue;
        flag(report.unknown, { label: c.label, key: fieldKey(c), q: c.q, ref: c.ref ?? null, controlKind: c.kind, required: c.required, ...describe(c) });
        mark(c, 'needs', renamed.has(c) ? `Looks like "${renamed.get(c).name}", but the carrier renamed this field: left for you.` : 'Unfamiliar question — left for you.');
      }
      for (const c of controls) {
        if (!mapped.has(c) || skippedField(c) || !hasValue(c) || !invalidControl(c)) continue;
        // An answer the page invalidated after another one changed (Progressive's liability limit
        // after a PIP change) is picked again, at most twice; then it's the agent's. Never one the
        // identity check left to the agent, nor a `keepChoice` answer this fill didn't give (a
        // person's): those stay as they are, flagged.
        const own = allPairs.find((p) => p.control === c)?.step;
        const ours = !!own && handled.get(own.id)?.note !== IDENTITY_NOTE
          && (!own.keepChoice || refill.has(own.id) || report.filled.some((x) => x.stepId === own.id));
        if (ours && own.value != null && !own.ignore && !own.note && !own.verifyOnly && retryOnce(own.id)) {
          report.failed = report.failed.filter((x) => x.key !== fieldKey(c));
          handled.delete(own.id);
          refill.add(own.id);
          continue;
        }
        flag(report.failed, { label: c.label, key: fieldKey(c), q: c.q, controlKind: c.kind, reason: 'The page marks this answer invalid.', ...describe(c) });
        mark(c, 'failed', 'the page marks this answer invalid');
      }
      for (const { step, control } of allPairs) {
        if (skippedField(control) || !hasValue(control)) continue;
        if (step.verifyOnly && !agreesWith(step, control)) {
          flag(report.failed, { label: control.label, key: fieldKey(control), q: control.q, reason: 'The looked-up value differs from the intake. Check the VIN.' });
          mark(control, 'failed', 'lookup result differs from the intake');
        } else if (!step.verifyOnly && !step.ignore && !step.note && !step.replace && !step.trustPage && step.value != null && control.kind === 'text' && !overwrite && !agreesWith(step, control) && !handled.has(step.id) && !refill.has(step.id) && !givenForOtherUnit(step, control)) {
          // The page already had a different value (e.g. from the USDOT lookup): keep it, show it.
          // Not what a fill gave for another unit (W43-38): that is replaced below.
          flag(report.kept, { label: control.label, key: fieldKey(control), q: control.q, path: step.path, name: step.name, differs: true });
          mark(control, 'needs', `page says something different from the intake (${step.name})`);
          handled.set(step.id, { status: 'needs', note: `page value differs from the intake: ${step.name}` });
        }
      }
      for (const { previous, pair } of changedSinceFilled(allPairs)) {
        if (retryOnce(pair.step.id)) {
          report.filled = report.filled.filter((x) => x !== previous);
          handled.delete(pair.step.id);
          refill.add(pair.step.id);
          continue;
        }
        if (hasValue(pair.control)) {
          report.failed.push({ ...previous, reason: 'A later server response changed this answer; check it.' });
          report.filled = report.filled.filter((x) => x !== previous);
          handled.set(pair.step.id, { status: 'failed', note: 'a later server response changed this answer' });
        }
      }
      identityAfterAnswer(allPairs, controls);
      if (report.halted) break;
      // Buttons that must come right after their field (Verify DOT, Lookup VIN) go first.
      if (window === window.top && clickNextAction(controls, true)) {
        // A lookup (Import Data) may wait on its server without changing the page for a while.
        phase('helper', pendingAction?.label ?? report.actions.at(-1)?.text ?? null);
        if (!await settle(serverBacked ? {} : { quietMs: 800, maxMs: 8000 })) { halt('The helper response did not settle. Review before retrying.'); break; }
        if (!await verifyAction()) break;
        if (currentPage() !== startPage) { report.navigatedTo = currentPage(); break; }
        if (stepChanged()) break;
        continue;
      }
      const pairs = assign(controls, plan).filter(({ step, control }) => !handled.has(step.id) && !skippedField(control));
      // Answers given one at a time go down the page, as the agent works it: what an answer draws
      // under its question comes before the questions further down. In rule order a fill went up and
      // down the page (GEICO mock, Business & Owner Info: the business name, 14th of 16, first, then
      // the owner's name at the top). A batch round keeps the rules' order: its answers land
      // together, and AmWINS' driver names and license number come before gender, marital status
      // and the license year, which sit between them on the page.
      if (!batch) {
        const place = new Map(controls.map((c, i) => [c, i]));
        pairs.sort((a, b) => place.get(a.control) - place.get(b.control));
      }
      let changed = false;
      // A failed answer may still have redrawn the page (new questions): look again next round.
      let retry = false;
      // A step waited for the page this round (`waitFor`).
      let waited = false;
      // Another step on screen since the round began (the agent clicked Next): this round's
      // questions are that step's no longer, and nothing more is given or clicked for them.
      let stepMoved = false;
      for (const { step: planned, control: c, how, reworded } of pairs) {
        if (stepChanged() || stopStepOn(stopSteps)) { stepMoved = true; break; }
        // A known field whose question reads differently now: answered, and the agent checks it.
        const step = reworded ? { ...planned, warn: [planned.warn, `The carrier's wording of this question changed (it read "${[].concat(planned.ask ?? [])[0] ?? planned.re}"): check the answer.`].filter(Boolean).join(' ') } : planned;
        const item = { stepId: step.id, label: c.label, path: step.path, name: step.name, key: fieldKey(c), q: c.q ?? null, controlKind: c.kind, how, standard: !!step.standard, manualOnly: !!step.manualOnly,
          // Where its answer comes from (plan.js `source`) and whether review mode asks the agent to
          // confirm it, for the usage log (a TNI standard or an intake fact; a check item or not).
          source: step.source ?? null, review: !!step.reviewRequired,
          // A field another step of a one-address application holds (AmWINS keeps every step's
          // section in the page, hidden): filled again here, but not this step's question.
          ...(step.hidden && otherStep(c.el) ? { otherStep: true } : {}) };
        // A question left as the page has it whose wording changed: what the page has may not fit
        // any more, so the agent checks it (Continue waits).
        const leftAlone = step.verifyOnly || step.ignore;
        if (leftAlone && reworded) {
          const note = `The carrier's wording of this question changed (it read "${[].concat(planned.ask ?? [])[0] ?? planned.re}"): check what the page has.`;
          if (step.verifyOnly) report.kept.push(item);
          report.checks.push({ ...item, note, ...describe(c) });
          handled.set(step.id, { status: 'needs', note });
          continue;
        }
        if (step.verifyOnly) { report.kept.push(item); handled.set(step.id, { status: null }); continue; }
        if (step.ignore || (!hasValue(c) && consumedPaths().has(step.path))) { handled.set(step.id, { status: null }); continue; }
        if (identityDiffers(step, controls)) {
          report.noData.push({ ...item, note: IDENTITY_NOTE, reviewOnly: true, ...describe(c) });
          handled.set(step.id, { status: 'needs', note: IDENTITY_NOTE });
          continue;
        }
        // Answered only when the question's own text shows each of these intake words (`labelHas`:
        // GEICO's USDOT record, Yes when it shows the intake's street and ZIP: W43-24); otherwise
        // the agent's, with `labelNote`. The legend is read with its lines apart (W43-46).
        if (step.labelHas?.length && step.value != null && !step.note) {
          const text = ` ${squash(`${c.label ?? ''} ${c.text ?? ''} ${legendWords(c.radios)}`)} `;
          if (!step.labelHas.every((w) => squash(w) && text.includes(` ${squash(w)} `))) {
            report.noData.push({ ...item, note: step.labelNote, ...describe(c) });
            handled.set(step.id, { status: 'needs', note: step.labelNote });
            continue;
          }
        }
        // `onlyIf`: answered only when one of its conditions holds: a list, its own or another
        // question's (`path`; off the page it offers none), offers a limit (a choice with an amount)
        // or none (GEICO's Medical Payments Not Included where Basic PIP offers a limit or it offers
        // none: the maintainer, 2026-10-26, "If there is personal injury protection available, we
        // always prefer PIP"). Otherwise the agent's alone, with `onlyNote`: a limit TNI doesn't
        // name is never the AI's.
        if (step.onlyIf && step.value != null && !step.note) {
          const offersLimit = (path) => {
            const list = path ? allPairs.find((p) => p.step.path === path)?.control : c;
            return !!list && usableOptions(optionsOf(list)).some((o) => moneyTokens(o.text).length > 0);
          };
          if (!step.onlyIf.some((x) => offersLimit(x.path) === x.limit)) {
            report.noData.push({ ...item, note: step.onlyNote, manualOnly: true, ...describe(c) });
            handled.set(step.id, { status: 'needs', note: step.onlyNote });
            continue;
          }
        }
        if (step.note || step.value == null) {
          if (step.optional) { handled.set(step.id, { status: null }); continue; }
          report.noData.push({ ...item, note: step.note, ...describe(c) });
          handled.set(step.id, { status: 'needs', note: step.note ?? `intake form has no answer for ${step.name}` });
          continue;
        }
        // The question it waits for isn't drawn yet, or is on the page without an answer yet: the page
        // is still working. Once it is in, what it redraws comes a moment later: the page goes quiet
        // first, and the round reads it again.
        if (step.waitFor) waitShown = true;
        if (step.waitFor && !waitOver.has(step.id)) {
          const pending = shownControl(controls, { field: step.waitFor });
          const anchor = (step.whenShown ? shownControl(controls, step.whenShown)?.el : null) ?? document.body;
          const undrawn = waitedOutUndrawn.get(anchor) ?? new Set();
          const working = pending ? !hasValue(pending) && !waitedOut.has(pending.el) : !undrawn.has(step.id);
          if (working) {
            if (mayWait(step.id)) { retry = true; waited = true; continue; }
            if (pending) waitedOut.add(pending.el); else waitedOutUndrawn.set(anchor, undrawn.add(step.id));
            waitOver.add(step.id);
          } else if (waitingSince.has(step.id)) {
            waitOver.add(step.id);
            phase('waiting');
            await settle({ quietMs: AFTER_WAIT_QUIET_MS, maxMs: WAIT_MS });
            retry = true;
            waited = true;
            break;
          }
        }
        // A pre-selected "Enter a different …" isn't an answer worth keeping for pick-not steps.
        const presetToReplace = step.kind === 'pick-not' && new RegExp(step.value.not, 'i').test(selectedText(c) ?? '') && !agreesWith(step, c);
        const isChoice = c.kind === 'radio' || c.kind === 'select' || c.kind === 'checkbox';
        // `keepChoice`: a question the carrier never pre-selects, so a differing choice already
        // there is a person's: kept and flagged, not replaced.
        // An answer an earlier fill gave here that the page has since taken back (`takenBack`).
        const tookBack = isChoice && !overwrite && !!takenBack?.keys && Object.hasOwn(takenBack.keys, fieldKey(c)) && stepIs(takenBack.steps)
          && !agreesWith(step, c) && !refill.has(step.id) && !report.filled.some((x) => x.stepId === step.id);
        const differs = isChoice && replaceChoices && !step.keepChoice && !tookBack && !agreesWith(step, c);
        const legacyHold = mayHoldLegacyEdit(c) && !refill.has(step.id);
        // An unticked box that should stay unticked already has its answer (live run 2026-10-09:
        // every unticked box was "filled" again on each pass).
        const answered = hasValue(c) || (c.kind === 'checkbox' && step.value === false && !c.el.checked);
        // A street an earlier fill left without a suggestion is not answered while the box holds
        // what that fill left: it stays the agent's, never taken as the page's.
        if (step.checkNumber && unpicked.has(c.el) && unpicked.get(c.el) === c.el.value) {
          const reason = 'no address suggestion was picked for it: pick the address yourself';
          report.failed.push({ ...item, reason, ...describe(c) });
          handled.set(step.id, { status: 'failed', note: `couldn't fill ${step.name}: ${reason}` });
          continue;
        }
        // Replace existing answers replaces a different value; one that already is the answer is
        // kept, so nothing fires on it (FL live run 4, 2026-10-21: every Fill on GEICO's Quote &
        // Coverages set 9–12 coverages again, once right after Recalculate). An address-suggest
        // box agrees with any address, so Replace still retypes it.
        const sameAnswer = overwrite && answered && step.kind !== 'address-suggest' && agreesWith(step, c);
        // What a fill gave here for another vehicle, driver or trailer, still as it gave it, is
        // replaced with this unit's answer (W43-38, Progressive Add Driver, 2026-10-22: another
        // driver's name and date of birth were kept as differing and left to the agent).
        const otherUnits = answered && !agreesWith(step, c) && givenForOtherUnit(step, c);
        if (legacyHold || sameAnswer || (!overwrite && answered && !presetToReplace && !differs && !otherUnits && !refill.has(step.id) && !(step.replace && !agreesWith(step, c)))) {
          report.kept.push(item);
          if (legacyHold && !agreesWith(step, c)) {
            const note = 'Left as it is: an edit saved by an older version may be on this question. Check it.';
            report.checks.push({ ...item, note, ...describe(c) });
            handled.set(step.id, { status: 'needs', note });
          } else if (tookBack) {
            const note = `The page changed this back after it was filled (${step.name}): left as it is. Check it.`;
            report.checks.push({ ...item, note, ...describe(c) });
            handled.set(step.id, { status: 'needs', note });
          } else if (step.keepChoice && isChoice && !agreesWith(step, c)) {
            const note = `The page already has another answer here (${step.name}): left as it is. Check it.`;
            report.checks.push({ ...item, note, ...describe(c) });
            handled.set(step.id, { status: 'needs', note });
          // Review mode confirms every retained standard, including a differing carrier choice.
          // Other defaults retain their existing confirmation behavior.
          } else if (step.warn && (step.reviewRequired || agreesWith(step, c))) {
            report.checks.push({ ...item, note: step.warn, ...describe(c) });
            handled.set(step.id, { status: 'needs', note: step.warn });
          } else handled.set(step.id, { status: null });
          continue;
        }
        // A choice an earlier answer gave that the page has since reset (an earlier fill's, or this
        // fill's: changedSinceFilled) is given again only on a page quiet for a second, once a fill,
        // and the page is read again first (FL live run 5, 2026-10-21, W43-21: GEICO cleared the
        // business description when the agent answered the USDOT record, and the answer given again
        // a second later showed but GEICO's Next refused it). An earlier fill's key counts only for a
        // question asked once a quote: a vehicle's, driver's or trailer's form reuses its keys for the
        // next unit, where the answer is a first one. A page that doesn't go quiet gets it anyway, as
        // before.
        if (isChoice && !resetWaited && !agreesWith(step, c) && (refill.has(step.id) || (!step.scope && filledKeys.has(fieldKey(c))))) {
          resetWaited = true;
          phase('waiting');
          await settle({ quietMs: RESET_QUIET_MS, maxMs: 15000 });
          retry = true;
          break;
        }
        // Timing and side effects of this answer, for working out which questions could be
        // answered together: did it reach the server, did questions appear or disappear, did
        // other answers change.
        // Batch: a field an earlier answer this round redrew is answered next round.
        if (batch && c.el.isConnected === false) { retry = true; continue; }
        const snap = (list) => new Map(list.map((x) => [`${fieldKey(x)}|${x.label}`, x.kind === 'text' ? x.el.value : selectedText(x)]));
        const before = batch ? null : snap(controls);
        const t0 = Date.now();
        const requests0 = ajaxCount;
        let result;
        try { result = await apply(step, c); } catch (e) { result = { ok: false, reason: String(e?.message ?? e) }; }
        const tApplied = Date.now();
        if (result.ok && batch) {
          item.timing = { ms: Date.now() - t0, settleMs: 0, ajax: ajaxCount - requests0, revealed: 0, removed: 0, changed: 0, batch: true };
          if (report.halted) result = { ok: false, reason: 'the agent interrupted filling' };
          else if (c.el.isConnected === false) result = { ok: false, reason: 'the page did not keep the answer; check it' };
          else if (invalidControl(c) || !agreesWith(step, c)) result = { ok: false, reason: 'the page did not keep the answer; check it' };
        } else if (result.ok) {
          const settled = await settle(serverBacked ? {} : { quietMs: 150, maxMs: 3000 });
          const currentControls = collectControls();
          const after = snap(currentControls);
          const mine = `${fieldKey(c)}|${c.label}`;
          item.timing = {
            ms: Date.now() - t0, settleMs: Date.now() - tApplied, ajax: ajaxCount - requests0,
            revealed: [...after.keys()].filter((k) => !before.has(k)).length,
            removed: [...before.keys()].filter((k) => !after.has(k)).length,
            changed: [...before.keys()].filter((k) => k !== mine && after.has(k) && after.get(k) !== before.get(k)).length,
          };
          const fresh = assign(currentControls, plan).find((p) => p.step.id === step.id)?.control;
          // An address box may collapse once a suggestion is picked; the ZIP/city rules check it.
          const accepted = fresh ? !invalidControl(fresh) && agreesWith(step, fresh) : step.kind === 'address-suggest' || summaryAccepted(step, currentControls);
          if (!settled || !accepted || report.halted) {
            result = { ok: false, reason: !settled ? 'the page did not settle after the answer' : !fresh ? 'the field disappeared after the answer; check the page' : report.halted ? 'the agent interrupted filling' : 'the page did not keep the answer; check it' };
          }
        }
        if (result.ok) {
          if (currentPage() === 'CoveragesRates') {
            // The bill plan (payment method) stays chosen; the premium needs recalculating.
            // A cargo or general liability answer re-arms its Done with this coverage too.
            for (const id of ['recalculate', 'print', 'printSend', ...(step.cargo ? ['doneCargo'] : []), ...(step.gl === 'section' ? ['doneGl'] : [])]) {
              clicked.delete(id);
              report.actions = report.actions.filter((x) => x.id !== id);
              if (!report.invalidatedActions.includes(id)) report.invalidatedActions.push(id);
            }
          }
          // A step-fenced recalculation is due again after any later answer on its step (the
          // premium showed "$ --.--" until it was clicked, and Next stayed hidden: GEICO mock run,
          // 2026-10-20). It still waits for ratesStale() and the required questions before it's
          // clicked. One clicked once a quote (`once`: GEICO's, W43-31) never is again.
          for (const a of actions.filter((x) => x.needsRecalculation && !x.once && x.steps?.length && actionHere(x))) {
            clicked.delete(a.action);
            report.actions = report.actions.filter((x) => x.id !== a.action);
            if (!report.invalidatedActions.includes(a.action)) report.invalidatedActions.push(a.action);
          }
          // An option picked in place of one never offered (`orMost`) is named in the report.
          const instead = substituted.get(step.id);
          report.filled.push({ ...item, shown: result.shown, ...(instead ? { said: instead } : {}) });
          quietDue = true;
          unoffered.delete(step.id);
          // A TNI standard is marked apart from intake answers, so the agent sees the assumptions.
          handled.set(step.id, step.standard
            ? { status: 'standard', note: instead ?? `TNI standard answer, not from the intake: ${step.name}` }
            : { status: 'filled', note: instead ?? `filled from intake: ${step.name}` });
          if (step.warn) {
            report.checks.push({ ...item, note: step.warn, ...describe(c) });
            handled.set(step.id, { status: 'needs', note: step.warn });
          }
          changed = true;
          // Batch: carry on with the next answer, except before a helper button that waits on
          // this one (Import Data after the VIN list): it's clicked first thing next round.
          if (!batch || immediateAfter.has(step.path)) break;
        } else if (step.unofferedNote && /^no option matches/.test(result.reason ?? '')) {
          // A list without the answer, which no helper shows later (GEICO's Basic PIP without
          // $2,500): the agent's alone at once, so a `whenClear` helper (Print) waits for it.
          report.noData.push({ ...item, note: step.unofferedNote, manualOnly: true, ...describe(c) });
          handled.set(step.id, { status: 'needs', note: step.unofferedNote });
        } else if (step.whenOffered && /^no option matches/.test(result.reason ?? '')) {
          // Not offered yet: a helper may show it (GEICO's 11 Payments, behind View More Payment
          // Plans). Tried again each round; never offered by the fill's end, it is the agent's.
          unoffered.set(step.id, { item: { ...item, ...describe(c) }, control: c, step, options: result.options ?? [] });
        } else if (/did not keep/.test(result.reason ?? '') && !report.halted && retryOnce(step.id)) {
          // Often a later redraw resets it (a coverage list reloading): try again next round.
          refill.add(step.id);
          retry = true;
          if (serverBacked) break;
        } else if (step.keepUnlisted && /^no option matches/.test(result.reason ?? '') && hasValue(c) && !/^other\b/i.test(oneLine(selectedText(c) ?? ''))) {
          // A list without the answer that already holds the page's own (`keepUnlisted`: GEICO's
          // cities for the ZIP, TNI, 2026-10-21, W43-35: one city and OTHER in GA, "failed: City"
          // on two steps, and the agent kept GEICO's): kept, with a check naming the answer. Its
          // OTHER is no answer to keep (review of #141): that still fails.
          const note = `The page's list has no "${step.value}" (${step.name}): its "${selectedText(c)}" is left as it is. Check it.`;
          report.kept.push(item);
          report.checks.push({ ...item, note, ...describe(c) });
          handled.set(step.id, { status: 'needs', note });
        } else {
          report.failed.push({ ...item, reason: result.reason, ...describe(c) });
          handled.set(step.id, { status: 'failed', note: `couldn't fill ${step.name}: ${result.reason}` });
          retry = true;
          if (report.halted) break;
          // On pages that redraw after every answer, a failed answer may have redrawn it too: the
          // controls read this round may be gone, so read the page again before the next one.
          if (serverBacked) break;
        }
      }
      if (report.halted) break;
      // The next round's start ends the fill (or stops it on a step that is the agent's).
      if (stepMoved) continue;
      // A choice never offered once the helper that shows every option has been clicked (`orMost`:
      // GEICO's pay plans after View More Payment Plans, W43-32): the option with the highest count
      // among its question's fields is its answer, given next round.
      if (!changed && substitute()) continue;
      // Nothing left to type or pick: click the next button whose turn it is. Not on a page the agent
      // moved to while this round answered (its answer's field gone with the old page).
      if (currentPage() !== startPage) { report.navigatedTo = currentPage(); break; }
      let helperClicked = false;
      if (!changed && window === window.top && !agentPressed) {
        loadDue = null;
        changed = helperClicked = clickNextAction(controls);
        // A helper that loads a view (GEICO's "+", Add Driver) is clicked on a page quiet for a
        // second (FL live run 4, 2026-10-21: Add Driver 2 s after the list showed, and GEICO's
        // spinner stayed until the agent reloaded), and one that waits for a quiet page for its own
        // time (`quietMs`: GEICO's Recalculate, W43-31), its own requests included (REQUESTS_MS at
        // most): once it is due, the page is waited for, and clicked next round if nothing changed
        // meanwhile (a page that changed is read again).
        if (loadDue) {
          const before = signature();
          const due = actions.find((x) => x.action === loadDue);
          phase('waiting');
          if (!await settle({ quietMs: due?.quietMs ?? LOAD_QUIET_MS, maxMs: LOAD_MS, requests: due?.quietMs ? () => !report.halted : null })) { halt(LOAD_HALT); break; }
          quiet = !agentPressed && signature() === before ? { action: loadDue, sig: before } : null;
          continue;
        }
      }
      progressed = changed;
      if (!changed && !retry) {
        // A fill with a step that waits on the page takes one more look once the page has gone quiet:
        // an answer the page cleared after the last round read it (GEICO fills its type list again a
        // moment after the decoded year: FL live run 3, the Cascadia's Tractor) is given again
        // (changedSinceFilled).
        if (!lastLook && waitShown && report.filled.length && window === window.top) {
          lastLook = true;
          phase('waiting');
          await settle({ quietMs: AFTER_WAIT_QUIET_MS, maxMs: WAIT_MS });
          continue;
        }
        // GEICO draws some questions a moment after the answer that asks them, once that answer's
        // wait is over (team driving and the hazmat placard after "more about the business": FL live
        // run, 2026-10-23). Drawn during the wait before Continue, the fill never read them, the
        // recorder took them as the fill's when it resumed, and nobody answered them until the agent
        // did. Where Continue waits for a quiet page (`advance.quietMs`), a fill that gave answers waits
        // for it here, before it ends, and answers what was drawn, again after each later answer. (A
        // fill that gave none has drawn nothing: one the agent's answer drew, the recorder reports.)
        // Not after the agent's own Next: the step's move is theirs, and no Continue follows. The
        // wait counts as progress: a fill whose rounds run out on it, with what it drew unread, stops
        // at its round limit and doesn't continue.
        if (quietDue && !agentPressed && advance?.quietMs && !serverBacked && window === window.top && currentPage() === startPage && !stepChanged()
          && (!advance.steps?.length || stepIs(advance.steps, stepKey()))) {
          quietDue = false;
          progressed = true;
          phase('waiting');
          await settle({ quietMs: advance.quietMs, maxMs: 6000 });
          quietSig = signature();
          continue;
        }
        break;
      }
      if (!changed) {
        if (waited) await sleep(WAIT_ROUND_MS);
        continue;
      }
      // An answer given one at a time has already waited for the page (above); only a helper
      // click or a batch of answers still needs the wait. (Waiting twice cost Progressive about
      // 0.3 s per answer.)
      // A helper that draws a new view (`loads`: GEICO's add icons and the chooser's Next) is waited
      // for as long as a step's load, and so is one that rates the quote (GEICO's Recalculate, its
      // spinner up while it rates).
      const loads = helperClicked && !!pendingAction?.loads;
      const rates = helperClicked && pendingAction?.verify === 'premium';
      if (helperClicked) phase('helper', pendingAction?.label ?? report.actions.at(-1)?.text ?? null);
      if ((helperClicked || batch) && !await settle(serverBacked ? {} : { quietMs: batch ? 150 : 250, maxMs: loads || rates ? LOAD_MS : 3000 })) {
        traceEnd(pendingAction);
        halt(loads ? LOAD_HALT : 'The page did not settle after the helper.');
        break;
      }
      // Its view comes a moment after the page went quiet (GEICO's chooser after "+", with no
      // spinner: FL live run 4, 2026-10-21, "+" clicked three times in 1.4 s): waited for, once
      // the page is quiet again, before the click counts as lost.
      if (loads && pendingAction?.verify === 'revealed') {
        const until = Date.now() + loadResultMs;
        let dirty = true;
        const mo = new MutationObserver(() => { dirty = true; });
        mo.observe(document.body, { subtree: true, childList: true });
        try {
          for (let tick = 0; Date.now() < until; tick++) {
            if ((dirty || tick % 5 === 0) && revealedNow(pendingAction)) break;
            dirty = false;
            await sleep(200);
          }
        } finally {
          mo.disconnect();
        }
        if (!await settle({ quietMs: 250, maxMs: LOAD_MS })) { halt(LOAD_HALT); break; }
      }
      // One that rates the quote on a page that isn't ExtJS (GEICO's Recalculate) shows nothing
      // busy at first: GEICO's loader shows only 3 s into a load. GEICO rated the fill's click 13 to
      // 19 s after it (2026-10-22). The wait above had ended by then, so the click was failed as
      // unrated, and GEICO's redraw with its own values was never checked. Its premium is waited for
      // as long as a step's load. Then the page and its own requests are waited for, quiet for the
      // helper's own time, before the answers are read (W43-41, FL, 2026-10-22). Read 250 ms after the
      // premium showed, four answers the agent saw right the whole time were marked as changed by
      // GEICO.
      if (rates && !serverBacked) {
        phase('premium');
        const until = Date.now() + LOAD_MS;
        while (Date.now() < until && !rated(pendingAction) && !report.halted && currentPage() === startPage && !stepChanged()) { traceRead(pendingAction); await sleep(500); }
        if (pendingAction?.trace && rated(pendingAction)) { pendingAction.trace.premiumMs = Math.round(perfNow() - pendingAction.trace.at); traceRead(pendingAction); }
        // Stopped, or the agent edited, while it rated: nothing more is done here.
        if (report.halted) { traceEnd(pendingAction); break; }
        if (!await settle({ quietMs: pendingAction?.quietMs ?? 250, maxMs: LOAD_MS, requests: () => !report.halted })) { traceEnd(pendingAction); halt(LOAD_HALT); break; }
        traceRead(pendingAction);
      }
      if (!await verifyAction()) break;
      if (currentPage() !== startPage) { report.navigatedTo = currentPage(); break; }
      if (stepChanged()) break;
    }
    // The agent's step after the last round (Next clicked during its wait): stopped there too.
    if (!stoppedAt) {
      stoppedAt = stopStepOn(stopSteps);
      if (stoppedAt) { report.stopStep = stoppedAt; if (!report.halted) halt(STOP_STEP_HALT); }
    }

    function revealedNow(a) {
      const before = a.before ?? new Map();
      const controls = collectControls();
      return [...controlSnapshot(controls)].some(([k, v]) => !before.has(k) || before.get(k) !== v)
        || resultShown(a, assign(controls, plan));
    }

    async function verifyAction() {
      const a = pendingAction;
      pendingAction = null;
      if (!a) return true;
      if (a.verify === 'download') {
        report.documentPending = true;
        return true;
      }
      let accepted = true;
      if (a.verify === 'premium') accepted = rated(a);
      // Clicked once a quote (`once`: GEICO's Recalculate, W43-31): never again, also when its
      // result didn't show; from here it is the agent's, and they're told.
      if (!accepted && a.once) {
        report.failed.push({ label: a.label ?? 'Recalculate', path: null, name: a.label ?? a.action, key: null, q: null, controlKind: null, reason: ONCE_UNVERIFIED });
        traceEnd(a);
        return false;
      }
      // The answers it may have redrawn (`keepAnswers`), read again once its result shows, and
      // watched until KEPT_WATCH_MS after the click when they held.
      if (accepted && a.kept && !await answersKept(a)) await watchKept(a);
      traceEnd(a);
      // A link that opens a section (Add Non-Trucking Liability) is gone once it took; still on
      // screen but disabled is not gone.
      if (a.verify === 'gone') accepted = !findButton(a, { disabledToo: true });
      if (a.verify === 'cargoClosed') {
        const controls = collectControls();
        // The cargo section's questions still on screen (found by the rules for them).
        const expanded = assign(controls, plan).some(({ step }) => step.cargo === 'section');
        const cargoSteps = plan.filter((s) => s.cargo === 'limit' && s.value != null);
        const retained = assign(controls, cargoSteps).some(({ step, control }) => agreesWith(step, control));
        const summary = (document.body.innerText ?? '').match(/motor truck cargo[^\n]*(?:\n[^\n]*){0,2}/i)?.[0] ?? '';
        const amounts = moneyTokens(summary);
        const summaryAgrees = cargoSteps.some((s) => moneyTokens(s.value).length >= 2 && moneyTokens(s.value).every((n) => amounts.includes(n)));
        accepted = !expanded && (retained || summaryAgrees);
      }
      // General liability's Done: its section's questions are gone and the row keeps the limit.
      if (a.verify === 'glClosed') {
        const pairs = assign(collectControls(), plan);
        accepted = !pairs.some(({ step }) => step.gl === 'section')
          && pairs.some(({ step, control }) => step.gl === 'limit' && hasValue(control) && (step.value == null || agreesWith(step, control)));
      }
      // `revealed`: the click showed its result: a question appeared, or an answer changed, since
      // the snapshot taken as the button was clicked (a lookup's decoded values, the rows an
      // import redraws, the registered names a USDOT check offers). A redraw of the same
      // questions with the same answers is no result.
      // A redraw that shows the result again unchanged (it was there before the click) counts too.
      if (a.verify === 'revealed') accepted = revealedNow(a);
      // `{ appears }`: more of these on the page than before the click (any, when there were none).
      if (a.verify?.appears) accepted = deepQueryAll(document, a.verify.appears).length > (a.before ?? 0);
      if (!accepted) {
        clicked.delete(a.action);
        report.invalidatedActions.push(a.action);
        report.actions = report.actions.filter((x) => x.id !== a.action);
        report.blocked.push({ id: a.action, why: 'result not verified yet' });
        // A click whose result never showed is tried again, twice at most in one fill (the
        // button is due again, being unclicked); then it stays the agent's, and they're told.
        if (a.verify === 'revealed' || a.verify?.appears) {
          // A helper that loads a view is never clicked again: it was waited for (above).
          if (a.loads) {
            exhausted.add(a.action);
            report.noData.push({ label: a.label ?? a.baseAction ?? a.action, path: a.path, name: a.name, key: null, q: null, controlKind: null,
              note: 'Clicked once, but the page never showed what it opens: check the page, do it yourself if it isn\'t there, then fill again.' });
            return true;
          }
          if (retryOnce(`action:${a.action}`)) return true;
          // Left to the agent for the rest of this fill (not clicked again), and the page's other
          // questions still fill around it.
          exhausted.add(a.action);
          report.noData.push({ label: a.label ?? a.baseAction ?? a.action, path: a.path, name: a.name, key: null, q: null, controlKind: null,
            note: 'Clicked three times, but the page never showed its result: do it yourself, then fill again.' });
          return true;
        }
      }
      return accepted;
    }

    // A helper's result already on the page (`shownBy`), for the unit's own value: the helper's
    // fields show the intake's value, and this fill didn't type them (an older result would then
    // be another value's). A click alone never counts.
    function resultShown(a, pairs) {
      const shown = a.shownBy;
      if (!shown || !a.after.length) return false;
      if (report.filled.some((x) => a.after.includes(x.path))) return false;
      const agrees = (p) => pairs.some(({ step, control }) => step.path === p && step.value != null && !invalidControl(control) && agreesWith(step, control));
      const present = (p) => pairs.some(({ step, control }) => step.path === p && !invalidControl(control) && (!shown.answered || hasValue(control)));
      return a.after.every(agrees) && (shown.all.length ? shown.all.every(present) : shown.any.some(present));
    }

    // What the page's questions show, by question: the snapshot a `revealed` check compares with.
    function controlSnapshot(controls) {
      return new Map(controls.map((x) => [`${fieldKey(x)}|${x.label}`, x.kind === 'text' ? x.el.value : selectedText(x)]));
    }

    // The intake unit a form names (`formUnit`: { list, text, names, active, label }, Progressive's
    // "Questions about <driver>" on Add Driver for a driver it already has), by the words of each
    // unit's name (`names`), all of them in the form's: `index` the plan's unit when it is one of
    // those named, the only one named otherwise, null for none or several. Null when the page
    // names none (a new driver's blank form).
    function unitNamedNow() {
      const re = new RegExp(formUnit.text, 'i');
      const line = String(document.body?.innerText ?? '').split(/\n+/).map((l) => l.trim()).find((l) => re.test(l));
      if (!line) return null;
      const name = (re.exec(line)?.[1] ?? '').trim();
      const words = ` ${name.toUpperCase().replace(/[^A-Z0-9]+/g, ' ')} `;
      const all = (formUnit.names ?? []).flatMap((n, i) => (n.length && n.every((w) => words.includes(` ${w} `)) ? [i] : []));
      // A driver whose name words another named driver's also holds (Ann Lee beside Mary Ann Lee) is not the one named.
      const most = Math.max(0, ...all.map((i) => formUnit.names[i].length));
      const named = all.filter((i) => formUnit.names[i].length === most);
      return { name, index: named.includes(formUnit.active) ? formUnit.active : named.length === 1 ? named[0] : null };
    }
    // Whether the field shows just what an earlier fill gave for another unit of the plan step's
    // list (`givenBefore`: field key -> { path, shown }, the panel's record of this tab's answers).
    function givenForOtherUnit(step, c) {
      // Only on a form that names its unit (`unitNames`), where a form naming another unit halts.
      if (!formUnit) return false;
      const given = givenBefore?.[fieldKey(c)];
      const unit = (path) => String(path ?? '').match(/^(vehicles|drivers|trailers)\[(\d+)\]/);
      const mine = unit(step.path);
      const theirs = unit(given?.path);
      return !!mine && !!theirs && mine[1] === theirs[1] && mine[2] !== theirs[2] && given.shown != null && String(given.shown) === String(answerShown(c) ?? '');
    }
    // Each question by its field and its place among the fields of that key (`key#n`): a GEICO
    // coverage row's label holds its premium, which a recalculation changes.
    function answerPlaces(controls) {
      const seen = new Map();
      return controls.map((c) => {
        const key = fieldKey(c);
        const n = (seen.get(key) ?? 0) + 1;
        seen.set(key, n);
        return [`${key}#${n}`, c];
      });
    }
    function answerShown(c) {
      return c.kind === 'text' ? c.el.value : selectedText(c);
    }

    // The answers on the page as a helper that redraws them is clicked (`keepAnswers`: GEICO's
    // Recalculate, W43-31): the fill's (any fill's, the page agreeing with its step) and the agent's.
    function answersNow() {
      const controls = collectControls();
      const pairs = assign(controls, plan);
      return answerPlaces(controls).flatMap(([at, c]) => {
        if (!hasValue(c)) return [];
        const step = pairs.find((p) => p.control === c)?.step;
        const agents = skippedField(c);
        const ours = !agents && !!step && step.value != null && !step.ignore && !step.note && !step.verifyOnly && agreesWith(step, c);
        return agents || ours ? [{ at, stepId: ours ? step.id : null, shown: answerShown(c), label: c.label, key: fieldKey(c), kind: c.kind }] : [];
      });
    }

    // What the page did after the click of a helper that rates the answers (`keepAnswers`: GEICO's
    // Recalculate), for the usage log (W43-44, to tell a check read too early from GEICO drawing its
    // own values): each kept choice's value whenever it changed, in ms after the click; how it was
    // pressed (pressButton: 'page', 'late' or 'kit'); when the premium showed; the page's requests
    // from 10 s before the click on; and which answers the fill put back. Typed boxes are left out
    // (they may hold a client's value). `now`: the controls already read.
    function traceStart() {
      return { at: perfNow(), press: null, last: new Map(), seen: [], premiumMs: null, putBack: [] };
    }
    function traceRead(a, now = null) {
      const t = a?.trace;
      if (!t) return;
      now ??= new Map(answerPlaces(collectControls()));
      const ms = Math.round(perfNow() - t.at);
      for (const k of a.kept) {
        const c = now.get(k.at);
        if (!c || k.kind === 'text' || c.kind === 'text') continue;
        const value = answerShown(c);
        if (value === (t.last.has(k.at) ? t.last.get(k.at) : k.shown)) continue;
        t.last.set(k.at, value);
        if (t.seen.length < 120) t.seen.push({ at: k.at, ms, value });
      }
    }
    function traceEnd(a) {
      const t = a?.trace;
      if (!t) return;
      traceRead(a);
      const rel = (x) => Math.round(x - t.at);
      report.recalcTrace = {
        action: a.action,
        ms: rel(perfNow()),
        press: t.press,
        premiumMs: t.premiumMs,
        requests: recentRequests.filter((r) => r.end >= t.at - 10000).slice(-40).map((r) => (r.poll ? [rel(r.start), rel(r.end), 1] : [rel(r.start), rel(r.end)])),
        answers: a.kept.filter((k) => k.kind !== 'text').map((k) => ({
          label: k.label, key: k.key, shown: k.shown, agents: k.stepId == null,
          seen: t.seen.filter((s) => s.at === k.at).slice(0, 10).map((s) => [s.ms, s.value]),
          putBack: t.putBack.includes(k.at),
        })),
      };
    }

    // Once its result shows (W43-31: GEICO drew its own choices back after a Recalculate the fill
    // clicked): an answer the page shows otherwise now is given back once if it was the fill's, and
    // left as it is if it was the agent's. Each is red, and one more item says the premium may not
    // be for the answers shown. The helper isn't clicked again (`once`): the agent recalculates,
    // and Print waits for them (`whenClear`).
    // Whether any answer had changed.
    function keptChanged(a, now) {
      return a.kept.flatMap((k) => {
        const c = now.get(k.at);
        return c && answerShown(c) !== k.shown ? [{ k, c }] : [];
      });
    }
    async function answersKept(a) {
      if (!keptChanged(a, new Map(answerPlaces(collectControls()))).length) return false;
      // A change counts only if it is still there once the page and its own requests have been
      // quiet again. A request still running can't be seen, and a value the page then draws back
      // by itself isn't a change (W43-41, FL, 2026-10-22: four answers marked as changed and put
      // back, which the agent saw right the whole time).
      await settle({ quietMs: a.quietMs ?? 1000, maxMs: LOAD_MS, requests: () => !report.halted });
      if (report.halted) return false;
      const now = new Map(answerPlaces(collectControls()));
      traceRead(a, now);
      const changed = keptChanged(a, now);
      if (!changed.length) return false;
      const pairs = assign([...now.values()], plan);
      const given = new Set();
      // What the page showed instead, before anything is put back.
      const seen = new Map(changed.map(({ k, c }) => [k.at, answerShown(c)]));
      for (const { k, c } of changed) {
        const step = k.stepId != null ? pairs.find((p) => p.control === c && p.step.id === k.stepId)?.step : null;
        if (!step) continue;
        let result;
        try { result = await apply(step, c); } catch (e) { result = { ok: false }; }
        if (result.ok) { given.add(k.at); a.trace?.putBack.push(k.at); }
      }
      if (given.size) await settle({ quietMs: 250, maxMs: LOAD_MS });
      const after = new Map(answerPlaces(collectControls()));
      for (const { k, c: before } of changed) {
        const c = after.get(k.at) ?? before;
        const step = k.stepId != null ? plan.find((s) => s.id === k.stepId) : null;
        // A choice's own words only (a typed box may hold a client's value).
        const was = c.kind === 'text' ? '' : ` (it was "${k.shown}")`;
        const back = !!step && given.has(k.at) && after.has(k.at) && agreesWith(step, c);
        const reason = !step ? `the page changed your answer when it recalculated${was}: answer it again, then click Recalculate yourself.`
          : back ? `the page changed this answer when it recalculated${c.kind === 'text' ? '' : ` (to "${seen.get(k.at)}")`}, and the fill put it back: click Recalculate yourself, then check the answer is kept.`
            : `the page changed this answer when it recalculated${was}, and the fill couldn't put it back: answer it yourself, then click Recalculate.`;
        const key = fieldKey(c);
        // Only this answer's own entry (its step, key and label): another field with its key (a
        // sibling, another step's) keeps its own. The agent's answer has none.
        const own = (list) => {
          const i = step ? list.findIndex((x) => x.stepId === step.id && x.key === key && x.label === c.label) : -1;
          return i < 0 ? list : list.filter((_, j) => j !== i);
        };
        report.filled = own(report.filled);
        report.kept = own(report.kept);
        report.failed.push({ stepId: step?.id ?? null, label: c.label, path: step?.path ?? null, name: step?.name ?? c.label, key, q: c.q ?? null, controlKind: c.kind, reason, ...describe(c) });
        mark(c, 'failed', reason);
        if (step) handled.set(step.id, { status: 'failed', note: reason });
      }
      const n = changed.length;
      report.failed.push({ label: a.label ?? 'Recalculate', path: null, name: a.label ?? a.action, key: null, q: null, controlKind: null,
        reason: `the page changed ${n === 1 ? 'an answer' : `${n} answers`} when it recalculated (marked above), so the premium may not be for the answers shown. Check them and click Recalculate yourself: the fill clicks it once a quote.` });
      return true;
    }

    // A redraw after the first check (GEICO's came 9 to 14 s after the click): the answers are read
    // again every half second until KEPT_WATCH_MS after the click, and a change is checked as above
    // once the page is quiet. An agent edit, another page or another step ends the watch.
    async function watchKept(a) {
      while (Date.now() - a.clickedAt < KEPT_WATCH_MS && !report.halted && currentPage() === startPage && !stepChanged()) {
        await sleep(500);
        const now = new Map(answerPlaces(collectControls()));
        traceRead(a, now);
        if (!keptChanged(a, now).length) continue;
        await settle({ quietMs: a.quietMs ?? 1000, maxMs: LOAD_MS, requests: () => !report.halted });
        await answersKept(a);
        return;
      }
    }

    // A choice never offered once the helper that shows every option was clicked (`orMost`: GEICO's
    // pay plans, W43-32: TX offers no 11 Payments): among the options of every field of its
    // question, the one with the highest count (`count`'s first group; `one`: an option that counts
    // 1) becomes its answer, given next round and named in the report. Clicked by an earlier fill,
    // the page may have drawn fewer plans since: only the page's own pick, when it is that one (a
    // later fill agrees with the 9 Payments the first picked). No option with a count, or one of its
    // fields already answered: still the agent's.
    function substitute() {
      const byPath = new Map();
      for (const u of unoffered.values()) {
        const m = u.step.orMost;
        if (!m || !clicked.has(m.after)) continue;
        byPath.set(u.step.path, [...(byPath.get(u.step.path) ?? []), u]);
      }
      let any = false;
      for (const [path, group] of byPath) {
        if (report.filled.some((x) => x.path === path) || plan.some((s) => s.path === path && substituted.has(s.id))) continue;
        const { count, one, name } = group[0].step.orMost;
        const counted = (text) => (one && new RegExp(one, 'i').test(text) ? 1 : Number(new RegExp(count, 'i').exec(text)?.[1] ?? NaN));
        let best = null;
        for (const u of group) {
          for (const text of u.options) {
            const n = counted(oneLine(text));
            if (Number.isFinite(n) && (!best || n > best.n)) best = { n, text: oneLine(text), id: u.step.id, control: u.control };
          }
        }
        if (!best) continue;
        const fresh = report.actions.some((x) => x.id === group[0].step.orMost.after);
        if (!fresh && oneLine(selectedText(best.control) ?? '') !== best.text) continue;
        const step = plan.find((s) => s.id === best.id);
        substituted.set(step.id, `The page doesn't offer "${step.value}" here: the fill picked "${best.text}", ${name}.`);
        step.value = best.text;
        unoffered.delete(step.id);
        any = true;
      }
      return any;
    }

    // A helper's own pages, and its own steps of a one-address application (`steps`: GEICO's
    // Recalculate only on Quote & Coverages; a later step's text can ask to recalculate too).
    function actionHere(a) {
      return (!a.pages.length || a.pages.includes(currentPage())) && (!a.steps?.length || stepIs(a.steps));
    }

    // A helper the agent must otherwise do by hand is open while the helpers it follows have run
    // and the page hasn't settled it (NTL added, then set back to No, and still on the quote).
    function holdOpen(a) {
      return !!a.missing && a.afterActions.every((id) => clicked.has(id)) && !clicked.has(a.action)
        && actionHere(a) && !settledItem(a);
    }

    // Its button back on the page (`resolvedBy`: the Add NTL link, NTL removed), or a page the agent
    // has been to since (`settledByPages`).
    function settledItem(a) {
      return !!(a.resolvedBy && findButton({ text: a.resolvedBy })) || !!a.settledByPages?.some((p) => visited.has(p));
    }

    // A prerequisite holds when its field shows the intake's answer, or an answer the agent chose
    // themselves (their correction counts as resolved). Missing, rejected or different: not yet.
    function answered(pairs, path) {
      return pairs.some(({ step, control }) => step.path === path && !step.ignore && !invalidControl(control)
        && ((step.value != null && agreesWith(step, control)) || (skippedField(control) && hasValue(control))));
    }

    // What this fill has left for the agent so far (`whenClear` helpers wait for none): its needs-you,
    // failed and check items, an answer kept that differs, and an empty question it reported as
    // unfamiliar (only those the panel lists, so the agent can answer or mark each one done).
    function leftForAgent(controls) {
      return report.noData.length + report.failed.length + report.checks.length + report.leftRequired.length
        + report.kept.filter((x) => x.differs).length
        + controls.filter((c) => !hasValue(c) && !skippedField(c) && report.unknown.some((x) => x.key === fieldKey(c))).length;
    }

    function clickNextAction(controls, immediateOnly = false) {
      // A page the plan has questions for that shows none yet is still drawing: its helpers wait for
      // them, a tile pick aside (W44-03, Progressive Business Owner Info in KY and OH, 2026-10-26: the
      // business type's Search was the only thing to do on the undrawn page, its click counted as
      // something done there, and "Ok, start quote." followed it).
      const blank = !controls.length && expectsQuestions && currentPage() === startPage;
      const pairs = assign(controls, plan);
      const has = (path) => answered(pairs, path);
      const blocked = [];
      // A helper's button with something open over it: waits, as one waiting for its prerequisites.
      const holdCovered = (a, el) => {
        blocked.push(a.action);
        report.blocked.push({ id: a.action, why: COVERED_HELPER, waits: [{ say: 'what is open over it closed' }], text: buttonText(el).slice(0, 60) || (a.label ?? '') });
      };
      for (const a of actions.filter((x) => (!immediateOnly || x.immediate) && (!blank || x.onBlankPage))) {
        // A link verified by its going away that is back on its page (NTL removed by hand, then
        // asked for again) is due again.
        if (clicked.has(a.action) && a.verify === 'gone' && actionHere(a) && findButton(a)) clicked.delete(a.action);
        if (clicked.has(a.action) || exhausted.has(a.action) || !actionHere(a)) continue;
        // A blank repeater row is already sufficient: do not add a duplicate merely because
        // its fields have not been filled yet (or the agent went back to this step).
        if (a.unlessSelector && deepQueryAll(document, a.unlessSelector).length) { clicked.add(a.action); continue; }
        // A helper that answers many questions at once (AmWINS' Default all answers to No) would
        // reset an answer the agent gave on this page: not clicked while one is here (the rules
        // answer the other questions one by one), and not counted as clicked either.
        if (a.skipIfProtected && controls.some((c) => skippedField(c))) continue;
        if (report.halted || pageBusy()) return false;
        if (a.action === 'printSend' && controls.some((c) => /^(email|e mail|fax)$/.test(c.text) && hasValue(c))) {
          report.blocked.push({ id: a.action, why: 'Email or Fax is ticked; untick it to print' });
          continue;
        }
        if (a.unless.some(has) || (a.unlessActions ?? []).some((id) => clicked.has(id))) { clicked.add(a.action); continue; }
        // Recalculate only when the rates are out of date; otherwise it isn't waited for.
        if (a.needsRecalculation && !ratesStale()) continue;
        const button = findButton(a);
        // `nudge`: a button that shows only once the page took an answer (Progressive's "Done with
        // this coverage" after the cargo commodity): with everything else ready and no button, that
        // answer is picked again, once (the agent's re-pick is what made it show).
        if (!button && a.nudge && !nudged.has(a.action) && a.after.every(has) && a.afterActions.every((id) => clicked.has(id))) {
          const pair = pairs.find(({ step }) => step.path === a.nudge && step.value != null);
          if (pair && agreesWith(pair.step, pair.control)) {
            nudged.add(a.action);
            // ExtJS's select hands its listeners the picked record, as a real pick does (Codex on PR #43).
            const { cmp } = pair.control;
            if (cmp) {
              const value = cmpValue(cmp, pair.control.el);
              const rec = storeOptions(cmp).find((o) => o.value === value || o.text === oneLine(value))?.rec ?? null;
              cmp.fireEvent?.('select', cmp, rec ?? value);
            }
            if (!cmp) setNativeValue(pair.control.el, pair.control.el.value);
            return true;
          }
        }
        // Menu items ("Add Vehicle" under "Add") only show once their menu button is opened.
        const alreadyShown = a.verify === 'revealed' && resultShown(a, pairs);
        if (!button && !a.opener && !alreadyShown) continue;
        const holds = actions.filter((h) => (a.heldBy ?? []).includes(h.baseAction) && holdOpen(h));
        // A page button that the carrier refuses while a required question is empty (Rates' bill
        // plan, SC 2026-10-07: clicked right after UM/UIM were cleared, and nothing opened).
        const openRequired = a.waitRequired ? controls.filter((c) => c.required && !hasValue(c) && !skippedField(c)) : [];
        const leftOpen = a.whenClear ? leftForAgent(controls) : 0;
        const ready = !holds.length && !openRequired.length && !leftOpen && (!a.afterAny?.length || a.afterAny.some(has))
          && (!a.needsPremium || premiumReady())
          && (!a.needsRecalculation || ratesStale())
          && a.after.every(has)
          && a.afterActions.every((id) => clicked.has(id))
          && (!a.afterPages.length || a.afterPages.some((p) => visited.has(p)))
          && (!a.afterValue || pairs.some(({ step, control }) => step.path === a.afterValue[0] && new RegExp(a.afterValue[1], 'i').test(selectedText(control) ?? '')));
        if (!ready) {
          // Name what it waits for (field paths, buttons, pages: no client values), so the panel
          // and the usage log say why a helper didn't run: `why` for the log, and `waits` (the same,
          // by kind) to tell, at the end of the fill, one the page did itself (doneByPage).
          const waits = [
            ...a.after.filter((p) => !has(p)).map((path) => ({ path })),
            ...(a.afterAny?.length && !a.afterAny.some(has) ? [{ any: a.afterAny }] : []),
            ...a.afterActions.filter((id) => !clicked.has(id)).map((action) => ({ action })),
            ...(a.afterPages.length && !a.afterPages.some((p) => visited.has(p)) ? [{ pages: a.afterPages }] : []),
            ...(a.needsPremium && !premiumReady() ? [{ say: 'a current premium' }] : []),
            ...(a.afterValue ? [{ path: a.afterValue[0], set: true }] : []),
            ...holds.map((h) => ({ action: h.action, say: `${h.label ?? h.baseAction} resolved` })),
            ...openRequired.slice(0, 3).map((c) => ({ say: `${c.label || 'a required question'} answered` })),
            ...(leftOpen ? [{ say: NOTHING_LEFT }] : []),
          ];
          const waitingFor = waits.map((w) => w.say ?? (w.any ? `one of ${w.any.join(' / ')}` : w.action ? `${w.action} clicked`
            : w.pages ? `${w.pages.join(' / ')} visited` : `${w.path}${w.set ? ' set' : ''}`));
          blocked.push(a.action);
          report.blocked.push({ id: a.action, why: waitingFor.length ? `waiting for ${waitingFor.join(', ')}` : 'waiting for its prerequisites', waits });
          continue;
        }
        // Its result already shows (the agent ran the lookup before Fill): done, not clicked again.
        if (alreadyShown) {
          clicked.add(a.action);
          report.actions.push({ id: a.action, text: 'already shown on the page', alreadyShown: true });
          continue;
        }
        if (!button) {
          const opener = !openersTried.has(a.action) && findButton({ text: a.opener });
          if (!opener) continue;
          // Something open over it (a dialog, a message): not clicked through it.
          if (coveredBy(opener)) { holdCovered(a, opener); continue; }
          openersTried.add(a.action);
          report.actions.push({ id: `${a.action}:menu`, text: buttonText(opener).slice(0, 60) });
          pressButton(opener);
          return true;
        }
        if ((a.loads || a.quietMs) && !(quiet?.action === a.action && quiet.sig === signature())) { loadDue = a.action; return false; }
        // Something open over it (a dialog, a message): not clicked through it; clicked once it's gone.
        if (coveredBy(button)) { holdCovered(a, button); continue; }
        quiet = null;
        clicked.add(a.action);
        report.actions.push({ id: a.action, text: buttonText(button).slice(0, 60) || (a.label ?? '') });
        // What the page shows as the button is clicked (the round's controls are older: answers
        // have landed since): what a `revealed` / `appears` check compares with afterwards.
        pendingAction = a.verify === 'revealed' ? { ...a, before: controlSnapshot(collectControls()) }
          : a.verify?.appears ? { ...a, before: deepQueryAll(document, a.verify.appears).length }
            : a.keepAnswers ? { ...a, kept: answersNow(), clickedAt: Date.now(), trace: traceStart() } : a;
        const trace = pendingAction.trace;
        const how = pressButton(button, { late: trace ? () => { trace.press = 'late'; } : null, kit: a.kitClick });
        if (trace) trace.press = how;
        return true;
      }
      return false;
    }

    // A helper that opened the next page (the vehicle tile opens Add Vehicle) leaves its questions
    // to that page's own fill: none of them is reported or marked as this page's. So does the
    // agent's Next to another step of a one-address application, and a stop step or a step that
    // can't be read is not read at all.
    const stillHere = !report.navigatedTo && currentPage() === startPage && !stepChanged() && !stoppedAt && !unreadStep;
    // Answers still waiting for another try when the fill ended are left for the agent, and so is
    // a field the page should have filled itself (emptyNote) but didn't.
    const finalControls = stillHere ? collectControls() : [];
    const finalPairs = stillHere ? assign(finalControls, plan) : [];
    // A unit form drawn after the last round read the page has its own edits, never the last one's.
    if (skipBy && stillHere) skipWhere(finalPairs.units);
    identityAfterAnswer(finalPairs, finalControls);
    // A unit whose row the page's rows don't show (its VIN on none of them, or on two): its
    // answers stay the agent's, once per unit, naming it and not its VIN.
    for (const step of finalPairs.unwitnessed ?? []) {
      const unit = unitName(step.witness.path);
      if (report.noData.some((x) => x.unit === unit)) continue;
      const why = step.witness.value == null ? `the intake has no ${witnessName(step.witness)} for ${unit}` : `the row for ${unit} (its ${witnessName(step.witness)}) wasn't found`;
      report.noData.push({ label: unit.replace(/^\w/, (ch) => ch.toUpperCase()), path: step.witness.path, name: unit, unit, key: null, q: null, controlKind: null, note: `${why}; check the rows and answer its questions yourself.` });
    }
    // A row showing a VIN no intake vehicle has: an unintended vehicle may be on the quote. Left
    // as it is (never removed or answered); Continue waits for the agent. Named by its place only.
    for (const { witness, position, key } of finalPairs.extraRows ?? []) {
      if (skippedKey(key)) continue;
      const kind = String(witness.path ?? '').match(/^(\w+?)s?\[/)?.[1] ?? 'unit';
      const label = `${kind.replace(/^\w/, (ch) => ch.toUpperCase())} row ${position || '?'} on the page`;
      if (report.checks.some((x) => x.label === label)) continue;
      report.checks.push({ label, path: null, name: label, key, q: null, controlKind: null,
        note: `Its ${witnessName(witness)} matches no ${kind} on the intake. Remove it, or dismiss this check to confirm it belongs on this quote, before continuing.` });
    }
    for (const { step, control } of finalPairs) {
      if (step.emptyNote && !hasValue(control) && !skippedField(control)) {
        report.noData.push({ stepId: step.id, label: control.label, path: step.path, name: step.name, key: fieldKey(control), q: control.q ?? null, controlKind: control.kind, note: step.emptyNote, ...describe(control) });
        handled.set(step.id, { status: 'needs', note: step.emptyNote });
        continue;
      }
      if ((!refill.has(step.id) && !waitingSince.has(step.id)) || handled.has(step.id) || skippedField(control) || agreesWith(step, control)) continue;
      // One that waited for the page to the end (the fill stopped first) is as unanswered as one the page reset.
      const reason = refill.has(step.id) ? 'the page did not keep the answer; check it' : 'the page was still working on this question; check it';
      report.failed.push({ stepId: step.id, label: control.label, path: step.path, name: step.name, key: fieldKey(control), q: control.q ?? null, controlKind: control.kind, reason, ...describe(control) });
      handled.set(step.id, { status: 'failed', note: `couldn't fill ${step.name}: ${reason.replace(/; check it$/, '')}` });
    }
    if (progressed && report.rounds === maxRounds && !report.halted) halt('Filling reached its round limit. Check the page before retrying.');
    // The page may have redrawn while filling, so mark the final fields.
    const controls = stoppedAt || unreadStep ? [] : collectControls();
    const pairs = assign(controls, plan);
    if (skipBy && stillHere) skipWhere(pairs.units);
    for (const { step, control } of stillHere ? pairs : []) {
      const h = handled.get(step.id);
      if (h?.status) mark(control, h.status, h.note);
    }
    // A held unit form is marked on its first question, where its check says why.
    for (const u of stillHere ? pairs.units : []) if (u.held && !skippedField(u.marker)) mark(u.marker, 'needs', heldFormNote(u));
    // An unfamiliar question that went away during the fill (hidden by an answer, such as the
    // equipment amount once "no equipment" is ticked) isn't one the agent has to answer.
    if (stillHere) {
      const onPageNow = new Set(controls.map((c) => fieldKey(c)));
      report.unknown = report.unknown.filter((x) => onPageNow.has(x.key));
      // Likewise a field that looked renamed (Codex on PR #43): it no longer holds Continue.
      report.renamed = report.renamed.filter((x) => onPageNow.has(x.key));
    }
    // Question text for every field on the page, keyed like the usage recorder's changes.
    report.labels = controls.map((c) => [fieldKey(c), c.label]);
    // Each ExtJS combo's loaded choices (never agency staff lists), so the usage log can tell a
    // pick from text typed into the box.
    report.choices = controls.filter((c) => c.cmp && c.kind === 'select' && c.options && !/agent|producer/i.test(c.label ?? ''))
      .map((c) => [fieldKey(c), [...new Set(c.options.map((o) => o.text).filter(Boolean))]]);
    report.skipped = controls.filter((c) => skippedField(c)).map((c) => ({ label: c.label, key: fieldKey(c) }));
    const matched = new Set(pairs.map((p) => p.control));
    for (const c of stillHere ? controls : []) {
      if (!matched.has(c) && report.unknown.some((x) => x.key === fieldKey(c)) && !skippedField(c)) mark(c, 'needs', 'Unfamiliar question — left for you.');
      if (!matched.has(c) && c.required && !hasValue(c) && !skippedField(c) && !pairs.held.has(c)) {
        report.leftRequired.push({ label: c.label, key: fieldKey(c), q: c.q ?? null, controlKind: c.kind, ...describe(c) });
        mark(c, 'needs', 'required, and not on the intake form');
      }
    }
    // A choice never offered (`whenOffered`), unless another rule for the same question answered it
    // (GEICO's two pay plan groups, one of which lists 11 Payments), or a helper that may show it is
    // still waiting (View More Payment Plans, for the agent's answers, or for a Recalculate: GEICO hides
    // the link while the premium is out of date): the agent's, or the offered plan with the most (`orMost`).
    const offerPending = report.blocked.some((x) => !clicked.has(x.id) && x.waits?.some((w) => w.say === NOTHING_LEFT))
      || (unoffered.size > 0 && actions.some((a) => a.needsPremium && !clicked.has(a.action) && actionHere(a)) && !premiumReady());
    for (const { item, control, step } of unoffered.values()) {
      if (handled.has(step.id) || offerPending || report.filled.some((x) => x.path === step.path) || report.kept.some((x) => x.path === step.path)) continue;
      const note = `The page doesn't offer "${step.value}" here: pick it yourself.`;
      report.noData.push({ ...item, note });
      handled.set(step.id, { status: 'needs', note });
      mark(control, 'needs', note);
    }
    // A helper the agent must otherwise do by hand (the vehicle tile) that couldn't be clicked here,
    // once the helpers it follows have run (an NTL still on the quote after the agent set it to No).
    if (window === window.top && currentPage() === startPage && !stepChanged() && !stoppedAt && !unreadStep) {
      for (const a of actions) {
        if (!a.missing || clicked.has(a.action) || !actionHere(a) || findButton(a)
          || !a.afterActions.every((id) => clicked.has(id)) || a.unlessActions?.some((id) => clicked.has(id))
          || settledItem(a)) continue;
        // A markable one carries its own id, scoped as `clicked` has it, for the panel's Mark done.
        report.noData.push({ label: a.label ?? a.name, path: a.path, name: a.name, key: null, q: null, controlKind: null, note: a.missing, action: a.markable ? a.action : null });
      }
      // Clicked earlier, but what it adds never got in (Add Trailer opened, the trailer page left
      // without filling it): the agent finishes it before Continue. A helper kept to a container
      // (`within`: GEICO's add row) says so only where its list is on screen, not on the unit's
      // own form, which one address draws in its place.
      for (const a of actions) {
        if (!a.unfinished || !a.doneWhen?.length || !clicked.has(a.action) || a.doneWhen.some((id) => clicked.has(id))
          || !actionHere(a) || (a.within && !findButton(a, { disabledToo: true }))) continue;
        report.noData.push({ label: a.label ?? a.name, path: a.path, name: a.name, key: null, q: null, controlKind: null, note: a.unfinished });
      }
    }
    // A button that was waiting earlier in this fill and got clicked later isn't waiting any more.
    // Nor is one that waited only for answers the page now shows, once the page took the button
    // away: Progressive looked a second vehicle's VIN up by itself once it was typed (SC
    // 2026-10-19), and the panel still said Look up VIN was waiting for the VIN. The page did it,
    // so it's done, unclicked, as one already shown is: a helper that follows it (Add Trailer after
    // every vehicle's lookup) doesn't wait for it either. One still waiting for another helper, a
    // page or a premium stays, as does a menu item (`opener`: shown only with its menu open) and a
    // helper the agent must do by hand (`missing`, reported above).
    const doneByPage = (b) => {
      if (!stillHere || !b.waits?.length || !b.waits.every((w) => w.path && !w.set && answered(pairs, w.path))) return false;
      const a = actions.find((x) => x.action === b.id);
      return !!a && !a.opener && !a.missing && !findButton(a);
    };
    for (const b of report.blocked) {
      if (clicked.has(b.id) || !doneByPage(b)) continue;
      clicked.add(b.id);
      report.actions.push({ id: b.id, text: 'done by the page itself', alreadyShown: true });
    }
    // Each helper once, with what held it last (its prerequisites in one round, something open over
    // it in the next).
    report.blocked = report.blocked.filter((b, i, all) => !clicked.has(b.id) && all.findLastIndex((x) => x.id === b.id) === i);
    // Helpers still held by something open over them: the panel names them (`coveredHelpers`).
    const coveredHelpers = report.blocked.filter((b) => b.why === COVERED_HELPER).map((b) => b.text);
    if (coveredHelpers.length) report.coveredHelpers = coveredHelpers;
    // Where each item's field is on the page (`order`: its place among the page's questions, in
    // document order), so the side panel lists what's left in the page's order, whichever kind
    // of item it is. Read once, from the page as it is now (as the last round read it when a
    // helper opened the next page). An item with no field there (a helper, a unit without its row,
    // a field gone since) gets none: the panel lists it last.
    const placeOf = new Map();
    (stillHere ? controls : roundControls).forEach((c, i) => {
      const key = fieldKey(c);
      if (!placeOf.has(`${key}|${c.label}`)) placeOf.set(`${key}|${c.label}`, i);
      if (!placeOf.has(key)) placeOf.set(key, i);
    });
    // Answers filled too: the panel lists the whole page in one list, in this order.
    for (const x of [report.filled, report.unknown, report.failed, report.noData, report.leftRequired, report.kept, report.checks].flat()) {
      // Rows of one question share a key; their labels tell them apart.
      const at = x.key == null ? undefined : placeOf.get(`${x.key}|${x.label}`) ?? placeOf.get(x.key);
      if (at !== undefined) x.order = at;
    }
    // Anything the agent should look at before moving on.
    // The carrier probably changed this page: a known field renamed, or most of its questions
    // unfamiliar at once. Continue waits for the agent, and the panel says so.
    report.pageChanged = report.renamed.length > 0 || (report.unknown.length >= 5 && report.unknown.length >= 0.4 * Math.max(1, report.fields));
    // A field drawn without a caption (the cargo commodity lists) is named after its rule.
    const called = (x) => x.label || x.name || x.path || 'a question with no label';
    report.blockers = [
      ...(report.pageChanged ? [`page changed: ${report.unknown.length} unfamiliar question(s)${report.renamed.length ? `, ${report.renamed.length} known field(s) renamed` : ''}`] : []),
      // An unfamiliar question with no answer yet is left for the agent even when the page
      // doesn't mark it required (Progressive validates some only on Continue).
      ...report.unknown.filter((x) => x.required || x.current == null).map((x) => `unfamiliar: ${called(x)}`),
      ...report.noData.map((x) => `needs you: ${called(x)}`),
      ...report.failed.map((x) => `failed: ${called(x)}`),
      ...report.leftRequired.map((x) => `required: ${called(x)}`),
      ...report.kept.filter((x) => x.differs).map((x) => `differs: ${called(x)}`),
      // Another step's hidden fields (otherStep: AmWINS' prior carriers, filled again on every
      // step) are confirmed on their own step, not again on each later one (audit 2026-10-10).
      ...report.checks.filter((x) => !x.otherStep).map((x) => `check: ${called(x)}`),
      ...report.blocked.map((x) => `button: ${x.id}${x.why?.startsWith('waiting for ') ? ` (${x.why})` : ''}`),
      ...(report.halted ? [report.reason] : []),
      // The agent's own button during the fill (Next, "+", Looks Good): that step's move is theirs.
      ...(agentPressed ? [AGENT_PRESSED] : []),
    ];
    if (agentPressed) report.agentPressed = true;
    // The step this fill was on: the one it started on when the agent moved to another meanwhile
    // (its items are that step's).
    report.stepKey = stepChanged() ? startStep : stepKey();
    // A page the plan expects questions on that shows none yet, with nothing done on it, is still
    // drawing (Business Owner Info right after the state is picked, OK 2026-10-07): Continue there
    // only gets "fields are empty" errors. (A tile page that was clicked continues.) Only a frame of
    // the page in front says so: Progressive keeps a hidden frame loaded with Business Owner Info's
    // address for the whole quote, and on every later page it found none of "its" questions and said
    // the page wasn't drawn, so the panel took the top frame's held Continue for "No questions found"
    // and filled the page once more (live recording, 2026-10-24). On a page the plan has questions for,
    // only a tile pick is done while it shows none (clickNextAction, W44-03).
    const notDrawn = !report.fields && !report.actions.length && (topPage == null || topPage === startPage) && plan.some((s) => s.pages?.includes(startPage));
    // The panel tries such a page again in a moment, and says nothing of it yet (W43-42).
    if (notDrawn && !report.halted) report.notDrawn = true;
    if (advance && window === window.top && !report.blockers.length && !notDrawn && currentPage() === startPage && !stepChanged() && !pageBusy()
      && !(advance.exceptPages ?? []).includes(currentPage()) && !doneSteps.includes(report.stepKey)
      && (!advance.steps?.length || (!!report.stepKey && stepIs(advance.steps, report.stepKey)))) {
      // The last answer may still be redrawing part of the page (a new payment method reloads the
      // plan list): a Continue clicked meanwhile is lost. Let it finish first. `quietMs`: a page that
      // draws a question a moment after an answer (GEICO's USDOT record check) is waited for too,
      // unless the fill's own wait at the end of its rounds left it as it is now. Held for the agent's
      // check with nothing approved yet (`hold`), Continue isn't clicked: the wait is the page's, not
      // Continue's (the panel's dock read "Clicking Continue…" there: the review of PR #170).
      phase(hold && confirmed == null ? 'waiting' : 'continue');
      if (serverBacked) await settle({ quietMs: 500, maxMs: 6000 });
      else if (advance.quietMs && quietSig !== signature()) await settle({ quietMs: advance.quietMs, maxMs: 6000 });
      // An agent edit during that wait stopped the fill (the guard is still on): no Continue, and
      // the report says why. (Reproduced 2026-10-08: halted, and Continue clicked all the same.)
      if (report.halted) {
        if (!report.blockers.includes(report.reason)) report.blockers.push(report.reason);
      } else {
        // The carrier may have rewritten an answer during that wait (a late server response). An
        // answer whose field no longer shows it is the agent's to check (no retry here): it moves
        // to `failed`, is marked, and Continue waits.
        const now = collectControls();
        const nowPairs = assign(now, plan);
        const changed = changedSinceFilled(nowPairs);
        for (const { previous, pair } of changed) {
          const item = { ...previous, reason: 'The carrier changed this answer after it was filled; check it.', ...describe(pair.control) };
          const at = placeOf.get(`${item.key}|${item.label}`) ?? placeOf.get(item.key) ?? now.indexOf(pair.control);
          if (at >= 0) item.order = at;
          report.filled = report.filled.filter((x) => x !== previous);
          report.failed.push(item);
          mark(pair.control, 'failed', 'the carrier changed this answer after it was filled');
          report.blockers.push(`failed: ${called(item)}`);
        }
        // A registered name drawn during that wait, after the fill's last check, makes an answer
        // given before it the agent's to verify, as during the fill: marked, and Continue waits.
        const moved = identityAfterAnswer(nowPairs, now);
        for (const { item, control } of moved) {
          const at = placeOf.get(`${item.key}|${item.label}`) ?? placeOf.get(item.key) ?? now.indexOf(control);
          if (at >= 0) item.order = at;
          mark(control, 'needs', IDENTITY_NOTE);
          report.blockers.push(`needs you: ${called(item)}`);
        }
        // A question drawn during that wait without an answer (`quietMs`) holds Continue: the fill
        // never read it, so it is the agent's. (What the page drew during the fill's own wait at the
        // end of its rounds, the fill read and answered.)
        const readKeys = new Set(finalControls.map((c) => fieldKey(c)));
        const drawn = advance.quietMs ? now.filter((c) => !readKeys.has(fieldKey(c)) && !hasValue(c)) : [];
        const found = !changed.length && !moved.length && !drawn.length && !pageBusy() && currentPage() === startPage && !stepChanged() ? findAdvanceButton(advance.text, advance) : null;
        // Per form and button (`byForm`): one already continued from is the agent's now.
        const key = found && advance.byForm ? [report.stepKey, squash(buttonText(found)), unitFormsNow()?.[0]?.id ?? ''].filter(Boolean).join('@') : report.stepKey;
        const button = found && !(advance.byForm && doneSteps.includes(key)) ? found : null;
        // Nothing held Continue, but none could be clicked: the page still busy after the wait
        // ('busy') or showing no Continue (`none`: not drawn yet, disabled, or a list's Looks Good
        // left out). The panel tries an automatic fill once more, and logs which (`advanceDue`,
        // W43-40: Progressive's Vehicle Summary, every vehicle added, not continued on 2026-10-22
        // with nothing said why; continued 3 of 3 times on earlier builds with the switch on).
        if (!found && !changed.length && !moved.length && !drawn.length && !report.halted && !agentPressed) report.advanceDue = pageBusy() ? 'busy' : 'none';
        // The agent checks the answers first: Continue only for the page as they approved it.
        const approved = !hold || (confirmed != null && confirmed === receipt());
        if (button && !approved) report.held = confirmed == null ? 'check' : 'changed';
        // Pressed during the wait before Continue: held as above.
        if (button && approved && agentPressed) {
          report.agentPressed = true;
          report.blockers.push(AGENT_PRESSED);
        } else if (button && approved && coveredBy(button)) {
          // Something is open over Continue (a dialog, a message, a mask): a script's click would
          // go through it. Continue waits until the agent closes it.
          report.covered = true;
          report.blockers.push(COVERED);
        } else if (button && approved) {
          const text = buttonText(button).slice(0, 40);
          // On one-address applications (AmWINS) the side panel waits for the questions to change.
          report.signatureBefore = signature();
          pressButton(button);
          // Recorded once the press went out (on GEICO the page's world clicks a moment later, within
          // a second at most), never before it.
          report.advanced = text;
          if (advance.byForm) report.advanceKey = key;
        }
      }
    }
    return report;
    } finally {
      hiddenOk = [];
      fillUnits = null;
      try { ext()?.Ajax?.un?.('beforerequest', countAjax); } catch { /* no ExtJS events */ }
      releaseEditGuard();
      document.removeEventListener('click', notePress, true);
      if (running === thisFill) running = null;
    }
  }

  // Puts answers the agent accepted from the AI assistant (or that it was allowed to pick itself)
  // into their fields: [{ key, label, value, note }], `value` being one of the field's option
  // texts, 'checked'/'unchecked' for a checkbox, or text. Same apply-and-verify path as fill():
  // an answer counts only once the page has settled and still shows it. Returns one result per
  // answer, in order. An agent edit while they go in marks every item of that question
  // `protected: true`, and a question the agent edited that was not among the answers gets an item
  // of its own after them (`protected: true`, `ok: false`): the panel protects those keys, and a
  // protected item means the apply halted. Only the items survive the trip to the panel.
  // `stopSteps`: as fill's (by default those fills in this document were given): on a step that is
  // the agent's, nothing is put in. `by`: 'agent' for a choice the agent picked in the side panel
  // (marked as theirs, slate: neither the intake's green nor the AI's purple).
  async function answer(answers, expectedSnapshots, guardToken, { stopSteps = knownStopSteps, by = 'ai' } = {}) {
    const agent = by === 'agent';
    if (stopStepOn(stopSteps)) return answers.map((a) => ({ key: a.key, label: a.label, ok: false, reason: STOP_STEP_HALT }));
    // A frameId can be reused after navigation. Only the document guarded for this apply may
    // receive its later answers, even after earlier answers changed the original snapshot.
    if (guardToken && answerEditSession?.token !== guardToken) {
      return answers.map(a => ({ key: a.key, label: a.label, ok: false,
        reason: 'the page or frame changed while applying the answers; request fresh suggestions' }));
    }
    if (expectedSnapshots && !expectedSnapshots.includes(decisionSnapshot())) {
      return answers.map(a => ({ key: a.key, label: a.label, ok: false, reason: 'the page changed since the assistant evaluated it; request fresh suggestions' }));
    }
    const serverBacked = !!ext();
    const find = (key, label) => {
      const same = collectControls().filter((c) => fieldKey(c) === key);
      return same.length > 1 ? same.find((c) => c.label === label) ?? null : same[0] ?? null;
    };
    const results = [];
    // The agent at the page while the answers go in (the recorder is paused then, as during a
    // fill): their edit keeps its question, and the answers still to come are not put in (they
    // were chosen for the page as it was).
    const editedQuestions = answerEditSession?.questions ?? new Map();
    const edited = (key) => editedQuestions.has(key);
    const releaseEditGuard = answerEditSession ? () => {} : guardEdits((key, c) => {
      if (!edited(key)) editedQuestions.set(key, c.label ?? null);
    });
    try {
    for (const a of answers) {
      if (editedQuestions.size) { results.push({ key: a.key, label: a.label, ok: false, reason: EDIT_HALT_ANSWERS }); continue; }
      const c = find(a.key, a.label);
      if (!c) { results.push({ key: a.key, label: a.label, ok: false, reason: 'the question is no longer on this page' }); continue; }
      if (a.expected) {
        const d = describe(c);
        const options = c.kind === 'checkbox' ? ['checked', 'unchecked'] : d.options;
        const changed = [c.label !== a.label && 'label', c.kind !== a.expected.kind && 'type',
          (d.section || null) !== (a.expected.section || null) && 'section',
          JSON.stringify(options) !== JSON.stringify(a.expected.options) && 'options',
          (d.current ?? null) !== (a.expected.current ?? null) && 'selection'].filter(Boolean);
        if (changed.length) {
          results.push({ key: a.key, label: a.label, ok: false, reason: `the field changed (${changed.join(', ')}) since the assistant evaluated it; request a fresh suggestion` });
          continue;
        }
      }
      const id = `${agent ? 'agent' : 'ai'}:${a.key}`;
      const name = agent ? 'Your answer' : 'AI suggestion';
      const step = c.kind === 'checkbox'
        ? { id, name, kind: 'bool', value: /^(checked|yes|true)$/i.test(String(a.value)) }
        : { id, name, value: String(a.value) };
      let result;
      try { result = await apply(step, c); } catch (e) { result = { ok: false, reason: String(e?.message ?? e) }; }
      if (result.ok) {
        const settled = await settle(serverBacked ? {} : { quietMs: 250, maxMs: 3000 });
        const fresh = find(a.key, a.label);
        // The agent changed this very question while its answer went in: theirs stays, unmarked.
        if (edited(a.key)) result = { ok: false, reason: 'you changed this question yourself while the answer went in; your answer stays' };
        else if (!settled) result = { ok: false, reason: 'the page did not settle after the answer' };
        else if (!fresh) result = { ok: false, reason: 'the field disappeared after the answer; check the page' };
        else if (invalidControl(fresh) || !agreesWith(step, fresh)) result = { ok: false, reason: 'the page did not keep the answer; check it' };
        else mark(fresh, agent ? 'agent' : 'ai', a.note ?? (agent ? 'your answer, from the side panel' : 'answer suggested by the AI assistant — check it'));
      }
      if (!result.ok && !edited(a.key)) { const now = find(a.key, a.label); if (now) mark(now, 'failed', `${agent ? 'Your answer' : 'AI answer'} not accepted: ${result.reason}`); }
      results.push({ key: a.key, label: a.label, ok: result.ok, shown: result.shown ?? null, reason: result.reason ?? null });
    }
    for (const r of results) if (edited(r.key)) r.protected = true;
    for (const [key, label] of editedQuestions) {
      if (!results.some((r) => r.key === key)) results.push({ key, label, ok: false, protected: true, reason: 'you changed this question yourself while the AI answers went in; your answer stays' });
    }
    return results;
    } finally {
      releaseEditGuard();
    }
  }

  // Re-marks one field (e.g. an AI choice the agent rejected). Returns whether it was found.
  // Which of these the page shows: a VIN as a whole run of letters and digits (the vehicle list's
  // units on the quote), or a name as all its words on one line (one driver of the driver list, not
  // a first name from one and a last name from another). Only true/false goes back.
  function listed(items) {
    const text = String(document.body?.innerText ?? '').toUpperCase();
    const page = ` ${text.replace(/[^A-Z0-9]+/g, ' ')} `;
    const lines = text.split(/\n+/).map((l) => ` ${l.replace(/[^A-Z0-9]+/g, ' ')} `);
    const word = (w) => String(w ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return (items ?? []).map((t) => {
      if (Array.isArray(t)) { const words = t.map(word).filter((w) => w.length >= 2); return words.length >= 2 && lines.some((l) => words.every((w) => l.includes(` ${w} `))); }
      const v = word(t);
      return v.length >= 11 && page.includes(` ${v} `);
    });
  }

  // A one-address application's list of the units on the quote (GEICO's Vehicles and Trailers,
  // Drivers), by its selector: null when it isn't on screen; else how many units it lists (its
  // rows but the add row) and which of `items` it shows, as listed() reads them but within the list
  // only. Only numbers and true/false go back.
  function unitList(selector, items) {
    if (!knownUnitLists.includes(selector)) knownUnitLists.push(selector);
    const list = deepQueryAll(document, selector).find((el) => el.getClientRects().length);
    if (!list) return null;
    const text = String(list.innerText ?? '').toUpperCase();
    const flat = ` ${text.replace(/[^A-Z0-9]+/g, ' ')} `;
    const lines = text.split(/\n+/).map((l) => ` ${l.replace(/[^A-Z0-9]+/g, ' ')} `);
    const word = (w) => String(w ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const rows = [...list.children].filter((li) => li.tagName === 'LI' && !li.classList.contains('add-state')).length;
    const shown = (items ?? []).map((t) => {
      if (Array.isArray(t)) { const words = t.map(word).filter((w) => w.length >= 2); return words.length >= 2 && lines.some((l) => words.every((w) => l.includes(` ${w} `))); }
      const v = word(t);
      return v.length >= 11 && flat.includes(` ${v} `);
    });
    return { rows, shown };
  }

  // The unit lists unitList read here that are on screen now, each with its rows but the add row:
  // '' when none is. The recorder reads it on every poll and tells the panel when it changes: GEICO
  // draws a vehicle or driver list with no question on it, 5–7 s after the Next that saved a unit's
  // form, so neither new_fields nor removed_fields comes with it (FL live run 6, 2026-10-21: the
  // follow-up for the form that went away ran before the list was there, and nothing ran after).
  // Light DOM and no text, as it runs every poll; GEICO's lists are in the light DOM. Selectors and
  // counts only.
  function unitListsNow() {
    try {
      return knownUnitLists.map((selector) => {
        const list = [...document.querySelectorAll(selector)].find((el) => el.getClientRects().length);
        return list ? `${selector}:${[...list.children].filter((li) => li.tagName === 'LI' && !li.classList.contains('add-state')).length}` : '';
      }).filter(Boolean).join('|');
    } catch {
      return '';
    }
  }

  function markKey(key, label, status, note) {
    const same = collectControls().filter((c) => fieldKey(c) === key);
    const c = same.length > 1 ? same.find((x) => x.label === label) : same[0];
    if (c) mark(c, status, note);
    return !!c;
  }

  // "Show on page" in the side panel: brings the field `key` into view (`label` tells rows of one
  // question apart, as in markKey) and rings its mark for 1.5 s, then puts back what was there.
  // It reads and scrolls only: no value is changed, nothing is clicked or focused, and no event is
  // sent to the page. Returns whether this frame has the field on screen (one in a closed section
  // isn't).
  const ringed = new Map(); // a ringed element -> { prev: its own box-shadow, ring, timer }
  function reveal(key, label) {
    const same = collectControls().filter((c) => fieldKey(c) === key);
    const c = same.length > 1 ? same.find((x) => x.label === label) : same[0];
    if (!c) return false;
    const targets = highlightTargets(c);
    targets[0]?.scrollIntoView?.({ block: 'center' });
    for (const el of targets) {
      const was = ringed.get(el);
      if (was) clearTimeout(was.timer);
      const prev = was ? was.prev : el.style.boxShadow ?? '';
      // In the color of its mark (blue when it has none), wider than the mark's outline.
      el.style.boxShadow = `0 0 0 4px ${el.style.outlineColor || '#2563eb'}`;
      // As the browser reads it back, to tell it from a shadow the page sets meanwhile.
      const ring = el.style.boxShadow;
      const timer = setTimeout(() => {
        ringed.delete(el);
        if (el.style.boxShadow === ring) el.style.boxShadow = prev;
      }, 1500);
      ringed.set(el, { prev, ring, timer });
    }
    return true;
  }

  // What fields show now, so the side panel can check answers against the page: `items` is
  // [{ key, label }] (keys as fill reports them; `label` tells rows of one question apart, as in
  // reveal). Returns [{ key, label, shown, empty }] for each one this frame has; one not found here
  // is left out. `shown` is in the form of fill's `shown`: the option text of a list or choice,
  // 'checked'/'unchecked' for a checkbox, the text in a box ('' when nothing is picked or typed).
  // `steps`: the plan steps that filled them (an item's `stepId`): `agrees` then says whether the
  // field still holds that answer the way fill judges it (agreesWith: an address the page wrote
  // in its own format, a ZIP+4, a reformatted amount still agree), null without its step.
  // It reads only: no event, focus, click, value change or mark change.
  function readBack(items, steps = []) {
    const controls = collectControls();
    const out = [];
    for (const { key, label, stepId = null } of items ?? []) {
      const same = controls.filter((c) => fieldKey(c) === key);
      const c = same.length > 1 ? same.find((x) => x.label === label) : same[0];
      const step = stepId == null ? null : (steps ?? []).find((s) => String(s.id) === String(stepId));
      if (c) out.push({ key, label, shown: shownNow(c), empty: !hasValue(c), agrees: step ? !!agreesWith(step, c) : null });
    }
    return out;
  }

  // The page's answers as they stand, as one short fingerprint (top frame only, where Continue is;
  // null elsewhere): every question's key, label and what it shows (shownNow), but not another
  // step's hidden fields (otherStep: AmWINS' prior carriers, filled again on every step). The panel
  // takes it when the agent clicks Looks right and the fill compares it before Continue (`hold`).
  // It reads only, and no value leaves the page: only the fingerprint does.
  function receipt() {
    if (window !== window.top) return null;
    // The page as the agent sees it, inside a fill or not: a fill also reads collapsed fields it
    // has rules for (hiddenOk: AmWINS' prior carriers), which the agent's Looks right didn't.
    const fillHidden = hiddenOk;
    let controls;
    try { hiddenOk = []; controls = collectControls(); } finally { hiddenOk = fillHidden; }
    const text = controls.filter((c) => !otherStep(c.el)).map((c) => `${fieldKey(c)}\u0001${c.label ?? ''}\u0001${shownNow(c)}`).join('\u0002');
    // cyrb53: a 53-bit string hash (an equality check, not a secret).
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return `r1-${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
  }

  function shownNow(c) {
    if (c.kind === 'checkbox') return (c.cmp ? !!cmpValue(c.cmp, c.el) : c.el.checked) ? 'checked' : 'unchecked';
    if (c.kind === 'text') return textValue(c.el) || (c.cmp ? String(cmpValue(c.cmp, c.el) ?? '') : '');
    return selectedText(c) ?? '';
  }

  // A small note at the bottom of the rater page listing what the AI selected and still needs
  // the agent's approval in the side panel. No buttons or inputs, so the fill engine and the
  // page's own scripts never pick it up. An empty list removes it.
  const BANNER_ID = 'rater-autofill-ai-banner';
  function aiBanner(lines) {
    if (window !== window.top) return;
    document.getElementById(BANNER_ID)?.remove();
    if (!lines?.length) return;
    const box = document.createElement('div');
    box.id = BANNER_ID;
    box.setAttribute('role', 'status');
    box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:360px;padding:10px 12px;'
      + 'background:#f5f1ff;border:2px solid #7c3aed;border-radius:8px;color:#2e1065;font:13px/1.4 system-ui,sans-serif;'
      + 'box-shadow:0 4px 14px rgba(0,0,0,.15)';
    const head = document.createElement('div');
    head.style.cssText = 'font-weight:700;margin-bottom:4px';
    head.textContent = `AI selected ${lines.length} answer${lines.length === 1 ? '' : 's'} on this page (purple). Approve in the side panel before Continue.`;
    const list = document.createElement('ul');
    list.style.cssText = 'margin:0;padding-left:18px';
    for (const line of lines.slice(0, 12)) {
      const li = document.createElement('li');
      li.textContent = line;
      list.append(li);
    }
    box.append(head, list);
    document.body.append(box);
  }

  // Describes this page's form so exact mappings can be written. Records no typed values (only
  // which dropdown/radio choice is picked); any text matching `redact` (client names, numbers)
  // is replaced with [client].
  function capture(plan, redact = []) {
    // As src/usage.js `redactor`: one word (a name word) only as a whole word, so "Ann" leaves
    // "Annual mileage" alone; anything else wherever it appears as written.
    const patterns = redact.filter((t) => t && t.length >= 3).map((t) => {
      const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return /^[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*$/u.test(t)
        ? new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escaped}(?![\\p{L}\\p{M}\\p{N}])`, 'giu') : new RegExp(escaped, 'gi');
    });
    // Registered addresses offered by the carrier aren't in the intake, so redact them by shape.
    const r = (s) => patterns.reduce((acc, re) => acc.replace(re, '[client]'), oneLine(s)).replace(/^.+?(?=\((?:USDOT|Primary Business|Mailing|Garaging) Address\))/i, '[client] ');
    const controls = collectControls();
    const matched = new Map(plan ? assign(controls, plan).map((p) => [p.control, p.step.path]) : []);
    const path = location.pathname.replace(/\d{5,}/g, ':id');
    const pageName = currentPage();
    return {
      frame: location.origin + path,
      page: pageName,
      // The step of a one-address application on screen (its visible headings), redacted.
      step: r(stepKey()),
      isTopFrame: window === window.top,
      title: r(document.title),
      headings: deepQueryAll(document, 'h1, h2, h3, legend, [role=heading]').filter(isVisible).map((h) => r(h.textContent)).filter(Boolean).slice(0, 40),
      controls: controls.map((c) => ({
        q: c.q ?? undefined,
        // The field's data-model name (fieldref): how a rule finds it (assign).
        ref: c.ref ?? undefined,
        // Its row (Duck Creek "<page>_<row>": one per vehicle or trailer on Rates), numbers only.
        row: c.row ?? undefined,
        kind: c.kind,
        type: c.cmp?.xtype ?? c.type,
        label: r(c.label),
        name: c.el.name || null,
        id: c.el.id || null,
        // Repeating sections without ids (AmWINS drivers/vehicles) still name their fields.
        dataId: c.el.getAttribute('data-id') || null,
        selector: cssPath(c.el),
        required: c.required,
        section: r(sectionOf(c.el)),
        ...captureOptions(c, r),
        wouldFill: matched.get(c) ?? null,
        pageHasValue: hasValue(c),
        // Which choice is picked (never text typed into boxes): shows which answers make
        // follow-up questions appear.
        selected: c.kind === 'text' ? undefined : r(selectedText(c) ?? ''),
      })),
      // Buttons and links on the page (text only), so button actions can be written from layouts.
      buttons: [...new Set(deepQueryAll(document, 'a, button, [role=button], input[type=button], input[type=submit], .x-btn')
        .filter((el) => el.getClientRects().length).map((el) => r(buttonText(el)).slice(0, 60)).filter(Boolean))].slice(0, 80),
      customWidgets: deepQueryAll(document, '[role=combobox]:not(input):not(select), [role=listbox], [contenteditable=true]')
        .filter(isVisible).slice(0, 50).map((el) => ({ role: el.getAttribute('role') ?? 'contenteditable', label: r(labelFor(el)), selector: cssPath(el) })),
      // Validation and help messages on screen (what the page said about the answers), redacted. A
      // message can repeat what was typed into a box (a corrected VIN, a phone number): the boxes'
      // text and anything shaped like a VIN or a long number are taken out as well.
      messages: [...new Set(deepQueryAll(document, '[role=alert], .x-form-error-msg, .x-form-invalid-under, [class*="error-message"], [class*="validation-message"], [class*="help-block"]')
        .filter(isVisible).map((el) => withoutTyped(r(oneLine(el.textContent)), controls).slice(0, 200)).filter(Boolean))].slice(0, 40),
      // Dropdown lists open on screen (a capture taken with the keyboard shortcut while one is open):
      // their choices as shown, and which question opened them. Choices are kept only for a fixed
      // list of a known question: never agency staff lists, never a list whose question can't be
      // found, and never a lookup filled from what was typed (addresses, businesses, customers).
      openLists: deepQueryAll(document, '[role=listbox], .x-boundlist').filter(isVisible).slice(0, 10).map((list) => {
        const owner = listOwner(list);
        const label = owner?.label ?? null;
        const items = [...list.querySelectorAll('[role=option], .x-boundlist-item')].map((o) => withoutTyped(r(oneLine(o.textContent)), controls)).filter(Boolean);
        const kept = !!owner?.fixed && label !== null && !/agent|producer/i.test(label);
        return { label: label === null ? null : r(label), selector: cssPath(list), count: items.length, fixed: !!owner?.fixed,
          options: kept ? items.slice(0, CAPTURE_OPTIONS) : [], optionsTruncated: (kept && items.length > CAPTURE_OPTIONS) || undefined };
      }),
    };
  }

  // Text typed into the page's boxes, and anything shaped like a VIN or a long number, out of a
  // message the page shows (it may repeat what was typed, which the intake's terms don't cover).
  function withoutTyped(text, controls) {
    // Every box that holds typed text, whatever its role, read from the page itself: the questions
    // found (a combo you can type into included) and the boxes question discovery skips (search
    // boxes, editable regions).
    const boxes = [...controls.map((c) => c.el), ...deepQueryAll(document, 'input, textarea, [contenteditable=""], [contenteditable=true]')];
    const typed = [...new Set(boxes.filter((el) => el?.tagName === 'TEXTAREA' || el?.getAttribute?.('contenteditable') != null
      || (el?.tagName === 'INPUT' && !/^(radio|checkbox|button|submit|reset|image|file|hidden|password|range|color)$/i.test(el.type ?? '')))
      .map((el) => oneLine(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? el.value : el.textContent)))].filter((v) => v.length >= 3);
    // Whatever the case or spacing the page shows it in (it may capitalize what was typed).
    const pattern = (v) => new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'gi');
    let out = typed.reduce((acc, v) => acc.replace(pattern(v), '[typed]'), text);
    out = out.replace(/\b[A-HJ-NPR-Z0-9]{17}\b/gi, '[typed]').replace(/\d[\d\s().-]{4,}\d/g, '[number]');
    return out;
  }

  // The question an open dropdown list belongs to, and whether the list is a fixed one (a choice,
  // not results looked up from what was typed): by ARIA (aria-owns / aria-controls), then ExtJS
  // (the bound list's field; fixed when its store is local: typing only filters the carrier's own
  // choices, a remote store looks results up),
  // then the box the agent is in. null when none is found.
  function listOwner(list) {
    const fixedBox = (el) => !!el && (el.tagName !== 'INPUT' || el.readOnly || !String(el.value ?? '').trim());
    if (list.id) {
      const owner = deepQueryAll(document, 'input, [role=combobox]').find((el) =>
        `${el.getAttribute('aria-owns') ?? ''} ${el.getAttribute('aria-controls') ?? ''}`.split(/\s+/).includes(list.id));
      if (owner) return { label: labelFor(owner), fixed: fixedBox(owner) && owner.getAttribute('aria-autocomplete') !== 'list' };
      const cmp = ext()?.getCmp(list.id);
      const field = cmp?.pickerField ?? cmp?.ownerCmp;
      const label = field?.dctCaption ?? field?.fieldLabel ?? (field?.inputEl?.dom ? labelFor(field.inputEl.dom) : null);
      if (label) return { label, fixed: field.queryMode === 'local' && !field.remoteFilter };
    }
    const focused = document.activeElement;
    return focused && focused !== document.body && /^(INPUT|SELECT)$/.test(focused.tagName ?? '')
      ? { label: labelFor(focused), fixed: focused.tagName === 'SELECT' || !!focused.readOnly } : null;
  }

  // A captured field's choices, as the page has them loaded (never agency staff / agent-code
  // lists, which aren't page structure). Long lists are cut, and say so.
  const CAPTURE_OPTIONS = 250;
  function captureOptions(c, r) {
    const all = /agent|producer/i.test(c.label ?? '') ? [] : optionsOf(c);
    return { options: all.slice(0, CAPTURE_OPTIONS).map((o) => r(o.text)), optionsTruncated: all.length > CAPTURE_OPTIONS || undefined };
  }

  function cssPath(el) {
    const looksStable = (s) => s && !/\d{4,}|[a-f0-9]{8,}|^(mat|ng|react|ember|ext)-?/i.test(s);
    if (looksStable(el.id) && el.getRootNode().querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
    if (looksStable(el.name)) return `${el.tagName.toLowerCase()}[name="${el.name.replace(/"/g, '\\"')}"]`;
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 5; e = e.parentElement) {
      let part = e.tagName.toLowerCase();
      if (looksStable(e.id)) { parts.unshift(`#${CSS.escape(e.id)}`); break; }
      const same = e.parentElement ? [...e.parentElement.children].filter((x) => x.tagName === e.tagName) : [];
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(e) + 1})`;
      parts.unshift(part);
    }
    return parts.join(' > ');
  }

  // A step progress bar's parts (GEICO's #progressIndicator: one <gds-progress-bar> per step, in
  // the page itself, value 100 done, 0 to come).
  const stepBars = () => [...(document.querySelectorAll?.('gds-progress-bar[value]') ?? [])];

  // The bar's one part under way (0 < value < 100), by its words; '' when none or several are.
  function barStep() {
    const now = stepBars().filter((b) => { const v = Number(b.getAttribute('value')); return v > 0 && v < 100; });
    return now.length === 1 ? oneLine(now[0].textContent) : '';
  }

  // Which step of a one-address application is on screen. With a progress bar, its part under way,
  // while the page title names it too (GEICO titles each step "GEICO <step>"): the title and the
  // form were seen to be one step's while the bar was another's mid-redraw (FL capture 007), and
  // then no step is named, so nothing kept to a step is filled. Otherwise its visible headings
  // (AmWINS; GEICO's read "Dashboard" on every step).
  function stepKey() {
    if (stepBars().length) {
      const bar = barStep();
      return squash(bar) && squash(document.title).includes(squash(bar)) ? bar : '';
    }
    return deepQueryAll(document, 'h1, h2, h3').filter(isVisible).map((h) => oneLine(h.textContent)).filter(Boolean).slice(0, 4).join(' / ');
  }

  // Whether the step on screen (`key`, as stepKey reads it) is one of `names`: one of its parts
  // (headings are joined by " / ") reads as one of them.
  function stepIs(names, key = stepKey()) {
    const parts = String(key ?? '').split(' / ').map(squash).filter(Boolean);
    return [].concat(names ?? []).some((n) => !!squash(n) && parts.includes(squash(n)));
  }

  // The step of `stopSteps` (the carrier's steps that are the agent's) on screen, or ''. Any one
  // reading says so (the bar alone, the step as stepKey reads it, or the title): a stop errs on
  // the agent's side.
  function stopStepOn(stopSteps) {
    if (!stopSteps?.length) return '';
    const bar = barStep();
    const key = stepKey();
    const title = squash(document.title);
    return stopSteps.find((n) => stepIs([n], bar) || stepIs([n], key) || (!!squash(n) && title.includes(squash(n)))) ?? '';
  }

  // The questions on screen, to tell when a step that keeps the same address has changed.
  function signature() {
    return collectControls().map((c) => `${fieldKey(c)}|${c.label}`).join('\n');
  }

  // Used only locally to reject stale AI answers, never sent to a provider or usage logs.
  function decisionSnapshot() {
    return JSON.stringify([location.href, collectControls().map(c => ({ key: fieldKey(c), label: c.label, kind: c.kind,
      ...describe(c), current: c.kind === 'text' ? c.el.value : selectedText(c) }))]);
  }

  globalThis.__raterKit = { version: 90, build: BUILD, fill, progress, stop, answer, answerEdits, listed, unitList, unitListsNow, markKey, reveal, readBack, receipt, aiBanner, capture, clear, signature, decisionSnapshot, busy: pageBusy, step: stepKey, unitFormsNow };
})();
