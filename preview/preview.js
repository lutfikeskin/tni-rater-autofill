// The preview page (npm run preview): the side panel beside a practice carrier page, as one tab of
// Chrome with the extension's panel open, on Vite's dev server. The panel's chrome.* is
// panel-shim.js; this page answers it: the stored data, the one tab (the carrier frame), its frames
// and the messages between the page scripts and the panel.
//
// For seeing and changing how the panel looks and behaves while working on it. It proves nothing
// about a live carrier or the packaged extension: that is the verify-tni-rater skill's.

// Fetched, not imported: this page runs without Vite's client (vite.config.js).
const manifest = await (await fetch('/manifest.json')).json();

// The practice carrier pages the repository serves (src/carriers.js PRACTICE).
const CARRIERS = {
  amwins: { name: 'AmWINS', url: '/test/fixtures/amwins/application.html' },
  geico: { name: 'GEICO', url: '/test/fixtures/geico/quote.html' },
  progressive: { name: 'Progressive', url: '/test/mock-progressive/index.html' },
};
const SAMPLE_INTAKE = '/test/fixtures/sample-intake.pdf';
const TAB_ID = 1;

const $ = (id) => document.getElementById(id);
const carrierFrame = $('carrier');
const panelFrame = $('panel');
const params = new URLSearchParams(location.search);

// The panel's storage, as JSON strings: chrome.storage.local and session. Uploads start off.
const storage = { local: new Map(), session: new Map() };
const resetStorage = () => {
  storage.local.clear();
  storage.session.clear();
  storage.local.set('settings', JSON.stringify({ serverUrl: '' }));
};
resetStorage();

const documentIds = new WeakMap();
const documentId = (doc) => {
  if (!documentIds.has(doc)) documentIds.set(doc, crypto.randomUUID().replaceAll('-', '').toUpperCase());
  return documentIds.get(doc);
};
const json = (win, x) => (x === undefined ? undefined : win.JSON.parse(JSON.stringify(x)));

// The tab's frames, top first, as Chrome numbers them (frameId 0 is the top).
function frames() {
  const list = [];
  const walk = (win) => {
    let doc;
    try { doc = win.document; } catch { return; /* another origin: Chrome would need its permission */ }
    list.push({ win, frameId: list.length, documentId: documentId(doc) });
    for (let i = 0; i < win.frames.length; i++) walk(win.frames[i]);
  };
  if (carrierFrame.contentWindow) walk(carrierFrame.contentWindow);
  return list;
}

function tab() {
  const win = carrierFrame.contentWindow;
  let url = '', title = '';
  try { url = win.location.href; title = win.document.title; } catch { /* loading */ }
  if (!url || url === 'about:blank') return null;
  return { id: TAB_ID, windowId: 1, index: 0, active: true, highlighted: true, url, title, status: carrierFrame.dataset.status ?? 'complete' };
}

function deliver(listeners, win, msg, sender) {
  return new Promise((resolve) => {
    let waits = false, done = false;
    const respond = (r) => { if (!done) { done = true; resolve(r); } };
    for (const f of listeners) {
      try {
        const r = f(json(win, msg), json(win, sender), respond);
        if (r === true) waits = true;
        else if (r && typeof r.then === 'function') { waits = true; r.then(respond, () => respond(undefined)); }
      } catch (e) { console.error(e); }
    }
    if (!waits) respond(undefined);
  });
}

// The `window` the page scripts run with: the frame's own, except that its `top` is the carrier
// page, as in a tab of its own (in the preview the carrier page is a frame, whose real top is this
// page). The page scripts tell the top frame from frames inside it by `window === window.top`.
const windows = new WeakMap();
function windowFor(win) {
  if (!windows.has(win)) {
    windows.set(win, new Proxy(win, {
      get(target, key) {
        if (key === 'top') return windowFor(carrierFrame.contentWindow);
        if (key === 'parent') return windowFor(target === carrierFrame.contentWindow ? target : target.parent);
        if (key === 'window' || key === 'self') return windowFor(target);
        const value = Reflect.get(target, key, target);
        // The window's own methods (setTimeout, getComputedStyle) need it as `this`; constructors
        // keep their prototype.
        return typeof value === 'function' && !('prototype' in value) ? value.bind(target) : value;
      },
      set: (target, key, value) => Reflect.set(target, key, value, target),
    }));
  }
  return windows.get(win);
}

// The page scripts' chrome.runtime (the usage recorder's and the trace's): messages to the panel.
function pageChrome(win) {
  if (win.__previewChrome) return;
  const listeners = new Set();
  win.__previewChrome = { listeners };
  const runtime = {
    id: 'preview',
    sendMessage: async (msg) => {
      const frame = frames().find((f) => f.win === win);
      const sender = { id: 'preview', tab: tab(), frameId: frame?.frameId ?? 0, documentId: frame?.documentId, url: win.location.href };
      return json(win, await host.panel?.message(JSON.parse(JSON.stringify(msg)), sender));
    },
    onMessage: {
      addListener: (f) => listeners.add(f),
      removeListener: (f) => listeners.delete(f),
      hasListener: (f) => listeners.has(f),
    },
  };
  win.chrome = Object.assign(win.chrome ?? {}, { runtime });
}

// chrome.tabs.sendMessage from the panel: to every frame's listeners, or one frame's.
async function toPage(msg, frameId) {
  const targets = frames().filter((f) => frameId == null || f.frameId === frameId);
  const replies = await Promise.all(targets.map((f) => (f.win.__previewChrome ? deliver(f.win.__previewChrome.listeners, f.win, msg, { id: 'preview' }) : undefined)));
  return replies.find((r) => r !== undefined);
}

const host = {
  manifest,
  storage,
  tab,
  frames,
  windowFor,
  pageChrome,
  toPage,
  open: (url) => window.open(url, '_blank', 'noopener'),
  panel: null,
};
window.__tniPreview = host;

// The tab's address: Chrome's tabs.onUpdated when the carrier page loads, and when its address
// changes without a load (a page that changes its own query or hash).
let lastUrl = '';
const tabChanged = (change) => {
  lastUrl = tab()?.url ?? '';
  host.panel?.tabUpdated(change);
  $('address').textContent = lastUrl ? new URL(lastUrl).pathname + new URL(lastUrl).search : '';
};
carrierFrame.addEventListener('load', () => {
  carrierFrame.dataset.status = 'complete';
  tabChanged({ status: 'complete', url: tab()?.url });
});
setInterval(() => {
  const url = tab()?.url ?? '';
  if (url && url !== lastUrl) tabChanged({ url });
}, 500);

function openCarrier(id) {
  const carrier = CARRIERS[id] ?? CARRIERS.amwins;
  $('carrier-pick').value = id in CARRIERS ? id : 'amwins';
  carrierFrame.dataset.status = 'loading';
  host.panel?.tabUpdated({ status: 'loading' });
  carrierFrame.src = carrier.url;
  params.set('carrier', $('carrier-pick').value);
  history.replaceState(null, '', `?${params}`);
}

// The sample intake (scrubbed, committed) through the panel's own file input, as an agent picks one.
async function loadSample() {
  const blob = await (await fetch(SAMPLE_INTAKE)).blob();
  const doc = panelFrame.contentDocument;
  const input = doc.getElementById('file');
  const data = new panelFrame.contentWindow.DataTransfer();
  data.items.add(new panelFrame.contentWindow.File([blob], 'sample-intake.pdf', { type: 'application/pdf' }));
  input.files = data.files;
  input.dispatchEvent(new panelFrame.contentWindow.Event('change', { bubbles: true }));
}

function setPanelWidth(px) {
  document.documentElement.style.setProperty('--panel-width', `${px}px`);
  $('panel-width').value = String(px);
  params.set('width', String(px));
  history.replaceState(null, '', `?${params}`);
}

for (const [id, c] of Object.entries(CARRIERS)) $('carrier-pick').append(new Option(c.name, id));
$('carrier-pick').addEventListener('change', (e) => openCarrier(e.target.value));
$('reload-carrier').addEventListener('click', () => openCarrier($('carrier-pick').value));
$('sample').addEventListener('click', () => loadSample().catch((e) => console.error(e)));
$('reset').addEventListener('click', () => {
  resetStorage();
  panelFrame.contentWindow.location.reload();
  openCarrier($('carrier-pick').value);
});
$('panel-width').addEventListener('change', (e) => setPanelWidth(Number(e.target.value)));

setPanelWidth(Number(params.get('width')) || 400);
openCarrier(params.get('carrier') ?? 'amwins');
panelFrame.src = '/sidepanel/sidepanel.html';
