// The report's list in React: each answer and each item left for the agent, one row each, drawn from
// its record (report-rows.js). The panel changes a record and drawRow (fill.js) has the list draw
// that row again; a row that didn't change isn't drawn again, so the button the agent is on keeps its
// focus. What a row's buttons do is the panel's (`act`, rowActs in fill.js).
// One part of the panel; renderReport mounts it in a report (rowsHost).
import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useStore } from 'zustand';
import { panelStore } from './state-store.js';
import { choiceSaid } from './report-model.js';
import { needId, needSay, nowSaid, optionsSaid, rowClass, rowHead } from './report-rows.js';

// A source tag on a row's head.
function Tag({ tag }) {
  return <span className={`tag ${tag.kind}`} title={tag.title ?? ''}>{tag.text}</span>;
}

// What settled a row, or why the page didn't take a pick: empty while it is open.
function Note({ note }) {
  return (
    <p className={`need-note${note?.bad ? ' bad' : ''}`} hidden={!note}>
      {note?.text}
      {note?.undo ? <button type="button" className="link small" onClick={note.undo}>Undo</button> : null}
    </p>
  );
}

// The choices the panel may put in for the agent: buttons, or a list past six; the page's answer now
// pressed, and the AI's pick marked. `onPick(choice, button)`. A choice the page lists twice is
// offered once (Change answer's come as the page has them; an item's are deduplicated already,
// needRecord), keyed by itself.
function Choices({ options: all, pressed = null, aiPick = null, onPick }) {
  const options = useMemo(() => [...new Set(all)], [all]);
  const select = useRef(null);
  const listed = options.length > 6;
  // The list shows the pressed answer as it changes, not only the one it was drawn with.
  useLayoutEffect(() => {
    if (listed && select.current) select.current.value = pressed != null && options.includes(pressed) ? pressed : '';
  }, [listed, options, pressed]);
  if (!listed) {
    return (
      <div className="opts" role="group" aria-label="Answers">
        {options.map((o) => (
          <button key={o} type="button" className={o === aiPick ? 'opt-btn ai-pick' : 'opt-btn'} aria-pressed={String(o === pressed)} data-choice={o}
            onClick={(e) => onPick(o, e.currentTarget)}>
            <span>{choiceSaid(o)}</span>
            {o === aiPick ? <span className="ai-badge">AI pick</span> : null}
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="opt-select">
      <select ref={select} aria-label="Answer" defaultValue={pressed != null && options.includes(pressed) ? pressed : ''}>
        <option value="">Choose…</option>
        {options.map((o) => <option key={o} value={o}>{`${choiceSaid(o)}${o === aiPick ? ' (AI pick)' : ''}`}</option>)}
      </select>
      <button type="button" className="ghost" onClick={(e) => { if (select.current?.value) onPick(select.current.value, e.currentTarget); }}>Put it in</button>
    </div>
  );
}

// The row's head: icon, label, what it shows, its tag; opens or closes the row.
function Head({ rec, head, act, children }) {
  return (
    <button type="button" className="row-head" aria-expanded={String(!!rec.open)} onClick={() => act.toggleRow(rec)}>
      <span className="row-icon" aria-hidden="true">{head.icon}</span>
      {children}
      {head.tag ? <Tag tag={head.tag} /> : null}
    </button>
  );
}

// One answer in the page's list: what went in and where it came from (rec.source, answerSource),
// opening to its source with Change answer and See in intake. `rec.kind` 'clicked', 'page' (left as
// the page had it) or 'yours' (the agent's own answer, not filled); otherwise an answer, by its
// source. `v`: the record's draw count, so the row is drawn again when it changes.
const AnswerRow = memo(function AnswerRow({ rec, ctx, act }) {
  const source = rec.source ?? {};
  const head = rowHead(rec, source.tag ?? null);
  const { change } = rec;
  const data = rec.key ? { 'data-key': rec.key, 'data-field': rec.field ?? '', 'data-value': String(rec.value), 'data-step': rec.stepId ?? '', 'data-offpage': rec.offPage ? '1' : '' } : {};
  return (
    <div className={rowClass(rec)} hidden={!!rec.gone} ref={(el) => { act.node(rec, el); }} {...data}>
      <Head rec={rec} head={head} act={act}>
        <span className="row-text">
          <span className="row-label">{rec.label}</span><span className="row-value">{head.value}</span>
          {rec.key ? <span className="kv-now" hidden={!rec.changed}>{rec.changed ?? ''}</span> : null}
        </span>
        {/* From the intake is the usual source: no tag to read past, said to screen readers. */}
        {source.quiet ? <span className="sr-only">{source.quiet}</span> : null}
      </Head>
      <div className="row-body" hidden={!rec.open}>
        <div className="src-box"><span className="src-title">{source.title}</span>{source.quote ? <span className="src-quote">{source.quote}</span> : null}</div>
        <div className="change-slot">
          {change ? <><p className="why">Pick the answer to put in instead:</p>
            <Choices options={change.options} pressed={change.current} onPick={(choice, button) => act.pickRow(rec, choice, ctx, button)} /></> : null}
        </div>
        {rec.answer && rec.key || source.place ? (
          <div className="row-actions">
            {rec.answer && rec.key ? <button type="button" className="ghost change" aria-label={`Change answer: ${rec.label}`} onClick={() => act.changeRow(rec, ctx)}>Change answer</button> : null}
            {source.place ? <button type="button" className="ghost src" title={source.seeTitle} onClick={() => act.seeRow(rec)}>See in intake</button> : null}
          </div>
        ) : null}
        {rec.key ? <span className="need-where" hidden={!rec.where}>{rec.where ?? ''}</span> : null}
        <Note note={rec.note} />
      </div>
    </div>
  );
});

// One item left for the agent: why, and its choices where the panel may put the agent's pick in
// (rec.pickable; the AI's pick marked), with Show on page and Mark done. The AI's card goes in its
// slot (renderAi), which React leaves alone.
const NeedRow = memo(function NeedRow({ rec, ctx, act }) {
  const { x, label } = rec;
  const head = rowHead(rec);
  // Mark done: an item's field, or a helper's reminder the carrier marks markable (its `action`);
  // gone once the agent settled it (answered, put in, marked done).
  const markable = !!x.key || !!x.action;
  const marked = ['answered', 'picked', 'marked'].includes(rec.settled);
  return (
    <div className={rowClass(rec)} hidden={!!rec.gone} tabIndex={-1} ref={(el) => { act.node(rec, el); }}
      data-need={needId(rec)} data-key={rec.key} data-field={rec.field} data-offpage={rec.offPage ? '1' : ''} data-icon={rec.icon} data-wait={rec.wait} data-finish={rec.finish ? '1' : ''}>
      <Head rec={rec} head={head} act={act}>
        <span className="row-text"><span className="row-label">{label}</span><span className="row-value">{head.value}</span></span>
      </Head>
      <div className="row-body" hidden={!rec.open}>
        <p className="why">{x.why}<span className="page-now">{nowSaid(rec.now)}</span></p>
        <div className="ai-slot" ref={(el) => { act.slot(rec, el); }} />
        {rec.pickable ? <Choices options={rec.options} pressed={rec.pressed} aiPick={rec.aiPick} onPick={(choice, button) => act.pickRow(rec, choice, ctx, button)} />
          : <p className="row-say">{needSay(rec)}</p>}
        {rec.offered ? <div className="options" hidden={!rec.offered.length}>{optionsSaid(rec.offered)}</div> : null}
        <div className="row-actions">
          {/* Scrolls the carrier page to its field and flashes its mark: changes nothing. */}
          {x.key ? <button type="button" className="ghost show-on-page" title="Scroll the carrier page to this question and flash its mark"
            aria-label={`Show on page: ${label}`} onClick={() => act.showRow(rec, ctx)}>Show on page</button> : null}
          {markable ? <button type="button" className="ghost mark-done" hidden={marked}
            title={x.key ? 'You answered it, or it stays as the page has it: the panel won’t fill it or wait on it on this page' : 'You did it on the page: the panel stops waiting on it for this quote'}
            aria-label={`Mark done: ${label}`} onClick={() => act.markRow(rec, ctx)}>Mark done</button> : null}
        </div>
        {x.key ? <span className="need-where" hidden={!rec.where}>{rec.where ?? ''}</span> : null}
        <Note note={rec.note} />
      </div>
    </div>
  );
});

// A report's list (`entry.list`), on the report's tab and page (`ctx`). Drawn again each time a row
// changes (drawRow bumps rowsDrawn); only the rows whose record changed (`rec.v`) are.
function ReportRows({ entry, ctx, act }) {
  useStore(panelStore, (s) => s.rowsDrawn);
  return (entry.list ?? []).map((rec) => (rec.type === 'need'
    ? <NeedRow key={rec.id} rec={rec} v={rec.v ?? 0} ctx={ctx} act={act} />
    : <AnswerRow key={rec.id} rec={rec} v={rec.v ?? 0} ctx={ctx} act={act} />));
}

// Draws a report's list into its host (the report's `.rows`), before it returns; the function it
// returns takes it down (a report replaced or forgotten).
function mountRows(host, entry, ctx, act) {
  const root = createRoot(host);
  flushSync(() => root.render(<ReportRows entry={entry} ctx={ctx} act={act} />));
  return () => root.unmount();
}

export { ReportRows, mountRows };
