// Plays the parts of GEICO's commercial auto quote application (sales.geico.com/quote, one address for
// every step) that the fill engine runs into, on the one-file fixture quote.html (built by
// scripts/geico-fixture.mjs from the NE pages saved 2026-10-20 and the FL captures of the same week):
// - each step is a view (<template id="view-…">) swapped into form#salesForm. Every render (a new step, a
//   new unit form, Recalculate, redraw()) renumbers the page: each Id_<Stem>_<n> gets a fresh 5-digit
//   render number, and the 32-hex container ids and coverage UUIDs are regenerated. Answering never
//   renumbers (FL runs: numbers stay put within a form, change per form);
// - the progress bar (value 100 / 50 / 0, a link for a finished step, a span for the others) and
//   document.title ("GEICO <step>") move with the step. A progress link click is recorded, goes nowhere;
// - Next shows #page-load (inline display:block) and disables the pressed button until the next view is
//   drawn; Recalculate shows #extendedWaiting;
// - the list's "+" draws the chooser (Add Driver's form) 1.2 s later with no loader, as the live page
//   did (FL live run 4, 2026-10-21); a second "+" meanwhile queues a second add (recorded, so the
//   check "added once each" fails on it);
// - gds-radio-button: one shadow input per option (so Chromium keeps each in its own radio group), the
//   host's `checked` and the group's `active-index` reflect the answer, exclusively. A click on the inner
//   input or its label fires the browser's own input (composed) and change (not composed, it never leaves
//   the shadow root); a click elsewhere in the host fires the same two from the inner input. The inner
//   inputs follow ?radio=: attribute (default; a Lit ?checked= binding, so an input once clicked keeps a
//   stale .checked), property (.checked set), redraw (the options are replaced by fresh copies after each
//   answer, so a held reference is detached);
// - gds-button: a click anywhere on the host or in its shadow root presses it; the host's disabled is
//   mirrored on the inner button (and blocks the press); Print Quote Proposal never navigates;
// - answers that draw or show questions, where a save or capture shows it:
//   DOT status Yes draws the USDOT number box (FL 001), a number of 5-8 digits shows the USDOT verify radio;
//   current insurance Yes draws years with insurer and BI limits (…InfoAlt, FL 039-040); filings Yes draws
//   the three filing boxes (FL 038), Federal Liability hides MCS-90 (FL 043); VIN handy shows or hides the
//   VIN box; Motor Truck Cargo Yes -> mobile homes -> No -> business documents -> No -> commodities and
//   the cargo limit (…Cargo, …CargoFull); Motor Truck General Liability Yes -> its four questions and its
//   limit (…withGL). Assumed, not seen: customizations Yes (vehicle) or comp/collision Yes (trailer) shows
//   the customization value, the cost without equipment and the stated amount (FL 027 shows it for a
//   tractor's comp/collision). Anything else keeps the visibility it was saved with;
// - select2 boxes: the rendered text (a list taking several: its chips) follows the hidden select; the
//   box opens a list to type in and pick from (select2's own markup), a × takes a pick off. Year resets Make and Model, Make reloads
//   Model (a moment later); the model list exists only for the saved make (data-mock-make), others get
//   VEHICLE NOT LISTED. The vehicle type list is drawn once the vehicle is known (model or VIN decode;
//   FL list), the trailer type list once the year is (synthetic, never captured);
// - a VIN in __geicoMock.decodes decodes a moment later: Year, Make, Model set, Make and Model disabled,
//   and the vehicle type and distance chosen before it cleared (GEICO redraws the form: FL live run 2,
//   2026-10-21);
// - a 5-digit ZIP draws its City list and picks the city (__geicoMock.cities, else SAMPLE CITY);
// - the address box offers a suggestion in its wrapper's shadow root, as GEICO's script draws them
//   (gds-dropdown-list#address-dropdown-list > gds-dropdown-list-item[type=address], a "listitem"; the
//   open list was never captured): the typed street with the city, state and ZIP; picking it fills
//   street, ZIP and City;
// - unit forms prefill the parking address from Business & Owner Info, as GEICO did on the FL run;
// - the unit lists: Next on a vehicle or trailer form (Save and Continue on Add Driver, Next on the
//   owner's driver form) saves the unit and draws the list, one row per unit; the add icon opens the
//   chooser (Vehicle = Yes, Trailer = No; Next without an answer stays) or Add Driver; a row's edit icon
//   opens its panel, the panel's edit icon reopens the unit's form with its answers; Discard Changes asks
//   (the trailer form's saved #action-modal), Yes discards, No keeps the form; Looks Good moves on;
// - Quote & Coverages: one row per saved vehicle under each vehicle coverage (headline: year make model
//   and VIN as saved); a comprehensive deductible lengthens that vehicle's collision, rental and road
//   service lists (…Full); any coverage or add-on change makes the quote stale (premiums "$ --.--",
//   "Please Recalculate Due To Coverage Change", Print and Next hidden, Recalculate shown); Recalculate
//   redraws the step with new numbers and UUIDs, the answers kept, and a new rated premium;
// - Final Quote Details, MVR & CLUE, Payment Information (never captured): placeholder views; every click
//   or fill there is recorded in stopActions.
// Start options: ?view=<id> (a view, at its step), ?delay=<ms> (page loads, default 400; lookups take
// half, Recalculate twice), ?radio=attribute|property|redraw, ?ssn=0 (skip the owner/SSN sub-form).
//
// What happened is kept in window.__geicoMock for the runner (scripts/geico-mock.mjs):
//   log          [{ type, view, step, target, text, isTrusted }]; type is view | click | change | input
//                | disabled (a press on a disabled button) | recalculate | decode. Clicks name
//                their target: button (text), radio (stem=value), progress, addIcon, editIcon (a row's
//                or an add-on panel's), edit-icon (reopen a unit), link, checkbox, option, other.
//                Changes name the control's key (below) and its value; the SSN's value is never logged;
//   view, step   the current view id and step name; renders: views drawn so far;
//   saved        [{ view, step, values }]: what each form held when it was left with Next, Save and
//                Continue or Looks Good (keys below);
//   units        { vehicles, trailers, drivers }: [{ form, values, seq }] per saved unit, list order;
//                form is the unit form's marker name (render number included), seq the order added;
//   business     Business & Owner Info as left (null before);
//   editing      { list, index } while a saved unit's form is reopened, else null;
//   stopActions  [{ type, view, step, target, text, isTrusted }] on stop steps (must stay empty);
//   recalcs, premium   Recalculates done and the rated premium shown ('' while stale);
//   decodes, cities    VIN -> { year, make, model } and ZIP -> city tables (change them before use);
//   options      { radio, delay, ssn };
//   values()     the current form's answers; go(view, { keep }) draws a view; redraw() redraws the
//                current view with new render numbers, the answers kept (a validation reload's effect).
// Value keys: the stem of the control's name or id (Id_<Stem>_<n>), a second group of a stem as
// <Stem>#2, filing boxes AddFilings.<Box>, coverage selects cov:<label> (policy level, by their label)
// or cov:<SUFFIX>#<n> (per vehicle, n-th of its suffix). Values are the shown text (select option,
// radio value, box checked true/false).
(() => {
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const params = new URLSearchParams(location.search);
  const delay = Math.max(0, Number(params.get('delay') ?? 400));
  const STEPS = ['Business Class & USDOT', 'Business & Owner Info', 'Vehicles', 'Drivers & Incidents', 'Additional Business Info',
    'Quote & Coverages', 'Final Quote Details', 'MVR & CLUE', 'Payment Information'];
  const STOP_VIEWS = ['final-quote-details', 'mvr-and-clue', 'payment-information'];
  const state = (window.__geicoMock = {
    log: [], view: null, step: null, renders: 0, saved: [], units: { vehicles: [], trailers: [], drivers: [] }, business: null, editing: null,
    stopActions: [], recalcs: 0, premium: '',
    decodes: { '1FTBR3X80MKA12345': { year: '2019', make: 'RAM', model: '1500' }, '1FTBR3X87MKA12399': { year: '2021', make: 'RAM', model: '2500' },
      '54DC4W1B5KS800000': { year: '2019', make: 'RAM', model: 'PROMASTER' } },
    cities: { 68102: 'OMAHA' },
    options: { radio: params.get('radio') ?? 'attribute', delay, ssn: params.get('ssn') !== '0' },
  });
  const form = $('#salesForm');
  const pageLoad = $('#page-load');
  const waiting = $('#extendedWaiting');
  const later = (ms, fn) => setTimeout(fn, ms);
  let seq = 0;
  let stale = false;
  const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const stemOf = (el) => String(el?.getAttribute?.('name') || el?.id || '').match(/^Id_([A-Za-z][A-Za-z0-9]*)_\d+/)?.[1] ?? null;
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
  const record = (entry) => {
    const e = { view: state.view, step: state.step, ...entry };
    state.log.push(e);
    if (STOP_VIEWS.includes(state.view) && e.type !== 'view') state.stopActions.push(e);
  };

  // --- Render numbers --------------------------------------------------------------------------------
  const ATTRS = ['id', 'name', 'for', 'input-id', 'group-id', 'fieldset-aria-labelledby', 'aria-controls', 'aria-labelledby', 'aria-describedby'];
  const deep = (root, acc = []) => { for (const el of root.querySelectorAll('*')) { acc.push(el); if (el.shadowRoot) deep(el.shadowRoot, acc); } return acc; };
  let next = 20011;
  const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  function renumber(root) {
    const numbers = new Map(), hexes = new Map(), uuids = new Map();
    const fresh = (map, k, make) => { if (!map.has(k)) map.set(k, make()); return map.get(k); };
    const number = () => { next = next >= 99000 ? 10007 : next + 37; return String(next); };
    for (const el of deep(root)) for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (!v) continue;
      const nv = v.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (u) => fresh(uuids, u, () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`))
        .replace(/\bId_([0-9a-f]{32})\b/g, (m, h) => `Id_${fresh(hexes, h, () => hex(32))}`)
        .replace(/(Id_(?:[A-Za-z][A-Za-z0-9]*|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_)(\d{5})/g, (m, p, n) => p + fresh(numbers, n, number));
      if (nv !== v) el.setAttribute(a, nv);
    }
  }
  // Without GEICO's stylesheet an option is no card, and a click on it can land beside its label. Each
  // option's label is laid over its host, so a click anywhere on the option reaches the label and the
  // browser passes it to the input, trusted, as on GEICO's card.
  const CARD = ':host{display:block;position:relative}label.text-wrapper{position:absolute;inset:0}';
  const cards = (root) => {
    for (const h of deep(root)) {
      if (h.tagName !== 'GDS-RADIO-BUTTON' || !h.shadowRoot || h.shadowRoot.querySelector('style[data-mock-card]')) continue;
      const style = document.createElement('style');
      style.dataset.mockCard = '';
      style.textContent = CARD;
      h.shadowRoot.append(style);
    }
  };
  const clone = (id) => { const t = document.getElementById(id); const f = document.importNode(t.content, true); renumber(f); cards(f); return f; };

  // --- Steps and views ----------------------------------------------------------------------------------
  function setStep(step) {
    const at = STEPS.indexOf(step);
    document.title = `GEICO ${step}`;
    $$('#progressIndicator gds-progress-bar').forEach((bar, j) => {
      const v = j < at ? 100 : j === at ? 50 : 0;
      bar.setAttribute('value', String(v));
      bar.shadowRoot?.querySelector('progress')?.setAttribute('value', String(v));
      for (const c of [...bar.children]) if (c.tagName !== 'TEMPLATE') c.remove();
      const label = document.createElement(j < at ? 'a' : 'span');
      label.textContent = STEPS[j];
      if (j < at) Object.assign(label, { href: '#', tabIndex: 0 }), label.setAttribute('role', 'button'), label.className = '';
      bar.append(label);
    });
  }
  const ENTER = {};
  function render(id, { keep = null, step = null } = {}) {
    const tpl = document.getElementById(`view-${id}`);
    closeList();
    form.replaceChildren(clone(`view-${id}`));
    state.view = id;
    state.step = step ?? tpl.dataset.step;
    state.renders++;
    stale = false;
    setStep(state.step);
    ENTER[id]?.();
    // Once Business & Owner Info is left, the summary panel shows its contact details.
    if (state.business) summary();
    if (keep) restore(keep);
    mirrorAll();
    record({ type: 'view', target: id, text: state.step, isTrusted: false });
  }
  // A press that loads the next view: GEICO disables the button and shows its loader meanwhile.
  function go(id, { keep = null, button = null, ms = delay } = {}) {
    if (button) button.setAttribute('disabled', '');
    pageLoad.style.display = 'block';
    later(ms, () => { render(id, { keep }); pageLoad.style.display = ''; window.scrollTo(0, 0); });
  }
  state.go = (id, opts = {}) => render(id, opts);
  state.redraw = () => render(state.view, { keep: values(), step: state.step });

  // --- Answers: read and put back -----------------------------------------------------------------------
  const isCoverage = (el) => UUID.test(el.id ?? '') && /^Id_/.test(el.id);
  const suffixOf = (el) => (el.id.match(/_\d+_([A-Za-z]+)$/) ?? [])[1] ?? null;
  const labelFor = (el) => { const l = $$('[for]', form).find((x) => x.getAttribute('for') === el.id); return l ? oneLine(l.querySelector('span')?.textContent ?? l.textContent) : ''; };
  function keyed() {
    const out = [];
    const seen = {};
    const add = (key, el, kind) => { seen[key] = (seen[key] ?? 0) + 1; out.push({ key: seen[key] > 1 ? `${key}#${seen[key]}` : key, el, kind }); };
    const covN = {};
    for (const el of $$('gds-radio-button-group, input:not([type=hidden]), select, textarea', form)) {
      if (el.matches('gds-radio-button-group')) { const s = stemOf(el); if (s) add(s, el, 'radio'); continue; }
      if (el.closest('gds-radio-button-group') || el.classList.contains('select2-search__field')) continue;
      if (el.type === 'checkbox') { const box = el.id.match(/^checkbox-Id_([A-Za-z]+)_\d+-([A-Za-z0-9]+)$/); add(box ? `${box[1]}.${box[2]}` : stemOf(el) ?? el.id, el, 'box'); continue; }
      if (isCoverage(el)) {
        const sfx = suffixOf(el);
        const label = sfx ? '' : labelFor(el);
        if (sfx) { covN[sfx] = (covN[sfx] ?? 0) + 1; out.push({ key: `cov:${sfx}#${covN[sfx]}`, el, kind: 'select' }); } else add(`cov:${label || el.id}`, el, 'select');
        continue;
      }
      const s = stemOf(el);
      if (s) add(s, el, el.tagName === 'SELECT' ? 'select' : 'text');
    }
    return out;
  }
  const optionText = (sel) => (sel.multiple ? [...sel.selectedOptions].map((o) => oneLine(o.textContent)) : sel.value === '' ? '' : oneLine(sel.selectedOptions[0]?.textContent));
  const checkedHost = (group) => $$(':scope > gds-radio-button', group).find((o) => o.hasAttribute('checked'));
  function valueOf({ el, kind }) {
    if (kind === 'radio') return checkedHost(el)?.getAttribute('value') ?? '';
    if (kind === 'box') return el.checked;
    if (kind === 'select') return optionText(el);
    return el.value;
  }
  function values() { const out = {}; for (const k of keyed()) out[k.key] = valueOf(k); return out; }
  state.values = values;
  // Put answers back after a redraw, in passes: an answer may draw the next question (DOT number box,
  // current insurer's selects, cargo limit), whose answer is then restored too.
  function restore(saved) {
    const done = new Set();
    for (let pass = 0; pass < 4; pass++) {
      let any = false;
      for (const order of ['radio', 'box', 'text', 'select']) {
        for (const k of keyed()) {
          if (k.kind !== order || done.has(k.key) || !(k.key in saved)) continue;
          done.add(k.key);
          any = true;
          const v = saved[k.key];
          if (k.kind === 'radio') { const host = $$(':scope > gds-radio-button', k.el).find((o) => o.getAttribute('value') === v); if (host) choose(host, null, { quiet: true }); } else if (k.kind === 'box') { k.el.checked = !!v; react(k.el, { sync: true }); } else if (k.kind === 'text') { k.el.value = v ?? ''; react(k.el, { sync: true }); } else { setSelect(k.el, v); react(k.el, { sync: true }); }
        }
      }
      if (!any) break;
    }
  }
  function setSelect(sel, text) {
    for (const o of sel.options) o.selected = sel.multiple ? [].concat(text ?? []).includes(oneLine(o.textContent)) : false;
    if (!sel.multiple) {
      const want = [...sel.options].find((o) => o.value !== '' && oneLine(o.textContent) === oneLine(text));
      sel.value = want ? want.value : '';
    }
    paintSelect2(sel);
  }

  // --- Visibility helpers -------------------------------------------------------------------------------
  // A question's box: the nearest container GEICO ids with a 32-hex id (a #salesForm child, or a question
  // inside an add-on panel). Hiding hides the box; showing clears hide/hidden between the control and it.
  const boxOf = (el) => { for (let p = el; p && p !== form; p = p.parentElement) if (/^Id_[0-9a-f]{32}$/.test(p.id ?? '')) return p; return null; };
  const controlsOf = (stem) => $$('gds-radio-button-group, input, select, textarea', form).filter((el) => stemOf(el) === stem);
  function setShown(stem, on) {
    for (const el of controlsOf(stem)) {
      const box = boxOf(el);
      if (!box) continue;
      if (on) for (let p = el; p && p !== box.parentElement; p = p.parentElement) p.classList?.remove('hide', 'hidden');
      else box.classList.add('hide');
    }
  }
  const slot = (name) => $(`[data-mock-slot="${name}"]`, form);
  const fill = (name, frag) => { const s = slot(name); if (s && !s.firstElementChild) s.append(clone(`frag-${frag ?? name}`)); return s; };
  const empty = (name) => { const s = slot(name); if (s) s.replaceChildren(); };

  // --- select2 ------------------------------------------------------------------------------------------
  function paintSelect2(sel) {
    if (sel.multiple) return paintChips(sel);
    const shown = $(`#select2-${CSS.escape(sel.id)}-container`, form) ?? sel.parentElement?.querySelector('.select2-selection__rendered');
    if (!shown) return;
    const text = optionText(sel);
    if (text) { shown.textContent = text; shown.title = text; } else { shown.replaceChildren(Object.assign(document.createElement('span'), { className: 'select2-selection__placeholder', textContent: 'Please Select' })); shown.removeAttribute('title'); }
    const box = sel.parentElement?.querySelector('.select2-container');
    box?.classList.toggle('select2-container--disabled', sel.disabled);
    box?.querySelector('.select2-selection')?.setAttribute('aria-disabled', String(sel.disabled));
  }
  // A list taking several picks shows each as a chip with its ×, before its own search box.
  function paintChips(sel) {
    const rendered = sel.parentElement?.querySelector('.select2-selection--multiple .select2-selection__rendered');
    if (!rendered) return;
    rendered.querySelectorAll('.select2-selection__choice').forEach((li) => li.remove());
    const inline = rendered.querySelector('.select2-search--inline');
    for (const o of sel.selectedOptions) {
      const li = Object.assign(document.createElement('li'), { className: 'select2-selection__choice', title: oneLine(o.textContent) });
      li.append(Object.assign(document.createElement('span'), { className: 'select2-selection__choice__remove', textContent: '×' }), oneLine(o.textContent));
      rendered.insertBefore(li, inline);
    }
  }
  // The open list (never captured; select2 v4's own markup, as GEICO's page loads it): a left-button
  // mousedown on a list's box opens it (a click on one taking several picks, or typing in its own
  // box), drawn at the end of the page with a search box (one taking several types in its own),
  // its results named after the <select> and narrowed to what is typed. A mouseup on a result picks
  // it (on a list taking several, one picked already is taken off) and closes the list, and the
  // <select> changes (the page reads only select2's own pick: FL live run 6, 2026-10-21; a change
  // set on the <select> by script is taken here too, as the agent's pickList does). A × takes its
  // pick off; a mousedown elsewhere or Escape closes the list.
  let dropdown = null;
  const ownList = (n) => {
    const sel = n?.closest?.('.select2-container')?.previousElementSibling;
    return sel?.matches?.('select.select2-hidden-accessible') && form.contains(sel) ? sel : null;
  };
  function closeList() {
    if (!dropdown) return;
    dropdown.select.parentElement?.querySelector('.select2-container')?.classList.remove('select2-container--open');
    dropdown.el.remove();
    dropdown = null;
  }
  function openList(sel) {
    closeList();
    if (sel.disabled) return;
    const el = document.createElement('span');
    el.className = 'select2-container select2-container--default select2-container--open';
    el.innerHTML = `<span class="select2-dropdown select2-dropdown--below">${sel.multiple ? '' : '<span class="select2-search select2-search--dropdown"><input class="select2-search__field" type="search" autocomplete="off"></span>'}<span class="select2-results"><ul class="select2-results__options" role="listbox"></ul></span></span>`;
    $('ul', el).id = `select2-${sel.id}-results`;
    document.body.append(el);
    sel.parentElement?.querySelector('.select2-container')?.classList.add('select2-container--open');
    dropdown = { el, select: sel };
    listResults('');
  }
  function listResults(typed) {
    const want = oneLine(typed).toLowerCase();
    const items = [...dropdown.select.options].filter((o) => oneLine(o.textContent) && !/^please select$/i.test(oneLine(o.textContent)) && oneLine(o.textContent).toLowerCase().includes(want))
      .map((o) => {
        const li = Object.assign(document.createElement('li'), { className: 'select2-results__option', textContent: oneLine(o.textContent) });
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(o.selected));
        li.mockOption = o;
        return li;
      });
    $('ul', dropdown.el).replaceChildren(...items);
  }
  function pickResult(li) {
    const sel = dropdown.select;
    if (sel.multiple) li.mockOption.selected = !li.mockOption.selected; else sel.value = li.mockOption.value;
    closeList();
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const byStem = (stem) => $$('select, input', form).find((el) => stemOf(el) === stem);
  const SAVED_MODELS = new WeakMap();
  function setDisabled(sel, on) { if (sel) { sel.disabled = on; paintSelect2(sel); } }
  function resetSelect(sel) { if (sel) { sel.value = ''; paintSelect2(sel); } }
  function drawTypes() {
    const type = byStem('GiveOtherVehicleType');
    if (!type || type.options.length > 1) return;
    const trailer = /\btrailer\b/i.test(type.getAttribute('aria-label') ?? '');
    type.append(clone(trailer ? 'frag-trailer-types' : 'frag-vehicle-types'));
  }
  function modelsFor(make, { sync }) {
    const model = byStem('GiveModel');
    if (!model) return;
    if (!SAVED_MODELS.has(model)) SAVED_MODELS.set(model, [...model.options].map((o) => o.cloneNode(true)));
    resetSelect(model);
    setDisabled(model, true);
    const draw = () => {
      const saved = SAVED_MODELS.get(model);
      const list = make && make.toUpperCase() === (model.dataset.mockMake ?? '').toUpperCase() ? saved : saved.filter((o) => o.value === '' || /vehicle not listed/i.test(o.textContent));
      model.replaceChildren(...list.map((o) => o.cloneNode(true)));
      model.value = '';
      setDisabled(model, false);
    };
    if (sync) draw(); else later(delay / 2, draw);
  }
  function decode(vin, { sync }) {
    const d = state.decodes[vin];
    if (!d) return;
    const apply = () => {
      if (byStem('GiveVinPreQuote')?.value !== vin) return;
      for (const stem of ['GiveOtherVehicleType', 'GiveFarthestOneWayDistance']) if (byStem(stem)) setSelect(byStem(stem), '');
      setSelect(byStem('GiveYear'), d.year);
      const make = byStem('GiveMake');
      setSelect(make, d.make);
      modelsFor(d.make, { sync: true });
      setSelect(byStem('GiveModel'), d.model);
      setDisabled(make, true);
      setDisabled(byStem('GiveModel'), true);
      drawTypes();
      record({ type: 'decode', target: 'GiveVinPreQuote', text: `${d.year} ${d.make} ${d.model}`, isTrusted: false });
    };
    if (sync) apply(); else later(delay / 2, apply);
  }
  function cityFor(zipBox, { sync }) {
    const city = $$('select', boxOf(zipBox)?.parentElement ?? form).find((el) => stemOf(el) === 'GiveCity') ?? byStem('GiveCity');
    if (!city || !/^\d{5}$/.test(zipBox.value)) return;
    const name = state.cities[zipBox.value] ?? 'SAMPLE CITY';
    const draw = () => {
      const keep = city.options[0];
      const opt = (t) => Object.assign(document.createElement('option'), { value: t, textContent: t });
      city.replaceChildren(keep, opt(name), opt('OTHER'));
      city.value = name;
    };
    if (sync) draw(); else later(delay / 2, draw);
  }

  // --- Reactions to answers ----------------------------------------------------------------------------
  const CUSTOMIZATION = ['GiveTotalCustomizationValue', 'GiveCostExcludingPermanentlyAttachedEquipment', 'GiveStatedAmount'];
  const MTC = ['GiveMtcRequireCoverageForMobileHomesYesNo', 'GiveMtcRequireCoverageForBusinessDocumentYesNo', 'GiveMtcHaulingCommoditiesCollect'];
  const GL = ['GiveIncomeOnlyFromTruckingOperation', 'GiveOperateFromWarehouseOrOtherAccessiblePremises', 'GiveInvolvedInAnySetupOrInstallation', 'GiveOperateOrInvolvedInAnyWayForOilGasProduction'];
  function answered(stem, value, { sync = false } = {}) {
    if (stem === 'YesNoPreQuoteHaveFullVinActivity') setShown('GiveVinPreQuote', value === 'Yes');
    if (stem === 'GiveDepartmentOfTransportationNumberStatus' && slot('usdot-number')) {
      if (value === 'Yes') fill('usdot-number'); else { empty('usdot-number'); setShown('GiveExtendUsDotVerifyBusinessAddress', false); }
    }
    if (stem === 'GiveHasFilingsYesNo') { if (value === 'Yes') fill('add-filings'); else empty('add-filings'); }
    if (stem === 'GiveAnyVehicleCustomizationYesNo' || (stem === 'GiveCommercialVehicleCompCollision' && state.view === 'trailer-form')) for (const s of CUSTOMIZATION) setShown(s, value === 'Yes');
    if (stem === 'GiveMtcEligibleRequireCoverageYesNo') {
      setShown(MTC[0], value === 'Yes');
      if (value !== 'Yes') { setShown(MTC[1], false); setShown(MTC[2], false); empty('mtc-limit'); }
    }
    if (stem === MTC[0]) { setShown(MTC[1], value === 'No'); if (value !== 'No') { setShown(MTC[2], false); empty('mtc-limit'); } }
    if (stem === MTC[1]) { setShown(MTC[2], value === 'No'); if (value === 'No') fill('mtc-limit'); else empty('mtc-limit'); }
    if (stem === 'GiveMotorTruckGeneralLiabilityCoverageRequired') { for (const s of GL) setShown(s, value === 'Yes'); if (value === 'Yes') fill('gl-limit'); else empty('gl-limit'); }
    if (state.view === 'quote' && stem !== 'GivePayPlanV2' && !sync) makeStale();
  }
  // Text boxes, selects and boxes (their change reaches the document; a radio's does not).
  function react(el, { sync = false } = {}) {
    const stem = stemOf(el);
    if (el.classList.contains('select2-hidden-accessible')) paintSelect2(el);
    if (stem === 'GiveDepartmentOfTransportationNumber') {
      const ok = /^\d{5,8}$/.test(el.value);
      if (sync) setShown('GiveExtendUsDotVerifyBusinessAddress', ok); else later(delay / 2, () => setShown('GiveExtendUsDotVerifyBusinessAddress', ok));
    }
    if (stem === 'GiveCurrentAutoInsuranceStatus') {
      if (optionText(el) === 'Yes') { fill('insurer-years'); fill('insurer-limits'); } else { empty('insurer-years'); empty('insurer-limits'); }
    }
    if (el.type === 'checkbox' && /-FederalLiability$/.test(el.id)) {
      const mcs = $$('input[type=checkbox]', form).find((b) => /-MCS90$/.test(b.id));
      if (mcs) { mcs.parentElement.classList.toggle('hide', el.checked); if (el.checked) mcs.checked = false; }
    }
    if (stem === 'GiveYear' && !sync) {
      const make = byStem('GiveMake');
      // Make is drawn disabled until a year is picked, then opens a moment later (Model emptied); a
      // decoded Make (disabled with its value) stays as the decode left it.
      if (make && !(make.disabled && make.value)) { resetSelect(make); setDisabled(make, true); resetSelect(byStem('GiveModel')); later(delay / 2, () => setDisabled(make, false)); }
      if (!make) drawTypes();
    }
    if (stem === 'GiveYear' && sync && !byStem('GiveMake')) drawTypes();
    if (stem === 'GiveMake' && !el.disabled) modelsFor(optionText(el), { sync });
    if (stem === 'GiveModel' && el.value) drawTypes();
    if (stem === 'GiveVinPreQuote' && el.value.length === 17) decode(el.value, { sync });
    if (stem === 'GiveZip' || stem === 'GiveInitialZipCode') cityFor(el, { sync });
    if (CUSTOMIZATION.slice(0, 2).includes(stem)) {
      const n = (s) => Number(String(byStem(s)?.value ?? '').replace(/[^\d.]/g, '')) || 0;
      const total = byStem('GiveStatedAmount');
      if (total) total.value = String(n(CUSTOMIZATION[0]) + n(CUSTOMIZATION[1]) || '');
    }
    if (state.view === 'quote' && isCoverage(el)) {
      // A collision, rental or road service row's options follow its comprehensive a moment later
      // (FL live run 2: the fill tried collision before GEICO drew its deductibles).
      if (suffixOf(el) === 'COMP') { if (sync) lengthen(el); else later(delay, () => lengthen(el)); }
      if (!sync) makeStale();
    } else if (state.view === 'quote' && el.closest('ul.expandable-form') && !sync) makeStale();
  }

  // --- Radios -------------------------------------------------------------------------------------------
  function choose(host, e, { quiet = false } = {}) {
    const group = host.closest('gds-radio-button-group');
    if (!group || host.hasAttribute('disabled')) return;
    const options = $$(':scope > gds-radio-button', group);
    const input = host.shadowRoot?.querySelector('input');
    const mode = state.options.radio;
    options.forEach((o) => {
      const on = o === host;
      o.toggleAttribute('checked', on);
      const i = o.shadowRoot?.querySelector('input');
      if (!i) return;
      if (mode === 'property') i.checked = on; else i.toggleAttribute('checked', on);
    });
    group.setAttribute('active-index', String(options.indexOf(host)));
    // The browser fires these itself when the click was on the input or its label.
    if (e && input && e.composedPath()[0] !== input) {
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const stem = stemOf(group), value = host.getAttribute('value');
    if (!quiet) record({ type: 'change', target: stem, text: value, isTrusted: !!e?.isTrusted });
    answered(stem, value, { sync: quiet });
    // The redraw comes after the page's own handlers (and the browser's input and change), as a re-render would.
    if (mode === 'redraw') later(0, () => { for (const o of options) { if (!o.isConnected) continue; const c = o.cloneNode(true); o.replaceWith(c); const i = c.shadowRoot?.querySelector('input'); if (i) i.checked = c.hasAttribute('checked'); } });
  }

  // --- Buttons ------------------------------------------------------------------------------------------
  // The host's disabled is mirrored on the inner button, whoever sets it.
  const mirror = (host) => {
    const on = host.hasAttribute('disabled');
    for (const b of host.shadowRoot?.querySelectorAll('button, a') ?? []) { b.toggleAttribute('disabled', on && b.tagName === 'BUTTON'); b.setAttribute('aria-disabled', String(on)); }
  };
  const mirrorAll = () => $$('gds-button', form).forEach(mirror);
  new MutationObserver((list) => { for (const m of list) if (m.target.tagName === 'GDS-BUTTON') mirror(m.target); }).observe(form, { attributes: true, attributeFilter: ['disabled'], subtree: true });
  const textOf = (host) => oneLine(host.textContent);
  const modal = () => $('#action-modal', form) ?? (() => { const m = clone('view-trailer-form').querySelector('#action-modal'); form.append(m); return m; })();
  const openModal = (on) => { const m = modal(); m.style.display = on ? 'block' : ''; m.classList.toggle('modal--show', on); };
  function snapshotForm() { const v = values(); state.saved.push({ view: state.view, step: state.step, values: v }); return v; }
  const MARKERS = { vehicles: 'YesNoPreQuoteHaveFullVinActivity', trailers: 'GiveOtherVehicleType', drivers: 'GiveDriverRelationshipToBusiness' };
  function saveUnit(list) {
    const v = snapshotForm();
    const marker = $$('gds-radio-button-group, select', form).find((el) => stemOf(el) === MARKERS[list]) ?? $$('select, gds-radio-button-group', form).find((el) => stemOf(el) === 'GiveDriverLicenseState');
    const formId = marker ? (marker.matches('gds-radio-button-group') ? $(':scope > gds-radio-button', marker)?.getAttribute('name') : marker.getAttribute('name') || marker.id) : null;
    if (state.editing?.list === list) state.units[list][state.editing.index] = { ...state.units[list][state.editing.index], form: formId, values: v };
    else state.units[list].push({ form: formId, values: v, seq: ++seq });
    state.editing = null;
  }
  const FLOW = { 'business-class': 'business-owner', 'owner-verification': 'vehicle-form', 'business-info': 'quote', quote: 'final-quote-details', 'final-quote-details': 'mvr-and-clue', 'mvr-and-clue': 'payment-information' };
  function press(host, e) {
    const text = textOf(host);
    if (host.hasAttribute('disabled')) { e.preventDefault(); e.stopPropagation(); record({ type: 'disabled', target: 'button', text, isTrusted: e.isTrusted }); return; }
    record({ type: 'click', target: 'button', text, isTrusted: e.isTrusted });
    if (/^print quote proposal$/i.test(text) || host.hasAttribute('href')) { e.preventDefault(); return; }
    const v = state.view;
    if (/^(next|save and continue)$/i.test(text)) {
      if (STOP_VIEWS.includes(v)) { if (FLOW[v]) go(FLOW[v], { button: host }); return; }
      if (v === 'vehicle-or-trailer') {
        const pick = checkedHost($('gds-radio-button-group', form) ?? form)?.getAttribute('value');
        if (pick) go(pick === 'No' ? 'trailer-form' : 'vehicle-form', { button: host });
        return;
      }
      if (v === 'business-owner') { state.business = snapshotForm(); return go(state.options.ssn ? 'owner-verification' : 'vehicle-form', { button: host }); }
      if (v === 'vehicle-form') { saveUnit('vehicles'); return go('vehicle-list', { button: host }); }
      if (v === 'trailer-form') { saveUnit('trailers'); return go('vehicle-list', { button: host }); }
      if (v === 'owner-driver' || v === 'add-driver') { saveUnit('drivers'); return go('driver-list', { button: host }); }
      if (FLOW[v]) { snapshotForm(); go(FLOW[v], { button: host }); }
      return;
    }
    if (/^looks good$/i.test(text)) { snapshotForm(); return go(v === 'vehicle-list' ? 'owner-driver' : 'business-info', { button: host }); }
    if (/^recalculate$/i.test(text) && v === 'quote') return recalculate(host);
    if (/^cancel$/i.test(text) && v === 'vehicle-or-trailer') return go('vehicle-list', { button: host });
    if (/^discard changes$/i.test(text)) return openModal(true);
    if (/^yes, please discard\.?$/i.test(text)) { openModal(false); const list = v === 'add-driver' ? 'driver-list' : 'vehicle-list'; state.editing = null; return go(list, { button: host }); }
    if (/^no, please don.t discard\.?$/i.test(text)) return openModal(false);
  }

  // --- Unit lists ---------------------------------------------------------------------------------------
  const unitTitle = (list, u) => {
    const t = u.values;
    if (list === 'drivers') return { names: [t.GiveFirstName || state.business?.GiveFirstName || '', t.GiveLastName || state.business?.GiveLastName || ''], sub: t.GiveDriverRelationshipToBusiness || 'Owner' };
    return { type: t.GiveOtherVehicleType || (list === 'trailers' ? 'Trailer' : 'Vehicle'), vin: t.GiveVinPreQuote || '', line: [t.GiveYear, t.GiveMake, t.GiveModel].filter(Boolean).join(' ') };
  };
  function drawList(lists) {
    const row = $('li[data-mock="unit-row"]', form);
    const units = lists.flatMap((list) => state.units[list].map((u, index) => ({ list, index, u }))).sort((a, b) => a.u.seq - b.u.seq);
    if (!row || !units.length) return;
    for (const { list, index, u } of units) {
      const li = row.cloneNode(true);
      li.dataset.mockUnit = `${list}:${index}`;
      const t = unitTitle(list, u);
      const h4 = $('p.h4', li), sub = $('p:not(.h4)', li);
      if (list === 'drivers') {
        const spans = $$('span[data-qm-encrypt]', h4);
        if (spans[0]) spans[0].textContent = t.names[0];
        if (spans[1]) spans[1].textContent = t.names[1];
        if (sub) sub.textContent = t.sub;
      } else {
        h4.firstChild.textContent = t.type;
        const vin = $('span[data-qm-encrypt]', h4);
        if (vin) vin.textContent = t.vin;
        if (!t.vin) $('strong', h4)?.remove();
        if (sub) sub.textContent = ` ${t.line} `;
      }
      row.before(li);
    }
    row.remove();
  }
  const togglePanel = (li, on = !li.classList.contains('expanded')) => {
    const panel = $(':scope > .expandable-form-content-container', li);
    li.classList.toggle('expanded', on);
    if (panel) { panel.setAttribute('aria-hidden', String(!on)); panel.style.display = on ? 'block' : ''; }
    $('.expandable-form-edit-icon, .expandable-form-view-icon', li)?.setAttribute('aria-expanded', String(on));
  };
  function reopen(li) {
    const [list, i] = String(li.dataset.mockUnit ?? '').split(':');
    const u = state.units[list]?.[Number(i)];
    if (!u) return;
    state.editing = { list, index: Number(i) };
    const view = list === 'vehicles' ? 'vehicle-form' : list === 'trailers' ? 'trailer-form' : u.values.GiveDriverRelationshipToBusiness === undefined ? 'owner-driver' : 'add-driver';
    go(view, { keep: u.values });
  }

  // --- Quote & Coverages --------------------------------------------------------------------------------
  const BASE_OPTIONS = new WeakMap();
  function lengthen(comp) {
    const n = $$('select', form).filter((s) => isCoverage(s) && suffixOf(s) === 'COMP').indexOf(comp);
    const on = optionText(comp) !== '' && !/^not included$/i.test(optionText(comp));
    for (const sfx of ['COLL', 'Rental', 'ERS']) {
      const sel = $$('select', form).filter((s) => isCoverage(s) && suffixOf(s) === sfx)[n];
      if (!sel) continue;
      if (!BASE_OPTIONS.has(sel)) BASE_OPTIONS.set(sel, [...sel.options].map((o) => o.cloneNode(true)));
      const keep = optionText(sel);
      const opts = on ? [...clone(`frag-options-${sfx}`).children] : BASE_OPTIONS.get(sel).map((o) => o.cloneNode(true));
      sel.replaceChildren(...opts);
      setSelect(sel, keep);
    }
  }
  function makeStale() {
    if (stale || state.view !== 'quote') return;
    stale = true;
    state.premium = '';
    const hide = (el) => el?.classList.add('hide');
    hide(slot('term')?.firstElementChild);
    fill('stale-card');
    const pay = slot('pay');
    hide(pay?.querySelector('.pricing-cards-wrapper'));
    hide(pay?.querySelector('gds-radio-button-group')?.parentElement);
    hide(slot('pay-in-full')?.firstElementChild);
    $$('.itemized-premium', form).forEach(hide);
    hide(slot('rated'));
    slot('recalc')?.classList.remove('hide');
  }
  function recalculate(host) {
    const keep = values();
    host.setAttribute('disabled', '');
    waiting.style.display = 'block';
    later(delay * 2, () => {
      state.recalcs++;
      render('quote', { keep });
      waiting.style.display = '';
      record({ type: 'recalculate', target: 'button', text: state.premium, isTrusted: false });
    });
  }
  // A rated premium per Recalculate: every amount on the step moves by $50.00 a time (fakes all along).
  function reprice() {
    if (!state.recalcs) return;
    const walker = document.createTreeWalker(form, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (t.parentElement?.closest('option, select')) continue;
      t.nodeValue = t.nodeValue.replace(/\$(\d{1,3}(?:,\d{3})*)\.(\d{2})/g, (m, d) => `$${(Number(d.replace(/,/g, '')) + 50 * state.recalcs).toLocaleString('en-US')}.00`);
    }
  }
  function vehicleRows() {
    const vehicles = state.units.vehicles;
    if (!vehicles.length) return;
    for (const sel of $$('select', form).filter((s) => isCoverage(s) && suffixOf(s))) {
      const row = sel.closest('.row');
      if (!row) continue;
      vehicles.forEach((u, i) => {
        const copy = i ? row.cloneNode(true) : row;
        if (i) { renumber(copy); row.parentElement.append(copy); }
        const head = $('gds-section-header strong', copy);
        if (head) {
          const t = unitTitle('vehicles', u);
          head.replaceChildren(document.createTextNode(` ${t.line} `), document.createElement('br'), Object.assign(document.createElement('span'), { textContent: t.vin }));
          head.lastChild.setAttribute('data-qm-encrypt', 'true');
        }
      });
    }
  }

  // --- Entering a view ----------------------------------------------------------------------------------
  const ownerFirst = () => state.business?.GiveFirstName;
  const nameSpans = () => {
    const first = ownerFirst();
    if (!first) return;
    for (const s of $$('gds-section-header span[data-qm-encrypt], gds-label-legend span[data-qm-encrypt]', form)) s.textContent = first;
    for (const el of $$('[aria-label*="data-qm-encrypt"]', form)) el.setAttribute('aria-label', el.getAttribute('aria-label').replace(/(<span[^>]*>)[^<]*(<\/span>)/, `$1${first}$2`));
  };
  function prefillAddress() {
    const b = state.business;
    if (!b) return;
    const street = byStem('GiveStreet'), zip = byStem('GiveZip');
    if (street && b.GiveStreet) street.value = b.GiveStreet;
    if (zip && b.GiveZip) { zip.value = b.GiveZip; cityFor(zip, { sync: true }); }
  }
  ENTER['vehicle-form'] = prefillAddress;
  ENTER['trailer-form'] = prefillAddress;
  ENTER['vehicle-list'] = () => drawList(['vehicles', 'trailers']);
  ENTER['driver-list'] = () => drawList(['drivers']);
  ENTER['owner-driver'] = nameSpans;
  ENTER.quote = () => { nameSpans(); vehicleRows(); reprice(); state.premium = oneLine(slot('rated')?.querySelector('p')?.textContent); };
  function summary() {
    const b = state.business;
    if (!b) return;
    for (const li of $$('#consolidated-summary-component li')) {
      const [label, value] = li.children;
      const v = /contact number/i.test(label?.textContent) ? b.GivePhoneNumber : /^\s*email\s*$/i.test(label?.textContent) ? b.GiveEmail : null;
      if (v != null && value?.firstElementChild) value.firstElementChild.textContent = v;
    }
  }

  // --- Address suggestions (GEICO's markup from its script: the open list was never captured) ---------------
  let suggest = null;
  function suggestions(box) {
    suggest?.remove();
    suggest = null;
    const q = box.value.trim();
    if (q.length < 3) return;
    const zip = Object.keys(state.cities)[0] ?? '68102';
    const street = q.split(',')[0].trim();
    suggest = document.createElement('gds-dropdown-list');
    suggest.id = box.getAttribute('aria-controls') || 'address-dropdown-list';
    suggest.setAttribute('role', 'listbox');
    suggest.setAttribute('aria-label', 'Address suggestions');
    const item = Object.assign(document.createElement('gds-dropdown-list-item'), { textContent: `${street}, ${state.cities[zip] ?? 'SAMPLE CITY'}, NE ${zip} US` });
    item.setAttribute('type', 'address');
    item.setAttribute('role', 'listitem');
    item.dataset.index = '0';
    item.dataset.street = street;
    item.dataset.zip = zip;
    suggest.append(item);
    suggest.box = box;
    box.setAttribute('aria-expanded', 'true');
    const container = box.closest('gds-address-auto-complete-wrapper')?.shadowRoot?.querySelector('.dropdown-container');
    if (container) container.append(suggest); else box.closest('gds-input-wrapper, div')?.after(suggest);
  }
  function pickSuggestion(li) {
    const box = suggest.box;
    box.value = li.dataset.street;
    box.setAttribute('aria-expanded', 'false');
    const zip = byStem('GiveZip');
    if (zip) { zip.value = li.dataset.zip; cityFor(zip, { sync: true }); }
    suggest.remove();
    suggest = null;
  }

  // --- Events -------------------------------------------------------------------------------------------
  // select2 (above): its box opens on a left-button mousedown (toggles), a result is picked on mouseup.
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const path = e.composedPath();
    if (dropdown && path.includes(dropdown.el)) return;
    const single = path.find((n) => n.classList?.contains('select2-selection--single'));
    const sel = ownList(single);
    if (sel && dropdown?.select === sel) return closeList();
    if (sel) return openList(sel);
    if (!path.some((n) => n.classList?.contains('select2-selection--multiple'))) closeList();
  }, true);
  document.addEventListener('mouseup', (e) => {
    if (e.button !== 0 || !dropdown) return;
    const li = e.composedPath().find((n) => n.classList?.contains('select2-results__option'));
    if (li && dropdown.el.contains(li)) pickResult(li);
  }, true);
  document.addEventListener('click', (e) => {
    const path = e.composedPath();
    const remove = path.find((n) => n.classList?.contains('select2-selection__choice__remove'));
    const sel = ownList(remove ?? path.find((n) => n.classList?.contains('select2-selection--multiple')));
    if (!sel) return;
    if (remove) {
      const o = [...sel.options].find((x) => oneLine(x.textContent) === remove.parentElement.title);
      if (o) { o.selected = false; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    } else if (dropdown?.select !== sel) openList(sel);
  }, true);
  document.addEventListener('keydown', (e) => { if (dropdown && e.key === 'Escape') closeList(); }, true);
  document.addEventListener('click', (e) => {
    const path = e.composedPath();
    const progress = path.find((n) => n.tagName === 'A' && n.closest?.('#progressIndicator'));
    if (progress) { e.preventDefault(); return record({ type: 'click', target: 'progress', text: oneLine(progress.textContent), isTrusted: e.isTrusted }); }
    const option = path.find((n) => n.tagName === 'GDS-DROPDOWN-LIST-ITEM' && n.dataset?.street != null);
    if (option) { record({ type: 'click', target: 'option', text: oneLine(option.textContent), isTrusted: e.isTrusted }); return pickSuggestion(option); }
    const radio = path.find((n) => n.tagName === 'GDS-RADIO-BUTTON');
    if (radio) {
      // A click on the option's label is passed to its input by the browser: that click answers.
      if (path.some((n) => n.tagName === 'LABEL' && n.getRootNode?.() === radio.shadowRoot) && path[0] !== radio.shadowRoot?.querySelector('input')) return;
      record({ type: 'click', target: 'radio', text: `${stemOf(radio.closest('gds-radio-button-group'))}=${radio.getAttribute('value')}`, isTrusted: e.isTrusted });
      return choose(radio, e);
    }
    const button = path.find((n) => n.tagName === 'GDS-BUTTON');
    if (button) return press(button, e);
    const icon = path.find((n) => ['addIcon', 'edit-icon', 'editIcon'].includes(n.getAttribute?.('data-testid')) || n.classList?.contains('expandable-form-edit-icon') || n.classList?.contains('expandable-form-view-icon'));
    if (icon) {
      const id = icon.getAttribute('data-testid');
      const li = icon.closest('li[data-mock-unit], li.expandable-form, li');
      if (id === 'addIcon') {
        record({ type: 'click', target: 'addIcon', text: '', isTrusted: e.isTrusted });
        state.editing = null;
        const to = state.view === 'vehicle-list' ? 'vehicle-or-trailer' : state.view === 'driver-list' ? 'add-driver' : state.view;
        return later(1200, () => render(to));
      }
      if (id === 'edit-icon') { record({ type: 'click', target: 'edit-icon', text: '', isTrusted: e.isTrusted }); return reopen(icon.closest('li[data-mock-unit]') ?? li); }
      record({ type: 'click', target: 'editIcon', text: '', isTrusted: e.isTrusted });
      return togglePanel(icon.closest('ul.expandable-form > li') ?? li);
    }
    const plain = path.find((n) => /^(BUTTON|A|INPUT)$/.test(n.tagName ?? ''));
    if (plain?.matches?.('.expandable-form-cancel-btn')) { record({ type: 'click', target: 'button', text: 'Cancel', isTrusted: e.isTrusted }); return togglePanel(plain.closest('li'), false); }
    if (plain?.closest?.('#action-modal')) { record({ type: 'click', target: 'button', text: oneLine(plain.textContent), isTrusted: e.isTrusted }); return openModal(false); }
    if (plain?.tagName === 'A') {
      e.preventDefault();
      // View More Payment Plans shows its group's other plans (11 Payments among them).
      if (/^view more payment plans$/i.test(oneLine(plain.textContent))) $$('gds-radio-button.hide', plain.closest('gds-radio-button-group')).forEach((r) => r.classList.remove('hide'));
      return record({ type: 'click', target: 'link', text: oneLine(plain.textContent), isTrusted: e.isTrusted });
    }
    if (plain?.type === 'checkbox') return record({ type: 'click', target: 'checkbox', text: plain.id, isTrusted: e.isTrusted });
    if (STOP_VIEWS.includes(state.view)) record({ type: 'click', target: 'other', text: path[0]?.tagName ?? '', isTrusted: e.isTrusted });
  }, true);
  const keyOf = (el) => keyed().find((k) => k.el === el)?.key ?? stemOf(el) ?? el.id;
  const shown = (el) => (stemOf(el) === 'GiveSocialSecurityNumber' ? `(${el.value.length} characters)` : el.tagName === 'SELECT' ? optionText(el) : el.type === 'checkbox' ? String(el.checked) : el.value);
  document.addEventListener('change', (e) => {
    const el = e.composedPath()[0];
    if (!el?.matches?.('input, select, textarea') || !form.contains(el)) return;
    record({ type: 'change', target: keyOf(el), text: shown(el), isTrusted: e.isTrusted });
    react(el);
  }, true);
  document.addEventListener('input', (e) => {
    const el = e.composedPath()[0];
    // Typed in a select2 search box: its results (a list taking several opens as it's typed in).
    if (el?.classList?.contains('select2-search__field')) {
      const own = ownList(el);
      if (own && dropdown?.select !== own) openList(own);
      if (dropdown) listResults(el.value);
      return;
    }
    if (!el?.matches?.('input, textarea') || !form.contains(el) || el.closest?.('gds-radio-button')) return;
    if (STOP_VIEWS.includes(state.view)) record({ type: 'input', target: keyOf(el), text: shown(el), isTrusted: e.isTrusted });
    if (el.type === 'search' && el.getAttribute('aria-autocomplete') === 'list') later(200, () => suggestions(el));
    const stem = stemOf(el);
    if ((stem === 'GiveZip' && el.value.length === 5) || (stem === 'GiveVinPreQuote' && el.value.length === 17)) react(el);
  }, true);

  const start = params.get('view');
  render(start && document.getElementById(`view-${start}`) ? start : 'business-class');
})();
