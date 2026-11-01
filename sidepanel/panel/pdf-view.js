// The side panel: the intake PDF shown in the panel.
// One part of the panel; sidepanel.js wires the parts together.
import * as pdfjs from '../../lib/pdf.min.mjs';
import { sourcePlace } from '../../src/intake-source.js';
import { fillEvents, knownStep } from '../../src/usage.js';
import * as usage from '../usage-log.js';
import { inExtension } from './env.js';
import { $, clearAgentKeys, persistAiPending, state, store } from './core.js';
import { loadFile, logProfile, profileTimer } from './intake.js';
import { render, showScreen } from './record.js';
import { pageOf, samePage } from './usage.js';
import { cancelLayouts, dropReports, holdLayouts, renderSite, resetViews, stopPageIsOurs, viewOf } from './coordinator.js';
import { refreshAnswers, runKit } from './fill.js';
import { stopRecording } from './dev-recording.js';
import { flushSync } from 'react-dom';

// ---------------------------------------------------------------------------------------------
// The intake PDF, shown in the panel with the item it was opened for marked on it

// Kept in session storage beside the intake (cleared when Chrome closes, or by Clear this client),
// so a reopened panel can still show it. That storage holds 10 MB in all: a larger PDF is shown
// only until the panel closes.
const PDF_KEY = 'intakePdf';
const PDF_KEEP_MAX = 4 * 1024 * 1024;
// Zoom steps, relative to the page fitting the panel's width. The whole PDF opens at PDF_OPEN_ZOOM,
// the page fitting the width, so the agent sees where everything is and zooms (the buttons, Ctrl +
// wheel) or drags the page around (pdfPan); an item marked on it opens at PDF_FOCUS_ZOOM, where the
// form's text is readable at the panel's width (it opened at 200% before, and at a side panel's
// width the agent had to scroll sideways to find anything: the maintainer, 2026-10-23).
const PDF_ZOOMS = [1, 1.5, 2, 3, 4];
const PDF_OPEN_ZOOM = 1;
// An item opens at 200%: 300% showed too little around it (2026-10-10).
const PDF_FOCUS_ZOOM = 2;

// Whether the intake PDF can be shown (this panel read it, or it is kept for the session).
function pdfAvailable() {
  return !!(state.pdfBytes || state.intake?.pdfKept);
}

// "page 2" for an intake of several pages; nothing for a one-page intake (TNI's is one page).
function pdfPageSaid(page, before) {
  return (state.intake?.places?.pages?.length ?? 1) > 1 ? `${before}${page + 1}` : '';
}

async function keepPdf(bytes) {
  state.pdfBytes = bytes;
  state.pdfDoc?.doc.then((d) => d.destroy()).catch(() => {});
  state.pdfDoc = null;
  let kept = false;
  if (bytes.length <= PDF_KEEP_MAX) {
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    kept = await store.set(PDF_KEY, btoa(text)).then(() => true, () => false);
  }
  if (!kept) await store.remove(PDF_KEY).catch(() => {});
  if (state.intake) state.intake.pdfKept = kept;
}

async function forgetPdf() {
  state.pdfBytes = null;
  state.pdfDoc?.doc.then((d) => d.destroy()).catch(() => {});
  state.pdfDoc = null;
  state.pdf = null;
  await store.remove(PDF_KEY);
}

async function intakePdfBytes() {
  if (state.pdfBytes) return state.pdfBytes;
  const kept = state.intake?.pdfKept ? await store.get(PDF_KEY) : null;
  if (!kept) return null;
  const text = atob(kept);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return (state.pdfBytes = bytes);
}

async function intakePdfDocument() {
  const bytes = await intakePdfBytes();
  if (!bytes) return null;
  if (state.pdfDoc?.bytes !== bytes) {
    // pdf.js takes the buffer it is given: it gets a copy.
    state.pdfDoc = { bytes, doc: pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise };
  }
  return state.pdfDoc.doc;
}

// `target`: { path, from, label, kind: 'check' | 'filled' }, the record path to mark, or for a
// derived answer the paths it was worked out from (`from`, plan.js; intake-source.js); none for
// the whole PDF from its first page. Shown in a sheet over the panel, which pdf-sheet-view.jsx draws
// from what this and drawPdf say (state.pdfSheet); Back (or Escape) returns to where the agent was.
async function openPdf(target = null) {
  const paths = [].concat(target?.from ?? target?.path ?? []);
  const place = target ? sourcePlace(paths, state.intake) : null;
  // An answer the agent corrected in the panel: the PDF still shows what the client wrote.
  const kind = target?.kind === 'filled' && paths.some((p) => state.intake?.agentEdited?.includes(p)) ? 'edited'
    : target?.kind === 'filled' && target.from ? 'derived' : target?.kind;
  if (!state.pdf) state.pdfReturn = document.activeElement;
  state.pdf = { page: place?.page ?? 0, zoom: place ? PDF_FOCUS_ZOOM : PDF_OPEN_ZOOM, pages: state.pdf?.pages ?? null, mark: place ? { ...target, kind, place } : null };
  // The last PDF drawn stays hidden until this one is.
  state.pdfSheet = {
    ...state.pdfSheet,
    title: place ? target.label : 'Intake PDF',
    name: place ? `Intake${pdfPageSaid(place.page, ', page ')} · marked` : state.intake?.fileName ?? 'Intake PDF',
    shown: 'loading',
  };
  flushSync(render);
  $('pdf-scroll').scrollTo(0, 0);
  $('pdf-back').focus();
  await drawPdf({ focus: !!place });
}

// All client details: the drawer over the panel, from the button by the client's name or the row
// under the checks. Focus goes into it and back where it was when it closes.
function openDetails() {
  if (!state.intake) return;
  if (!state.detailsOpen) state.detailsReturn = document.activeElement;
  state.detailsOpen = true;
  render();
  if (!$('details-view').contains(document.activeElement)) $('details-close').focus();
}
function closeDetails() {
  if (!state.detailsOpen) return;
  state.detailsOpen = false;
  showScreen();
  const back = state.detailsReturn;
  state.detailsReturn = null;
  (back?.isConnected ? back : $(state.view === 'check' ? 'step-check' : 'step-fill'))?.focus();
}

function closePdf() {
  state.pdf = null;
  state.pdfTask?.cancel();
  render();
  const back = state.pdfReturn;
  state.pdfReturn = null;
  (back?.isConnected ? back : $(state.view === 'check' ? 'step-check' : 'step-fill'))?.focus();
}

async function drawPdf({ focus = false } = {}) {
  const view = state.pdf;
  if (!view) return;
  const draw = ++state.pdfDraw;
  const mark = view.mark?.place.page === view.page ? view.mark : null;
  // The hint over the page for an item marked on it (pdf-sheet-view.jsx says it by its kind).
  const hint = mark ? { kind: mark.kind ?? 'check', label: mark.label, where: pdfPageSaid(mark.place.page, ' on page '), several: mark.place.rects?.length > 1 } : null;
  state.pdfSheet = { ...state.pdfSheet, hint, controls: pdfControls(view) };
  let page;
  try {
    const doc = await intakePdfDocument();
    if (!doc) throw new Error('missing');
    // A new view, so the page count is drawn; not for a draw a newer one or Back replaced.
    if (draw === state.pdfDraw && state.pdf && state.pdf.pages !== doc.numPages) state.pdf = { ...state.pdf, pages: doc.numPages };
    page = await doc.getPage(view.page + 1);
  } catch (e) {
    if (draw !== state.pdfDraw) return;
    const missing = e?.message === 'missing';
    state.pdfSheet = {
      ...state.pdfSheet,
      shown: 'error',
      error: missing
        ? 'This PDF is no longer kept. Load the same file again (Change file); your work stays.'
        : 'Couldn’t show this PDF here. Open it in a new tab instead.',
      hint: null,
      // Nothing to page, zoom or mark; a PDF that isn't kept can't open in a tab either.
      controls: { ...state.pdfSheet.controls, prev: false, next: false, zoomOut: false, fit: false, zoomIn: false, focus: false, tab: !missing },
    };
    return;
  }
  if (draw !== state.pdfDraw || !state.pdf) return;
  state.pdfSheet = { ...state.pdfSheet, controls: pdfControls(state.pdf) };
  // Fit the page to the panel's width, then zoom; drawn sharp on high-density screens.
  const scroll = $('pdf-scroll');
  const fit = Math.max(scroll.clientWidth - 28, 120) / page.getViewport({ scale: 1 }).width;
  const viewport = page.getViewport({ scale: fit * view.zoom });
  const ratio = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  state.pdfTask?.cancel();
  // The form's answers are drawn from its fields (their appearance), as a PDF viewer shows them.
  const task = page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0], annotationMode: pdfjs.AnnotationMode.ENABLE });
  state.pdfTask = task;
  try { await task.promise; } catch { return; /* cancelled by a newer draw */ }
  if (draw !== state.pdfDraw || !state.pdf) return;
  // The page is drawn off screen, then copied onto the sheet's canvas in one go, so the last page
  // stays in view until this one is ready. pdf-sheet-view.jsx draws that canvas once and never sets
  // its size or contents: only this does, so a redraw of the sheet never wipes the page.
  const shown = $('pdf-canvas');
  shown.width = canvas.width;
  shown.height = canvas.height;
  shown.style.width = `${Math.floor(viewport.width)}px`;
  shown.style.height = `${Math.floor(viewport.height)}px`;
  shown.getContext('2d').drawImage(canvas, 0, 0);
  // The copy off screen is let go now, not when it is collected (a page at 400% is a large one).
  canvas.width = canvas.height = 0;
  // One mark per field the answer came from (a derived answer may have read several), drawn before
  // the view moves to them.
  const marks = (mark ? (mark.place.rects ?? [mark.place.rect]) : []).map((rect) => {
    const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(rect);
    return { filled: mark.kind !== 'check', left: Math.min(x1, x2) - 2, top: Math.min(y1, y2) - 2, width: Math.abs(x2 - x1) + 4, height: Math.abs(y2 - y1) + 4 };
  });
  flushSync(() => { state.pdfSheet = { ...state.pdfSheet, shown: 'page', error: null, marks }; });
  if (mark && focus) focusPdfMark();
}

// Scrolls the marked items into the middle of the view, with the question's label to their left
// in view too where the panel is wide enough.
function focusPdfMark() {
  const scroll = $('pdf-scroll');
  const marks = [...$('pdf-marks').children];
  if (!marks.length) return;
  const sr = scroll.getBoundingClientRect();
  const boxes = marks.map((m) => m.getBoundingClientRect());
  const top = Math.min(...boxes.map((b) => b.top));
  const bottom = Math.max(...boxes.map((b) => b.bottom));
  const left = Math.min(...boxes.map((b) => b.left));
  const right = Math.max(...boxes.map((b) => b.right));
  scroll.scrollTop += top - sr.top - (scroll.clientHeight - (bottom - top)) / 2;
  // The field's label is printed to its left: show up to a third of the view of it, unless the
  // marks would then run off the right edge.
  const lead = Math.max(14, Math.min(scroll.clientWidth / 3, scroll.clientWidth - (right - left) - 14));
  scroll.scrollLeft += left - sr.left - lead;
}

// What the page and zoom controls say for a view (pdf-sheet-view.jsx draws them): the page of how
// many, which buttons can be used (true: enabled), and the zoom in percent, which the zoom's middle
// button shows and sets back to the page's width.
function pdfControls(view) {
  return {
    pages: view.pages ? `${view.page + 1} / ${view.pages}` : '',
    prev: view.page > 0,
    next: !!view.pages && view.page < view.pages - 1,
    zoomOut: view.zoom > PDF_ZOOMS[0],
    zoomIn: view.zoom < PDF_ZOOMS.at(-1),
    fit: true,
    tab: true,
    focus: true,
    zoom: Math.round(view.zoom * 100),
  };
}

function pdfZoom(zoom, { focus = false } = {}) {
  if (!state.pdf || zoom == null) return;
  // Zooming keeps the middle of the view in the middle.
  const scroll = $('pdf-scroll');
  const keep = [(scroll.scrollLeft + scroll.clientWidth / 2) / scroll.scrollWidth, (scroll.scrollTop + scroll.clientHeight / 2) / scroll.scrollHeight];
  state.pdf = { ...state.pdf, zoom };
  drawPdf({ focus }).then(() => {
    if (focus || !state.pdf) return;
    scroll.scrollLeft = keep[0] * scroll.scrollWidth - scroll.clientWidth / 2;
    scroll.scrollTop = keep[1] * scroll.scrollHeight - scroll.clientHeight / 2;
  });
}

// Moving around the PDF: drag it with the mouse (the primary button, anywhere in the page area), and
// zoom a step with Ctrl (or ⌘) + wheel, as PDF viewers do. A drag never selects text or clicks.
function pdfPan(scroll) {
  let drag = null;
  scroll.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !state.pdf) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: scroll.scrollLeft, top: scroll.scrollTop };
    scroll.setPointerCapture?.(e.pointerId);
    scroll.classList.add('panning');
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    scroll.classList.remove('panning');
  };
  scroll.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    // The button went up where the panel didn't hear it (on the scrollbar, in another window):
    // the drag is over, not carried on under a free mouse.
    if (!(e.buttons & 1)) return end(e);
    scroll.scrollLeft = drag.left - (e.clientX - drag.x);
    scroll.scrollTop = drag.top - (e.clientY - drag.y);
  });
  scroll.addEventListener('pointerup', end);
  scroll.addEventListener('pointercancel', end);
  scroll.addEventListener('lostpointercapture', end);
  let wheelAt = 0;
  scroll.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !state.pdf) return;
    e.preventDefault();
    // One step per gesture, not per tick of a smooth-scrolling wheel or trackpad.
    if (Date.now() - wheelAt < 250) return;
    wheelAt = Date.now();
    pdfZoom(e.deltaY < 0 ? PDF_ZOOMS.find((z) => z > state.pdf.zoom) : PDF_ZOOMS.findLast((z) => z < state.pdf.zoom));
  }, { passive: false });
}

function pdfPage(step) {
  const view = state.pdf;
  if (!view?.pages) return;
  const next = Math.min(Math.max(view.page + step, 0), view.pages - 1);
  if (next === view.page) return;
  state.pdf = { ...view, page: next };
  $('pdf-scroll').scrollTo(0, 0);
  drawPdf();
}

// Chrome's own PDF viewer, in a tab beside the quote (the panel keeps working on the quote tab).
async function openPdfInTab() {
  const bytes = await intakePdfBytes();
  if (!bytes) return;
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  if (inExtension) await chrome.tabs.create({ url });
  else window.open(url, '_blank', 'noopener');
}

// The step a one-address application's tab is on (AmWINS), as the recorder reads it on arrival,
// with new questions, with each batch of changes and whenever the headings change (step_shown): for
// the page strip and the report shown (renderSite), so the agent's own Continue to the next step,
// or a click on another step's tab, is followed. A fill's own step is noted by renderReport.
// Registered before onRecorderMessage, which then scopes the same message by this step.
// Arriving at a step that is the agent's (stopSteps: GEICO's MVR & CLUE, Payment Information; a
// move from another step, or a new document on it) is logged as a fill run that stopped, as a stop
// page is, with the step's name only, once the tab is shown to be this intake's quote.
function noteStep(msg, sender) {
  if (msg?.ra !== 'usage' || !['field_changes', 'new_fields', 'page_view', 'step_shown', 'list_shown'].includes(msg.event) || !state.intake || sender.tab?.id !== state.tab?.id) return;
  const carrier = state.tab.carrier;
  const step = knownStep(carrier, msg.step);
  if (!step) return;
  const moved = state.tabSteps.get(sender.tab.id) !== step;
  if (moved) state.tabSteps.set(sender.tab.id, step);
  if (carrier?.stopSteps?.[step] && (moved || (msg.event === 'page_view' && !msg.from)) && !carrier.practice && stopPageIsOurs()) {
    const page = samePage(msg.page) || pageOf(state.tab.url);
    usage.log(...fillEvents([{ fields: 0, blockers: [`stop: ${step}`] }], { carrier: carrier.id, page, view: viewOf(sender.tab.id, page), overwrite: false, auto: 'stop', ms: 0, redact: (text) => text, step }));
  }
  // A stop screen (noteStopScreen) ends with a move to a step or a new document: a question or list
  // drawn while it shows doesn't end it (a layout read without its button does).
  const screenOver = !!state.stopScreens?.has(sender.tab.id) && (moved || msg.event === 'page_view');
  if (screenOver) state.stopScreens.delete(sender.tab.id);
  if (moved || screenOver) renderSite();
  // A report shown again for this step is read back from the page (read only).
  if (moved && state.reportFor?.restored) refreshAnswers();
}

// What the agent did on this intake, for the file menu's question and the same-file note:
// "corrected 2 answers and checked 3 items", '' for nothing.
function workSaid(edits, checks) {
  return [edits ? `corrected ${edits} answer${edits === 1 ? '' : 's'}` : null,
    checks ? `checked ${checks} item${checks === 1 ? '' : 's'}` : null].filter(Boolean).join(' and ');
}

// The file tools ask before the agent's work would go: `what` 'replace', 'clear' or 'new-quote',
// under the client's name; `from`, the button that asked, gets focus back on Cancel.
function askFile(what, text, yes, from = what === 'replace' ? 'replace' : what === 'clear' ? 'clear-client' : 'new-quote') {
  state.fileConfirm = what;
  state.fileConfirmFrom = from;
  state.fileQuestion = { text, yes };
  flushSync(render);
  $('file-confirm-no').focus();
}

// New quote with this intake (the restart button by the client's name): the agent quotes the same
// client on another carrier, or again on this one, and this quote's work must not carry over to it
// (a report "from the fill at 10:12" on a page the new quote reaches in the same tab, a vehicle taken
// as already added, the page's marks), while the intake, their corrections and their checks stay
// (the maintainer, 2026-10-23). The kept PDF is loaded again as the same file: loadFile keeps the
// agent's work on the same intake and starts everything else over, after the page's marks and this
// intake's per-tab records (edits on the page, helpers clicked, unit forms) are let go: the panel's own
// first, then the stored ones, so nothing saving the panel's meanwhile (an edit on the page, a unit
// arrival) writes the old quote's back (the review of PR #170). No fill starts while it is under way
// (`resetting`: fillPage, autoFill).
async function newQuote() {
  if (!state.intake) return;
  if (state.filling) { clientNote('Wait for the answers going in to finish, then start the new quote.'); return; }
  state.resetting = true;
  try {
    const bytes = await intakePdfBytes();
    if (!bytes) { clientNote('The PDF isn’t kept here: load it again with Change file to start a new quote.'); return; }
    const scope = usage.currentSession()?.intakeId;
    if (inExtension && state.tab?.carrier) await runKit(state.tab.id, state.tab.carrier, () => globalThis.__raterKit?.clear?.()).catch(() => {});
    state.tabSessions.clear();
    state.agentKeys = new Map();
    state.doneActions = new Set();
    state.unitForms = { vehicles: {}, drivers: {}, trailers: {} };
    await clearAgentKeys(scope);
    state.intake.ntlAdded = false;
    await loadFile(new File([bytes], state.intake.fileName || 'intake.pdf', { type: 'application/pdf' }), { reset: true });
  } finally {
    state.resetting = false;
  }
}

// A line under the client's name about the file just loaded (null hides it): client-view.jsx.
function clientNote(text) {
  state.clientNote = text ?? null;
}

async function clearClient() {
  const scope = usage.currentSession()?.intakeId;
  // A recording ends with its client, saved as it is.
  if (state.recording) await stopRecording('The client was cleared, so the recording stopped.');
  if (profileTimer) logProfile();
  usage.log({ type: 'intake_closed', reason: 'cleared' });
  cancelLayouts();
  holdLayouts();
  resetViews();
  state.intake = null;
  state.fileConfirm = null;
  state.view = 'check';
  state.filter = 'all';
  state.aiDocks = new Map();
  state.pastKey = null;
  state.detailsOpen = false;
  dropReports();
  clientNote(null);
  usage.restoreSession(null);
  await store.remove('intake');
  await store.remove('session');
  await forgetPdf();
  await persistAiPending();
  await clearAgentKeys(scope);
  render();
  renderSite();
}

export { PDF_FOCUS_ZOOM, PDF_ZOOMS, askFile, clearClient, clientNote, closeDetails, closePdf, drawPdf, keepPdf, newQuote, noteStep, openDetails, openPdf, openPdfInTab, pdfAvailable, pdfPage, pdfPageSaid, pdfPan, pdfZoom, workSaid };
