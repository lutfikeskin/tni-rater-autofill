// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { findPii } from '../scripts/lib/privacy.mjs';
import { pageBusy } from '../src/kit/adapter.js';
import { collectControls, stepKey } from '../src/kit/dom.js';
import { findAdvanceButton, findButton } from '../src/kit/actions.js';

const ADAPTER_SRC = fs.readFileSync(new URL('../src/content/carriers/geico-pa.js', import.meta.url), 'utf8');
const FIELD_KEY_SRC = fs.readFileSync(new URL('../src/content/field-key.js', import.meta.url), 'utf8');
const RECORDER_SRC = fs.readFileSync(new URL('../src/content/recorder.js', import.meta.url), 'utf8');
const FIXTURE_DIR = new URL('./fixtures/geico-pa/', import.meta.url);

const FIXTURES = [
  { file: 'policyholder-info.html', step: 'Policyholder Information' },
  { file: 'vehicle-prefill.html', step: 'Vehicle Prefill' },
  { file: 'current-insurance.html', step: 'Current Insurance' },
  { file: 'vehicle-info.html', step: 'Vehicle Information' },
  { file: 'driver-info.html', step: 'Driver Information' },
  { file: 'license-history.html', step: 'License History' },
  { file: 'incidents.html', step: 'Select Drivers with Incidents' },
  { file: 'groups-org.html', step: 'Groups or Organizations' },
  { file: 'quote-summary.html', step: 'Quote Summary' },
];

/** @param {string} file */
const readFixture = (file) => fs.readFileSync(new URL(`./fixtures/geico-pa/${file}`, import.meta.url), 'utf8');

/**
 * Upgrades declarative `<template shadowrootmode="open">` tags in jsdom into real open shadow
 * roots so deepQueryAll, radioHost, buttonText, and shadow traversal behave as in Chrome.
 * @param {Document} doc
 */
function attachDeclarativeShadowRoots(doc) {
  for (const tpl of [...doc.querySelectorAll('template[shadowrootmode="open"]')]) {
    const host = tpl.parentElement;
    if (!host || host.shadowRoot) continue;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.appendChild(/** @type {HTMLTemplateElement} */ (tpl).content.cloneNode(true));
    tpl.remove();
  }
}

/**
 * Loads HTML in jsdom with the geico-pa adapter, field-key.js, and recorder.js
 * in the document's VM context.
 * @param {string} html
 * @param {{ url?: string, topWindow?: boolean }} [opts]
 */
function loadPage(html, { url = 'https://sales.geico.com/quote' } = {}) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const win = dom.window;
  attachDeclarativeShadowRoots(win.document);

  // jsdom has no layout engine; approximate getClientRects() walking across shadow roots.
  win.Element.prototype.getClientRects = function getClientRects() {
    /** @type {any} */
    let n = this;
    while (n) {
      if (n.style?.display === 'none' || n.hasAttribute?.('hidden')) return /** @type {any} */ ([]);
      n = n.parentElement ?? n.getRootNode?.()?.host ?? null;
    }
    return /** @type {any} */ ([{ left: 0, top: 0, width: 100, height: 24 }]);
  };

  /** @type {any[]} */
  const sent = [];
  /** @type {Array<() => void>} */
  const timers = [];
  const ctx = dom.getInternalVMContext();
  ctx.setInterval = (/** @type {() => void} */ fn) => { timers.push(fn); return timers.length; };
  ctx.clearInterval = () => {};
  ctx.chrome = {
    runtime: {
      id: 'synthetic-extension',
      sendMessage: (/** @type {any} */ msg) => { sent.push(msg); return Promise.resolve({ ok: true }); },
      onMessage: { addListener() {}, removeListener() {} },
    },
  };

  vm.runInContext(ADAPTER_SRC, ctx, { filename: 'src/content/carriers/geico-pa.js' });
  vm.runInContext(FIELD_KEY_SRC, ctx, { filename: 'src/content/field-key.js' });
  vm.runInContext(RECORDER_SRC, ctx, { filename: 'src/content/recorder.js' });

  return {
    adapter: ctx.__raterAdapter,
    fieldKey: ctx.__raterFieldKey,
    recorder: ctx.__raterRecorder,
    document: win.document,
    window: win,
    ctx,
    sent,
    tick: () => { for (const fn of timers) fn(); },
    close: () => { ctx.__raterRecorder?.dispose?.(); win.close(); },
  };
}

/**
 * Temporarily binds a jsdom page onto globalThis so src/kit/ modules run directly against it.
 * @template T
 * @param {ReturnType<typeof loadPage>} page
 * @param {() => T} fn
 * @returns {T}
 */
function withKitGlobals(page, fn) {
  const keys = ['document', 'location', 'getComputedStyle', 'Node', 'NodeFilter', 'CSS', 'window', '__raterAdapter', '__raterFieldKey'];
  const prev = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const next = {
    document: page.document,
    location: page.window.location,
    getComputedStyle: page.window.getComputedStyle.bind(page.window),
    Node: page.window.Node,
    NodeFilter: page.window.NodeFilter,
    CSS: { escape: (/** @type {unknown} */ v) => String(v).replace(/[^a-z0-9_-]/gi, '\\$&') },
    window: page.window,
    __raterAdapter: page.adapter,
    __raterFieldKey: page.fieldKey,
  };
  for (const [k, v] of Object.entries(next)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    for (const [k, desc] of prev) {
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete /** @type {any} */ (globalThis)[k];
    }
  }
}

test('adapter shape: registers carrier geico-pa with shared GDS hooks and create() for XHR tracking, row indexing, and column order', () => {
  const page = loadPage(readFixture('policyholder-info.html'));
  try {
    assert.equal(page.adapter.carrier, 'geico-pa');
    assert.equal(typeof page.adapter.create, 'function');
    assert.equal(typeof page.adapter.shared.step, 'function');
    assert.equal(typeof page.adapter.shared.caption, 'function');
    assert.equal(typeof page.adapter.shared.date, 'function');
    assert.equal(page.adapter.shared.components, 'gds-');
    assert.deepEqual([...page.adapter.shared.changeAttributes], ['active-index', 'selected']);
    assert.deepEqual([...page.adapter.shared.selectors.busy], ['#page-load', '#extendedWaiting']);
    assert.deepEqual([...page.adapter.shared.selectors.stepLinks], ['gds-drawer', 'gds-vertical-stepper']);
    assert.deepEqual([...page.adapter.shared.selectors.suggestions], ['gds-dropdown-list-item[type="address"]']);
    assert.deepEqual([...page.adapter.shared.selectors.tooltips], ['gds-tooltip']);
    assert.deepEqual([...page.adapter.shared.selectors.agentPress], ['gds-button']);
    assert.deepEqual([...page.adapter.shared.selectors.disabled], ['gds-button[disabled]', '.select-box.disabled']);
    assert.deepEqual([...page.adapter.shared.selectors.errors], ['.form-message']);

    const hooks = page.adapter.create();
    assert.equal(hooks.serverBacked(), true);
    assert.equal(hooks.busy(), false);
    assert.equal(typeof hooks.onRequest, 'function');
    assert.equal(typeof hooks.offRequest, 'function');
    assert.equal(typeof hooks.row, 'function');
    assert.equal(typeof hooks.order, 'function');
  } finally {
    page.close();
  }
});

test('step detection: identifies all 8 stepper pages, Vehicle Prefill interstitial, post-quote stop steps, and non-quote boundaries', () => {
  for (const { file, step } of FIXTURES) {
    const page = loadPage(readFixture(file));
    try {
      assert.equal(page.adapter.shared.step(), step, `${file}: adapter.shared.step()`);
      assert.equal(withKitGlobals(page, () => stepKey()), step, `${file}: kit stepKey()`);
    } finally {
      page.close();
    }
  }

  // Fixture URL path is also accepted (for local mock / replay verification).
  const localFixture = loadPage(readFixture('current-insurance.html'), { url: 'http://127.0.0.1:4321/test/fixtures/geico-pa/current-insurance.html' });
  try {
    assert.equal(localFixture.adapter.shared.step(), 'Current Insurance');
  } finally {
    localFixture.close();
  }

  // Post-quote Finalize and Payment steps map cleanly to canonical names.
  for (const stopStep of ['Vehicle Details', 'Driver Details', 'Communication Options', 'Payment Plan', 'Payment Type']) {
    const html = `<!doctype html><html><head><title>GEICO</title></head><body>
      <gds-drawer><gds-vertical-stepper><gds-vertical-stepper-item state="current"><a href="#">${stopStep}</a></gds-vertical-stepper-item></gds-vertical-stepper></gds-drawer>
    </body></html>`;
    const p = loadPage(html);
    try {
      assert.equal(p.adapter.shared.step(), stopStep);
    } finally {
      p.close();
    }
  }

  // Outside /quote (/dashboard, /PrintQuote) and child frames return undefined.
  for (const url of ['https://sales.geico.com/dashboard', 'https://sales.geico.com/PrintQuote?auth=t']) {
    const p = loadPage(readFixture('quote-summary.html'), { url });
    try {
      assert.equal(p.adapter.shared.step(), undefined, url);
    } finally {
      p.close();
    }
  }
  const childDom = new JSDOM(readFixture('policyholder-info.html'), { url: 'https://sales.geico.com/quote', runScripts: 'outside-only' });
  try {
    const childWin = { top: {} };
    const childCtx = vm.createContext({
      window: childWin,
      document: childDom.window.document,
      location: childDom.window.location,
      globalThis: /** @type {any} */ (null),
    });
    childCtx.globalThis = childCtx;
    vm.runInContext(ADAPTER_SRC, childCtx, { filename: 'src/content/carriers/geico-pa.js' });
    assert.equal(childCtx.__raterAdapter.shared.step(), undefined);
  } finally {
    childDom.window.close();
  }

  // No vertical stepper (e.g. commercial GEICO progress bar only) returns undefined.
  const noStepper = loadPage('<!doctype html><html><body><gds-progress-bar value="50">Vehicles</gds-progress-bar></body></html>');
  try {
    assert.equal(noStepper.adapter.shared.step(), undefined);
  } finally {
    noStepper.close();
  }

  // Stepper present with 0 or 2 current items or unknown label returns null.
  for (const html of [
    '<!doctype html><html><body><gds-drawer><gds-vertical-stepper-item state="future">Current Insurance</gds-vertical-stepper-item></gds-drawer></body></html>',
    '<!doctype html><html><body><gds-drawer><gds-vertical-stepper-item state="current">Current Insurance</gds-vertical-stepper-item><gds-vertical-stepper-item state="current">Vehicle Information</gds-vertical-stepper-item></gds-drawer></body></html>',
    '<!doctype html><html><body><gds-drawer><gds-vertical-stepper-item state="current">Unknown Mystery Step</gds-vertical-stepper-item></gds-drawer></body></html>',
  ]) {
    const p = loadPage(html);
    try {
      assert.equal(p.adapter.shared.step(), null);
    } finally {
      p.close();
    }
  }
});

test('stepLinks exclusion & button safety: sidebar links and Discard Changes are never clicked; enabled GDS buttons and addIcon are found', () => {
  // Policyholder Info: Save and Continue found; sidebar links & Discard Changes excluded.
  const ph = loadPage(readFixture('policyholder-info.html'));
  try {
    withKitGlobals(ph, () => {
      const adv = findAdvanceButton('^(next|save and continue)$');
      assert.ok(adv, 'Save and Continue found via shadow <button>');
      assert.equal(findAdvanceButton('^current insurance$'), null, 'drawer link must never match advance');
      assert.equal(findButton({ text: '^policyholder information$' }), null, 'drawer link must never match helper');
      assert.equal(findButton({ text: '^payment plan$' }), null, 'payment drawer link must never match helper');
      assert.equal(findAdvanceButton('^discard changes$'), null, 'Discard Changes blocked by NEVER_ADVANCE');
      assert.equal(findButton({ text: '^discard changes$' }), null, 'Discard Changes blocked by NEVER_CLICK');
    });
  } finally {
    ph.close();
  }

  // Driver Info: Save and Continue is disabled (host & inner button disabled), Add Driver is enabled.
  const drv = loadPage(readFixture('driver-info.html'));
  try {
    withKitGlobals(drv, () => {
      assert.equal(findAdvanceButton('^(next|save and continue)$'), null, 'disabled Save and Continue must not be returned');
      assert.ok(findButton({ text: '^add driver$' }), 'Add Driver helper found');
      assert.equal(findButton({ text: '^discard changes$' }), null);
    });
  } finally {
    drv.close();
  }

  // Vehicle Info: Add Vehicle and Next found.
  const veh = loadPage(readFixture('vehicle-info.html'));
  try {
    withKitGlobals(veh, () => {
      assert.ok(findButton({ text: '^add vehicle$' }), 'Add Vehicle helper found');
      assert.ok(findAdvanceButton('^next$'), 'Next advance button found');
    });
  } finally {
    veh.close();
  }

  // Incidents: Add Incident found by token addIcon, Next found as advance.
  const inc = loadPage(readFixture('incidents.html'));
  try {
    withKitGlobals(inc, () => {
      assert.ok(findButton({ token: 'addIcon', near: 'Add Incident' }), 'Add Incident addIcon found');
      assert.ok(findAdvanceButton('^next$'), 'Incidents Next found');
    });
  } finally {
    inc.close();
  }

  // Current Insurance, License History, Groups, and Vehicle Prefill: Next / Save and Continue found cleanly.
  for (const file of ['current-insurance.html', 'license-history.html', 'groups-org.html', 'vehicle-prefill.html']) {
    const p = loadPage(readFixture(file));
    try {
      withKitGlobals(p, () => {
        assert.ok(findAdvanceButton('^(next|save and continue)$'), `${file}: advance button found`);
        assert.equal(findAdvanceButton('^discard changes$'), null, `${file}: Discard Changes never matched`);
      });
    } finally {
      p.close();
    }
  }

  // Quote Summary: sticky-bar Recalculate scoped via within: 'gds-sticky-bar' (ignoring top .button-group-center-stacked);
  // Print Quote Proposal hidden while stale, found when unhidden (shadow <a>).
  const qs = loadPage(readFixture('quote-summary.html'));
  try {
    withKitGlobals(qs, () => {
      const topRecalc = findButton({ text: '^recalculate$', within: '.button-group-center-stacked' });
      const stickyRecalc = findButton({ text: '^recalculate$', within: 'gds-sticky-bar' });
      assert.ok(topRecalc, 'top .button-group-center-stacked Recalculate exists');
      assert.ok(stickyRecalc, 'bottom gds-sticky-bar Recalculate found via within');
      assert.notEqual(stickyRecalc, topRecalc, 'within: gds-sticky-bar resolves sticky-bar Recalculate, not top button');
      const stickyHost = /** @type {ShadowRoot} */ (stickyRecalc.getRootNode())?.host;
      assert.ok(stickyHost?.closest('gds-sticky-bar'), 'resolved Recalculate sits inside gds-sticky-bar');
      assert.equal(findButton({ text: '^print quote proposal$' }), null, 'hidden Print Quote Proposal ignored while stale');
      const hiddenBar = /** @type {HTMLElement} */ (qs.document.querySelector('div.hide'));
      hiddenBar.style.display = '';
      const printBtn = findButton({ text: '^print quote proposal$' });
      assert.ok(printBtn, 'Print Quote Proposal found once visible via shadow <a>');
      assert.equal(printBtn.tagName, 'A');
    });
  } finally {
    qs.close();
  }
});

test('stable field keys: dataName strips render numbers, maskedField, and -shadow; .ssp-grid and License History assign 1-based entity rows', () => {
  // Policyholder Info: single-entity controls have no @row suffix.
  const ph = loadPage(readFixture('policyholder-info.html'));
  try {
    const key = (/** @type {Element | null} */ el) => ph.fieldKey(el);
    assert.equal(key(ph.document.getElementById('Id_GiveFirstName_90857')), 'ref:GiveFirstName');
    assert.equal(key(ph.document.getElementById('Id_GiveDateOfBirth_95389')), 'ref:GiveDateOfBirth');
    assert.equal(key(ph.document.getElementById('Id_GiveStreet_59106')), 'ref:GiveStreet');
    assert.equal(key(ph.document.getElementById('Id_GiveSocialSecurityNumber_74851')), 'ref:GiveSocialSecurityNumber');
    const ownHost = ph.document.getElementById('Id_GiveOwnOrRent_793100');
    const ownRadio = ownHost?.shadowRoot?.querySelector('input[type="radio"]') ?? null;
    assert.equal(key(ownRadio), 'ref:GiveOwnOrRent');
  } finally {
    ph.close();
  }

  // Vehicle Info (.ssp-grid, 2 vehicles): distinct @row keys per vehicle column.
  const veh = loadPage(readFixture('vehicle-info.html'));
  try {
    const key = (/** @type {Element | null} */ el) => veh.fieldKey(el);
    assert.equal(key(veh.document.getElementById('Id_YesNoPreQuoteHaveFullVinActivity_16545')), 'ref:YesNoPreQuoteHaveFullVinActivity');
    assert.equal(key(veh.document.getElementById('Id_YesNoPreQuoteHaveFullVinActivity_26545')), 'ref:YesNoPreQuoteHaveFullVinActivity@2');
    assert.equal(key(veh.document.getElementById('Id_GiveVinPreQuote_32739')), 'ref:GiveVinPreQuote');
    assert.equal(key(veh.document.getElementById('Id_GiveVinPreQuote_42739')), 'ref:GiveVinPreQuote@2');
    assert.equal(key(veh.document.getElementById('Id_GiveAnnualMileage_95079')), 'ref:GiveAnnualMileage');
    assert.equal(key(veh.document.getElementById('Id_GiveAnnualMileage_85079')), 'ref:GiveAnnualMileage@2');
    assert.equal(veh.adapter.shared.keys.row(veh.document.getElementById('Id_GiveVinPreQuote_32739')), '1');
    assert.equal(veh.adapter.shared.keys.row(veh.document.getElementById('Id_GiveVinPreQuote_42739')), '2');
  } finally {
    veh.close();
  }

  // Driver Info (.ssp-grid, 3 drivers + footer checkbox).
  const drv = loadPage(readFixture('driver-info.html'));
  try {
    const key = (/** @type {Element | null} */ el) => drv.fieldKey(el);
    assert.equal(key(drv.document.getElementById('Id_GiveFirstName_26136')), 'ref:GiveFirstName');
    assert.equal(key(drv.document.getElementById('Id_GiveFirstName_99161')), 'ref:GiveFirstName@2');
    assert.equal(key(drv.document.getElementById('Id_GiveFirstName_70980')), 'ref:GiveFirstName@3');
    // Column 1 is empty for Insure this person?, so first select sits in Column 2 (@2) and second in Column 3 (@3).
    assert.equal(key(drv.document.getElementById('Id_GiveDriverExclusionInsuredYesNo_29214')), 'ref:GiveDriverExclusionInsuredYesNo@2');
    assert.equal(key(drv.document.getElementById('Id_GiveDriverExclusionInsuredYesNo_55468')), 'ref:GiveDriverExclusionInsuredYesNo@3');
    // Page-level acknowledgement checkbox below grid has box suffix and no @row.
    const ack = drv.document.getElementById('checkbox-Id_GiveAllDriversAcknowledgement_40067-Yes');
    assert.equal(key(ack), 'ref:GiveAllDriversAcknowledgement.Yes');
    assert.equal(drv.adapter.shared.keys.row(ack), null);
    // Trailing-dash checkbox id (e.g. Quote Summary PrimaryHeader) resolves to bare ref.
    const primaryHdr = drv.document.createElement('input');
    primaryHdr.type = 'checkbox';
    primaryHdr.id = 'checkbox-Id_PrimaryHeader_12345-';
    primaryHdr.name = 'Id_PrimaryHeader_12345';
    assert.equal(key(primaryHdr), 'ref:PrimaryHeader');
  } finally {
    drv.close();
  }

  // License History (3 stacked sibling driver sections, shadow radios + inputs).
  const lic = loadPage(readFixture('license-history.html'));
  try {
    const key = (/** @type {Element | null} */ el) => lic.fieldKey(el);
    const r1 = lic.document.getElementById('Id_SubstantialLicenseHistoryYesNo_916660')?.shadowRoot?.querySelector('input[type="radio"]') ?? null;
    const r2 = lic.document.getElementById('Id_SubstantialLicenseHistoryYesNo_120130')?.shadowRoot?.querySelector('input[type="radio"]') ?? null;
    const age3 = lic.document.getElementById('Id_GiveAgeFirstLicensed_70440');
    const my3 = lic.document.getElementById('Id_MonthYearAgeFirstLicensed_28780');
    assert.equal(key(r1), 'ref:SubstantialLicenseHistoryYesNo');
    assert.equal(key(r2), 'ref:SubstantialLicenseHistoryYesNo@2');
    assert.equal(key(age3), 'ref:GiveAgeFirstLicensed@3');
    assert.equal(key(my3), 'ref:MonthYearAgeFirstLicensed@3');
    assert.equal(lic.adapter.shared.keys.row(r1), '1');
    assert.equal(lic.adapter.shared.keys.row(r2), '2');
    assert.equal(lic.adapter.shared.keys.row(age3), '3');
  } finally {
    lic.close();
  }
});

test('Quote Summary coverage keys: policy-level vs per-vehicle keys stay distinct across vehicles and stable across UUID regeneration', () => {
  const qs = loadPage(readFixture('quote-summary.html'));
  try {
    const selects = [...qs.document.querySelectorAll('select')];
    const keys = selects.map((s) => qs.fieldKey(s));
    const rows = selects.map((s) => qs.adapter.shared.keys.row(s));
    assert.deepEqual(keys, [
      'cov:bodily injury liability bi',
      'cov:property damage liability pd',
      'cov:medical payments med',
      'cov:uninsured motorist bodily injury',
      'cov:uninsured motorist property damage',
      'cov:purchased claim forgiveness',
      'cov:comprehensive excluding collision#1',
      'cov:collision coll#1',
      'cov:emergency road service ers#1',
      'cov:rental reimbursement rr#1',
      'cov:comprehensive excluding collision#2',
      'cov:collision coll#2',
      'cov:emergency road service ers#2',
      'cov:rental reimbursement rr#2',
    ]);
    assert.deepEqual(rows, [
      null, null, null, null, null, null,
      '1', '1', '1', '1',
      '2', '2', '2', '2',
    ]);
    // Regenerating every UUID + render number (as after Recalculate) yields identical keys.
    for (const [i, sel] of selects.entries()) {
      const oldId = sel.id;
      const newId = `Id_00000000-1111-2222-3333-${String(i).padStart(12, '0')}_${50000 + i}`;
      const legend = qs.document.querySelector(`gds-label-legend[for="${oldId}"]`);
      sel.id = newId;
      legend?.setAttribute('for', newId);
    }
    assert.deepEqual(selects.map((s) => qs.fieldKey(s)), keys);
  } finally {
    qs.close();
  }
});

test('captions and date detection: grid row headers provide clean PII-free captions and date inputs are flagged', () => {
  const drv = loadPage(readFixture('driver-info.html'));
  try {
    const dob1 = drv.document.getElementById('Id_GiveDateOfBirth_40319');
    const insure2 = drv.document.getElementById('Id_GiveDriverExclusionInsuredYesNo_29214');
    const first1 = drv.document.getElementById('Id_GiveFirstName_26136');
    assert.equal(drv.adapter.shared.caption(dob1), 'Date of Birth');
    assert.equal(drv.adapter.shared.caption(insure2), 'Insure this person?');
    assert.equal(drv.adapter.shared.date(dob1), true);
    assert.equal(drv.adapter.shared.date(first1), false);
  } finally {
    drv.close();
  }

  const veh = loadPage(readFixture('vehicle-info.html'));
  try {
    const miles = veh.document.getElementById('Id_GiveMilesOneWay_78174');
    const vin = veh.document.getElementById('Id_GiveVinPreQuote_32739');
    assert.equal(veh.adapter.shared.caption(miles), 'One-way Commute Mileage');
    assert.equal(veh.adapter.shared.caption(vin), 'VIN');
    assert.equal(veh.adapter.shared.date(vin), false);
  } finally {
    veh.close();
  }

  const ph = loadPage(readFixture('policyholder-info.html'));
  try {
    assert.equal(ph.adapter.shared.caption(ph.document.getElementById('Id_GiveDateOfBirth_95389')), 'Date of Birth');
    assert.equal(ph.adapter.shared.date(ph.document.getElementById('Id_GiveDateOfBirth_95389')), true);
    assert.equal(ph.adapter.shared.date(ph.document.getElementById('Id_GiveEffectiveDate_58039')), true);
    assert.equal(ph.adapter.shared.date(ph.document.getElementById('Id_GivePhoneNumber_76864')), false);
  } finally {
    ph.close();
  }
});

test('create().order reorders .ssp-grid column-first with within-column dependencies and footer last, while preserving non-grid pages', () => {
  // Vehicle Info: 2 columns, fixture intentionally puts Annual Mileage before Primary Use in DOM.
  const veh = loadPage(readFixture('vehicle-info.html'));
  try {
    withKitGlobals(veh, () => {
      const controls = collectControls();
      const ordered = veh.adapter.create().order(controls);
      const keys = ordered.map((/** @type {any} */ c) => veh.fieldKey(c.el));
      assert.deepEqual(keys, [
        // Column 1 completely before Column 2; Primary Use + Commute fields before Annual Mileage.
        'ref:YesNoPreQuoteHaveFullVinActivity',
        'ref:GiveVinPreQuote',
        'ref:GiveVehicleOwnerShip',
        'ref:GiveLengthOfOwnership',
        'ref:GiveVehiclePrimaryUse',
        'ref:GiveDaysPerWeekCommute',
        'ref:GiveMilesOneWay',
        'ref:GiveAnnualMileage',
        // Column 2
        'ref:YesNoPreQuoteHaveFullVinActivity@2',
        'ref:GiveVinPreQuote@2',
        'ref:GiveVehicleOwnerShip@2',
        'ref:GiveVehiclePrimaryUse@2',
        'ref:GiveAnnualMileage@2',
      ]);
    });
  } finally {
    veh.close();
  }

  // Driver Info: 3 columns + page-level GiveAllDriversAcknowledgement last.
  const drv = loadPage(readFixture('driver-info.html'));
  try {
    withKitGlobals(drv, () => {
      const controls = collectControls();
      const ordered = drv.adapter.create().order(controls);
      const keys = ordered.map((/** @type {any} */ c) => drv.fieldKey(c.el));
      const idxMarital1 = keys.indexOf('ref:GiveMaritalStatus');
      const idxFirst2 = keys.indexOf('ref:GiveFirstName@2');
      const idxFirst3 = keys.indexOf('ref:GiveFirstName@3');
      const idxAck = keys.indexOf('ref:GiveAllDriversAcknowledgement.Yes');
      assert.ok(idxMarital1 >= 0 && idxMarital1 < idxFirst2, 'Driver 1 Marital Status runs before Driver 2 starts');
      assert.ok(idxFirst2 < idxFirst3, 'Driver 2 completes before Driver 3 starts');
      assert.equal(idxAck, keys.length - 1, 'GiveAllDriversAcknowledgement is always last');
      // Select2 inline search boxes must not appear as collected controls.
      assert.ok(!ordered.some((/** @type {any} */ c) => c.el.classList?.contains('select2-search__field')));
    });
  } finally {
    drv.close();
  }

  // Non-grid page (Policyholder Info) keeps original DOM order.
  const ph = loadPage(readFixture('policyholder-info.html'));
  try {
    withKitGlobals(ph, () => {
      const controls = collectControls();
      const ordered = ph.adapter.create().order(controls);
      assert.deepEqual(ordered.map((/** @type {any} */ c) => c.el.id), controls.map((c) => c.el.id));
    });
  } finally {
    ph.close();
  }
});

test('spinner and XHR/fetch busy() tracking: tracks /api/lookup and /api/conversation only, ignores non-API URLs, and handles spinners', async () => {
  // 1. Spinner DOM checks (#page-load and #extendedWaiting) via kit pageBusy().
  const spinPage = loadPage(readFixture('vehicle-info.html'));
  try {
    withKitGlobals(spinPage, () => {
      assert.equal(pageBusy(), false, 'idle hidden spinners are not busy');
      const spinner = /** @type {HTMLElement} */ (spinPage.document.getElementById('page-load'));
      spinner.style.display = 'block';
      assert.equal(pageBusy(), true, 'visible #page-load marks pageBusy');
      spinner.style.display = 'none';
      const ext = /** @type {HTMLElement} */ (spinPage.document.getElementById('extendedWaiting'));
      ext.style.display = 'block';
      assert.equal(pageBusy(), true, 'visible #extendedWaiting marks pageBusy');
      ext.style.display = 'none';
      assert.equal(pageBusy(), false);
    });
  } finally {
    spinPage.close();
  }

  // 2. XHR and fetch tracking in create() for /api/lookup/* and /api/conversation/*.
  const page = loadPage(readFixture('vehicle-info.html'));
  try {
    /** @type {Array<() => void>} */
    const fetchResolvers = [];
    page.ctx.fetch = () => new Promise((resolve) => { fetchResolvers.push(() => resolve({ ok: true })); });
    /** @type {Array<{ listeners: Record<string, Array<() => void>> }>} */
    const xhrs = [];
    page.ctx.XMLHttpRequest = class FakeXHR {
      constructor() { /** @type {Record<string, Array<() => void>>} */ this.listeners = {}; xhrs.push(this); }
      open() {}
      send() {}
      /** @param {string} ev @param {() => void} fn */
      addEventListener(ev, fn) { (this.listeners[ev] ??= []).push(fn); }
    };

    const hooks = page.adapter.create();
    // Re-calling create() reuses __raterGpaNet without double-wrapping.
    const hooks2 = page.adapter.create();
    let reqCount = 0;
    const onReq = () => { reqCount++; };
    hooks.onRequest(onReq);
    assert.equal(hooks.busy(), false);

    // Tracked same-origin XHR: /api/lookup/SearchVin
    const xhr1 = new page.ctx.XMLHttpRequest();
    xhr1.open('POST', '/api/lookup/SearchVin');
    xhr1.send();
    assert.equal(hooks.busy(), true);
    assert.equal(hooks2.busy(), true);
    assert.equal(reqCount, 1);

    // Ignored same-origin non-API XHR (analytics / static asset) and cross-origin URL.
    const xhrNoise = new page.ctx.XMLHttpRequest();
    xhrNoise.open('POST', '/analytics/beacon');
    xhrNoise.send();
    const xhrCross = new page.ctx.XMLHttpRequest();
    xhrCross.open('POST', 'https://other.example.test/api/lookup/SearchVin');
    xhrCross.send();
    assert.equal(reqCount, 1, 'non-API and cross-origin requests do not increment tracker');

    // Tracked same-origin fetch: /api/conversation/controlinput
    const pendingFetch = page.ctx.fetch('https://sales.geico.com/api/conversation/controlinput', { method: 'POST' });
    assert.equal(reqCount, 2);
    assert.equal(hooks.busy(), true);

    // Finish XHR1; still busy because fetch is in flight.
    for (const fn of xhr1.listeners.loadend ?? []) fn();
    assert.equal(hooks.busy(), true);

    // Finish fetch; no longer busy.
    fetchResolvers.shift()?.();
    await pendingFetch;
    assert.equal(hooks.busy(), false);

    hooks.offRequest(onReq);
  } finally {
    page.close();
  }
});

test('Vehicle Prefill: step detection with 0 current stepper items, prefill:AddVehicle key & caption, host-click toggle, and Next button', () => {
  const vp = loadPage(readFixture('vehicle-prefill.html'));
  try {
    // 0 state="current" items in the drawer (Policyholder is completed, all others future).
    assert.equal(vp.document.querySelectorAll('gds-vertical-stepper-item[state="current"]').length, 0);
    assert.equal(vp.document.querySelectorAll('gds-vertical-stepper-item[state="completed"]').length, 1);
    assert.equal(vp.adapter.shared.step(), 'Vehicle Prefill');

    const cards = [...vp.document.querySelectorAll('gds-card-selections-card')];
    assert.equal(cards.length, 3);
    const vehCard = cards[0];
    const addCard = cards.find((c) => c.getAttribute('input-value') === 'AddVehicle');
    assert.ok(addCard, 'AddVehicle card exists');

    const vehInput = /** @type {HTMLInputElement | null} */ (vehCard.shadowRoot?.querySelector('input[type="checkbox"]') ?? null);
    const addInput = /** @type {HTMLInputElement | null} */ (addCard.shadowRoot?.querySelector('input[type="checkbox"]') ?? null);
    assert.ok(vehInput && addInput, 'shadow checkboxes exist inside gds-card-selections-card');

    // Stable key & clean caption for AddVehicle; prefilled cards stay free of VIN/model captions.
    assert.equal(vp.adapter.shared.keys.special(addInput), 'prefill:AddVehicle');
    assert.equal(vp.fieldKey(addInput), 'prefill:AddVehicle');
    assert.equal(vp.adapter.shared.caption(addInput), 'Quote a different vehicle');
    assert.equal(vp.adapter.shared.keys.special(vehInput), null);
    assert.equal(vp.adapter.shared.caption(vehInput), '');

    // collectControls + selector matching finds input[type="checkbox"][value="AddVehicle"] cleanly.
    withKitGlobals(vp, () => {
      assert.equal(stepKey(), 'Vehicle Prefill');
      const controls = collectControls();
      assert.equal(controls.length, 3);
      const addControl = controls.find((c) => c.el.matches('input[type="checkbox"][value="AddVehicle"]'));
      assert.ok(addControl, 'selector input[type="checkbox"][value="AddVehicle"] matches collected control');
      assert.equal(addControl.kind, 'checkbox');
      assert.equal(addControl.ref, null);
      assert.equal(vp.fieldKey(addControl.el), 'prefill:AddVehicle');

      const nextBtn = findAdvanceButton('^(next|save and continue)$');
      assert.ok(nextBtn, 'Next advance button found');
      const host = /** @type {ShadowRoot} */ (nextBtn.getRootNode())?.host;
      assert.ok(host?.closest('#Id_AutoVehiclePrefillAdaptiveActionSet_Container_39734 .button-group-right'));
    });

    // Mirror live GDS cardSelectedHandler: host click toggles selected based on host attribute
    // (never input.checked) and syncs shadow input.checked without double-toggling.
    addCard.addEventListener('click', () => {
      if (addCard.hasAttribute('selected')) addCard.removeAttribute('selected');
      else addCard.setAttribute('selected', '');
      addInput.checked = addCard.hasAttribute('selected');
    });
    assert.equal(addCard.hasAttribute('selected'), false);
    assert.equal(addInput.checked, false);
    addInput.click();
    assert.equal(addCard.hasAttribute('selected'), true, 'clicking shadow input toggles host selected on');
    assert.equal(addInput.checked, true, 'shadow input stays checked without double-toggle');
    addInput.click();
    assert.equal(addCard.hasAttribute('selected'), false, 'second click toggles host selected off');
    assert.equal(addInput.checked, false);
  } finally {
    vp.close();
  }
});

test('all geico-pa HTML fixtures are completely free of client PII', () => {
  const files = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.html'));
  assert.ok(files.length >= FIXTURES.length);
  for (const f of files) {
    const content = fs.readFileSync(new URL(f, FIXTURE_DIR), 'utf8');
    assert.deepEqual(findPii(content), [], `${f} must contain zero PII`);
  }
});
