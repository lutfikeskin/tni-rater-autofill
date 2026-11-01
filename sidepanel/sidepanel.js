// The side panel: what the agent sees beside a rater tab. Its parts are in sidepanel/panel/, one
// file each (state and storage in core.js, filling in fill.js, the assistant in assistant.js…);
// this file wires the page's controls to them and starts the panel (init).
// Not type-checked yet; what it passes the page kit and reads back is typed in types.js, at the repository's root.
import * as usage from './usage-log.js';
import { canRecord } from '../src/recording.js';
import { inExtension, popped } from './panel/env.js';
import { $, migrateStoredData, restoreAiPending, state, store } from './panel/core.js';
import { loadFile, logProfile, logSettings, markTestRun, save } from './panel/intake.js';
import { firstView, openSettings, pickUnit, render, setFilter, setView, showEmpty, showScreen } from './panel/record.js';
import { onTabUpdated, refreshTab } from './panel/tab.js';
import { onRecorderMessage, pageOf } from './panel/usage.js';
import { dismissState, dropReports, holdLayouts, inheritQuoteState, renderSteps, showPast, stopFill } from './panel/coordinator.js';
import { captureFromShortcut, capturePage, checkItems, clearMarks, fillPage, lookRight, noteLiveItems, refreshAnswers, showNextNeed } from './panel/fill.js';
import { noteRecording, onTraceMessage, recoverRecording, renderUnfinished, startRecording, stopRecording } from './panel/dev-recording.js';
import { renderAiSettings, reviewIntake, wireAi } from './panel/assistant.js';
import { renderUsage, uploadNow, wireUsage } from './panel/usage-panel.js';
import { PDF_FOCUS_ZOOM, PDF_ZOOMS, askFile, clearClient, closeDetails, closePdf, drawPdf, newQuote, noteStep, openDetails, openPdf, openPdfInTab, pdfPage, pdfPan, pdfZoom, workSaid } from './panel/pdf-view.js';
import { announceCopy, dock, keepPlace, onPanelMessage, popOut } from './panel/window.js';
import { mountLive } from './panel/live-view.jsx';
import { mountDock, mountSteps } from './panel/steps-view.jsx';
import { mountFeed } from './panel/feed-view.jsx';
import { mountCards } from './panel/cards-view.jsx';
import { mountChecks, mountPickers } from './panel/checks-view.jsx';
import { mountClient } from './panel/client-view.jsx';
import { mountDetails } from './panel/details-view.jsx';
import { mountPdf } from './panel/pdf-sheet-view.jsx';
import { mountLoadError, mountNote } from './panel/notes-view.jsx';
import { mountSiteTrack } from './panel/site-view.jsx';

// ---------------------------------------------------------------------------------------------
// Wiring

function wire() {
  const drop = $('load');
  $('choose').addEventListener('click', (e) => { e.stopPropagation(); $('file').click(); });
  drop.addEventListener('click', () => $('file').click());
  $('settings-btn').addEventListener('click', () => { if (state.settingsOpen) { state.settingsOpen = false; showScreen(); } else openSettings(); });
  $('pop-out').addEventListener('click', popOut);
  $('dock-back').addEventListener('click', dock);
  $('settings-done').addEventListener('click', () => { state.settingsOpen = false; showScreen(); $('settings-btn').focus(); });
  // The header's strip of the quote's steps; the usage log that can't be saved, a Pop out or Dock
  // that didn't work, and a PDF that couldn't be read.
  mountSiteTrack($('site-track'));
  mountNote($('notices'), 'usage');
  mountNote($('window-note'), 'window');
  mountLoadError($('load-error'));
  mountSteps($('steps'), {
    check: () => setView('check'),
    fill: () => setView('page'),
    confirm: () => { setView('page'); refreshAnswers(); checkItems(); },
  });
  // The client's name opens or closes client details; the intake PDF; the file tools. Change file:
  // straight to the file picker, unless the agent has corrected or checked this intake (a different
  // file starts over). Clear, and New quote: always asked first.
  mountClient($('client-root'), {
    details: () => (state.detailsOpen ? closeDetails() : openDetails()),
    pdf: () => openPdf(),
    replace: () => {
      const work = workSaid(state.intake?.agentEdited?.length ?? 0, state.intake?.done?.length ?? 0);
      if (!work) { $('file').click(); return; }
      askFile('replace', `You ${work}. A different file starts over; the same file keeps it.`, 'Choose a file');
    },
    newQuote: () => {
      if (state.filling) return;
      askFile('new-quote', 'Start another quote with this intake? This quote’s fills, marks and clicks are forgotten; the intake, your corrections and checks stay. The carrier’s site isn’t changed.', 'New quote');
    },
    clear: () => {
      const name = state.intake?.record.applicant.name || state.intake?.record.applicant.owner1 || 'this client';
      askFile('clear', `Clear ${name}? Your corrections, checks and reports go. The carrier's site isn't changed.`, 'Clear this client');
    },
    cancel: () => { state.fileConfirm = null; render(); $(state.fileConfirmFrom ?? 'replace')?.focus(); },
    yes: () => {
      const what = state.fileConfirm;
      state.fileConfirm = null;
      render();
      if (what === 'replace') $('file').click();
      if (what === 'clear') clearClient();
      if (what === 'new-quote') newQuote();
    },
  });
  // Step 1's checks and their All client details row.
  mountChecks($('check-view'), { openDetails: () => openDetails() });
  // Client details: Close, the scrim, and the empty fields shown or hidden.
  mountDetails($('details-view'), { close: () => closeDetails(), showEmpty: () => showEmpty() });
  // The page's answers: their filters, an earlier page's answers on this tab (read-only) and back to
  // this page's, what the tags mean, and Clear the marks.
  mountCards($('cards-root'));
  mountPickers($('pickers'), { pick: (list, i) => pickUnit(list, i) });
  mountFeed($('feed-root'), {
    setFilter: (filter) => setFilter(filter),
    showPast: (key) => showPast(key),
    toggleKey: () => { state.keyOpen = !state.keyOpen; renderSteps(); },
    clearMarks: () => clearMarks(),
  });
  // The intake PDF's sheet: Back, Close and the scrim; the full PDF in a tab; Zoom to it; the pages
  // and the zoom. Its page area (drawn by now) drags and zooms with Ctrl + wheel.
  mountPdf($('pdf-view'), {
    close: () => closePdf(),
    tab: () => openPdfInTab(),
    focus: () => pdfZoom(Math.max(state.pdf?.zoom ?? 1, PDF_FOCUS_ZOOM), { focus: true }),
    page: (step) => pdfPage(step),
    zoomIn: () => pdfZoom(PDF_ZOOMS.find((z) => z > state.pdf?.zoom)),
    zoomOut: () => pdfZoom(PDF_ZOOMS.findLast((z) => z < state.pdf?.zoom)),
    fit: () => pdfZoom(1),
  });
  pdfPan($('pdf-scroll'));
  // The page is drawn for the panel's width: again when it changes (the panel resized).
  let width = 0;
  new ResizeObserver(([entry]) => {
    const w = Math.round(entry.contentRect.width);
    if (w !== width && state.pdf && width) drawPdf();
    width = w;
  }).observe($('pdf-scroll'));
  // Escape closes the PDF sheet, the client details drawer, then Settings; the sheet or the drawer
  // keeps keyboard focus while it's open.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.pdf && !$('pdf-view').hidden) { e.preventDefault(); closePdf(); return; }
    if (e.key === 'Escape' && state.detailsOpen && !$('details-view').hidden) { e.preventDefault(); closeDetails(); return; }
    if (e.key === 'Escape' && state.settingsOpen) { e.preventDefault(); state.settingsOpen = false; showScreen(); $('settings-btn').focus(); return; }
    const modal = state.pdf && !$('pdf-view').hidden ? $('pdf-view') : state.detailsOpen && !$('details-view').hidden ? $('details-view') : null;
    if (e.key !== 'Tab' || !modal) return;
    const stops = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')].filter((n) => n.offsetParent !== null);
    if (!stops.length) return;
    const [first, last] = [stops[0], stops.at(-1)];
    if (!modal.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  $('file').addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
  for (const t of [document.body]) {
    t.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    t.addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('over'); });
    t.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
    t.addEventListener('dragover', () => { if (!state.intake) $('load-error').hidden = true; });
  }
  $('test-run').addEventListener('change', () => markTestRun($('test-run').checked));
  // The dock: its one button and its alternative.
  mountDock($('dock-root'), {
    fill: (go) => fillPage({ continuing: go === 'continue' }),
    stop: () => stopFill(),
    next: () => showNextNeed(),
    lookRight: (button) => { button.disabled = true; lookRight(state.tab?.id, pageOf(state.tab?.url), state.tab?.carrier, button); },
    approve: () => state.aiDocks.get(`${state.tab?.id}|${pageOf(state.tab?.url)}`)?.go(),
    alt: (go) => {
      if (go === 'fill-anyway') dismissState();
      fillPage();
    },
  });
  $('capture').addEventListener('click', capturePage);
  // Alt+Shift+C (manifest "commands"): a capture without leaving the page, e.g. with a list open.
  if (inExtension) chrome.commands?.onCommand.addListener((command) => { if (command === 'capture-page') captureFromShortcut(); });
  // Developer recording: shown in unpacked builds only (canRecord), never in the store's.
  $('devrec').hidden = !inExtension || !canRecord(usage.build().channel);
  if (!$('devrec').hidden) {
    $('devrec-start').addEventListener('click', startRecording);
    $('devrec-note').addEventListener('click', noteRecording);
    $('devrec-stop').addEventListener('click', () => stopRecording());
    $('devrec-recover').addEventListener('click', recoverRecording);
    chrome.runtime.onMessage.addListener(onTraceMessage);
    renderUnfinished();
  }
  wireUsage();
  wireAi();
  if (inExtension) {
    // The step first: a field change or new question is scoped by the step it came with.
    chrome.runtime.onMessage.addListener(noteStep);
    chrome.runtime.onMessage.addListener(onRecorderMessage);
    chrome.runtime.onMessage.addListener(noteLiveItems);
    chrome.runtime.onMessage.addListener(onPanelMessage);
    chrome.tabs.onActivated.addListener(refreshTab);
    chrome.tabs.onCreated.addListener((tab) => { if (state.layoutHold) state.layoutNewTabs.add(tab.id); inheritQuoteState(tab); });
    chrome.tabs.onUpdated.addListener(onTabUpdated);
    chrome.tabs.onRemoved.addListener((tabId) => { state.tabSteps.delete(tabId); state.stopScreens.delete(tabId); dropReports((entry) => entry.tabId === tabId); });
    chrome.windows.onFocusChanged.addListener(refreshTab);
  }
}

async function init() {
  // Stored data in this build's shape before anything reads it (migrateStoredData).
  await migrateStoredData();
  wire();
  mountLive($('live-root'), $('view'));
  if (inExtension && popped) keepPlace();
  // An intake saved by an earlier panel: while the panel was closed the tabs may have moved to
  // another client's quote, so their layouts wait as after loading one (holdLayouts).
  holdLayouts();
  state.intake = (await store.get('intake')) ?? null;
  if (state.intake) state.view = firstView(state.intake);
  state.active = (await store.get('active')) ?? state.active;
  // The selection saved for that tab, kept should the panel reach another tab first.
  state.savedActive = state.active;
  state.activeTab = (await store.get('activeTab')) ?? null;
  usage.restoreSession((await store.get('session')) ?? null);
  const views = await store.get('views');
  if (views?.session && views.session === usage.currentSession()?.id) state.viewTabs = new Map(views.tabs);
  // With the panel in its own window, the newest copy is the one that stays (onPanelMessage); said
  // once its intake is known, for the copy giving way to hand over to (takeOver).
  announceCopy();
  await restoreAiPending();
  const saved = await usage.settings();
  $('auto-followups').checked = saved.autoFollowUps ?? true;
  $('auto-pages').checked = saved.autoPages ?? true;
  $('auto-advance').checked = saved.autoAdvance ?? true;
  // The panel opened on a saved intake: the settings in force for the rest of its quote.
  if (state.intake && usage.currentSession()) logSettings('opened');
  // A correction's profile the panel closed before logging (or an intake loaded by an earlier version).
  if (logProfile()) save();
  $('check-continue').checked = saved.checkBeforeContinue ?? true;
  $('finish-sound').checked = saved.finishSound ?? true;
  uploadNow();
  render();
  renderUsage();
  renderAiSettings();
  reviewIntake();
  await refreshTab();
}

init();
