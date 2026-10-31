// The panel's chrome.* in the preview (preview/index.html): the extension APIs the panel uses,
// answered by the preview page (preview/preview.js) instead of Chrome. Vite's dev server puts this
// classic script before the panel's own code (vite.config.js); a build never includes it. The panel
// page opened by itself, outside the preview, keeps its own "Preview only" mode.
//
// What the panel stores lives in the preview page, as JSON, so it survives the panel reloading
// after an edit and is gone when the preview reloads. Nothing leaves this computer: a request to
// any other origin is refused, and uploads start switched off (the server setting is blank).
(() => {
  const host = window.parent !== window ? window.parent.__tniPreview : null;
  if (!host) return;

  // Values cross between pages as Chrome sends them: JSON, rebuilt in the receiving page.
  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  const event = () => {
    const listeners = new Set();
    return {
      addListener: (f) => listeners.add(f),
      removeListener: (f) => listeners.delete(f),
      hasListener: (f) => listeners.has(f),
      listeners,
    };
  };
  const fire = (ev, ...args) => {
    for (const f of ev.listeners) {
      try { f(...args); } catch (e) { console.error(e); }
    }
  };

  const area = (name) => {
    const data = host.storage[name];
    const read = (k) => JSON.parse(data.get(k));
    return {
      async get(keys) {
        const out = {};
        if (keys == null) {
          for (const k of data.keys()) out[k] = read(k);
        } else if (typeof keys === 'string' || Array.isArray(keys)) {
          for (const k of [].concat(keys)) if (data.has(k)) out[k] = read(k);
        } else {
          for (const [k, fallback] of Object.entries(keys)) out[k] = data.has(k) ? read(k) : fallback;
        }
        return out;
      },
      async set(items) {
        for (const [k, v] of Object.entries(items)) if (v !== undefined) data.set(k, JSON.stringify(v));
      },
      async remove(keys) {
        for (const k of [].concat(keys)) data.delete(k);
      },
      async clear() { data.clear(); },
      async setAccessLevel() {},
      onChanged: event(),
    };
  };

  const runtime = {
    id: 'preview',
    lastError: undefined,
    getURL: (p) => new URL(`/${String(p).replace(/^\//, '')}`, location.origin).href,
    getManifest: () => clone(host.manifest),
    // To other extension pages (another copy of the panel): the preview has none.
    sendMessage: async () => undefined,
    onMessage: event(),
  };

  const tabs = {
    query: async () => (host.tab() ? [clone(host.tab())] : []),
    get: async (id) => {
      if (!host.tab() || id !== host.tab().id) throw new Error(`No tab with id: ${id}.`);
      return clone(host.tab());
    },
    getCurrent: async () => undefined,
    create: async ({ url }) => { host.open(url); return { id: -1, url }; },
    remove: async () => {},
    sendMessage: async (tabId, msg, options) => clone(await host.toPage(clone(msg), options?.frameId)),
    onUpdated: event(),
    onActivated: event(),
    onCreated: event(),
    onRemoved: event(),
  };

  const browserWindow = { id: 1, focused: true, type: 'normal', state: 'normal' };
  const windows = {
    getCurrent: async () => ({ ...browserWindow }),
    getLastFocused: async () => ({ ...browserWindow }),
    create: async ({ url }) => { host.open(url); return { id: -1 }; },
    remove: async () => {},
    onFocusChanged: event(),
    onBoundsChanged: event(),
  };

  // The page scripts as files, fetched once per panel load.
  const files = new Map();
  const fileText = (f) => {
    if (!files.has(f)) files.set(f, fetch(runtime.getURL(f)).then((r) => {
      if (!r.ok) throw new Error(`Could not load file: '${f}'.`);
      return r.text();
    }));
    return files.get(f);
  };

  // Runs `func` or `files` in the practice carrier page's frames, as Chrome does in a tab: there is
  // one world (the page's), arguments and results go as JSON, and a frame whose script throws gives
  // no result (the error is in the console). Each runs with the frame's `window` from the preview
  // (windowFor), whose `top` is the carrier page.
  const inFrame = (win, source, url) => win.eval(`(function (window) {\n${source}\n})${url ? `\n//# sourceURL=${url}` : ''}`).call(win, host.windowFor(win));
  const scripting = {
    async executeScript({ target, func, args = [], files: names }) {
      const tab = host.tab();
      if (!tab || target.tabId !== tab.id) throw new Error(`No tab with id: ${target.tabId}.`);
      let frames = host.frames();
      if (target.documentIds) {
        frames = frames.filter((f) => target.documentIds.includes(f.documentId));
        if (!frames.length) throw new Error(`No document with id ${target.documentIds[0]} in tab with id ${target.tabId}`);
      } else if (target.frameIds) {
        frames = frames.filter((f) => target.frameIds.includes(f.frameId));
        if (!frames.length) throw new Error(`No frame with id ${target.frameIds[0]} in tab with id ${target.tabId}`);
      } else if (!target.allFrames) {
        frames = frames.slice(0, 1);
      }
      const texts = names ? await Promise.all(names.map(fileText)) : null;
      return Promise.all(frames.map(async ({ win, frameId, documentId }) => {
        host.pageChrome(win);
        let result;
        try {
          if (texts) {
            for (const [i, text] of texts.entries()) result = inFrame(win, text, runtime.getURL(names[i]));
          } else {
            result = await inFrame(win, `return (${func});`)(...win.JSON.parse(JSON.stringify(args)));
          }
        } catch (e) {
          console.error(`preview: script in frame ${frameId} threw`, e);
          result = undefined;
        }
        return { frameId, documentId, result: clone(result) };
      }));
    },
  };

  const noop = async () => {};
  globalThis.chrome = {
    runtime,
    tabs,
    windows,
    scripting,
    storage: { local: area('local'), session: area('session'), onChanged: event() },
    sidePanel: { open: noop, close: noop, setPanelBehavior: noop },
  };

  // What the preview page tells this panel: the page's messages (the usage recorder's), and the tab
  // loading or changing address.
  host.panel = {
    message: (msg, sender) => new Promise((resolve) => {
      let waits = false, done = false;
      const respond = (r) => { if (!done) { done = true; resolve(clone(r)); } };
      for (const f of runtime.onMessage.listeners) {
        try {
          const r = f(clone(msg), clone(sender), respond);
          if (r === true) waits = true;
          else if (r && typeof r.then === 'function') { waits = true; r.then(respond, () => respond(undefined)); }
        } catch (e) { console.error(e); }
      }
      if (!waits) respond(undefined);
    }),
    tabUpdated: (change) => fire(tabs.onUpdated, host.tab()?.id, clone(change), clone(host.tab())),
  };

  // Nothing leaves this computer from the preview.
  const fetchHere = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin !== location.origin) return Promise.reject(new TypeError(`The preview doesn't send requests off this computer (${url.origin}).`));
    return fetchHere(input, init);
  };
})();
