// The side panel: where the panel runs: in the extension or a preview, docked or in its own window, and this copy.
// One part of the panel; sidepanel.js wires the parts together.
import * as pdfjs from '../../lib/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../../lib/pdf.worker.min.mjs', import.meta.url).href;

// Outside the extension (e.g. opening this page directly to check the layout) there is no
// chrome.* API: keep data in memory and disable filling.
const inExtension = !!globalThis.chrome?.scripting;
// The panel opened in a window of its own (Pop out, popOut) rather than as Chrome's side panel: it
// follows the browser window the agent last used (tabInView) and offers Dock instead.
const popped = new URLSearchParams(globalThis.location?.search ?? '').get('window') === 'popup';
// This copy of the panel: with one in its own window, only the newest stays (onPanelMessage).
const panelCopy = { id: globalThis.crypto?.randomUUID?.() ?? String(Math.random()), at: Date.now() };

export { inExtension, panelCopy, popped };
