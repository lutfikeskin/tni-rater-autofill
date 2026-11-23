// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { progressivePa } from '../src/carriers/progressive-pa.js';
import { carrierRuleFiles, fieldChangeEvent, knownStep, redactor } from '../src/usage.js';
import { carrierRefusal } from '../scripts/lib/carrier-reports.mjs';
import { currentPage, pageAt, pageBusy } from '../src/kit/adapter.js';
import { stepKey } from '../src/kit/dom.js';
import { capture } from '../src/kit/capture.js';
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
 * Temporarily binds a jsdom page onto globalThis so src/kit/ modules (`stepKey`, `currentPage`,
 * `pageAt`, `pageBusy`, `capture`, `findAdvanceButton`, `findButton`) run directly against its DOM and adapter.
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

test('progressive-pa carrier config wires its own adapter, layoutSteps, stopSteps, and carrierRuleFiles without stopPages, rules or display', () => {
  assert.equal(progressivePa.pageAdapter, 'src/content/carriers/progressive-pa.js');
  assert.deepEqual(progressivePa.layoutSteps, [
    'Named Insured', 'Products', 'Household Members', 'Additional Details',
    'Coverages/Bill Plans', 'Portfolio', 'Point of Sale', 'Final Sale',
  ]);
  assert.equal('stopPages' in progressivePa, false);
  assert.deepEqual(progressivePa.stopSteps, {
    'Point of Sale': 'This step is yours: nothing is filled or clicked. The quote stops at Portfolio.',
    'Final Sale': 'This step is yours: nothing is filled or clicked. The quote stops at Portfolio.',
  });
  assert.equal(knownStep(progressivePa, 'Point of Sale'), 'Point of Sale');
  assert.equal(knownStep(progressivePa, 'Coverages/Bill Plans'), 'Coverages/Bill Plans');
  assert.equal(carrierRefusal('progressive-pa', 'stop: Point of Sale'), false);
  assert.equal(carrierRefusal('progressive-pa', 'stop: Final Sale'), false);
  assert.deepEqual(progressivePa.rules, []);
  assert.equal(progressivePa.useGenericRules, false);
  assert.equal('display' in progressivePa, false);
  assert.equal('advance' in progressivePa, false);
  assert.ok(carrierRuleFiles('progressive-pa').includes('src/content/carriers/progressive-pa.js'));
  assert.ok(!carrierRuleFiles('progressive-pa').includes('src/content/carriers/progressive.js'));
});

test('adapter shape: registers carrier progressive-pa with shared hooks only (no page, no create)', () => {
  const page = loadPage(readFixture('named-insured.html'));
  try {
    assert.equal(page.adapter.carrier, 'progressive-pa');
    assert.equal(page.adapter.create, undefined);
    assert.equal(page.adapter.shared.page, undefined);
    assert.equal(typeof page.adapter.shared.step, 'function');
    assert.equal(typeof page.adapter.shared.date, 'function');
    assert.deepEqual([...page.adapter.shared.selectors.stepLinks], ['a.navigation-link']);
    assert.deepEqual([...page.adapter.shared.selectors.busy], ['.ui-blocker-spinner-outer-wrapper']);
  } finally {
    page.close();
  }
});

test('recorder logs clean question captions across all fixtures, never helper/sr-only/entity noise, and handles radios and checkboxes', () => {
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
      'mat-input-21': 'Policy Effective Date',
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

      for (const el of page.document.querySelectorAll('input, select, textarea')) {
        const desc = page.recorder.read.describe(el);
        for (const bad of NOISE) assert.doesNotMatch(desc.label, bad, `${file} #${el.id} leaked noise: "${desc.label}"`);
      }
    } finally {
      page.close();
    }
  }

  // Real recorder poll emits the clean caption on change events (checkbox + select) and marks pickerInput as date.
  const details = loadPage(readFixture('additional-details.html'));
  try {
    const boat = /** @type {HTMLInputElement} */ (details.document.getElementById('AdditionalDetails_Embedded_Questions_List_Boat'));
    const paperless = /** @type {HTMLSelectElement} */ (details.document.getElementById('AdditionalDetails_Embedded_Questions_List_PaperlessPreference'));
    assert.equal(details.adapter.shared.caption(boat), '', 'checkbox with own <label> text returns empty so own label wins');
    boat.checked = true;
    paperless.value = 'N';
    details.recorder.poll();
    const changes = details.sent.filter((m) => m.event === 'field_changes').flatMap((m) => m.changes);
    assert.equal(changes.find((c) => c.key === 'ref:AdditionalDetails.Boat')?.label, 'Boat');
    assert.equal(changes.find((c) => c.key === 'ref:AdditionalDetails.PaperlessPreference')?.label,
      'Apply Paperless and accept documents and bills delivered through email?');
  } finally {
    details.close();
  }

  const prod = loadPage(readFixture('products.html'));
  try {
    const picker = /** @type {HTMLInputElement} */ (prod.document.getElementById('mat-input-21'));
    assert.equal(prod.adapter.shared.date(picker), true);
    picker.value = '12/01/2026';
    prod.recorder.poll();
    const changes = prod.sent.filter((m) => m.event === 'field_changes').flatMap((m) => m.changes);
    const change = changes.find((c) => c.key === 'picker:PolicyEffectiveDate');
    assert.equal(change?.date, true);
    assert.equal(change?.label, 'Policy Effective Date');
  } finally {
    prod.close();
  }
});

test('caption edge cases: radio skips label[for], checkbox without own label uses <question> label, and fallbacks strip */:', () => {
  const html = `<!doctype html><html><body>
    <h3 id="entitydetails0">2020 Example Sedan</h3>
    <label id="Fallback_Label">Standalone<span aria-hidden="true">*</span>Label : * </label>
    <select id="s1" aria-labelledby="Fallback_Label entitydetails0"></select>
    <select id="s2" aria-labelledby="entitydetails0 Fallback_Label"></select>
    <label for="t1">For Label * : <span class="visually-hidden">Discount tag, for</span><help-icon><span>Help Text, for</span></help-icon></label>
    <input type="text" id="t1">
    <input type="text" id="orphan" aria-labelledby="entitydetails0">

    <span>Prior Lapse Question</span>
    <div role="radiogroup">
      <input type="radio" id="ProductsAA_Embedded_Questions_List_PriorLapse_Y" name="ProductsAA_Embedded_Questions_List_PriorLapse" value="Y">
      <label for="ProductsAA_Embedded_Questions_List_PriorLapse_Y">Yes</label>
    </div>

    <question property="PaperlessBox" class="box-row question">
      <div class="left">
        <div class="question-label">
          <label id="PaperlessBox_Label">Enroll in Paperless? <span aria-hidden="true">*</span></label>
        </div>
      </div>
      <div class="right">
        <input type="checkbox" id="AdditionalDetails_Embedded_Questions_List_PaperlessBox" aria-labelledby="entitydetails0">
      </div>
    </question>
  </body></html>`;
  const page = loadPage(html);
  try {
    const cap = page.adapter.shared.caption;
    assert.equal(cap(page.document.getElementById('s1')), 'Standalone Label');
    assert.equal(cap(page.document.getElementById('s2')), 'Standalone Label');
    assert.equal(cap(page.document.getElementById('t1')), 'For Label');
    assert.equal(cap(page.document.getElementById('orphan')), '');

    // Radio with <label for="…_Y">Yes</label> and no <question> gives '' from caption() and never logs "Yes".
    const radio = page.document.getElementById('ProductsAA_Embedded_Questions_List_PriorLapse_Y');
    assert.equal(cap(radio), '');
    assert.notEqual(page.recorder.read.describe(radio).label, 'Yes');
    assert.equal(page.recorder.read.describe(radio).label, 'Prior Lapse Question');

    // Checkbox with no own label inside <question> uses the question's words, never the entity heading.
    const box = page.document.getElementById('AdditionalDetails_Embedded_Questions_List_PaperlessBox');
    assert.equal(cap(box), 'Enroll in Paperless?');
    assert.equal(page.recorder.read.describe(box).label, 'Enroll in Paperless?');
  } finally {
    page.close();
  }
});

test('step() names each step on /Quote/Index/ for kit and recorder while page stays /Quote/Index/ and never falls back to headings', () => {
  for (const { file, step } of FIXTURES) {
    const page = loadPage(readFixture(file), { url: 'https://www.foragentsonly.com/Quote/Index/' });
    try {
      assert.equal(page.adapter.shared.step(), step, `${file}: shared.step`);
      assert.equal(page.recorder.read.stepKey(), step, `${file}: recorder.stepKey`);
      assert.equal(page.recorder.read.pageKey(), '/Quote/Index/', `${file}: recorder.pageKey`);
      const pageView = page.sent.find((m) => m.event === 'page_view');
      assert.equal(pageView?.page, '/Quote/Index/', `${file}: initial page_view page`);
      assert.equal(pageView?.step, step, `${file}: initial page_view step`);

      withKitGlobals(page, () => {
        assert.equal(stepKey(), step, `${file}: kit.stepKey`);
        assert.equal(currentPage(), '/Quote/Index/', `${file}: kit.currentPage`);
        assert.equal(pageAt(page.window.location), '/Quote/Index/', `${file}: kit.pageAt`);
        const cap = capture();
        assert.equal(cap.isTopFrame, true, `${file}: capture.isTopFrame`);
        assert.equal(cap.page, '/Quote/Index/', `${file}: capture.page`);
        assert.equal(cap.step, step, `${file}: capture.step`);
      });
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
      assert.equal(page.adapter.shared.step(), want);
      assert.equal(page.recorder.read.stepKey(), want);
      assert.equal(page.recorder.read.pageKey(), '/quote/index');
      withKitGlobals(page, () => {
        assert.equal(stepKey(), want);
        assert.equal(pageAt(page.window.location), '/quote/index');
      });
    } finally {
      page.close();
    }
  }

  // Wrong path: step returns null (kit '' / recorder undefined), page is the URL path.
  const wrongPath = loadPage(readFixture('coverages.html'), { url: 'https://www.foragentsonly.com/Home/Dashboard' });
  try {
    assert.equal(wrongPath.adapter.shared.step(), null);
    assert.equal(wrongPath.recorder.read.stepKey(), undefined);
    assert.equal(wrongPath.recorder.read.pageKey(), '/Home/Dashboard');
    withKitGlobals(wrongPath, () => {
      assert.equal(stepKey(), '');
      assert.equal(pageAt(wrongPath.window.location), '/Home/Dashboard');
    });
  } finally {
    wrongPath.close();
  }

  // No nav link current + visible h1/h2 holding "Test Person": kit returns '', recorder undefined (never headings).
  const noCurrentHtml = readFixture('coverages.html')
    .replace(' aria-current="step"', '')
    .replace('<main>', '<main><h1>Test Person</h1><h2>Test Person</h2>');
  const noCurrent = loadPage(noCurrentHtml, { url: 'https://www.foragentsonly.com/Quote/Index/' });
  try {
    assert.equal(noCurrent.adapter.shared.step(), null);
    assert.equal(noCurrent.recorder.read.stepKey(), undefined);
    assert.equal(noCurrent.recorder.read.pageKey(), '/Quote/Index/');
    withKitGlobals(noCurrent, () => {
      assert.equal(stepKey(), '');
      assert.equal(currentPage(), '/Quote/Index/');
    });

    // Two current nav items -> null (kit '' / recorder undefined).
    const links = noCurrent.document.querySelectorAll('a.navigation-link');
    links[0].setAttribute('aria-current', 'step');
    links[1].setAttribute('aria-current', 'step');
    assert.equal(noCurrent.adapter.shared.step(), null);
    assert.equal(noCurrent.recorder.read.stepKey(), undefined);
    withKitGlobals(noCurrent, () => assert.equal(stepKey(), ''));

    // Unknown step text -> null (never document.title or headings).
    links[1].removeAttribute('aria-current');
    links[0].textContent = 'UNLISTED STEP';
    assert.equal(noCurrent.adapter.shared.step(), null);
    assert.equal(noCurrent.recorder.read.stepKey(), undefined);
    withKitGlobals(noCurrent, () => assert.equal(stepKey(), ''));
  } finally {
    noCurrent.close();
  }
});

test('field keys match the decided ref, row, and picker:special mapping across fixtures and edge cases', () => {
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
      [{ type: 'text', id: 'mat-input-99' }, null, null, 'mat-input-99'],
      [{ tag: 'button', id: 'product_tab_AA' }, null, null, 'product_tab_AA'],
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

  // Actual DOM elements inside fixtures produce the exact decided keys (including picker:PolicyEffectiveDate).
  const prod = loadPage(readFixture('products.html'));
  try {
    const picker = prod.document.getElementById('mat-input-21');
    assert.equal(prod.adapter.shared.keys.ref(picker), null);
    assert.equal(prod.adapter.shared.keys.special(picker), 'picker:PolicyEffectiveDate');
    assert.equal(prod.fieldKey(picker), 'picker:PolicyEffectiveDate');
  } finally {
    prod.close();
  }

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
    assert.equal(key, 'picker:DateOfBirth');
    assert.ok(!key.startsWith('ref:'), `mat-input-21 must not get a ref: key, got "${key}"`);
  } finally {
    ni.close();
  }

  // Nested row keys (`@<row>.<sub-row>`) pass DATA_MODEL_KEY in src/usage.js without redaction or hashing.
  const nestedChange = fieldChangeEvent(
    { key: 'ref:People.Drivers.Violations.Code@1.2', q: null, label: 'Incident Description', kind: 'select', before: '', after: 'Speeding', agent: true },
    { record: /** @type {any} */ ({}), filled: new Map(), redact: redactor(['Code', 'Drivers']), keySalt: 'salt-1' },
  );
  assert.equal(nestedChange.key, 'ref:People.Drivers.Violations.Code@1.2');
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
