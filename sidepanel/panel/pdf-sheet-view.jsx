// The intake PDF in React: the sheet over the panel with the page, the item it was opened for marked
// on it, and its controls. Drawn from what openPdf and drawPdf say (state.pdfSheet); what its buttons
// do is the panel's (`act`, wired in sidepanel.js). The page itself is drawn by drawPdf on
// #pdf-canvas, which this draws once and leaves alone (no size, style or children of React's), so a
// redraw never wipes it; the drag and the Ctrl + wheel zoom on #pdf-scroll are pdfPan's, wired once
// it is drawn. One part of the panel; sidepanel.js mounts it (mountPdf).
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useStore } from 'zustand';
import { panelStore } from './state-store.js';

// The hint over the page for the item marked on it, by its kind.
function HintText({ hint }) {
  const label = <b>{hint.label}</b>;
  if (hint.kind === 'filled') return <>Filled from {label}{hint.where}</>;
  if (hint.kind === 'derived') return <>{label}{` was worked out from the marked answer${hint.several ? 's' : ''}${hint.where}`}</>;
  if (hint.kind === 'edited') return <>You corrected {label}{` in the panel. The intake as the client wrote it${hint.where}`}</>;
  return <>Showing {label}{hint.where}</>;
}

// The sheet's scrim and panel (#pdf-view shows or hides it: showScreen). `act`: close, tab, focus,
// page(step), zoomIn, zoomOut, fit. A control is enabled until the PDF is first drawn.
function PdfSheet({ act }) {
  const sheet = useStore(panelStore, (s) => s.pdfSheet);
  const shown = sheet?.shown ?? 'loading';
  const hint = sheet?.hint ?? null;
  const on = (name) => sheet?.controls?.[name] ?? true;
  const zoom = sheet?.controls?.zoom;
  return (
    <>
      <div id="pdf-scrim" className="sheet-scrim" onClick={() => act.close()} />
      <section className="sheet-panel" role="dialog" aria-modal="true" aria-labelledby="pdf-title" aria-describedby="pdf-name">
        <div className="sheet-head">
          <div className="grow"><h2 id="pdf-title">{sheet?.title ?? 'Intake PDF'}</h2><p id="pdf-name" className="sheet-sub">{sheet?.name ?? ''}</p></div>
          <button type="button" id="pdf-close" className="icon-btn" aria-label="Close" onClick={() => act.close()}><svg aria-hidden="true"><use href="#close" /></svg></button>
        </div>
        <div id="pdf-hint" className={`pdf-hint${['filled', 'derived', 'edited'].includes(hint?.kind) ? ' filled' : ''}`} hidden={!hint}>
          <span id="pdf-hint-text" className="grow">{hint ? <HintText hint={hint} /> : null}</span>
          <button type="button" id="pdf-focus" className="link small" disabled={!on('focus')} onClick={() => act.focus()}>Zoom to it</button>
        </div>
        <div id="pdf-scroll" className="pdf-scroll">
          <p id="pdf-loading" className="small muted center" hidden={shown !== 'loading'}>Opening the PDF…</p>
          <div id="pdf-sheet" className="pdf-sheet" hidden={shown !== 'page'}>
            <canvas id="pdf-canvas" />
            <div id="pdf-marks">
              {(sheet?.marks ?? []).map((m, n) => (
                <div key={n} className={`pdf-mark${m.filled ? ' filled' : ''}`} style={{ left: `${m.left}px`, top: `${m.top}px`, width: `${m.width}px`, height: `${m.height}px` }} />
              ))}
            </div>
          </div>
          <p id="pdf-error" className="issue bad" hidden={shown !== 'error'}>{sheet?.error ?? ''}</p>
        </div>
        <div className="pdf-controls">
          <button type="button" id="pdf-prev" className="ghost pdf-nav" aria-label="Previous page" disabled={!on('prev')} onClick={() => act.page(-1)}>‹</button>
          <span id="pdf-pages" className="small muted">{sheet?.controls?.pages ?? ''}</span>
          <button type="button" id="pdf-next" className="ghost pdf-nav" aria-label="Next page" disabled={!on('next')} onClick={() => act.page(1)}>›</button>
          <span className="grow" />
          <div className="zoom">
            <button type="button" id="pdf-zoom-out" aria-label="Zoom out" disabled={!on('zoomOut')} onClick={() => act.zoomOut()}>−</button>
            {/* It shows the zoom, and sets it back to the page's width. */}
            <button type="button" id="pdf-zoom-fit" title="Fit page" aria-label={zoom == null ? undefined : `Zoom ${zoom}%. Fit the page to the panel`} disabled={!on('fit')} onClick={() => act.fit()}>{zoom == null ? '' : `${zoom}%`}</button>
            <button type="button" id="pdf-zoom-in" aria-label="Zoom in" disabled={!on('zoomIn')} onClick={() => act.zoomIn()}>+</button>
          </div>
        </div>
        <div className="sheet-foot">
          <button type="button" id="pdf-tab" className="ghost small-btn" disabled={!on('tab')} onClick={() => act.tab()}>Open full PDF</button>
          <button type="button" id="pdf-back" className="primary small-btn" onClick={() => act.close()}>Back</button>
        </div>
      </section>
    </>
  );
}

// Draws the PDF sheet into #pdf-view, before it returns (wire then hands #pdf-scroll to pdfPan).
function mountPdf(host, act) {
  const root = createRoot(host);
  flushSync(() => root.render(<PdfSheet act={act} />));
}

export { PdfSheet, mountPdf };
