// @ts-check
// Which screen the side panel shows, decided from the loaded intake, the chosen quote view,
// whether Settings is open, and `state.dock` (`dockFor`, `fillingSaid` and `continueSaid` in
// `coordinator.js`). Pure decision logic: no runtime imports and no DOM.

/** @import { PanelScreen } from '../../types.js' */

/**
 * Shape of `state.dock` (`renderDock` in `coordinator.js`, built from `dockFor`, `fillingSaid`
 * and `continueSaid`).
 * @typedef {object} DockSnapshot
 * @property {string} [phase]
 * @property {'bad' | 'warn' | 'good' | 'blue' | 'ai'} [tone]
 * @property {string} [eyebrow]
 * @property {string} [title]
 * @property {string} [sub]
 * @property {string} [button]
 * @property {string} [label]
 * @property {boolean} [disabled]
 * @property {string} [alt]
 * @property {string} [altLabel]
 * @property {string} [go]
 * @property {number | boolean} [progress]
 * @property {string} [progressSaid]
 * @property {boolean} [hidden]
 * @property {string} [report]
 * @property {boolean} [busy]
 * @property {string} [paused]
 */

/**
 * @param {{
 *   intake?: unknown,
 *   view?: string | null,
 *   settingsOpen?: boolean,
 *   dock?: DockSnapshot | null,
 * }} [state]
 * @returns {PanelScreen}
 */
export function screenFor({ intake = null, view = null, settingsOpen = false, dock = null } = {}) {
  if (settingsOpen) return 'settings';
  if (!intake) return 'start';
  if (view === 'check') return 'check';
  switch (dock?.phase) {
    case 'start':
      return 'start';
    case 'off':
      if (dock.eyebrow === 'Preview') return 'preview';
      if (/\bread\b/.test(dock.title ?? '')) return 'unreadable';
      return 'norater';
    case 'portal':
      return 'portal';
    case 'stopped':
      return 'stopped';
    case 'yours':
      if (dock.alt === 'fill-again') return 'review';
      return 'yours';
    case 'hold':
      if (dock.alt === 'fill-anyway') return 'hold';
      if (dock.button === 'dock-defaults' || dock.disabled) return 'defaults';
      if (dock.button === 'fill') return 'owner';
      return 'hold';
    case 'ready':
      return 'ready';
    case 'filling':
      return 'filling';
    case 'elsewhere':
      return 'elsewhere';
    case 'needs':
    case 'waiting':
    case 'check':
    case 'ready-continue':
      return 'review';
    case 'stopped-fill':
      return 'stopped-fill';
    case 'error':
      return 'error';
    case 'ai':
      return 'ai';
    case 'finished':
      return 'finished';
    case 'done':
      return 'continued';
    default:
      return 'norater';
  }
}
