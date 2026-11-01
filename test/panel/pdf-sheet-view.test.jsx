import { afterEach, beforeEach, expect, test } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { storeState } from '../../sidepanel/panel/state-store.js';
import { PdfSheet, mountPdf } from '../../sidepanel/panel/pdf-sheet-view.jsx';

// The intake PDF's sheet in React (2026-11-01): what openPdf and drawPdf drew with $() and h() into
// the page's #pdf-view, drawn from what they say now (state.pdfSheet). What they say, and what each
// button then does, are the panel's (the safety tests run openPdf, drawPdf, pdfZoom, pdfPage and
// pdfPan); here, that the sheet draws it as before, asks the panel for each button's own thing, and
// leaves the page drawn on its canvas alone.

let state;
beforeEach(() => { state = storeState({ pdfSheet: null }); });
afterEach(cleanup);

const $ = (container, sel) => container.querySelector(sel);
const acts = (calls) => ({
  close: () => calls.push('close'), tab: () => calls.push('tab'), focus: () => calls.push('focus'), page: (step) => calls.push(`page ${step}`),
  zoomIn: () => calls.push('zoomIn'), zoomOut: () => calls.push('zoomOut'), fit: () => calls.push('fit'),
});
const controls = { pages: '1 / 3', prev: false, next: true, zoomOut: true, zoomIn: true, fit: true, tab: true, focus: true, zoom: 200 };

test('the sheet as the page held it: a dialog named by its title and file, the ids the panel and its CSS read, opening until drawn', () => {
  const { container } = render(<PdfSheet act={acts([])} />);
  const dialog = $(container, 'section.sheet-panel');
  expect([dialog.getAttribute('role'), dialog.getAttribute('aria-modal'), dialog.getAttribute('aria-labelledby'), dialog.getAttribute('aria-describedby')]).toEqual(['dialog', 'true', 'pdf-title', 'pdf-name']);
  expect([...container.querySelectorAll('[id]')].map((n) => n.id)).toEqual(['pdf-scrim', 'pdf-title', 'pdf-name', 'pdf-close', 'pdf-hint', 'pdf-hint-text', 'pdf-focus', 'pdf-scroll', 'pdf-loading',
    'pdf-sheet', 'pdf-canvas', 'pdf-marks', 'pdf-error', 'pdf-prev', 'pdf-pages', 'pdf-next', 'pdf-zoom-out', 'pdf-zoom-fit', 'pdf-zoom-in', 'pdf-tab', 'pdf-back']);
  expect([$(container, '#pdf-scrim').className, $(container, '#pdf-scroll').className, $(container, '#pdf-sheet').className, $(container, '#pdf-error').className])
    .toEqual(['sheet-scrim', 'pdf-scroll', 'pdf-sheet', 'issue bad']);
  expect($(container, '#pdf-sheet > canvas#pdf-canvas + #pdf-marks')).not.toBeNull();
  // Before the PDF first opens: its title, opening, nothing marked, every button usable.
  expect([$(container, '#pdf-title').textContent, $(container, '#pdf-loading').hidden, $(container, '#pdf-loading').textContent, $(container, '#pdf-sheet').hidden, $(container, '#pdf-error').hidden, $(container, '#pdf-hint').hidden])
    .toEqual(['Intake PDF', false, 'Opening the PDF…', true, true, true]);
  expect([...container.querySelectorAll('button')].filter((b) => b.disabled)).toEqual([]);
  // The buttons' names and words, as before.
  expect(['pdf-close', 'pdf-prev', 'pdf-next', 'pdf-zoom-out', 'pdf-zoom-in'].map((id) => $(container, `#${id}`).getAttribute('aria-label'))).toEqual(['Close', 'Previous page', 'Next page', 'Zoom out', 'Zoom in']);
  expect(['pdf-focus', 'pdf-prev', 'pdf-next', 'pdf-zoom-out', 'pdf-zoom-in', 'pdf-tab', 'pdf-back'].map((id) => $(container, `#${id}`).textContent)).toEqual(['Zoom to it', '‹', '›', '−', '+', 'Open full PDF', 'Back']);
  expect($(container, '#pdf-zoom-fit').title).toBe('Fit page');
});

test('a marked item: its title and where it is, the hint by its kind, the page and its marks, the controls', () => {
  const { container } = render(<PdfSheet act={acts([])} />);
  act(() => {
    state.pdfSheet = { title: 'Garaging state', name: 'Intake · marked', shown: 'page', error: null, hint: { kind: 'check', label: 'Garaging state', where: '', several: false },
      controls, marks: [{ filled: false, left: 18, top: 18, width: 84, height: 24 }] };
  });
  expect([$(container, '#pdf-title').textContent, $(container, '#pdf-name').textContent]).toEqual(['Garaging state', 'Intake · marked']);
  expect([$(container, '#pdf-loading').hidden, $(container, '#pdf-sheet').hidden, $(container, '#pdf-error').hidden]).toEqual([true, false, true]);
  const hint = $(container, '#pdf-hint');
  expect([hint.hidden, hint.className, $(container, '#pdf-hint-text').innerHTML]).toEqual([false, 'pdf-hint', 'Showing <b>Garaging state</b>']);
  const marks = [...$(container, '#pdf-marks').children];
  expect(marks.map((m) => [m.className, m.style.left, m.style.top, m.style.width, m.style.height])).toEqual([['pdf-mark', '18px', '18px', '84px', '24px']]);
  // The controls: the page of how many, the buttons that can't be used off, the zoom shown on the button that fits the page.
  expect($(container, '#pdf-pages').textContent).toBe('1 / 3');
  expect(['pdf-prev', 'pdf-next', 'pdf-zoom-out', 'pdf-zoom-fit', 'pdf-zoom-in', 'pdf-tab', 'pdf-focus'].map((id) => $(container, `#${id}`).disabled)).toEqual([true, false, false, false, false, false, false]);
  expect([$(container, '#pdf-zoom-fit').textContent, $(container, '#pdf-zoom-fit').getAttribute('aria-label')]).toEqual(['200%', 'Zoom 200%. Fit the page to the panel']);
  act(() => { state.pdfSheet = { ...state.pdfSheet, controls: { ...controls, zoomIn: false, zoom: 400 } }; });
  expect([$(container, '#pdf-zoom-in').disabled, $(container, '#pdf-zoom-fit').textContent]).toEqual([true, '400%']);

  // Each kind's hint; an answer from the intake, worked out or corrected is blue, its marks too.
  const said = (h) => { act(() => { state.pdfSheet = { ...state.pdfSheet, hint: h }; }); return [hint.className, $(container, '#pdf-hint-text').innerHTML]; };
  expect(said({ kind: 'filled', label: 'USDOT', where: ' on page 2', several: false })).toEqual(['pdf-hint filled', 'Filled from <b>USDOT</b> on page 2']);
  expect(said({ kind: 'derived', label: 'Radius', where: '', several: true })).toEqual(['pdf-hint filled', '<b>Radius</b> was worked out from the marked answers']);
  expect(said({ kind: 'derived', label: 'Radius', where: '', several: false })).toEqual(['pdf-hint filled', '<b>Radius</b> was worked out from the marked answer']);
  expect(said({ kind: 'edited', label: 'Gender', where: '', several: false })).toEqual(['pdf-hint filled', 'You corrected <b>Gender</b> in the panel. The intake as the client wrote it']);
  act(() => { state.pdfSheet = { ...state.pdfSheet, marks: [{ filled: true, left: 1, top: 2, width: 3, height: 4 }, { filled: true, left: 5, top: 6, width: 7, height: 8 }] }; });
  expect([...$(container, '#pdf-marks').children].map((m) => m.className)).toEqual(['pdf-mark filled', 'pdf-mark filled']);
  // The whole PDF: no hint, no marks.
  act(() => { state.pdfSheet = { ...state.pdfSheet, title: 'Intake PDF', name: 'acme.pdf', hint: null, marks: [] }; });
  expect([hint.hidden, $(container, '#pdf-hint-text').textContent, $(container, '#pdf-marks').children.length, $(container, '#pdf-name').textContent]).toEqual([true, '', 0, 'acme.pdf']);
});

test('a PDF that can\'t be shown: the error in place of the page, and the buttons it leaves off', () => {
  const { container } = render(<PdfSheet act={acts([])} />);
  act(() => {
    state.pdfSheet = { title: 'Intake PDF', name: 'acme.pdf', shown: 'error', error: 'This PDF is no longer kept. Load the same file again (Change file); your work stays.', hint: null, marks: [],
      controls: { ...controls, prev: false, next: false, zoomOut: false, fit: false, zoomIn: false, focus: false, tab: false } };
  });
  expect([$(container, '#pdf-loading').hidden, $(container, '#pdf-sheet').hidden, $(container, '#pdf-error').hidden, $(container, '#pdf-error').textContent])
    .toEqual([true, true, false, 'This PDF is no longer kept. Load the same file again (Change file); your work stays.']);
  expect(['pdf-prev', 'pdf-next', 'pdf-zoom-out', 'pdf-zoom-fit', 'pdf-zoom-in', 'pdf-focus', 'pdf-tab'].map((id) => $(container, `#${id}`).disabled)).toEqual(Array(7).fill(true));
  // Back and Close always can.
  expect([$(container, '#pdf-back').disabled, $(container, '#pdf-close').disabled]).toEqual([false, false]);
  act(() => { state.pdfSheet = { ...state.pdfSheet, controls: { ...state.pdfSheet.controls, tab: true } }; });
  expect($(container, '#pdf-tab').disabled).toBe(false);
});

test('each button asks the panel for its own thing', () => {
  const calls = [];
  const { container } = render(<PdfSheet act={acts(calls)} />);
  act(() => { state.pdfSheet = { title: 'Garaging state', name: '', shown: 'page', error: null, hint: { kind: 'check', label: 'Garaging state', where: '', several: false }, controls: { ...controls, prev: true }, marks: [] }; });
  for (const id of ['pdf-back', 'pdf-close', 'pdf-scrim', 'pdf-tab', 'pdf-focus', 'pdf-prev', 'pdf-next', 'pdf-zoom-out', 'pdf-zoom-fit', 'pdf-zoom-in']) fireEvent.click($(container, `#${id}`));
  expect(calls).toEqual(['close', 'close', 'close', 'tab', 'focus', 'page -1', 'page 1', 'zoomOut', 'fit', 'zoomIn']);
});

test('the page drawn on the canvas, and the page area\'s drag class, stay when the sheet is drawn again', () => {
  const { container } = render(<PdfSheet act={acts([])} />);
  const canvas = $(container, '#pdf-canvas');
  const scroll = $(container, '#pdf-scroll');
  // As drawPdf sizes the canvas for the page it copies onto it, and pdfPan marks a drag.
  canvas.width = 1200;
  canvas.height = 1600;
  canvas.style.width = '1200px';
  scroll.classList.add('panning');
  act(() => { state.pdfSheet = { title: 'Intake PDF', name: 'acme.pdf', shown: 'page', error: null, hint: null, controls, marks: [{ filled: false, left: 1, top: 1, width: 1, height: 1 }] }; });
  act(() => { state.pdfSheet = { ...state.pdfSheet, shown: 'loading', controls: { ...controls, zoom: 300 }, marks: [] }; });
  act(() => { state.pdfSheet = { ...state.pdfSheet, shown: 'page' }; });
  expect($(container, '#pdf-canvas')).toBe(canvas);
  expect([canvas.width, canvas.height, canvas.style.width]).toEqual([1200, 1600, '1200px']);
  expect($(container, '#pdf-scroll')).toBe(scroll);
  expect(scroll.className).toBe('pdf-scroll panning');
});

test('mountPdf draws before it returns', () => {
  const host = document.body.appendChild(document.createElement('div'));
  act(() => {
    mountPdf(host, acts([]));
    expect(['pdf-scrim', 'pdf-back', 'pdf-close', 'pdf-scroll', 'pdf-canvas', 'pdf-marks', 'pdf-tab', 'pdf-zoom-fit'].map((id) => !!host.querySelector(`#${id}`))).toEqual(Array(8).fill(true));
  });
  host.remove();
});
