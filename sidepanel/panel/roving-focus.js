// @ts-check
// Roving tabindex keyboard navigation for WAI-ARIA composite widgets (`tablist`, `toolbar`):
// keeps one visible enabled item tabbable (`tabIndex=0`) and moves focus on ArrowLeft,
// ArrowRight, Home and End.

/**
 * Visible, enabled items matching `selector` inside `container`.
 * @param {HTMLElement | null} container
 * @param {string} selector
 * @returns {HTMLElement[]}
 */
function rovingItems(container, selector) {
  if (!container) return [];
  /** @type {HTMLElement[]} */
  const items = [];
  for (const el of container.querySelectorAll(selector)) {
    if (
      el instanceof HTMLElement
      && !el.hidden
      && !el.closest('[hidden]')
      && !/** @type {HTMLButtonElement} */ (el).disabled
      && el.getAttribute('aria-disabled') !== 'true'
    ) {
      items.push(el);
    }
  }
  return items;
}

/**
 * Handles horizontal roving-focus keys (`ArrowLeft`, `ArrowRight`, `Home`, `End`) inside a
 * `tablist` or `toolbar`, updating `tabIndex` and moving focus to the next item.
 * @param {import('react').KeyboardEvent | KeyboardEvent} e
 * @param {HTMLElement | null} container
 * @param {string} selector
 * @param {{ wrap?: boolean, onMove?: (el: HTMLElement) => void }} [opts]
 */
function handleRovingKey(e, container, selector, { wrap = false, onMove } = {}) {
  const { key } = e;
  if (key !== 'ArrowRight' && key !== 'ArrowLeft' && key !== 'Home' && key !== 'End') return;
  const items = rovingItems(container, selector);
  if (!items.length) return;
  const current = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
  const rtl = container ? getComputedStyle(container).direction === 'rtl' : false;
  const step = (key === 'ArrowRight' ? 1 : -1) * (rtl ? -1 : 1);
  let next;
  if (key === 'Home') next = 0;
  else if (key === 'End') next = items.length - 1;
  else if (current < 0) next = 0;
  else if (wrap) next = (current + step + items.length) % items.length;
  else next = Math.max(0, Math.min(items.length - 1, current + step));
  const target = items[next];
  if (!target) return;
  e.preventDefault();
  for (const el of items) el.tabIndex = el === target ? 0 : -1;
  target.focus();
  onMove?.(target);
}

export { handleRovingKey, rovingItems };
