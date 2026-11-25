// @ts-check
// The report's list in React: each answer and each item left for the agent, one row each, drawn from
// its record (report-rows.js) in the unified Option B (Accent Bar + Inset Tray) style.
// The panel changes a record and drawRow (fill.js) has the list draw that row again; a row that
// didn't change isn't drawn again, so the button the agent is on keeps its focus.
// One part of the panel; renderReport mounts it in a report (rowsHost).
import { memo, useId, useLayoutEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useStore } from 'zustand';
import { panelStore } from './state-store.js';
import { NEEDS } from './messages.js';
import { choiceSaid } from './report-model.js';
import { needId, needSay, nowSaid, optionsSaid, rowClass, rowHead, worthRank } from './report-rows.js';
import { AiCard } from './ai-view.jsx';

const VIN_PATH = /^(vehicles|trailers)\[\d+\]\.vin$/;
let onJumpPath = null;

// Wired by sidepanel.js to record.js jumpTo(path) so report-view.jsx does not import record.js.
function setJumpToPath(fn) {
  onJumpPath = fn;
}

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
// pressed, and the AI's pick marked. `onPick(choice, button)`.
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
          <button key={o} type="button" className={o === aiPick ? 'opt-btn ai-pick' : 'opt-btn'} aria-pressed={o === pressed} data-choice={o}
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

// The row's head: collapsed 1-line Label | Value + chevron; expanded Label above Value + tag + chevron.
function Head({ rec, head, act, bodyId, tagOverride = undefined, children }) {
  const tag = tagOverride !== undefined ? tagOverride : head.tag;
  return (
    <button type="button" className="row-head" aria-expanded={!!rec.open} aria-controls={bodyId} onClick={() => act.toggleRow(rec)}>
      <span className="row-icon" aria-hidden="true">{head.icon}</span>
      {children}
      <span className="row-right">
        {tag ? <Tag tag={tag} /> : null}
        <span className="row-chev" aria-hidden="true">{rec.open ? '\u25be' : '\u25b8'}</span>
      </span>
    </button>
  );
}

// The expanded body of a filled answer row (Option B Inset Tray): source, inline Change answer
// choices, slim footer actions (Change answer, See in intake), where-on-page note and settlement note.
function AnswerBody({ rec, ctx, act }) {
  const source = rec.source ?? {};
  const { change } = rec;
  const hasFoot = (rec.answer && rec.key) || source.place;
  return (
    <div className="row-tray">
      <div className="row-tray-info">
        <div className="src-box">
          <span className="src-title">{source.title}</span>
          {source.quote ? <span className="src-quote">{source.quote}</span> : null}
        </div>
        <div className="change-slot">
          {change ? <><p className="why">Pick the answer to put in instead:</p>
            <Choices options={change.options} pressed={change.current} onPick={(choice, button) => act?.pickRow?.(rec, choice, ctx, button)} /></> : null}
        </div>
        {rec.key ? <span className="need-where" hidden={!rec.where}>{rec.where ?? ''}</span> : null}
        <Note note={rec.note} />
      </div>
      {hasFoot ? (
        <div className="row-tray-foot row-actions">
          {rec.answer && rec.key ? <button type="button" className="tray-link change" aria-label={`Change answer: ${rec.label}`} onClick={() => act?.changeRow?.(rec, ctx)}>Change answer</button> : null}
          {source.place ? <button type="button" className="tray-link src intake-action" title={source.seeTitle} onClick={() => act?.seeRow?.(rec)}>See in intake</button> : null}
        </div>
      ) : null}
    </div>
  );
}

// One answer in the page's list: what went in and where it came from (rec.source, answerSource).
const AnswerRow = memo(/** @param {{ rec: Record<string, any>, v?: number, ctx: any, act: any }} props */ function AnswerRow({ rec, ctx, act }) {
  const source = rec.source ?? {};
  const head = rowHead(rec, source.tag ?? null);
  const bodyId = useId();
  const worth = worthRank(rec) >= 0;
  const tone = rec.kind === 'yours' || rec.kind === 'edited' ? 'you' : undefined;
  const data = rec.key ? { 'data-key': rec.key, 'data-field': rec.field ?? '', 'data-value': String(rec.value), 'data-step': rec.stepId ?? '', 'data-offpage': rec.offPage ? '1' : '' } : {};
  return (
    <div className={rowClass(rec)} hidden={!!rec.gone} ref={(el) => { act.node(rec, el); }} data-worth={worth ? '1' : undefined} data-tone={tone} {...data}>
      <Head rec={rec} head={head} act={act} bodyId={bodyId}>
        <span className="row-text">
          <span className="row-label">{rec.label}</span>
          <span className="row-value">{head.value}</span>
          {rec.key ? <span className="kv-now" hidden={!rec.changed}>{rec.changed ?? ''}</span> : null}
        </span>
        {/* From the intake is the usual source: no tag to read past, said to screen readers. */}
        {source.quiet ? <span className="sr-only">{source.quiet}</span> : null}
      </Head>
      <div id={bodyId} className="row-body" hidden={!rec.open}>
        <AnswerBody rec={rec} ctx={ctx} act={act} />
      </div>
    </div>
  );
});

// One item left for the agent (or settled since): unified Option B Accent Bar + Inset Tray.
const NeedRow = memo(/** @param {{ rec: Record<string, any>, v?: number, ctx: any, act: any, needPos?: number, needTotal?: number }} props */ function NeedRow({ rec, ctx, act }) {
  const { x, label } = rec;
  const head = rowHead(rec);
  const bodyId = useId();
  const markNoteId = useId();
  const markable = !!x.key || !!x.action;
  const marked = ['answered', 'picked', 'marked'].includes(rec.settled);
  const settledClean = Boolean(rec.settled) && !rec.pending;
  const worth = settledClean && worthRank(rec) >= 0;
  const tone = settledClean ? 'you' : rec.pending ? 'ai' : rec.kind === 'failed' ? 'bad' : 'need';
  const vinFix = typeof x.path === 'string' && VIN_PATH.test(x.path);
  const jumpPath = act.jumpPath ?? onJumpPath;
  return (
    <div className={rowClass(rec)} hidden={!!rec.gone} tabIndex={-1} ref={(el) => { act.node(rec, el); }}
      data-need={needId(rec)} data-key={rec.key} data-field={rec.field} data-offpage={rec.offPage ? '1' : ''} data-icon={rec.icon} data-wait={rec.wait} data-finish={rec.finish ? '1' : ''}
      data-worth={worth ? '1' : undefined} data-tone={tone}>
      <Head rec={rec} head={head} act={act} bodyId={bodyId}>
        <span className="row-text"><span className="row-label">{label}</span><span className="row-value">{head.value}</span></span>
      </Head>
      <div id={bodyId} className="row-body" hidden={!rec.open}>
        <div className="row-tray">
          <div className="row-tray-info">
            <Note note={rec.note} />
            <p className="why">{x.why}<span className="page-now">{nowSaid(rec.now)}</span></p>
            <div className="ai-slot">{rec.aiCard ? <AiCard card={rec.aiCard} /> : null}</div>
            {!marked ? (
              rec.pickable ? <Choices options={rec.options} pressed={rec.pressed} aiPick={rec.aiPick} onPick={(choice, button) => act.pickRow(rec, choice, ctx, button)} />
                : <p className="row-say">{needSay(rec)}</p>
            ) : null}
            {!marked && rec.offered ? <div className="options" hidden={!rec.offered.length}>{optionsSaid(rec.offered)}</div> : null}
            {!marked ? (
              <div className="row-actions need-btns">
                {vinFix ? <button type="button" className="ghost vin-fix" onClick={() => jumpPath?.(x.path)}>{NEEDS.vinFix}</button> : null}
                {x.key ? <button type="button" className="primary show-on-page" title="Scroll the carrier page to this question and flash its mark"
                  aria-label={`Show on page: ${label}`} onClick={() => act.showRow(rec, ctx)}>Show on page</button> : null}
                {markable ? <button type="button" className="ghost mark-done" hidden={marked}
                  aria-describedby={marked ? undefined : markNoteId}
                  title={x.key ? 'You answered it, or it stays as the page has it: the panel won’t fill it or wait on it on this page' : 'You did it on the page: the panel stops waiting on it for this quote'}
                  aria-label={`Mark done: ${label}`} onClick={() => act.markRow(rec, ctx)}>Mark done</button> : null}
              </div>
            ) : null}
            {x.key ? <span className="need-where" hidden={!rec.where}>{rec.where ?? ''}</span> : null}
          </div>
          {markable || (marked && x.key) ? (
            <div className="row-tray-foot">
              {marked && x.key ? (
                <button type="button" className="tray-link show-on-page" title="Scroll the carrier page to this question and flash its mark"
                  aria-label={`Show on page: ${label}`} onClick={() => act.showRow(rec, ctx)}>Show on page</button>
              ) : null}
              {markable && marked ? (
                <button type="button" className="ghost mark-done" hidden
                  aria-label={`Mark done: ${label}`} onClick={() => act.markRow(rec, ctx)}>Mark done</button>
              ) : null}
              {markable ? <p id={markNoteId} className="mark-done-note" hidden={marked}>{x.key ? NEEDS.markDoneNote : NEEDS.markActionNote}</p> : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
});

// A report's list (`entry.list`), on the report's tab and page (`ctx`). Drawn again each time one
// of its rows changes (drawRow bumps the report's `drawn` and rowsDrawn), not when another report's
// does (audit 2026-11-07, LIVE-09); only the rows whose record changed (`rec.v`) are.
function ReportRows({ entry, ctx, act }) {
  useStore(panelStore, (s) => `${entry.drawn ?? 0}|${s.rowsAll ?? 0}`);
  const list = entry.list ?? [];
  const needs = list.filter((r) => r.type === 'need' && !r.gone);
  return list.map((rec) => (rec.type === 'need'
    ? <NeedRow key={rec.id} rec={rec} v={rec.v ?? 0} ctx={ctx} act={act} needPos={Math.max(1, needs.indexOf(rec) + 1)} needTotal={Math.max(1, needs.length)} />
    : <AnswerRow key={rec.id} rec={rec} v={rec.v ?? 0} ctx={ctx} act={act} />));
}

// Draws a report's list into its host (the report's `.rows`), before it returns; the function it
// returns unmounts the list when the report is dropped (dropReports).
function mountRows(host, entry, ctx, act) {
  const root = createRoot(host);
  flushSync(() => root.render(<ReportRows entry={entry} ctx={ctx} act={act} />));
  return () => root.unmount();
}

export { AnswerBody, Note, ReportRows, mountRows, setJumpToPath };
