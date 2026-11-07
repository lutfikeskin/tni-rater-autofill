// @ts-check
// Trusted user gesture tracking, keystroke edit protection against rater overwrite, multi-frame AI answer edit sessions, and halt reasons.

import { radioHost, deepQueryAll, collectControls, fieldKey, shadowOf } from './dom.js';
import { closestOwn, withAdapter } from './adapter.js';

/** @import { PageControl } from './dom.js' */

export const EDIT_HALT = 'An agent edit interrupted filling. Review before resuming.';
export const EDIT_HALT_ANSWERS = 'an agent edit interrupted applying the answers; review the page, then request fresh suggestions';
export const STOP_HALT = 'You stopped the fill. Nothing more was filled or clicked.';
export const STOP_STEP_HALT = 'This step is yours: nothing is filled or clicked here.';
export const STEP_UNREAD_HALT = 'The step on screen could not be read (the progress bar and the page title disagree): fill again once the page settles.';

/**
 * Installs listeners to detect trusted agent edits to page controls.
 * @param {(key: string, c: PageControl) => void} onEdit
 * @returns {() => void} cleanup function
 */
export function guardEdits(onEdit) {
  let lastGesture = -Infinity;
  let gestureTarget = null;
  let gestureControl = null;

  const popupControl = (target) => {
    const option = target?.closest?.(withAdapter('[role=option]', 'options'));
    const popup = option?.closest?.(withAdapter('[role=listbox]', 'lists'));
    if (!popup) return null;
    const isControl = (el) => /^(INPUT|SELECT|TEXTAREA)$/.test(el?.tagName ?? '');
    if (popup.id) {
      for (const owner of deepQueryAll(document, 'input, select, textarea, [role=combobox]')) {
        const refs = `${owner.getAttribute('aria-owns') ?? ''} ${owner.getAttribute('aria-controls') ?? ''}`.split(/\s+/);
        if (!refs.includes(popup.id)) continue;
        const control = isControl(owner) ? owner : owner.querySelector('input, select, textarea');
        if (isControl(control)) return control;
      }
    }
    return isControl(document.activeElement) ? document.activeElement : null;
  };

  const gestureTypes = ['pointerdown', 'keydown', 'paste', 'drop'];
  const realTarget = (event) => event.composedPath?.()[0] ?? event.target ?? null;

  const trackGesture = (event) => {
    if (!event.isTrusted) return;
    lastGesture = Date.now();
    gestureTarget = realTarget(event);
    gestureControl = popupControl(gestureTarget);
  };

  const sameGroup = (a, b) => a === b || (!!a && !!b && a.type === 'radio' && b.type === 'radio'
    && !!a.name && a.name === b.name && (a.form ?? null) === (b.form ?? null));

  const gestureOn = (el) => {
    const target = gestureTarget;
    if (!target || !el) return false;
    if (sameGroup(target, el) || sameGroup(gestureControl, el)) return true;
    for (let n = target, i = 0; n && i < 8; n = n.parentElement ?? /** @type {any} */ (n.getRootNode?.())?.host, i++) {
      const input = /** @type {HTMLInputElement | null | undefined} */ (shadowOf(n)?.querySelector?.('input[type=radio]'));
      if (input && radioHost(input) === n) return sameGroup(input, el);
    }
    const label = target.closest?.('label');
    if (label) {
      const forId = label.htmlFor || label.getAttribute?.('for');
      const linked = label.control ?? (forId ? document.getElementById(forId) : null)
        ?? label.querySelector?.('input, select, textarea');
      if (sameGroup(linked, el)) return true;
    }
    if (closestOwn(target, 'fieldWrap')?.contains?.(el)) return true;
    if (target === document.body || target === document.documentElement || !target.contains?.(el)) return false;
    return [...(target.querySelectorAll?.('input, select, textarea') ?? [])].every((x) => sameGroup(x, el));
  };

  const protectEdit = (event) => {
    const target = realTarget(event);
    if (!event.isTrusted || Date.now() - lastGesture > 2000 || !gestureOn(target)) return;
    const c = collectControls().find((x) => x.el === target || (x.radios?.includes(target)));
    if (c) onEdit(fieldKey(c), c);
  };

  for (const type of gestureTypes) document.addEventListener(type, trackGesture, true);
  document.addEventListener('input', protectEdit, true);
  document.addEventListener('change', protectEdit, true);
  return () => {
    for (const type of gestureTypes) document.removeEventListener(type, trackGesture, true);
    document.removeEventListener('input', protectEdit, true);
    document.removeEventListener('change', protectEdit, true);
  };
}

/** @type {{ questions: Map<string, string | null>, release: () => void, token: string } | null} */
let answerEditSession = null;
export const getAnswerEditSession = () => answerEditSession;
export const clearAnswerEditSession = () => { answerEditSession = null; };

/**
 * Manages multi-frame AI answer edit protection session.
 * @param {'read' | 'begin' | 'end' | string} [command]
 * @param {string} [token]
 * @returns {Array<{ key: string, label: string | null, ok: false, protected: true, reason: string }> | null}
 */
export function answerEdits(command = 'read', token = '') {
  if (command === 'begin') {
    answerEditSession?.release();
    const questions = new Map();
    const release = guardEdits((key, c) => questions.set(key, c.label ?? null));
    answerEditSession = { questions, release, token };
  }
  if (!answerEditSession || answerEditSession.token !== token) return null;
  const results = [...(answerEditSession?.questions ?? [])].map(([key, label]) => ({
    key,
    label,
    ok: /** @type {const} */ (false),
    protected: /** @type {const} */ (true),
    reason: 'you changed this question yourself while the AI answers went in; your answer stays',
  }));
  if (command === 'end') {
    answerEditSession?.release();
    answerEditSession = null;
  }
  return results;
}
