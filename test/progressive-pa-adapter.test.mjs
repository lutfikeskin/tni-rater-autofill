// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { progressivePa } from '../src/carriers/progressive-pa.js';
import { carrierRuleFiles } from '../src/usage.js';
import { pageAt, pageBusy } from '../src/kit/adapter.js';
import { findAdvanceButton, findButton } from '../src/kit/actions.js';

const ADAPTER_SRC = fs.readFileSync(new URL('../src/content/carriers/progressive-pa.js', import.meta.url), 'utf8');
const FIELD_KEY_SRC = fs.readFileSync(new URL('../src/content/field-key.js', import.meta.url), 'utf8');
const RECORDER_SRC = fs.readFileSync(new URL('../src/content/recorder.js', import.meta.url), 'utf8');

const FIXTURES = [
  { file: 'named-insured.html', step: 'Named Insured' },
  { file: 'products.html', step: 'Products' },
  { file: 'household-members.html', step: 'Household Members' },
  { file: 'additional-details.html', step: 'Additional Details' },
  { file: 'coverages.html', step: 'Coverages/Bill Plans' },
  { file: 'portfolio.html', step: 'Portfolio' },
];

/** @param {string} file */
const readFixture = (file) => fs.readFileSync(new URL(`./fixtures/progressive-pa/${file}`, import.meta.url), 'utf8');

/**
 * Loads HTML in jsdom with the progressive-pa adapter, field-key.js, and recorder.js
 * in the document's VM context (mirroring isolated-world content-script injection).
 * @param {string} html
 * @param {{ url?: string }} [opts]
 */
function loadPage(html, { url = 'https://www.foragentsonly.com/Quote/Index/' } = {}) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const win = dom.window;
  // jsdom has no layout engine; approximate getClientRects() so visible controls and hidden spinners behave as in Chrome.
  win.Element.prototype.getClientRects = function getClientRects() {
    for (let n = /** @type {HTMLElement | null} */ (this); n; n = n.parentElement) {
      if (n.style?.display === 'none') return /** @type {any} */ ([]);
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

  vm.runInContext(ADAPTER_SRC, ctx, { filename: 'src/content/carriers/progressive-pa.js' });
  vm.runInContext(FIELD_KEY_SRC, ctx, { filename: 'src/content/field-key.js' });
  vm.runInContext(RECORDER_SRC, ctx, { filename: 'src/content/recorder.js' });

  /** @type {{ adapter: any, fieldKey: any, recorder: any, document: Document, window: any, sent: any[], tick: () => void, close: () => void }} */
  return {
    adapter: ctx.__raterAdapter,
    fieldKey: ctx.__raterFieldKey,
    recorder: ctx.__raterRecorder,
    document: win.document,
    window: win,
    sent,
    tick: () => { for (const fn of timers) fn(); },
    close: () => { ctx.__raterRecorder?.dispose?.(); win.close(); },
  };
}

/**
 * Temporarily binds a jsdom page onto globalThis so src/kit/ modules (`pageAt`, `pageBusy`,
 * `findAdvanceButton`, `findButton`) run directly against its DOM and adapter.
 * @template T
 * @param {ReturnType<typeof loadPage>} page
 * @param {() => T} fn
 * @returns {T}
 */
function withKitGlobals(page, fn) {
  const keys = ['document', 'location', 'getComputedStyle', 'Node', 'NodeFilter', 'window', '__raterAdapter', '__raterFieldKey'];
  const prev = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const next = {
    document: page.document,
    location: page.window.location,
    getComputedStyle: page.window.getComputedStyle.bind(page.window),
    Node: page.window.Node,
    NodeFilter: page.window.NodeFilter,
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

test('progressive-pa carrier config wires its own adapter, stopPages, and carrierRuleFiles without rules or display', () => {
  assert.equal(progressivePa.pageAdapter, 'src/content/carriers/progressive-pa.js');
  assert.deepEqual(progressivePa.stopPages, {
    'Point of Sale': 'This step is yours: nothing is filled or clicked. The quote stops at Portfolio.',
    'Final Sale': 'This step is yours: nothing is filled or clicked. The quote stops at Portfolio.',
  });
  assert.deepEqual(progressivePa.rules, []);
  assert.equal(progressivePa.useGenericRules, false);
  assert.equal('display' in progressivePa, false);
  assert.equal('advance' in progressivePa, false);
  assert.ok(carrierRuleFiles('progressive-pa').includes('src/content/carriers/progressive-pa.js'));
  assert.ok(!carrierRuleFiles('progressive-pa').includes('src/content/carriers/progressive.js'));
});

test('adapter shape: registers carrier progressive-pa with shared hooks only (no create)', () => {
  const page = loadPage(readFixture('named-insured.html'));
  try {
    assert.equal(page.adapter.carrier, 'progressive-pa');
    assert.equal(page.adapter.create, undefined);
    assert.deepEqual([...page.adapter.shared.selectors.stepLinks], ['a.navigation-link']);
    assert.deepEqual([...page.adapter.shared.selectors.busy], ['.ui-blocker-spinner-outer-wrapper']);
  } finally {
    page.close();
  }
});

test('recorder logs clean question captions across all fixtures, never helper/sr-only/entity noise, and preserves checkbox labels', () => {
  const NOISE = [/\bHelp Text\b/i, /\bDiscount tag\b/i, /\bClear\b/i, /\bRemove\b/i, /\bFormat\b/i, /\bCost of coverage\b/i, /\bfor\b/i];

  /** @type {Record<string, Record<string, string>>} */
  const expectedByFixture = {
    'named-insured.html': {
      NamedInsured_Embedded_Questions_List_FirstName: 'First Name',
      NamedInsured_Embedded_Questions_List_City: 'City',
      NamedInsured_Embedded_Questions_List_ZipCode: 'ZIP Code',
      'mat-input-21': 'Date of Birth',
    },
    'products.html': {
      ProductsAA_Embedded_Questions_List_NamedOperatorIndicator_Y: 'Named Non-Owner Policy',
      ProductsAA_Vehicles_List_0_Embedded_Questions_List_TypeCode: 'Vehicle Type',
      ProductsAA_Vehicles_List_1_Embedded_Questions_List_TypeCode: 'Vehicle Type',
    },
    'household-members.html': {
      People_Drivers_List_0_Embedded_Questions_List_Gender: 'Gender',
      People_Drivers_List_0_Embedded_Questions_List_Relationship: 'Relationship',
      People_Drivers_List_0_Embedded_Questions_List_LicenseType: 'Driver License Type',
      People_Drivers_List_1_Embedded_Questions_List_Gender: 'Gender',
      People_Drivers_List_1_ProductSpecificInformation_List_0_Embedded_Questions_List_DriverIncluded: 'Driver Status',
      People_Drivers_List_1_Embedded_Questions_List_StateFiling_Y: 'State Filing',
      People_Drivers_List_1_Violations_List_1_Embedded_Questions_List_Code: 'Incident Description',
    },
    'additional-details.html': {
      AdditionalDetails_Embedded_Questions_List_TotalResidents: 'Total Residents',
      AdditionalDetails_Embedded_Questions_List_PaperlessPreference: 'Apply Paperless and accept documents and bills delivered through email?',
      AdditionalDetails_Embedded_Questions_List_Boat: 'Boat',
    },
    'coverages.html': {
      CoveragesAA_Vehicles_List_0_Embedded_Questions_List_veh_liab: 'Liability',
      CoveragesAA_Vehicles_List_0_Embedded_Questions_List_COMP: 'Comprehensive Deductible',
      CoveragesAA_Vehicles_List_0_Embedded_Questions_List_COLL: 'Collision Deductible',
      CoveragesAA_Vehicles_List_1_Embedded_Questions_List_veh_liab: 'Liability',
      CoveragesAA_Vehicles_List_1_Embedded_Questions_List_COMP: 'Comprehensive Deductible',
      CoveragesAA_Vehicles_List_1_Embedded_Questions_List_COLL: 'Collision Deductible',
    },
    'portfolio.html': {
      Portfolio_HvdVehicles_List_0_Embedded_Questions_List_IsSelected: '2020 Example Sedan',
      Portfolio_HvdVehicles_List_1_Embedded_Questions_List_IsSelected: '2021 Example Hatch',
      Portfolio_Embedded_EmbeddedViewModel_ProductSpecificInformation_List_0_Embedded_Questions_List_IsIncluded: 'Auto',
    },
  };

  for (const { file } of FIXTURES) {
    const page = loadPage(readFixture(file));
    try {
      const checks = expectedByFixture[file];
      for (const [id, want] of Object.entries(checks)) {
        const el = page.document.getElementById(id);
        assert.ok(el, `${file}: missing #${id}`);
        const desc = page.recorder.read.describe(el);
        assert.equal(desc.label, want, `${file} #${id}`);
        for (const bad of NOISE) assert.doesNotMatch(desc.label, bad, `${file} #${id} caption leaked noise: "${desc.label}"`);
      }

      // Check every visible control on the page (except non-question checkboxes like product_tab_AA) has no noise in its caption.
      for (const el of page.document.querySelectorAll('input, select, textarea')) {
        const desc = page.recorder.read.describe(el);
        for (const bad of NOISE) assert.doesNotMatch(desc.label, bad, `${file} #${el.id} leaked noise: "${desc.label}"`);
      }
    } finally {
      page.close();
    }
  }

  // Also verify real recorder poll emits the clean caption on a change event (checkbox + select).
  const page = loadPage(readFixture('additional-details.html'));
  try {
    const boat = /** @type {HTMLInputElement} */ (page.document.getElementById('AdditionalDetails_Embedded_Questions_List_Boat'));
    const paperless = /** @type {HTMLSelectElement} */ (page.document.getElementById('AdditionalDetails_Embedded_Questions_List_PaperlessPreference'));
    assert.equal(page.adapter.shared.caption(boat), '', 'checkbox caption hook returns empty so own <label> wins');
    boat.checked = true;
    paperless.value = 'N';
    page.recorder.poll();
    const changes = page.sent.filter((m) => m.event === 'field_changes').flatMap((m) => m.changes);
    assert.equal(changes.find((c) => c.key === 'ref:AdditionalDetails.Boat')?.label, 'Boat');
    assert.equal(changes.find((c) => c.key === 'ref:AdditionalDetails.PaperlessPreference')?.label,
      'Apply Paperless and accept documents and bills delivered through email?');
  } finally {
    page.close();
  }
});

test('caption fallbacks: aria-labelledby *_Label, label[for], trailing */: stripping, and empty when missing', () => {
  const html = `<!doctype html><html><body>
    <h3 id="entitydetails0">2020 Example Sedan</h3>
    <label id="Fallback_Label">Standalone Label : * </label>
    <select id="s1" aria-labelledby="Fallback_Label entitydetails0"></select>
    <label for="t1">For Label * : <span class="visually-hidden">Discount tag, for</span><help-icon><span>Help Text, for</span></help-icon></label>
    <input type="text" id="t1">
    <input type="text" id="orphan" aria-labelledby="entitydetails0">
  </body></html>`;
  const page = loadPage(html);
  try {
    const cap = page.adapter.shared.caption;
    assert.equal(cap(page.document.getElementById('s1')), 'Standalone Label');
    assert.equal(cap(page.document.getElementById('t1')), 'For Label');
    assert.equal(cap(page.document.getElementById('orphan')), '');
  } finally {
    page.close();
  }
});

test('page() names each step on /Quote/Index/, agrees with kit pageAt and recorder pageKey, and returns null otherwise', () => {
  for (const { file, step } of FIXTURES) {
    const page = loadPage(readFixture(file), { url: 'https://www.foragentsonly.com/Quote/Index/' });
    try {
      assert.equal(page.adapter.shared.page(page.window.location), step, `${file}: shared.page`);
      assert.equal(page.recorder.read.pageKey(), step, `${file}: recorder.pageKey`);
      assert.equal(withKitGlobals(page, () => pageAt(page.window.location)), step, `${file}: kit.pageAt`);
      const pageView = page.sent.find((m) => m.event === 'page_view');
      assert.equal(pageView?.page, step, `${file}: initial page_view`);
    } finally {
      page.close();
    }
  }

  // Case-insensitive path without trailing slash, plus Point of Sale and Final Sale mappings.
  for (const [navText, want] of [['POINT OF SALE', 'Point of Sale'], ['FINAL SALE', 'Final Sale']]) {
    const html = `<!doctype html><html><head><title>Test Person - ${navText} FAO Quoting</title></head><body>
      <nav><a class="navigation-link" aria-current="step">  ${navText.toLowerCase()} </a></nav>
    </body></html>`;
    const page = loadPage(html, { url: 'https://www.foragentsonly.com/quote/index' });
    try {
      assert.equal(page.adapter.shared.page(page.window.location), want);
      assert.equal(page.recorder.read.pageKey(), want);
      assert.equal(withKitGlobals(page, () => pageAt(page.window.location)), want);
    } finally {
      page.close();
    }
  }

  // Wrong path, another document's pathname, no aria-current, multiple aria-current, and unknown text all return null (never document.title).
  const wrongPath = loadPage(readFixture('coverages.html'), { url: 'https://www.foragentsonly.com/Home/Dashboard' });
  try {
    assert.equal(wrongPath.adapter.shared.page(wrongPath.window.location), null);
    assert.equal(wrongPath.recorder.read.pageKey(), '/Home/Dashboard');
    assert.equal(withKitGlobals(wrongPath, () => pageAt(wrongPath.window.location)), '/Home/Dashboard');
  } finally {
    wrongPath.close();
  }

  const sameDoc = loadPage(readFixture('coverages.html'), { url: 'https://www.foragentsonly.com/Quote/Index/' });
  try {
    // Another document's Location whose pathname differs from this document's location.pathname.
    assert.equal(sameDoc.adapter.shared.page(/** @type {any} */ ({ pathname: '/Quote/Index' })), null);

    // No current nav item -> null, falls back to pathname (never document.title).
    const active = sameDoc.document.querySelector('a.navigation-link[aria-current]');
    active?.removeAttribute('aria-current');
    assert.equal(sameDoc.adapter.shared.page(sameDoc.window.location), null);
    assert.equal(sameDoc.recorder.read.pageKey(), '/Quote/Index/');
    assert.equal(withKitGlobals(sameDoc, () => pageAt(sameDoc.window.location)), '/Quote/Index/');

    // Two current nav items -> null.
    const links = sameDoc.document.querySelectorAll('a.navigation-link');
    links[0].setAttribute('aria-current', 'step');
    links[1].setAttribute('aria-current', 'step');
    assert.equal(sameDoc.adapter.shared.page(sameDoc.window.location), null);

    // Unknown step label -> null.
    links[1].removeAttribute('aria-current');
    links[0].textContent = 'UNLISTED STEP';
    assert.equal(sameDoc.adapter.shared.page(sameDoc.window.location), null);
  } finally {
    sameDoc.close();
  }
});

test('field keys match the decided ref and row mapping across fixtures and edge cases', () => {
  const page = loadPage(readFixture('coverages.html'));
  try {
    /** @param {{ tag?: string, id?: string, name?: string, type?: string }} spec */
    const mk = ({ tag = 'input', id = '', name = '', type = 'text' }) => {
      const el = page.document.createElement(tag);
      if (id) el.id = id;
      if (name) el.setAttribute('name', name);
      if (tag === 'input') el.setAttribute('type', type);
      return el;
    };

    /** @type {Array<[{ tag?: string, id?: string, name?: string, type?: string }, string | null, string | null, string]>} */
    const cases = [
      [{ id: 'NamedInsured_Embedded_Questions_List_City' }, 'NamedInsured.City', null, 'ref:NamedInsured.City'],
      [{ tag: 'select', id: 'ProductsAA_Vehicles_List_2_Embedded_Questions_List_TypeCode' }, 'ProductsAA.Vehicles.TypeCode', '3', 'ref:ProductsAA.Vehicles.TypeCode@3'],
      [{ tag: 'select', id: 'People_Drivers_List_1_Embedded_Questions_List_Gender' }, 'People.Drivers.Gender', '2', 'ref:People.Drivers.Gender@2'],
      [{ tag: 'select', id: 'People_Drivers_List_1_ProductSpecificInformation_List_0_Embedded_Questions_List_DriverIncluded' }, 'People.Drivers.ProductSpecificInformation.DriverIncluded', '2', 'ref:People.Drivers.ProductSpecificInformation.DriverIncluded@2'],
      [{ tag: 'select', id: 'People_Drivers_List_3_Violations_List_0_Embedded_Questions_List_Code' }, 'People.Drivers.Violations.Code', '4', 'ref:People.Drivers.Violations.Code@4'],
      [{ tag: 'select', id: 'People_Drivers_List_1_Violations_List_1_Embedded_Questions_List_Code' }, 'People.Drivers.Violations.Code', '2.2', 'ref:People.Drivers.Violations.Code@2.2'],
      [{ tag: 'select', id: 'People_Drivers_List_0_Violations_List_1_Embedded_Questions_List_Code' }, 'People.Drivers.Violations.Code', '1.2', 'ref:People.Drivers.Violations.Code@1.2'],
      [{ tag: 'select', id: 'People_Drivers_List_2_Violations_List_1_Embedded_Questions_List_Code' }, 'People.Drivers.Violations.Code', '3.2', 'ref:People.Drivers.Violations.Code@3.2'],
      [{ tag: 'select', id: 'AdditionalDetails_Embedded_Questions_List_TotalResidents' }, 'AdditionalDetails.TotalResidents', null, 'ref:AdditionalDetails.TotalResidents'],
      [{ tag: 'select', id: 'CoveragesAA_Vehicles_List_0_Embedded_Questions_List_COMP' }, 'CoveragesAA.Vehicles.COMP', '1', 'ref:CoveragesAA.Vehicles.COMP'],
      [{ tag: 'select', id: 'CoveragesAA_Vehicles_List_1_Embedded_Questions_List_COMP' }, 'CoveragesAA.Vehicles.COMP', '2', 'ref:CoveragesAA.Vehicles.COMP@2'],
      [{ tag: 'select', id: 'CoveragesAA_Vehicles_List_0_Embedded_Questions_List_veh_liab' }, 'CoveragesAA.Vehicles.veh_liab', '1', 'ref:CoveragesAA.Vehicles.veh_liab'],
      [{ type: 'checkbox', name: 'IsSelected', id: 'Portfolio_HvdVehicles_List_3_Embedded_Questions_List_IsSelected' }, 'Portfolio.HvdVehicles.IsSelected', '4', 'ref:Portfolio.HvdVehicles.IsSelected@4'],
      [{ type: 'checkbox', name: 'IsSelected', id: 'Portfolio_HvdVehicles_List_4_Embedded_Questions_List_IsSelected' }, 'Portfolio.HvdVehicles.IsSelected', '5', 'ref:Portfolio.HvdVehicles.IsSelected@5'],
      [{ type: 'checkbox', name: 'IsIncluded', id: 'Portfolio_Embedded_EmbeddedViewModel_ProductSpecificInformation_List_0_Embedded_Questions_List_IsIncluded' }, 'Portfolio.Embedded.EmbeddedViewModel.ProductSpecificInformation.IsIncluded', '1', 'ref:Portfolio.Embedded.EmbeddedViewModel.ProductSpecificInformation.IsIncluded'],
      [{ type: 'radio', id: 'ProductsAA_Embedded_Questions_List_NamedOperatorIndicator_Y', name: 'ProductsAA_Embedded_Questions_List_NamedOperatorIndicator' }, 'ProductsAA.NamedOperatorIndicator', null, 'ref:ProductsAA.NamedOperatorIndicator'],
      [{ type: 'radio', id: 'People_Drivers_List_1_Embedded_Questions_List_StateFiling_N', name: 'People_Drivers_List_1_Embedded_Questions_List_StateFiling' }, 'People.Drivers.StateFiling', '2', 'ref:People.Drivers.StateFiling@2'],
      [{ type: 'tel', id: 'mat-input-21', name: 'pickerInput' }, null, null, 'pickerInput'],
      [{ type: 'checkbox', id: 'product_tab_AA', name: 'product_tab_AA' }, null, null, 'product_tab_AA'],
    ];

    for (const [spec, wantRef, wantRow, wantKey] of cases) {
      const el = mk(spec);
      assert.equal(page.adapter.shared.keys.ref(el), wantRef, `ref(${spec.id})`);
      assert.equal(page.adapter.shared.keys.row(el), wantRow, `row(${spec.id})`);
      assert.equal(page.fieldKey(el), wantKey, `fieldKey(${spec.id})`);
    }
  } finally {
    page.close();
  }

  // Also check actual DOM elements inside fixtures produce the exact decided keys.
  const hh = loadPage(readFixture('household-members.html'));
  try {
    assert.equal(hh.fieldKey(hh.document.getElementById('People_Drivers_List_1_Embedded_Questions_List_StateFiling_Y')), 'ref:People.Drivers.StateFiling@2');
    assert.equal(hh.fieldKey(hh.document.getElementById('People_Drivers_List_1_Embedded_Questions_List_StateFiling_N')), 'ref:People.Drivers.StateFiling@2');
    assert.equal(hh.fieldKey(hh.document.getElementById('People_Drivers_List_1_Violations_List_1_Embedded_Questions_List_Code')), 'ref:People.Drivers.Violations.Code@2.2');
  } finally {
    hh.close();
  }

  const pf = loadPage(readFixture('portfolio.html'));
  try {
    assert.equal(pf.fieldKey(pf.document.getElementById('Portfolio_HvdVehicles_List_0_Embedded_Questions_List_IsSelected')), 'ref:Portfolio.HvdVehicles.IsSelected');
    assert.equal(pf.fieldKey(pf.document.getElementById('Portfolio_HvdVehicles_List_1_Embedded_Questions_List_IsSelected')), 'ref:Portfolio.HvdVehicles.IsSelected@2');
    assert.equal(pf.fieldKey(pf.document.getElementById('Portfolio_Embedded_EmbeddedViewModel_ProductSpecificInformation_List_0_Embedded_Questions_List_IsIncluded')),
      'ref:Portfolio.Embedded.EmbeddedViewModel.ProductSpecificInformation.IsIncluded');
  } finally {
    pf.close();
  }

  const ni = loadPage(readFixture('named-insured.html'));
  try {
    const key = ni.fieldKey(ni.document.getElementById('mat-input-21'));
    assert.ok(!key.startsWith('ref:'), `mat-input-21 must not get a ref: key, got "${key}"`);
  } finally {
    ni.close();
  }
});

test('step links, Portfolio btnNextId, Remove, and Clear are never chosen as Continue or allowed helpers, and idle spinner is not busy', () => {
  const NAV_WORDS = '^(named insured|products|household members|additional details|coverages/bill plans|portfolio|point of sale|final sale)$';

  for (const { file } of FIXTURES) {
    const page = loadPage(readFixture(file));
    try {
      withKitGlobals(page, () => {
        // Hidden idle spinner is not busy; showing it makes pageBusy() true.
        assert.equal(pageBusy(), false, `${file}: hidden spinner is not busy`);
        const spinner = /** @type {HTMLElement} */ (page.document.querySelector('.ui-blocker-spinner-outer-wrapper'));
        assert.ok(spinner, `${file}: has spinner`);
        spinner.style.display = 'block';
        assert.equal(pageBusy(), true, `${file}: visible spinner is busy`);
        spinner.style.visibility = 'hidden';
        assert.equal(pageBusy(), false, `${file}: visibility:hidden spinner is not busy`);
        spinner.style.display = 'none';
        spinner.style.visibility = '';

        // No a.navigation-link is ever found as a Continue or a helper.
        assert.equal(findAdvanceButton(NAV_WORDS), null, `${file}: nav link refused as Continue`);
        assert.equal(findButton({ text: NAV_WORDS }), null, `${file}: nav link refused as helper`);

        // Broad Continue pattern never picks a nav link, btnNextId, Remove, or Clear.
        const adv = findAdvanceButton('next|continue|step');
        if (adv) {
          assert.equal(adv.matches('a.navigation-link'), false, `${file}: not a nav link`);
          assert.notEqual(adv.id, 'btnNextId', `${file}: btnNextId carries "submit" so never Continue`);
          assert.doesNotMatch(adv.textContent ?? '', /\b(remove|clear)\b/i, `${file}: never Remove or Clear`);
        }

        // Remove is refused as both Continue and helper (src/restricted.js NEVER_ADVANCE / NEVER_CLICK).
        assert.equal(findAdvanceButton('remove'), null, `${file}: Remove refused as Continue`);
        assert.equal(findButton({ text: 'remove' }), null, `${file}: Remove refused as helper`);

        // Broad step/navigation helper pattern never picks Clear, Remove, btnNextId, or any nav link.
        const helper = findButton({ text: 'next|continue|step' });
        if (helper) {
          assert.equal(helper.matches('a.navigation-link'), false, `${file}: helper is not a nav link`);
          assert.notEqual(helper.id, 'btnNextId', `${file}: btnNextId never passes as helper`);
          assert.doesNotMatch(helper.textContent ?? '', /\b(remove|clear)\b/i, `${file}: helper is never Remove or Clear`);
        }
      });
    } finally {
      page.close();
    }
  }

  // Portfolio's btnNextId ("POINT OF SALE (submit and move to next step)") is never found as Continue or helper.
  const pf = loadPage(readFixture('portfolio.html'));
  try {
    withKitGlobals(pf, () => {
      assert.equal(findAdvanceButton('next|continue|step'), null, 'portfolio: broad Continue pattern returns null');
      assert.equal(findAdvanceButton('point of sale|submit|next|step'), null, 'portfolio: btnNextId refused as Continue');
      assert.equal(findButton({ text: 'point of sale|submit|next' }), null, 'portfolio: btnNextId refused as helper');
      assert.equal(findButton({ text: 'remove' }), null, 'portfolio: Remove refused as helper');
    });
  } finally {
    pf.close();
  }
});
