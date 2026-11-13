// @ts-check
// The keyboard over what covers the panel (docs/panel-ui.md, "Over the panel"): Escape closes the
// topmost one that is open (the PDF sheet, the quote summary, client details, then Settings), and
// Tab and Shift+Tab stay inside a sheet (`modal`) while it is open, wrapping at its ends. Settings
// covers the view but isn't modal: the header stays usable beside it. sidepanel.js passes the
// layers, read at each key, in that order.

/**
 * @typedef {object} OverlayLayer
 * @property {HTMLElement | null} el The element that is shown while the layer is open.
 * @property {boolean} open
 * @property {() => void} close What Escape does: the panel's own close, which gives focus back.
 * @property {boolean} [modal] Tab stays inside it.
 */

// What Tab can land on inside a layer.
const STOPS = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';

// Shown on screen: not in a hidden part, nor laid out as nothing (Chrome's checkVisibility; jsdom
// has none, and its tests hide by the attribute).
/** @param {Element} el */
const shown = (el) => !el.closest('[hidden]') && (typeof el.checkVisibility !== 'function' || el.checkVisibility());

/** @param {Element} layer @returns {HTMLElement[]} */
function tabStops(layer) {
  return /** @type {HTMLElement[]} */ ([...layer.querySelectorAll(STOPS)]).filter(shown);
}

// One keydown on the panel's document. Returns true when it was the layers' (and its default is
// prevented), false when the key goes on as usual.
/** @param {KeyboardEvent} e @param {OverlayLayer[]} layers */
function overlayKey(e, layers) {
  const top = layers.find((l) => l.open && l.el && !l.el.hidden);
  if (!top?.el) return false;
  if (e.key === 'Escape') { e.preventDefault(); top.close(); return true; }
  if (e.key !== 'Tab' || !top.modal) return false;
  const stops = tabStops(top.el);
  if (!stops.length) return false;
  const [first, last] = [stops[0], stops[stops.length - 1]];
  const active = top.el.ownerDocument.activeElement;
  if (!top.el.contains(active)) { e.preventDefault(); first.focus(); return true; }
  if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); return true; }
  if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); return true; }
  return false;
}

export { overlayKey, tabStops };
