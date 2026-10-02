// Plays the parts of AmWINS' own page script (application.cl.bauto.js, read from the saved site
// on 2026-10-02) that the fill engine runs into, on the saved Business Auto application:
// - show/hide of [app-rel-id] blocks when the answer they follow changes;
// - one prior carrier panel per prior year (Years in Business 1-3: that many; 4 / 5+ / Lapse: 3);
// - Save & Continue moves to the next step; the last step has Submit instead (recorded, never
//   expected);
// - Import Data opens the "Vehicle Import by VIN" preview; its Import Valid Records adds the
//   vehicle: the row is redrawn from the decoded VIN (body type and GVW from the decoder, other
//   answers on the row cleared) and the VIN list emptied;
// - typing a VIN into a vehicle row decodes it the same way (overwrites body type and GVW);
// - Default all answers to "No" answers the first underwriting section;
// - the classification box is a select2 type-ahead that opens on a left-button mousedown, with
//   several results for 484122 (as on the live site);
// - date boxes keep their date in a vanillajs-datepicker: text typed into the box only counts
//   once Tab / Enter is pressed, and a step shows what was saved when it is opened again;
// - Prev goes back a step;
// - Save & Continue shows the next step at once but saves in the background (the loading
//   overlay #loadingDefault), then redraws every step from what was saved: anything typed on the
//   new step before that is lost (as on the live site, run of 2026-10-02);
// - the dropdown lists load a moment after the page opens (overlay shown meanwhile).
// What happened is kept in window.__amwinsMock for the runner (scripts/amwins-mock.mjs).
(() => {
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const state = (window.__amwinsMock = { saves: 0, submitted: false, lookups: 0, imports: 0, decodes: 0, defaults: 0, steps: [] });
  const fire = (el, type = 'change') => el.dispatchEvent(new Event(type, { bubbles: true }));
  const later = (ms, fn) => setTimeout(fn, ms);

  // --- Loading overlay, background save and reload ---------------------------------------------------
  const overlay = $('#loadingDefault');
  const loading = (on) => { if (overlay) overlay.style.display = on ? 'block' : 'none'; };
  const FORM = 'input:not([type=button]):not([type=submit]):not([type=file]), select, textarea';
  const snapshot = () => $$(FORM).map((el) => [el, el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value, el._pickerDate]);
  const restore = (saved) => {
    for (const [el, v, date] of saved) {
      if (el.type === 'checkbox' || el.type === 'radio') el.checked = v; else el.value = v;
      el._pickerDate = date;
    }
  };
  const SAVE_MS = 1500;

  // The lists arrive from the server after the page opens.
  const LISTS = ['#mailingState', '#entityType', '#yrsInBusiness', '#natureOfBusiness', '#garagePanel [data-id="state"]'];
  const held = LISTS.map((sel) => $(sel)).filter(Boolean).map((el) => [el, [...el.options].slice(1)]);
  for (const [, opts] of held) opts.forEach((o) => o.remove());
  loading(true);
  later(1200, () => { for (const [el, opts] of held) el.append(...opts); loading(false); });

  // --- Steps --------------------------------------------------------------------------------------
  const tabs = $$('.form-tab');
  let current = Math.max(0, tabs.findIndex((t) => t.style.display !== 'none'));
  const showStep = (i) => {
    tabs.forEach((t, j) => { t.style.display = j === i ? '' : 'none'; });
    current = i;
    const last = i === tabs.length - 1;
    $$('[data-id="saveAndContinueButton"]').forEach((b) => { b.style.display = last ? 'none' : ''; });
    $$('[data-id="prevButton"]').forEach((b) => { b.style.display = i === 0 ? 'none' : ''; });
    // The step is drawn from what was saved: a date the picker never took is gone.
    for (const box of $$('.datepicker-input', tabs[i])) box.value = box._pickerDate ?? '';
    $$('[data-id="submitButton"]').forEach((b) => { b.style.display = last ? '' : 'none'; });
    state.steps.push(tabs[i].getAttribute('data-title'));
    window.scrollTo(0, 0);
  };
  showStep(current);
  document.addEventListener('click', (e) => {
    const button = e.target.closest?.('button, input[type=button]');
    if (!button) return;
    const id = button.getAttribute('data-id');
    if (id === 'saveAndContinueButton') {
      state.saves++;
      const saved = snapshot();
      loading(true);
      later(150, () => showStep(Math.min(current + 1, tabs.length - 1)));
      // The reload redraws every step from the save.
      later(SAVE_MS, () => { restore(saved); loading(false); state.reloads = (state.reloads ?? 0) + 1; });
    }
    if (id === 'submitButton') state.submitted = true;
    if (id === 'prevButton') { state.prevs = (state.prevs ?? 0) + 1; later(150, () => showStep(Math.max(current - 1, 0))); }
  }, true);

  // --- Show / hide (the site's setupAppRelativeShowHide / onAppRelativeChange) ---------------------
  // A control with app-id="X" shows or hides every [app-rel-id="X"] block: op (eq, nb, neq, gt,
  // lt, geq, leq, in, nin, contain) and values ("true" by default) from the block or else the
  // control; app-rel-show="false" inverts. A block that gets hidden has its answers cleared.
  const SOURCES = 'select[app-id], table[app-id] input[type=radio], input[type=hidden][app-id], input[type=text][app-id], input[type=checkbox][app-id]';
  const fieldValue = (el) => {
    if (el.type === 'radio') {
      const checked = el.closest('table[app-id]').querySelector('input[type=radio]:checked');
      return checked ? (checked.value === '1' ? 'true' : checked.value === '0' ? 'false' : checked.value) : '';
    }
    if (el.type === 'checkbox') return String(el.checked);
    return el.value ?? '';
  };
  const clearData = (block) => {
    for (const f of block.querySelectorAll('input[type=text], select, textarea')) f.value = '';
    for (const f of block.querySelectorAll('input[type=checkbox]:checked, input[type=radio]:checked')) f.checked = false;
  };
  const relChange = (el) => {
    const source = el.type === 'radio' ? el.closest('table[app-id]') : el;
    const key = source.getAttribute('app-id');
    const op0 = source.getAttribute('app-rel-op') ?? 'eq';
    const values0 = source.getAttribute('app-rel-values') ?? 'true';
    const show0 = (source.getAttribute('app-rel-show') ?? 'true').toLowerCase() === 'true';
    const t = fieldValue(el);
    for (const block of $$(`[app-rel-id="${key}"], [app-rel-id*="~${key}~"]`)) {
      const op = block.getAttribute('app-rel-op') ?? op0;
      let n = block.getAttribute('app-rel-values') ?? values0;
      const show = block.hasAttribute('app-rel-show') ? block.getAttribute('app-rel-show').toLowerCase() === 'true' : show0;
      let hit = false;
      if (op === 'eq') hit = t === n;
      else if (op === 'nb') hit = t !== '';
      else if (op === 'neq') hit = t !== n && t !== '';
      else if (op === 'gt') hit = parseInt(t, 10) > parseInt(n, 10);
      else if (op === 'lt') hit = parseInt(t, 10) < parseInt(n, 10);
      else if (op === 'geq') hit = parseInt(t, 10) >= parseInt(n, 10);
      else if (op === 'leq') hit = parseInt(t, 10) <= parseInt(n, 10);
      else if (op === 'in' || op === 'nin') {
        n = `~${n}~`;
        hit = n.includes('_BLANK_') ? n.includes(`~${t}~`) || t === '' : n.includes(`~${t}~`) && t !== '';
        if (op === 'nin') hit = !hit;
      } else if (op === 'contain') hit = t.includes(n);
      const visible = (show && hit) || (!show && !hit);
      if (!visible && !block.classList.contains('app-hide')) clearData(block);
      block.classList.toggle('app-hide', !visible);
    }
  };
  document.addEventListener('change', (e) => {
    if (e.target.matches?.(SOURCES)) relChange(e.target);
    // One prior carrier panel per prior year.
    if (e.target.id === 'yrsInBusiness') {
      const v = e.target.value;
      const n = /^[123]$/.test(v) ? Number(v) : v && v !== 'New Venture' ? 3 : 0;
      [0, 1, 2].forEach((i) => {
        const section = $(`#priorCarrierCoveragePanel${i}`)?.closest('.app-rp-section');
        if (section) section.style.display = i < n ? '' : 'none';
      });
    }
  });

  // --- Date pickers ---------------------------------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (e.target.classList?.contains('datepicker-input') && (e.key === 'Tab' || e.key === 'Enter')) {
      e.target._pickerDate = /^\d{2}\/\d{2}\/\d{4}$/.test(e.target.value) ? e.target.value : null;
    }
  }, true);

  // --- Vehicles -----------------------------------------------------------------------------------
  const DECODED = { year: '2019', make: 'ISUZU', model: 'NPR', bodyType: 'INCOMPLETE - STRAIGHT TRUCK', grossVehicleWeight: '14500' };
  const row = () => $('#vehiclesPanelAccordion0');
  const setRow = (id, value) => { const f = $(`[data-id="${id}"]`, row()); if (f) { f.value = value; fire(f); } };
  const decode = () => { for (const [id, value] of Object.entries(DECODED)) setRow(id, value); };
  const lookup = $('#vehLookupSuccess');
  $('#vehLookupButton')?.addEventListener('click', () => {
    if (!$('#vehLookupVin').value.trim()) return;
    state.lookups++;
    later(400, () => lookup.classList.add('show'));
  });
  lookup?.querySelector('.import')?.addEventListener('click', () => {
    state.imports++;
    // The rows are redrawn from the imported data: answers typed on the row before are gone.
    later(200, () => {
      for (const id of ['usageType', 'radius', 'bodyType']) setRow(id, '');
      const value = $('#marketValue'); if (value) value.value = '';
      setRow('vin', $('#vehLookupVin').value.trim().split('\n')[0]);
      decode();
      $('#vehLookupVin').value = '';
      lookup.classList.remove('show');
    });
  });
  lookup?.querySelector('.import-cancel')?.addEventListener('click', () => lookup.classList.remove('show'));
  document.addEventListener('change', (e) => {
    if (e.target.getAttribute?.('data-id') === 'vin' && e.target.closest('#vehiclesPanel') && e.target.value.length === 17 && !lookup.classList.contains('show')) {
      state.decodes++;
      later(500, decode);
    }
  });

  // --- Underwriting -------------------------------------------------------------------------------
  const FIRST_SECTION = ['subsidiaryToOther', 'subsidiary', 'safetyInfo', 'hazardExposure', 'otherInsurance', 'coverageDenial',
    'pastCriminalActivity', 'criminalActivityInPast5Years', 'codeVoilation', 'finacialDefault', 'finacialJudgement', 'trust',
    'foreignOperations', 'otherVenture', 'ownDrones', 'hireOtherToOperateDrones'];
  $('#defaultGeneralInfomationButton')?.addEventListener('click', (e) => {
    e.preventDefault();
    state.defaults++;
    for (const name of FIRST_SECTION) {
      const no = $(`input[type=radio][name="${name}"][value="0"]`);
      if (no) { no.checked = true; fire(no); }
    }
  });

  // --- Classification (select2) -------------------------------------------------------------------
  const CLASSES = ['484122 - General freight trucking, long-distance, less-than-truckload (LTL)', '484122 - Expedited freight, long-distance, LTL',
    '484122 - General freight trucking, long-distance, LTL - hazmat', '484122 - Less-than-truckload carriers, long-distance', '484121 - General freight trucking, long-distance, truckload', '484110 - General freight trucking, local'];
  const select = $('#classCodeAndDescription');
  const opener = select?.parentElement?.querySelector('.select2-selection');
  opener?.addEventListener('mousedown', (e) => {
    if (!(e instanceof MouseEvent) || e.button !== 0 || $('.select2-dropdown')) return;
    const drop = document.createElement('span');
    drop.className = 'select2-dropdown';
    drop.innerHTML = '<input class="select2-search__field" type="search"><ul class="select2-results__options"></ul>';
    document.body.append(drop);
    const box = $('.select2-search__field', drop);
    const list = $('ul', drop);
    box.addEventListener('keyup', () => later(300, () => {
      const q = box.value.trim().toLowerCase();
      list.innerHTML = '';
      for (const text of CLASSES.filter((c) => q && c.toLowerCase().includes(q))) {
        const li = document.createElement('li');
        li.className = 'select2-results__option';
        li.textContent = text;
        li.addEventListener('mouseup', () => {
          const option = new Option(text, text.slice(0, 6), true, true);
          select.append(option);
          select.value = option.value;
          $('.select2-selection__rendered', opener).textContent = text;
          drop.remove();
          fire(select);
        });
        list.append(li);
      }
    }));
    box.focus();
  });
  document.body.addEventListener('mousedown', (e) => { if (!e.target.closest?.('.select2-dropdown, .select2-selection')) $('.select2-dropdown')?.remove(); });
})();
