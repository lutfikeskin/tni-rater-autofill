// The page's own requests still running (fetch and XHR to its origin), counted in the page's own
// world and written on <html data-rater-pending="n">, where the kit's isolated world reads it.
// Resource Timing only shows a request once it has finished, so a quiet page can't show one still
// running: GEICO saves each coverage pick with a request sent half a second later, and a Recalculate
// clicked before that save was back was rated with GEICO's own values (W43-44, FL, 2026-10-22).
// Injected by the side panel for carriers with `countRequests` (GEICO), in the top frame, again
// before each fill; it wraps fetch and XHR once. Requests started before it was injected aren't
// counted. It reads nothing from the requests and changes nothing in them.
(() => {
  if (window.__raterRequestCount) return;
  let pending = 0;
  const show = () => { try { document.documentElement.setAttribute('data-rater-pending', String(pending)); } catch { /* no document yet */ } };
  const own = (url) => {
    try { return new URL(String(url), location.href).origin === location.origin; } catch { return false; }
  };
  const started = () => { pending++; show(); };
  const ended = () => { pending = Math.max(0, pending - 1); show(); };
  window.__raterRequestCount = { pending: () => pending };
  show();

  const fetch = window.fetch;
  if (typeof fetch === 'function') {
    window.fetch = function (input, init) {
      const counted = own(input?.url ?? input);
      if (counted) started();
      let result;
      try { result = fetch.call(this, input, init); } catch (e) { if (counted) ended(); throw e; }
      if (counted) Promise.resolve(result).then(ended, ended);
      return result;
    };
  }

  const XHR = window.XMLHttpRequest?.prototype;
  if (XHR) {
    const open = XHR.open;
    const send = XHR.send;
    XHR.open = function (method, url, ...rest) {
      this.__raterOwn = own(url);
      return open.call(this, method, url, ...rest);
    };
    XHR.send = function (...args) {
      if (this.__raterOwn && !this.__raterCounted) {
        this.__raterCounted = true;
        started();
        this.addEventListener('loadend', () => { this.__raterCounted = false; ended(); }, { once: true });
      }
      try { return send.apply(this, args); } catch (e) { if (this.__raterCounted) { this.__raterCounted = false; ended(); } throw e; }
    };
  }
})();
